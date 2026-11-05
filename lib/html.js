/**
 * HTML 重写器。
 *
 * 为什么不是"正则替换"：
 *   正则会在注释、脚本字符串、CDATA 里误伤，并且无法区分 `<a href>` 与文本里的 `<a href>`。
 * 为什么不是"完整 DOM 解析"：
 *   代理要面对的是真实世界里的残缺 HTML（未闭合标签、错嵌、超大文档）。
 *   全量建树 + 序列化会改变文档结构，进而改变 CSS 选择器与脚本行为。
 *
 * 本实现采用"词法扫描 + 属性级手术"：
 *   - 不重排、不补全、不规范化任何标签；
 *   - 只替换必须替换的属性值区间；
 *   - 其余字节原样透传（含空白、大小写、注释、条件注释）。
 */

import { rewriteRef } from './url.js';
import { rewriteCss } from './css.js';
import { rewriteJs, rewriteImportMap } from './jsrewrite.js';

/** 内容按原样透传的原始文本元素（HTML5 raw text）。 */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext', 'noembed', 'noframes', 'noscript']);

/** 单值 URL 属性。 */
const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'background',
  'longdesc', 'manifest', 'codebase', 'xlink:href', 'itemid', 'icon',
  'archive', 'classid', 'profile',
]);

/** 多值（空格分隔）URL 属性。 */
const URL_LIST_ATTRS = new Set(['ping']);

/** srcset 系属性。 */
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

function isWs(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f';
}

function isAlpha(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function escapeAttr(value, quote) {
  let out = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote === "'") out = out.replace(/'/g, '&#39;');
  else out = out.replace(/"/g, '&quot;');
  return out;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  sol: '/', bsol: '\\', colon: ':', lpar: '(', rpar: ')', num: '#', percnt: '%',
  equals: '=', quest: '?', commat: '@', dollar: '$', plus: '+', comma: ',',
  period: '.', semi: ';', Tab: '\t', NewLine: '\n',
};

export function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const num = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return m;
      try {
        return String.fromCodePoint(num);
      } catch {
        return m;
      }
    }
    const hit = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

/** 从 start 开始找到当前标签的 `>`（跳过引号内的内容）。 */
function findTagEnd(s, start) {
  let i = start;
  let quote = '';
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
    i++;
  }
  return s.length;
}

/** 解析开始标签；返回 null 表示这不是一个可解析的标签（按文本处理）。 */
function parseStartTag(s, start) {
  const n = s.length;
  let i = start + 1;
  const nameStart = i;
  while (i < n && !isWs(s[i]) && s[i] !== '>' && s[i] !== '/') i++;
  const name = s.slice(nameStart, i).toLowerCase();
  if (!name) return null;

  const attrs = [];
  for (;;) {
    while (i < n && isWs(s[i])) i++;
    if (i >= n) return null;
    if (s[i] === '>') return { name, ncStart: nameStart, attrs, end: i + 1, selfClosing: false };
    if (s[i] === '/' && s[i + 1] === '>') return { name, ncStart: nameStart, attrs, end: i + 2, selfClosing: true };
    if (s[i] === '/') { i++; continue; }

    const aNameStart = i;
    while (i < n && !isWs(s[i]) && s[i] !== '=' && s[i] !== '>' && !(s[i] === '/' && s[i + 1] === '>')) i++;
    if (i === aNameStart) { i++; continue; }
    const attrName = s.slice(aNameStart, i).toLowerCase();

    let j = i;
    while (j < n && isWs(s[j])) j++;
    if (s[j] === '=') {
      j++;
      while (j < n && isWs(s[j])) j++;
      let quote = '';
      let valueStart;
      let valueEnd;
      if (s[j] === '"' || s[j] === "'") {
        quote = s[j];
        valueStart = j + 1;
        const close = s.indexOf(quote, valueStart);
        if (close < 0) return null; // 引号未闭合：整段按文本处理，交给浏览器容错
        valueEnd = close;
        i = close + 1;
      } else {
        valueStart = j;
        while (j < n && !isWs(s[j]) && s[j] !== '>') j++;
        valueEnd = j;
        i = j;
      }
      attrs.push({ name: attrName, nameStart: aNameStart, valueStart, valueEnd, quote, raw: s.slice(valueStart, valueEnd) });
    } else {
      attrs.push({ name: attrName, nameStart: aNameStart, valueStart: -1, valueEnd: -1, quote: '', raw: null });
      i = j;
    }
  }
}

