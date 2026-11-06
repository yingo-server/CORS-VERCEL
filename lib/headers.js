/**
 * 请求头 / 响应头的清洗与改写。
 *
 * 原则：
 *  - 逐跳头（RFC 7230 6.1）双向丢弃。
 *  - 上游看到的是"以它自己身份发出"的请求（Host/Origin/Referer 全部还原）。
 *  - 浏览器看到的响应里，一切会把浏览器赶出代理的头部（CSP/HSTS/XFO/Reporting…）都摘掉。
 */
import { rewriteRef, toProxyHref } from './url.js';
import { rewriteSetCookie, filterRequestCookies } from './cookies.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const DROP_REQUEST = new Set([
  ...HOP_BY_HOP,
  // 仅这四个是"协议层面必须由代理自己控制"的：改了它们请求就发不出去或语义错乱
  'host', 'content-length', 'accept-encoding',
  // Vercel 平台内部头：透传给上游没意义且可能触发上游风控
  'x-vercel-id', 'x-vercel-proxy-signature', 'x-vercel-proxy-signature-ts',
  'x-vercel-deployment-url', 'x-vercel-sc-headers', 'x-vercel-sc-host',
  // 其余全部原样放行：x-forwarded-* / x-real-ip / cf-* / x-vercel-ip-* 等
  // 按用户要求不做任何安全过滤 —— 上游想看什么就让它看什么。
]);

/**
 * 响应头：只摘"协议上必须由代理自己控制"的，其余全部放行。
 * CSP/XFO/HSTS 等是否摘除由 stripSecurityHeaders 配置决定（默认摘，
 * 设为 false 则全部透传 —— 用户要求"不做任何限制"时可关）。
 */
const DROP_RESPONSE_ALWAYS = new Set([
  ...HOP_BY_HOP,
  'content-length',          // 由代理按实际输出重算
  'content-encoding',        // 已解压
  'location',                // 单独改写
  'set-cookie',              // 单独处理（多条）
]);

/** stripSecurityHeaders=true 时额外摘除的。 */
const DROP_RESPONSE_SECURITY = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy',
  'permissions-policy', 'feature-policy', 'clear-site-data',
  'report-to', 'reporting-endpoints', 'nel', 'origin-agent-cluster',
  'public-key-pins', 'expect-ct', 'x-permitted-cross-domain-policies',
  'x-content-security-policy', 'x-webkit-csp',
]);

function first(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 构造发往上游的请求头。
 * @param {object} cfg
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} upstreamUrl
 * @param {URL|null} pageUrl 浏览器当前页面在"上游视角"下的地址（用于 Referer 还原）
 */
export function buildUpstreamHeaders(cfg, req, upstreamUrl, pageUrl) {
  const out = new Headers();
  const raw = req.headers || {};

  for (const [key, value] of Object.entries(raw)) {
    const k = key.toLowerCase();
    if (DROP_REQUEST.has(k)) continue;
    if (k === 'cookie' || k === 'referer' || k === 'origin') continue; // 单独处理
    if (k.startsWith('x-vercel-')) continue;
    if (value === undefined) continue;
    try {
      if (Array.isArray(value)) out.set(k, value.join(', '));
      else out.set(k, String(value));
    } catch {
      /* 非法头直接跳过，不让单个畸形头炸掉整请求 */
    }
  }

  // 自定义上游头（配置优先，用于需要固定 token 的站点）
  for (const [k, v] of Object.entries(cfg.upstream.headers || {})) {
    out.set(k.toLowerCase(), String(v));
  }

  const ua = cfg.upstream.userAgent || first(raw['user-agent']);
  if (ua) out.set('user-agent', ua);

  out.set('host', upstreamUrl.host);

  // Referer / Origin 还原成上游视角
  const reqOrigin = first(raw['origin']);
  const reqReferer = first(raw['referer']);
  if (reqReferer) {
    const mapped = mapBackToUpstream(cfg, reqReferer);
    if (mapped) out.set('referer', mapped);
  } else if (pageUrl) {
    out.set('referer', pageUrl.href);
  }
  if (reqOrigin) {
    const mapped = mapBackToUpstream(cfg, reqOrigin);
    if (mapped) out.set('origin', mapped.replace(/\/$/, ''));
  }

  const cookie = filterCookiesFor(cfg, raw.cookie, upstreamUrl.host);
  if (cookie) out.set('cookie', cookie);

  // 不手工设置 accept-encoding：交给 undici 自己协商，它才会替我们解压。
  // 手工设了就等于关闭自动解码，拿到的会是 gzip 字节流，改写必然写坏。

  return out;
}

