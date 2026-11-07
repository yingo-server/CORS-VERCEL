/**
 * JavaScript 重写器。
 *
 * 只做"必须静态改写"的部分，其余交给注入的运行时垫片：
 *   - import / export ... from / import()      —— 说明符必须是可解析的绝对路径
 *   - new URL(x, import.meta.url)              —— 显式 URL 构造
 *   - fetch / XHR.open / location.assign ...   —— 显式 URL 消费点
 *   - new Worker / EventSource / window.open
 *   - 指向目标主机的绝对 URL 字面量（可选，镜像场景下默认开）
 *
 * 依赖 acorn 做真实语法解析：正则扫 JS 会在字符串、模板、正则字面量、注释里误伤，
 * 那是"能跑但随机出错"的典型来源。
 *
 * 解析失败（TS/JSX/新语法）时回退到保守的语法嗅探，绝不猜测改写范围。
 */

import { parse } from 'acorn';
import { rewriteRef } from './url.js';

const MAX_PARSE_BYTES = 1_500_000;

/** 直接把参数当 URL 用的全局函数。 */
const URL_CALLEES = new Set(['fetch', 'importScripts', 'open', 'sendBeacon', 'assign', 'replace']);

/** 成员调用：x.open / x.assign / x.replace / x.register。 */
const URL_MEMBER_CALLEES = new Set(['open', 'assign', 'replace', 'register', 'sendBeacon', 'navigate']);

/** 构造器。 */
const URL_CTORS = new Set(['Worker', 'SharedWorker', 'EventSource', 'URL']);

/** 形如 HTTP 方法的字面量（xhr.open('GET', url) 的判别依据）。 */
const HTTP_METHOD = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)$/i;

function looksLikeSpecifier(value) {
  if (typeof value !== 'string' || !value) return false;
  return value[0] === '.' || value[0] === '/' || /^https?:\/\//i.test(value);
}

function quoteFor(src, node) {
  const ch = src[node.start];
  return ch === "'" || ch === '"' ? ch : '"';
}

function stringifyLiteral(value, quote) {
  const body = String(value)
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quote === '"' ? '"' : "'", 'g'), '\\' + quote)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return quote + body + quote;
}

function parseSource(src, preferModule) {
  const base = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowNewTargetOutsideFunction: true,
  };
  const order = preferModule ? ['module', 'script'] : ['script', 'module'];
  for (const sourceType of order) {
    try {
      return parse(src, { ...base, sourceType });
    } catch {
      /* 换另一种模式再试 */
    }
  }
  return null;
}

/**
 * 全局 location 引用白名单（审计缺陷 #3/#4 修复）：
 * 只认 location、window.location、document.location 三种形态。
 * obj.location（iframe 句柄、配置对象等）一律不算 —— 误改它们会崩真实页面。
 * window/document 自身被局部 shadow 时同样保守跳过。
 */
function isGlobalLocationRef(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'location';
  if (node.type !== 'MemberExpression' || node.computed) return false;
  const prop = node.property && node.property.name;
  if (prop !== 'location') return false;
  const obj = node.object;
  if (obj.type !== 'Identifier') return false;
  return obj.name === 'window' || obj.name === 'document';
}

/**
 * 保守作用域预扫描（审计缺陷 #1 修复）：
 * 收集所有把 `location` 声明为局部绑定的位置 —— var/let/const 声明、
 * 函数参数、函数声明、catch 参数、解构。命中任何一个即整份文件放弃
 * location 改写（宁可漏改，不可改坏：局部 location 的页面通常是框架代码）。
 * 返回 true 表示该文件存在 location shadow，应跳过所有 location 导航改写。
 */
function hasLocationShadow(ast) {
  let found = false;
  const stack = [ast];
  let guard = 0;
  while (stack.length && !found) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (++guard > 400000) return true; // 病态 AST：保守当作有 shadow

    const checkNames = (names) => {
      for (const n of names) {
        if ((n.type === 'Identifier' && n.name === 'location') ||
            (n && n.type === 'ObjectPattern' && JSON.stringify(n).includes('"location"'))) {
          found = true;
          return;
        }
      }
    };

    switch (node.type) {
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier' && node.id.name === 'location') found = true;
        else if (node.id.type === 'ObjectPattern' || node.id.type === 'ArrayPattern') checkNames([node.id]);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        checkNames(node.params || []);
        break;
      case 'CatchClause':
        if (node.param && node.param.name === 'location') found = true;
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id && node.id.name === 'location') found = true;
        break;
    }
    if (found) return true;

    for (const key in node) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (let k = value.length - 1; k >= 0; k--) {
          const child = value[k];
          if (child && typeof child.type === 'string') stack.push(child);
        }
      } else if (value && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
  return found;
}

function walkAll(root, visit) {
  const stack = [root];
  let guard = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (++guard > 400000) return; // 防御性上限：病态 AST 直接停
    visit(node);
    for (const key in node) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (let k = value.length - 1; k >= 0; k--) {
          const child = value[k];
          if (child && typeof child.type === 'string') stack.push(child);
        }
      } else if (value && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
}