/** 找原始文本元素的闭合标签位置。 */
function findRawEnd(s, lower, from, name) {
  const needle = '</' + name;
  let idx = lower.indexOf(needle, from);
  while (idx !== -1) {
    const after = lower[idx + needle.length];
    if (after === undefined || after === '>' || isWs(after) || after === '/') {
      const gt = s.indexOf('>', idx);
      return { closeStart: idx, closeEnd: gt < 0 ? s.length : gt + 1 };
    }
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return { closeStart: s.length, closeEnd: s.length };
}

function scanBaseHref(html, lower) {
  let i = 0;
  while (i < html.length) {
    const idx = lower.indexOf('<base', i);
    if (idx < 0) return null;
    const after = lower[idx + 5];
    if (after !== undefined && !isWs(after) && after !== '>') { i = idx + 5; continue; }
    const tag = parseStartTag(html, idx);
    if (!tag) { i = idx + 5; continue; }
    const href = tag.attrs.find((a) => a.name === 'href');
    if (href && href.raw != null) return decodeEntities(href.raw);
    i = tag.end;
  }
  return null;
}

function applyEdits(s, edits) {
  if (!edits.length) return s;
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const e of edits) {
    if (e.start < cursor) continue; // 重叠编辑：保留先到的（理论上不会发生）
    out += s.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + s.slice(cursor);
}

function rewriteSrcset(cfg, base, value) {
  const decoded = decodeEntities(value);
  // srcset 语法：逗号分隔的候选，候选内部"URL 空白 描述符"，URL 自身可含逗号（data: 里）。
  const parts = decoded.split(',');
  const out = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = /^(\S+)([\s\S]*)$/.exec(trimmed);
    if (!m) { out.push(trimmed); continue; }
    const url = m[1];
    const desc = m[2];
    out.push(rewriteRef(cfg, base, url) + desc);
  }
  return out.join(', ');
}