/** 浏览器侧的代理 URL -> 上游绝对 URL 字符串。 */
export function mapBackToUpstream(cfg, value) {
  if (typeof value !== 'string' || !value) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  // 通过 /x/<b64> 通道的
  const idx = u.pathname.indexOf(cfg.prefix + '/x/');
  if (idx === 0) {
    const b64 = u.pathname.slice((cfg.prefix + '/x/').length);
    try {
      return Buffer.from(b64, 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }
  // 同源镜像：保留原 path+query，配上上游 origin
  return cfg.targetOrigin + u.pathname + u.search;
}

function filterCookiesFor(cfg, header, host) {
  if (!header) return '';
  const value = Array.isArray(header) ? header.join('; ') : String(header);
  return filterRequestCookies(cfg, value, host);
}

/**
 * 构造返回给浏览器的响应头。
 * @returns {Array<[string,string]>}
 */
export function buildDownstreamHeaders(cfg, upstreamHeaders, ctx) {
  const out = [];
  const seen = new Set();
  const dropResponse = cfg.stripSecurityHeaders === false
    ? DROP_RESPONSE_ALWAYS
    : new Set([...DROP_RESPONSE_ALWAYS, ...DROP_RESPONSE_SECURITY]);

  const push = (k, v) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push([k, v]);
  };

  for (const [rawKey, rawValue] of upstreamHeaders.entries()) {
    const k = rawKey.toLowerCase();
    if (dropResponse.has(k)) continue;
    if (k === 'set-cookie') continue;      // 单独处理（可能多条）
    if (k === 'location') continue;
    if (k === 'link') { push('link', rewriteLinkHeader(cfg, rawValue, ctx.baseUrl)); continue; }
    if (k === 'refresh') { push('refresh', rewriteRefreshHeader(cfg, rawValue, ctx.baseUrl)); continue; }
    if (k === 'content-type') { push('content-type', rawValue); continue; }
    if (k === 'cache-control') { push('cache-control', scopeCacheControl(rawValue, ctx)); continue; }
    push(k, rawValue);
  }

  const setCookies = typeof upstreamHeaders.getSetCookie === 'function'
    ? upstreamHeaders.getSetCookie()
    : [];
  for (const sc of setCookies) {
    const rewritten = rewriteSetCookie(cfg, sc, ctx.upstreamHost);
    if (rewritten) out.push(['set-cookie', rewritten]);
  }

  seth('x-vproxy', '1');
  function seth(k, v) { if (!seen.has(k)) { seen.add(k); out.push([k, v]); } }

  return out;
}

function scopeCacheControl(value, ctx) {
  const v = String(value || '');
  if (!ctx.rewritten) return v;
  // 改写后的 HTML 与 Cookie 相关，禁止共享缓存把 A 用户的响应喂给 B 用户
  if (/\bhtml\b/i.test(ctx.contentType || '')) {
    return 'private, max-age=0, must-revalidate';
  }
  return v;
}

function rewriteLinkHeader(cfg, value, base) {
  return String(value).replace(/<([^>]*)>/g, (m, url) => {
    const out = rewriteRef(cfg, base, url);
    return `<${out}>`;
  });
}

function rewriteRefreshHeader(cfg, value, base) {
  return String(value).replace(/(url\s*=\s*)(.*)$/i, (m, pre, url) => {
    const trimmed = url.trim().replace(/^['"]|['"]$/g, '');
    return pre + rewriteRef(cfg, base, trimmed);
  });
}

export { toProxyHref };
