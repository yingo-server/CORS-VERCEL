/**
 * CSS 重写器。
 *
 * 覆盖：url()、@import（字符串与 url() 两种写法）、image-set() 里的裸字符串、
 *       自定义属性里的 url()、data URI、转义序列、注释、字符串。
 * 关键点：CSS 里的相对路径是相对"样式表自身"解析的，不是相对文档。
 */

import { rewriteRef } from './url.js';

const IDENT = /[A-Za-z0-9_\-\u00a0-\uffff]/;

/** 这些函数内部的字符串/URL 语义不同，不能当 URL 改写。 */
const NON_URL_FUNCS = new Set(['local', 'format', 'counter', 'counters', 'attr', 'var', 'calc', 'min', 'max', 'clamp']);
/** 这些函数内部允许"裸字符串 URL"。 */
const STRING_URL_FUNCS = new Set(['image-set', '-webkit-image-set', 'cross-fade', '-webkit-cross-fade', 'image']);

export function rewriteCss(cfg, css, cssUrl) {
  if (typeof css !== 'string' || !css) return css;
  // 输出统一是 UTF-8，@charset 若继续声明原编码会让浏览器整表按错误编码解析
  if (/^\uFEFF?@charset/i.test(css)) {
    css = css.replace(/^\uFEFF?@charset\s+(['"])[^'"]*\1\s*;/i, '@charset "utf-8";');
  }
  const base = typeof cssUrl === 'string' ? new URL(cssUrl) : cssUrl;
  const out = [];
  const n = css.length;
  let i = 0;
  let last = 0;
  let edits = 0;
  const budget = cfg.rewrite.maxEdits || 50000;
  const stack = []; // 当前所在函数名

  const flush = (start, end, text) => {
    if (text === undefined) return;
    out.push(css.slice(last, start), text);
    last = end;
    edits++;
  };

  while (i < n && edits < budget) {
    const ch = css[i];

    // 注释
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }

    // 字符串
    if (ch === '"' || ch === "'") {
      const { value, end } = readString(css, i);
      const fn = stack[stack.length - 1];
      if (STRING_URL_FUNCS.has(fn)) {
        const rewritten = rewriteRef(cfg, base, value);
        if (rewritten !== value) {
          const quote = css[i];
          flush(i, end, quote + escapeCssString(rewritten, quote) + quote);
        }
      }
      i = end;
      continue;
    }

    // 标识符 / at-rule / 函数
    if (IDENT.test(ch) || ch === '-') {
      const start = i;
      while (i < n && (IDENT.test(css[i]) || css[i] === '\\')) {
        if (css[i] === '\\') i++;
        i++;
      }
      const word = css.slice(start, i);
      const lower = word.toLowerCase();

      // url( ... )
      if (lower === 'url' && css[i] === '(') {
        const r = readUrl(css, i, start);
        if (r) {
          const rewritten = rewriteRef(cfg, base, r.value);
          if (rewritten !== r.value) {
            const text = r.quoted
              ? escapeCssString(rewritten, css[r.valueStart - 1])
              : encodeCssUrlValue(rewritten);
            flush(r.valueStart, r.valueEnd, text);
          }
          i = r.end;
          continue;
        }
      }

      // @import "..." —— 字符串形式
      if (lower === 'import') {
        let j = i;
        while (j < n && /\s/.test(css[j])) j++;
        if (css[j] === '"' || css[j] === "'") {
          const { value, end } = readString(css, j);
          const rewritten = rewriteRef(cfg, base, value);
          if (rewritten !== value) {
            const quote = css[j];
            flush(j, end, quote + escapeCssString(rewritten, quote) + quote);
          }
          i = end;
          continue;
        }
        i = j;
        continue;
      }

      if (css[i] === '(') {
        stack.push(lower);
        i++;
        continue;
      }
      continue;
    }

    if (ch === ')') {
      stack.pop();
      i++;
      continue;
    }

    i++;
  }

  out.push(css.slice(last));
  return out.join('');
}

function readString(css, start) {
  const quote = css[start];
  let i = start + 1;
  let value = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '\\') {
      // 保留转义原样（浏览器自行解释）
      value += css.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    if (ch === '\n') return { value, end: i }; // 未闭合字符串：CSS 容错为行尾
    value += ch;
    i++;
  }
  return { value, end: css.length };
}

/** 读取 url(...) 内部值及其在源码中的区间。 */
function readUrl(css, parenIndex, funcStart) {
  let i = parenIndex + 1;
  const n = css.length;
  while (i < n && /\s/.test(css[i])) i++;
  if (i >= n) return null;

  if (css[i] === '"' || css[i] === "'") {
    const { value, end } = readString(css, i);
    let j = end;
    while (j < n && /\s/.test(css[j])) j++;
    if (css[j] !== ')') return null;
    return { value, valueStart: i + 1, valueEnd: end - 1, end: j + 1, quoted: true };
  }

  const start = i;
  while (i < n) {
    const ch = css[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === ')') break;
    i++;
  }
  return { value: css.slice(start, i).trim(), valueStart: start, valueEnd: i, end: i + 1, quoted: false };
}

function escapeCssString(value, quote) {
  let out = String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\a ');
  if (quote === '"') out = out.replace(/"/g, '\\"');
  else out = out.replace(/'/g, "\\'");
  return out;
}

function encodeCssUrlValue(value) {
  // url() 未加引号时的安全写法：包上双引号，杜绝空格/括号/引号破坏语法
  return '"' + escapeCssString(value, '"') + '"';
}