/** 内联事件处理器里的绝对 URL（`onclick="location.href='https://x/y'"`）。 */
function rewriteInlineHandler(cfg, code, base) {
  const host = cfg.targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(['"\`])((?:https?:)?//${host}[^'"\`\\\\]*)\\1`, 'g');
  return code.replace(re, (m, q, url) => {
    const out = rewriteRef(cfg, base, url);
    return q + out + q;
  });
}

/**
 * 主入口。
 * @param {object} cfg
 * @param {string} html
 * @param {URL|string} docUrl 文档在上游视角下的绝对 URL
 * @param {{depth?:number, injectRuntime?:boolean}} [opts]
 */
export function rewriteHtml(cfg, html, docUrl, opts = {}) {
  const depth = opts.depth || 0;
  if (depth > 3) return html; // srcdoc 嵌套上限，防炸栈

  const doc = typeof docUrl === 'string' ? new URL(docUrl) : docUrl;
  const edits = [];
  let count = 0;
  const budget = cfg.rewrite.maxEdits || 50000;

  let base = doc;
  const lowerHtml = html.toLowerCase();
  const baseHref = scanBaseHref(html, lowerHtml);
  if (baseHref) {
    try {
      const resolved = new URL(baseHref, doc);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') base = resolved;
    } catch { /* 无效 base 忽略，浏览器也会忽略 */ }
  }

  const addValueEdit = (attr, newValue) => {
    if (newValue == null || newValue === attr.raw) return;
    const text = attr.quote
      ? escapeAttr(newValue, attr.quote)
      : `"${escapeAttr(newValue, '"')}"`;
    edits.push({ start: attr.valueStart, end: attr.valueEnd, text });
    count++;
  };

  const dropAttr = (attr) => {
    let start = attr.nameStart;
    while (start > 0 && (html[start - 1] === ' ' || html[start - 1] === '\t' || html[start - 1] === '\n' || html[start - 1] === '\r')) start--;
    const end = attr.valueStart >= 0
      ? attr.valueEnd + (attr.quote ? 1 : 0)
      : attr.nameStart + attr.name.length;
    edits.push({ start, end, text: '' });
    count++;
  };

  let i = 0;
  const n = html.length;

  while (i < n && count < budget) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;

    // 注释
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 7);
      i = end < 0 ? n : end + 3;
      continue;
    }
    // 声明 / 处理指令 / 结束标签
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      i = findTagEnd(html, lt + 2);
      continue;
    }
    if (html[lt + 1] === '/') {
      i = findTagEnd(html, lt + 2);
      continue;
    }
    if (!isAlpha(html.charCodeAt(lt + 1))) {
      i = lt + 1;
      continue;
    }

    const tag = parseStartTag(html, lt);
    if (!tag) { i = lt + 1; continue; }

    rewriteTag(cfg, tag, base, edits, addValueEdit, dropAttr, { depth, doc });

    // 原始文本内容
    if (RAW_TEXT.has(tag.name) && !tag.selfClosing) {
      const { closeStart, closeEnd } = findRawEnd(html, lowerHtml, tag.end, tag.name);
      const content = html.slice(tag.end, closeStart);
      const inner = rewriteRawContent(cfg, tag, content, base, doc, depth);
      if (inner !== null && inner !== content) {
        edits.push({ start: tag.end, end: closeStart, text: inner });
      }
      i = closeEnd;
      continue;
    }

    i = tag.end;
  }

  let out = applyEdits(html, edits);

  if (opts.injectRuntime !== false && cfg.injectRuntime) {
    out = injectRuntimeTag(cfg, out, doc);
  }
  return out;

  function rewriteRawContent(cfg2, t, content, baseUrl, docUrl2, d) {
    if (!content) return null;
    const typeAttr = t.attrs.find((a) => a.name === 'type');
    const type = (typeAttr && typeAttr.raw ? decodeEntities(typeAttr.raw) : '').toLowerCase().trim();

    if (t.name === 'script') {
      if (type === 'importmap') {
        return cfg.rewrite.importmap ? rewriteImportMap(cfg, content, baseUrl) : null;
      }
      if (type === 'speculationrules' || type === 'application/ld+json' || type.endsWith('/json') || type === 'text/template') {
        return null;
      }
      if (!cfg.rewrite.js) return null;
      return rewriteJs(cfg, content, baseUrl, { module: type === 'module', docUrl: docUrl2, depth: d });
    }
    if (t.name === 'style') {
      return cfg.rewrite.css ? rewriteCss(cfg, content, baseUrl) : null;
    }
    return null; // textarea/title/noscript 等原样
  }
}