/** 取表达式节点里的"字符串值"（字面量或无插值模板）。 */
function literalOf(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return { value: node.value, kind: 'literal' };
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return { value: node.quasis[0].value.cooked ?? node.quasis[0].value.raw, kind: 'template' };
  }
  return null;
}

function rewriteSpecifier(cfg, base, literal) {
  if (!looksLikeSpecifier(literal.value)) return null; // 'lodash' 这类裸包名不动
  const out = rewriteRef(cfg, base, literal.value);
  return out === literal.value ? null : out;
}

/**
 * @param {object} cfg
 * @param {string} src
 * @param {URL|string} scriptUrl 脚本在上游视角下的绝对 URL
 * @param {{module?:boolean, docUrl?:URL}} opts
 */
export function rewriteJs(cfg, src, scriptUrl, opts = {}) {
  if (!cfg.rewrite || !cfg.rewrite.js) return src;
  if (typeof src !== 'string' || !src) return src;
  if (src.length > MAX_PARSE_BYTES) return src; // 超大 bundle：交由运行时垫片兜底

  const base = typeof scriptUrl === 'string' ? new URL(scriptUrl) : scriptUrl;
  const ast = parseSource(src, !!opts.module);
  if (!ast) return fallbackRewrite(cfg, src, base);

  // 作用域保守预扫描：任何作用域把 location 声明为局部绑定（var/let/const/
  // 参数/解构/函数名），就整份文件跳过 location 导航改写。
  // 理由：改坏框架代码的代价远大于漏改几个跳转（审计缺陷 #1）。
  const locationShadowed = hasLocationShadow(ast);

  const edits = new Map(); // start -> {start,end,text}
  const done = new Set();

  const setEdit = (node, newValue) => {
    const key = node.start + ':' + node.end;
    if (done.has(key)) return;
    done.add(key);
    const quote = node.type === 'TemplateLiteral' ? '`' : quoteFor(src, node);
    const text = node.type === 'TemplateLiteral'
      ? '`' + newValue.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'
      : stringifyLiteral(newValue, quote);
    const existing = edits.get(node.start);
    // 同起点取更小区间：嵌套节点同时命中时保留最精确的改写（审计缺陷 #6）
    if (existing && existing.end <= node.end) return;
    edits.set(node.start, { start: node.start, end: node.end, text });
  };

  const handleSpecifier = (node) => {
    const lit = literalOf(node);
    if (!lit) return;
    const out = rewriteSpecifier(cfg, base, lit);
    if (out !== null) setEdit(node, out);
  };

  const handleUrlArg = (node) => {
    const lit = literalOf(node);
    if (!lit) return false;
    const out = rewriteRef(cfg, base, lit.value);
    if (out !== lit.value) { setEdit(node, out); return true; }
    return false;
  };

  // 运行时才能求值的 URL（模板/拼接/变量）：包一层垫片调用，由运行时映射。
  // 这是 location.* 与 fetch 等动态地址的唯一可靠拦截路径（Location 不可 patch）。
  const wrapWithRuntimeMap = (node) => {
    if (!node) return;
    // 无插值模板是字面量等价物，handleUrlArg 已处理；有插值的才需要运行时
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return;
    if (node.type === 'Literal' && typeof node.value === 'string') return;
    if (node.type === 'Literal') return;
    if (done.has(node.start + ':' + node.end)) return;
    const text = `(__VPROXY__ ? __VPROXY__.map(${src.slice(node.start, node.end)}) : ${src.slice(node.start, node.end)})`;
    const existing = edits.get(node.start);
    if (existing && existing.end <= node.end) return;
    edits.set(node.start, { start: node.start, end: node.end, text });
    done.add(node.start + ':' + node.end);
  };

  const handleCallee = (node) => {
    const { callee } = node;
    if (!callee) return;
    const args = node.arguments || [];

    if (callee.type === 'Identifier' && URL_CALLEES.has(callee.name)) {
      if (args[0]) handleUrlArg(args[0]);
      return;
    }

    if (callee.type === 'MemberExpression' && !callee.computed) {
      const prop = callee.property && callee.property.name;
      if (prop === 'open' && args.length >= 2) {
        const first = literalOf(args[0]);
        // xhr.open('GET', url)  vs  window.open(url)
        if (first && HTTP_METHOD.test(first.value)) handleUrlArg(args[1]);
        else handleUrlArg(args[0]);
        return;
      }
      if (prop && URL_MEMBER_CALLEES.has(prop)) {
        // 跳过 Array/String 等明显不是 URL 的调用
        const objName = callee.object && callee.object.name;
        if (objName === 'Array' || objName === 'Object' || objName === 'String') return;
        if (args[0] && !handleUrlArg(args[0])) {
          // 仅 location 导航需要包装（垫片运行时拦不住 Location.*；
          // fetch/XHR 等已由垫片 API 层拦截，无需重复）
          const obj = callee.object;
          const objIsLoc = obj && (obj.name === 'location' ||
            (obj.type === 'MemberExpression' && obj.property && obj.property.name === 'location') ||
            (obj.type === 'MemberExpression' && obj.object && obj.object.name === 'document' && obj.property && obj.property.name === 'location'));
          if (!locationShadowed && isGlobalLocationRef(callee.object)) wrapWithRuntimeMap(args[0]);
        }
      }
    }
  };

  const handleNew = (node) => {
    const { callee } = node;
    if (!callee || callee.type !== 'Identifier' || !URL_CTORS.has(callee.name)) return;
    const args = node.arguments || [];
    if (args[0]) handleUrlArg(args[0]);
  };

  walkAll(ast, (node) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source) handleSpecifier(node.source);
        break;
      case 'ImportExpression':
        if (node.source) handleSpecifier(node.source);
        break;
      case 'CallExpression':
        handleCallee(node);
        break;
      case 'NewExpression':
        handleNew(node);
        break;
      case 'AssignmentExpression': {
        // location.href = '...' / window.location.href = '...' / document.location = '...'
        // location = '...' / window.location = '...'
        const left = node.left;
        if (!locationShadowed && left && left.type === 'MemberExpression' && !left.computed) {
          const prop = left.property && left.property.name;
          if (isGlobalLocationRef(left.object) && (prop === 'href' || prop === 'pathname')) {
            if (!handleUrlArg(node.right)) wrapWithRuntimeMap(node.right);
          }
        }
        // 注意：裸标识符赋值 location = ... 不改写 —— 无法区分全局 location
        // 与局部 shadow（var/let/const/参数），误伤代价大于收益（审计缺陷 #2）。
        break;
      }
      default:
        break;
    }

    // 绝对 URL 字面量兜底（同一主机 => 换成根路径；跨主机按 external 策略）
    if (cfg.rewrite.absoluteLiterals) {
      const lit = literalOf(node);
      if (lit && /^https?:\/\//i.test(lit.value)) {
        let hostOnly = null;
        try {
          hostOnly = new URL(lit.value).host;
        } catch { /* 非法 URL 字面量：交给运行时 */ }
        if (hostOnly === cfg.targetHost) {
          const out = rewriteRef(cfg, base, lit.value);
          if (out !== lit.value) setEdit(node, out);
        }
      }
    }
  });

  if (!edits.size) return src;

  const list = [...edits.values()].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const e of list) {
    if (e.start < cursor) continue;
    out += src.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + src.slice(cursor);
}

