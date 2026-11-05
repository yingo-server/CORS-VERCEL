/**
 * URL 映射层：浏览器可见 URL <-> 上游真实 URL。
 *
 * 映射规则（target 模式）：
 *   上游 https://example.com/a/b.css?x=1
 *   浏览器 /a/b.css?x=1
 *   —— 根路径 1:1 镜像，所以页面里任何相对路径、根路径天然就是对的。
 *
 * 例外映射（跨源，或无法用根路径表达的同源 URL）：
 *   浏览器 {prefix}/x/{base64url(绝对URL)}
 */
import { isBlockedHost } from './config.js';

const HTTP_LIKE = /^https?:\/\//i;

/** 这些 scheme 交给浏览器原生处理，代理绝不改写。 */
const KEEP_SCHEME = /^(?:data|blob|javascript|mailto|tel|sms|callto|fax|about|chrome|chrome-extension|moz-extension|ms-browser-extension|view-source|file|magnet|bitcoin|intent|android-app|ios-app|webcal|ftp|ipp|market|fb|whatsapp|tg|skype|zoommtg|slack|discord|spotify|steam|itms-apps|itms-services):/i;

export function b64uEncode(str) {
  return Buffer.from(String(str), 'utf8').toString('base64url');
}

export function b64uDecode(str) {
  try {
    // base64url 解码：Node 支持 'base64url'，非法输入会抛出
    return Buffer.from(String(str), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function isHttpLike(value) {
  return HTTP_LIKE.test(value);
}

export function isKeepScheme(value) {
  return KEEP_SCHEME.test(value);
}

/**
 * 把绝对 URL 转成浏览器可见的代理 URL。
 * 同源（target host）走根路径镜像，其余走 /x/ 编码通道。
 */
export function toProxyHref(cfg, abs) {
  if (abs.host === cfg.targetHost) {
    const p = abs.pathname || '/';
    // 以 // 开头的 pathname 会被浏览器当成 protocol-relative，必须走编码通道
    if (p.startsWith('//')) return `${cfg.prefix}/x/${b64uEncode(abs.href)}`;
    return p + abs.search + abs.hash;
  }
  if (cfg.external === 'direct') return abs.href;
  return `${cfg.prefix}/x/${b64uEncode(abs.href)}`;
}

/**
 * 核心：把一段引用值（href/src/url()/import 说明符…）改写为代理形式。
 *
 * 严格保持"无法解析就原样返回"，绝不把未知值改坏。
 *
 * @param {object} cfg
 * @param {string|URL} base 解析相对路径的基准（文档 URL 或 CSS/JS 文件 URL）
 * @param {string} raw 原始引用值
 * @param {{fromAttr?: boolean}} [opts]
 */
export function rewriteRef(cfg, base, raw, opts = {}) {
  if (typeof raw !== 'string') return raw;
  const value = raw.trim();
  if (!value) return raw;
  if (value[0] === '#') return raw;               // 纯锚点
  if (isKeepScheme(value)) return raw;            // data:/blob:/javascript: …
  if (value.startsWith('?') || value.startsWith('.')) {
    // 相对引用：仍然需要解析（. 可能越出到别的 host 是不可能的，但 '//' 除外）
    if (!value.startsWith('//')) {
      let abs;
      try {
        abs = new URL(value, base);
      } catch {
        return raw;
      }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return raw;
      return toProxyHref(cfg, abs);
    }
  }

  let abs;
  try {
    abs = new URL(value, base);
  } catch {
    return raw;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return raw;
  if (!abs.host) return raw;
  if (isBlockedHost(cfg, abs.host)) return raw;

  if (cfg.external === 'direct' && abs.host !== cfg.targetHost) return raw;
  return toProxyHref(cfg, abs);
}

/**
 * 解析入站请求 -> 上游目标。
 *
 * @param {object} cfg
 * @param {string} rawUrl Node 的 req.url（原始、未归一化，保留 %XX 与查询串）
 * @returns {{kind:'page'|'encoded'|'runtime'|'health', upstream?: URL, error?: string, rawPath?: string}}
 */
export function resolveIncoming(cfg, rawUrl) {
  let u = rawUrl || '/';
  if (!u.startsWith('/')) {
    // 极端情况下可能是绝对形式（Vercel 内部转发），只取 path+query
    try {
      const parsed = new URL(u);
      u = parsed.pathname + parsed.search;
    } catch {
      u = '/' + u;
    }
  }

  // Vercel rewrite 会把前缀挂上来；直接命中 /api/proxy 也兼容
  if (u === '/api/proxy' || u.startsWith('/api/proxy/')) {
    u = u.slice('/api/proxy'.length) || '/';
    if (u[0] !== '/') u = '/' + u;
  }

  if (u === cfg.prefix || u.startsWith(cfg.prefix + '/')) {
    const rest = u.slice(cfg.prefix.length);
    if (rest === '/' || rest === '' || rest.startsWith('/?')) {
      return { kind: 'health' };
    }
    if (rest === '/runtime.js' || rest.startsWith('/runtime.js?')) {
      return { kind: 'runtime' };
    }
    if (rest === '/health' || rest.startsWith('/health?')) {
      return { kind: 'health' };
    }
    const m = /^\/x\/([A-Za-z0-9_-]+)$/.exec(rest.split('?')[0]);
    if (m) {
      const decoded = b64uDecode(m[1]);
      if (!decoded) return { kind: 'encoded', error: 'bad_base64' };
      let abs;
      try {
        abs = new URL(decoded);
      } catch {
        return { kind: 'encoded', error: 'bad_url' };
      }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') {
        return { kind: 'encoded', error: 'bad_scheme' };
      }
      return { kind: 'encoded', upstream: abs };
    }
    // 未知内部路由：落到上游（上游可能真有同名目录）
  }

  return { kind: 'page', rawPath: u };
}

/** 把浏览器路径拼成上游绝对 URL（保留原始查询串与百分号编码）。 */
export function buildUpstreamUrl(cfg, rawPath) {
  const q = rawPath.indexOf('?');
  const pathPart = q === -1 ? rawPath : rawPath.slice(0, q);
  const search = q === -1 ? '' : rawPath.slice(q);
  const base = cfg.targetOrigin;
  const cleanPath = pathPart === '/' ? '/' : pathPart;
  return new URL(base + cleanPath + search);
}

/** 内网/元数据地址判定（SSRF 兜底）。 */
const PRIVATE_V4 = [
  [/^10\./, ''],
  [/^127\./, ''],
  [/^169\.254\./, ''],
  [/^192\.168\./, ''],
  [/^172\.(1[6-9]|2\d|3[01])\./, ''],
  [/^0\./, ''],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, ''],
  [/^198\.1[89]\./, ''],
];

export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;           // fc00::/7
  if (/^fe80:/.test(h)) return true;                         // link-local
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    for (const [re] of PRIVATE_V4) if (re.test(h)) return true;
    return false;
  }
  // 纯数字/十六进制等非标准写法一律拒绝，避免绕过
  if (!h.includes('.') && !h.includes(':')) return true;
  return false;
}