function rewriteTag(cfg, tag, base, edits, addValueEdit, dropAttr, meta) {
  const name = tag.name;

  // 收集属性（同名属性浏览器取第一个，我们也只认第一个）
  const seen = new Set();
  const attrs = [];
  for (const a of tag.attrs) {
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    attrs.push(a);
  }
  const get = (n2) => attrs.find((a) => a.name === n2);

  // <base href>：改写并已作为解析基准
  if (name === 'base') {
    const href = get('href');
    if (href && href.raw != null) addValueEdit(href, rewriteRef(cfg, base, decodeEntities(href.raw)));
    return;
  }

  // <meta charset> / <meta http-equiv=content-type> / refresh / csp
  if (name === 'meta') {
    const charsetAttr = get('charset');
    if (charsetAttr && charsetAttr.raw != null && decodeEntities(charsetAttr.raw).toLowerCase() !== 'utf-8') {
      addValueEdit(charsetAttr, 'utf-8');
    }
    const equiv = get('http-equiv');
    const content = get('content');
    const equivKind = equiv && equiv.raw ? decodeEntities(equiv.raw).toLowerCase().trim() : '';
    if (equivKind === 'content-type' && content && content.raw != null) {
      const raw = decodeEntities(content.raw);
      if (/charset\s*=/i.test(raw)) addValueEdit(content, raw.replace(/charset\s*=\s*"?[^";\s]+"?/i, 'charset=utf-8'));
    }
    const kind = equiv && equiv.raw ? decodeEntities(equiv.raw).toLowerCase().trim() : '';
    if (kind === 'refresh' && content && content.raw != null) {
      const raw = decodeEntities(content.raw);
      const m = /^([\s\S]*?;\s*(?:url\s*=\s*)?)(['"]?)([^'"]+)\2\s*$/i.exec(raw);
      if (m) {
        const target = rewriteRef(cfg, base, m[3].trim());
        addValueEdit(content, `${m[1]}${m[2]}${target}${m[2]}`);
      }
    }
    if (kind === 'content-security-policy' || kind === 'content-security-policy-report-only' || kind === 'x-frame-options') {
      if (cfg.stripSecurityHeaders) {
        for (const a of attrs) dropAttr(a);
      }
    }
    return;
  }

  for (const attr of attrs) {
    const an = attr.name;

    // 子资源完整性：内容已变，SRI 必然失败
    if ((an === 'integrity' || an === 'nonce') && (name === 'script' || name === 'link')) {
      if (an === 'integrity') { dropAttr(attr); continue; }
    }
    if (an === 'integrity') { dropAttr(attr); continue; }

    if (attr.raw == null) continue;
    const value = attr.raw;

    if (URL_ATTRS.has(an)) {
      addValueEdit(attr, rewriteRef(cfg, base, decodeEntities(value)));
      continue;
    }

    if (SRCSET_ATTRS.has(an)) {
      addValueEdit(attr, rewriteSrcset(cfg, base, value));
      continue;
    }

    if (URL_LIST_ATTRS.has(an)) {
      const list = decodeEntities(value).split(/\s+/).filter(Boolean).map((u) => rewriteRef(cfg, base, u));
      if (list.length) addValueEdit(attr, list.join(' '));
      continue;
    }

    if (an === 'style' && cfg.rewrite.css) {
      addValueEdit(attr, rewriteCss(cfg, decodeEntities(value), base));
      continue;
    }

    if (an === 'srcdoc' && (name === 'iframe' || name === 'frame')) {
      const inner = decodeEntities(value);
      const rewritten = rewriteHtml(cfg, inner, meta.doc, { depth: meta.depth + 1, injectRuntime: false });
      addValueEdit(attr, rewritten);
      continue;
    }

    if (an.startsWith('on') && an.length > 2 && cfg.rewrite.inlineHandlers) {
      addValueEdit(attr, rewriteInlineHandler(cfg, decodeEntities(value), base));
      continue;
    }

    // <object>/<embed> 的 param：<param name="movie" value="...">
    if (name === 'param' && an === 'value') {
      const pname = get('name');
      const pv = pname && pname.raw ? decodeEntities(pname.raw).toLowerCase() : '';
      if (pv === 'movie' || pv === 'src' || pv === 'url' || pv === 'filename') {
        addValueEdit(attr, rewriteRef(cfg, base, decodeEntities(value)));
      }
    }
  }
}

function injectRuntimeTag(cfg, html, doc) {
  const tag = `<script src="${cfg.prefix}/runtime.js?v=1" data-vp-base="${escapeAttr(doc.href, '"')}" data-vp-prefix="${cfg.prefix}" data-vp-cookie="${cfg.cookieMode}" data-vp-ext="${cfg.external}"></script>`;
  const lower = html.toLowerCase();

  const headIdx = lower.indexOf('<head');
  if (headIdx >= 0) {
    const gt = html.indexOf('>', headIdx);
    if (gt >= 0) return html.slice(0, gt + 1) + tag + html.slice(gt + 1);
  }
  const htmlIdx = lower.indexOf('<html');
  if (htmlIdx >= 0) {
    const gt = html.indexOf('>', htmlIdx);
    if (gt >= 0) return html.slice(0, gt + 1) + tag + html.slice(gt + 1);
  }
  const doctype = /^<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length);
  return tag + html;
}

/**
 * 生成代理自身的错误/诊断页面（不经过上游重写）。
 */
export function renderNoticePage(cfg, { title, lines, status }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:dark light}
body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;background:#0b0d12;color:#e6e9ef}
.card{max-width:760px;margin:0 auto;background:#12151d;border:1px solid #242a38;border-radius:14px;padding:24px}
h1{font-size:18px;margin:0 0 4px;font-weight:600}
.status{color:#8b93a7;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:18px}
pre{background:#0a0c11;border:1px solid #1e2430;border-radius:10px;padding:14px;overflow:auto;font-size:13px;color:#c8cedd}
a{color:#7aa2ff}
</style></head><body><div class="card"><div class="status">${esc(status || 'vproxy')}</div>
<h1>${esc(title)}</h1><pre>${esc(lines.join('\n'))}</pre>
<p><a href="${cfg.prefix}/health">运行诊断</a></p></div></body></html>`;
}