/**
 * 解析失败时的保守回退：只处理高置信度模式。
 * 任何拿不准的地方保持原样——错误改写比不改写危险得多。
 */
function fallbackRewrite(cfg, src, base) {
  const rewriteStr = (value) => {
    if (!value) return value;
    return rewriteRef(cfg, base, value);
  };

  let out = src.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"\n]{1,2048})\2/g,
    (m, pre, quote, value) => {
      if (!looksLikeSpecifier(value)) return m;
      const next = rewriteStr(value);
      return pre + quote + next + quote;
    },
  );

  out = out.replace(
    /(\bnew\s+URL\s*\(\s*)(['"])([^'"\n]{1,2048})\2/g,
    (m, pre, quote, value) => {
      const next = rewriteStr(value);
      return pre + quote + next + quote;
    },
  );

  if (cfg.rewrite.absoluteLiterals) {
    const host = cfg.targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(['"\`])(https?:\\/\\/${host}(?:[^'"\`\\\\]*))\\1`, 'g'),
      (m, quote, value) => quote + rewriteStr(value) + quote,
    );
  }

  return out;
}

/**
 * <script type="importmap"> 的改写：只动值（键是裸包名）。
 */
export function rewriteImportMap(cfg, json, baseUrl) {
  if (typeof json !== 'string' || !json.trim()) return json;
  let map;
  try {
    map = JSON.parse(json);
  } catch {
    return json; // 非法 JSON 交给浏览器报错，别替它猜
  }
  const base = typeof baseUrl === 'string' ? new URL(baseUrl) : baseUrl;
  const fixValue = (v) => (typeof v === 'string' ? rewriteRef(cfg, base, v) : v);

  if (map && typeof map === 'object') {
    if (map.imports && typeof map.imports === 'object') {
      for (const k of Object.keys(map.imports)) map.imports[k] = fixValue(map.imports[k]);
    }
    if (map.scopes && typeof map.scopes === 'object') {
      for (const scopeKey of Object.keys(map.scopes)) {
        const inner = map.scopes[scopeKey];
        if (!inner || typeof inner !== 'object') continue;
        for (const k of Object.keys(inner)) inner[k] = fixValue(inner[k]);
      }
    }
  }
  return JSON.stringify(map);
}
