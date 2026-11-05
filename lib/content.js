/**
 * 内容类型判定与字符集处理。
 *
 * 关键点：浏览器认 header 里的 charset，不认 meta。所以我们解码 -> 改写 -> 以 UTF-8 输出，
 * 并同步改写 content-type 与页面里的 <meta charset>。
 * 顺序搞反就会出现"中文变乱码 + 二次编码"。
 */

import iconv from 'iconv-lite';

const TEXTUAL = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
  'image/svg+xml',
]);

export function parseContentType(value) {
  const raw = String(value || '').trim();
  if (!raw) return { mime: '', charset: '' };
  const semi = raw.indexOf(';');
  const mime = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
  const rest = semi === -1 ? '' : raw.slice(semi + 1);
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(rest);
  return { mime, charset: m ? m[1].toLowerCase() : '' };
}

/** @returns {'html'|'css'|'js'|'svg'|'xml'|'binary'} */
export function classify(mime) {
  if (!mime) return 'binary';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'text/css') return 'css';
  if (mime === 'image/svg+xml') return 'svg';
  if (/^(text|application)\/(x-)?(java|ecma)script$/.test(mime)) return 'js';
  if (mime === 'application/xml' || mime === 'text/xml') return 'xml';
  return 'binary';
}

export function isTextual(mime) {
  return TEXTUAL.has(mime);
}

/** 从 HTML 前 4KB 里嗅探 <meta charset> / <?xml encoding?>。 */
export function sniffHtmlCharset(buffer) {
  if (!buffer || !buffer.length) return '';
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1');
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)/i.exec(head);
  if (m) return m[1].toLowerCase();
  m = /<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9_\-]+)["']/i.exec(head);
  if (m) return m[1].toLowerCase();
  return '';
}

/** CSS 的权威编码声明在文件头部的 @charset 里（前 1024 字节内）。 */
export function sniffCssCharset(buffer) {
  if (!buffer || !buffer.length) return '';
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1').replace(/^\u00ef\u00bb\u00bf/, '');
  const m = /^\s*@charset\s+"([^"]+)"/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}

const CHARSET_ALIASES = {
  utf8: 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  'unicode11utf8': 'utf-8',
  gb2312: 'gbk',
  gb_2312: 'gbk',
  'gb_2312-80': 'gbk',
  'x-gbk': 'gbk',
  gb18030: 'gb18030',
  'iso-8859-1': 'windows-1252',
  latin1: 'windows-1252',
  ascii: 'windows-1252',
  'us-ascii': 'windows-1252',
  'ks_c_5601-1987': 'euc-kr',
  'shift-jis': 'shift_jis',
  sjis: 'shift_jis',
  'x-sjis': 'shift_jis',
  'windows-31j': 'shift_jis',
  big5: 'big5',
  'big5-hkscs': 'big5',
};

export function normalizeCharset(label) {
  const l = String(label || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!l) return '';
  return CHARSET_ALIASES[l] || l;
}

function decoderSupports(label) {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解码字节流为字符串。
 *
 * 优先用平台 TextDecoder（Vercel 完整 ICU 覆盖全部编码）；
 * 平台缺 ICU（精简构建、部分容器镜像）时退到 iconv-lite 的纯 JS 表。
 * 两者都不认时才退回 UTF-8 —— 这是唯一会丢信息的路径，并且会被记录下来。
 */
export function decodeBuffer(buffer, charset) {
  const label = normalizeCharset(charset) || 'utf-8';
  if (label === 'utf-8' || label === 'utf8') {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
  if (decoderSupports(label)) {
    try {
      return new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(buffer);
    } catch { /* 继续尝试 iconv */ }
  }
  if (iconv.encodingExists(label)) {
    return iconv.decode(buffer, label);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

/** 报告某个 charset 是否可被无损解码（诊断用）。 */
export function canDecode(label) {
  const l = normalizeCharset(label);
  return decoderSupports(l) || iconv.encodingExists(l);
}

/** 输出为 UTF-8 时同步修补 content-type。 */
export function withUtf8(contentType, mime) {
  const base = String(contentType || mime || 'text/plain').split(';')[0].trim();
  return `${base}; charset=utf-8`;
}
