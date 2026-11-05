/**
 * Vercel 入口：所有请求的汇合点。
 *
 * 路由约定（见 vercel.json）：
 *   /                 -> /api/proxy/（根）
 *   /任意路径?查询    -> /api/proxy/任意路径?查询
 *   因此 req.url 里一定带着"浏览器原始 path+query"，这就是上游路径。
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { loadConfig, isBlockedPath, isBlockedHost } from '../lib/config.js';
import {
  resolveIncoming, buildUpstreamUrl, toProxyHref, isPrivateHost, b64uDecode,
} from '../lib/url.js';
import { buildUpstreamHeaders, buildDownstreamHeaders, mapBackToUpstream } from '../lib/headers.js';
import { fetchUpstream, readBodyCapped, UpstreamError } from '../lib/upstream.js';
import { parseContentType, classify, sniffHtmlCharset, sniffCssCharset, decodeBuffer, withUtf8 } from '../lib/content.js';
import { rewriteHtml, renderNoticePage } from '../lib/html.js';
import { rewriteCss } from '../lib/css.js';
import { rewriteJs } from '../lib/jsrewrite.js';
import { buildRuntimeScript } from '../lib/runtime/client.js';

export const config = { api: { bodyParser: false } };

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function send(res, status, headers, body) {
  res.statusCode = status;
  for (const [k, v] of headers) res.setHeader(k, v);
  if (body === undefined || body === null) {
    res.end();
    return;
  }
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  send(res, status, [
    ['content-type', 'application/json; charset=utf-8'],
    ['cache-control', 'no-store'],
    ['x-vproxy', '1'],
  ], body);
}

function sendNotice(cfg, res, status, title, lines, extraHeaders = []) {
  const body = renderNoticePage(cfg, { title, lines, status: `vproxy · HTTP ${status}` });
  send(res, status, [
    ['content-type', 'text/html; charset=utf-8'],
    ['cache-control', 'no-store'],
    ...extraHeaders,
  ], body);
}

/** 把上游响应头数组落到 res 上（set-cookie 可能多条）。 */
function applyHeaders(res, pairs) {
  const grouped = new Map();
  for (const [k, v] of pairs) {
    const key = k.toLowerCase();
    const list = grouped.get(key);
    if (list) list.push(v);
    else grouped.set(key, [v]);
  }
  for (const [k, list] of grouped) {
    try {
      res.setHeader(k, list.length === 1 ? list[0] : list);
    } catch {
      /* 非法头名直接跳过，不阻断响应 */
    }
  }
}

async function readRequestBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw new UpstreamError('请求体过大', { code: 'request_too_large', status: 413 });
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export default async function handler(req, res) {
  const started = Date.now();
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`配置错误：${err.message}`);
    return;
  }

  const method = (req.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    res.setHeader('allow', [...ALLOWED_METHODS].join(', '));
    sendNotice(cfg, res, 405, '不支持的请求方法', [`method: ${method}`]);
    return;
  }

  const routed = resolveIncoming(cfg, req.url);

  /* ---------------- 内部路由：运行时脚本 ---------------- */
  if (routed.kind === 'runtime') {
    const body = buildRuntimeScript();
    send(res, 200, [
      ['content-type', 'application/javascript; charset=utf-8'],
      ['cache-control', 'public, max-age=300, must-revalidate'],
      ['x-vproxy', '1'],
    ], body);
    return;
  }

  /* ---------------- 内部路由：诊断 ---------------- */
  if (routed.kind === 'health') {
    sendJson(res, 200, {
      ok: true,
      version: '1.0.0',
      target: cfg.target,
      receivedUrl: req.url,
      resolved: routed.kind,
      method,
      external: cfg.external,
      cookieMode: cfg.cookieMode,
      elapsedMs: Date.now() - started,
      headers: {
        host: req.headers.host,
        'x-forwarded-host': req.headers['x-forwarded-host'] || null,
      },
    });
    return;
  }

  /* ---------------- 计算上游 URL ---------------- */
  let upstreamUrl;
  if (routed.kind === 'encoded') {
    if (routed.error) {
      sendNotice(cfg, res, 400, '编码通道参数非法', [`reason: ${routed.error}`, `url: ${req.url}`]);
      return;
    }
    upstreamUrl = routed.upstream;
  } else {
    if (isBlockedPath(cfg, routed.rawPath)) {
      sendNotice(cfg, res, 403, '该路径被配置屏蔽', [`path: ${routed.rawPath}`]);
      return;
    }
    try {
      upstreamUrl = buildUpstreamUrl(cfg, routed.rawPath);
    } catch (err) {
      sendNotice(cfg, res, 400, '无法构造上游地址', [String(err.message), `path: ${routed.rawPath}`]);
      return;
    }
  }

  if (isBlockedHost(cfg, upstreamUrl.host)) {
    sendNotice(cfg, res, 403, '该主机被配置屏蔽', [`host: ${upstreamUrl.host}`]);
    return;
  }
  if (!cfg.allowPrivateHosts && isPrivateHost(upstreamUrl.hostname)) {
    sendNotice(cfg, res, 403, '拒绝访问内网地址', [`host: ${upstreamUrl.hostname}`]);
    return;
  }

  /* ---------------- 发起上游请求 ---------------- */
  const pageUrl = (() => {
    const ref = req.headers.referer || req.headers.referrer;
    const mapped = ref ? mapBackToUpstream(cfg, ref) : null;
    if (!mapped) return null;
    try {
      return new URL(mapped);
    } catch {
      return null;
    }
  })();

  let body;
  if (!BODYLESS.has(method)) {
    try {
      body = await readRequestBody(req, Math.min(cfg.upstream.maxBodyBytes, 4 * 1024 * 1024));
    } catch (err) {
      sendNotice(cfg, res, err.status || 413, '请求体读取失败', [err.message]);
      return;
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(cfg, req, upstreamUrl, pageUrl);

  let upstream;
  try {
    upstream = await fetchUpstream(cfg, upstreamUrl, { method, headers: upstreamHeaders, body });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    sendNotice(cfg, res, status, '上游请求失败', [
      `target: ${upstreamUrl.href}`,
      `code:  ${err.code || 'error'}`,
      `detail: ${err.message}`,
      cfg.debug ? `stack: ${(err.stack || '').split('\n').slice(0, 6).join('\n')}` : '',
    ].filter(Boolean), [['x-vproxy-error', err.code || 'error']]);
    return;
  }

  /* ---------------- 重定向：改写 Location 后原样返回 ---------------- */
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    const pairs = buildDownstreamHeaders(cfg, upstream.headers, {
      baseUrl: upstreamUrl,
      upstreamHost: upstreamUrl.host,
      rewritten: false,
      contentType: 'text/html',
    });
    if (location) {
      let abs;
      try {
        abs = new URL(location, upstreamUrl);
      } catch {
        abs = null;
      }
      if (abs && (abs.protocol === 'http:' || abs.protocol === 'https:')) {
        pairs.push(['location', toProxyHref(cfg, abs)]);
      } else {
        pairs.push(['location', location]);
      }
    }
    pairs.push(['cache-control', 'no-store']);
    await upstream.body?.cancel().catch(() => {});
    send(res, upstream.status, pairs, '');
    return;
  }

  /* ---------------- 判定是否需要改写 ---------------- */
  const contentTypeRaw = upstream.headers.get('content-type') || '';
  const { mime, charset } = parseContentType(contentTypeRaw);
  const kindName = classify(mime);

  const dest = String(req.headers['sec-fetch-dest'] || '');
  const disposition = String(upstream.headers.get('content-disposition') || '');
  const isDownload = /attachment/i.test(disposition);

  // 超大可改写文档：直接透传（宁可少改写，也不能把整页挡成 502）
  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  const tooLarge = declaredLength > (cfg.upstream.maxBodyBytes || 12 * 1024 * 1024);

  const wantsRewrite = (() => {
    if (!cfg.rewrite) return false;
    if (isDownload) return false;          // 下载文件必须字节一致，绝不能动
    if (tooLarge) return false;
    if (kindName === 'html') return cfg.rewrite.html;
    if (kindName === 'css') return cfg.rewrite.css;
    if (kindName === 'js') return cfg.rewrite.js;
    if (kindName === 'svg') return cfg.rewrite.svg;
    return false;
  })();

  const basePairs = (rewritten) => buildDownstreamHeaders(cfg, upstream.headers, {
    baseUrl: upstreamUrl,
    upstreamHost: upstreamUrl.host,
    rewritten,
    contentType: mime,
  });

  if (!wantsRewrite || method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
    const pairs = basePairs(false);
    if ((isDownload || tooLarge) && kindName !== 'binary') {
      pairs.push(['x-vproxy-rewritten', '0']);
    }
    applyHeaders(res, pairs);
    res.statusCode = upstream.status;
    if (!upstream.body || method === 'HEAD') {
      res.end();
      return;
    }
    res.flushHeaders?.();
    try {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      res.destroy();
    }
    return;
  }

  /* ---------------- 读取 -> 解码 -> 改写 -> 输出 ---------------- */
  let buffer;
  try {
    buffer = await readBodyCapped(upstream, cfg.upstream.maxBodyBytes);
  } catch (err) {
    sendNotice(cfg, res, err.status || 502, '上游响应读取失败', [err.message, `url: ${upstreamUrl.href}`]);
    return;
  }

  const sniffed = kindName === 'css' ? sniffCssCharset(buffer)
    : (kindName === 'html' || kindName === 'svg' ? sniffHtmlCharset(buffer) : '');
  const effectiveCharset = charset || sniffed || 'utf-8';
  let text = decodeBuffer(buffer, effectiveCharset);

  const responseUrl = upstream.url ? new URL(upstream.url) : upstreamUrl;
  try {
    if (kindName === 'html') {
      text = rewriteHtml(cfg, text, responseUrl, {});
    } else if (kindName === 'css') {
      text = rewriteCss(cfg, text, responseUrl);
    } else if (kindName === 'js') {
      text = rewriteJs(cfg, text, responseUrl, { module: mime !== 'application/javascript' && mime !== 'text/javascript' });
    } else if (kindName === 'svg') {
      text = rewriteHtml(cfg, text, responseUrl, { injectRuntime: dest === 'document' });
    }
  } catch (err) {
    // 改写失败必须可见：返回 500 而不是把半成品吐给浏览器
    sendNotice(cfg, res, 500, '内容改写失败',
      [`url: ${upstreamUrl.href}`, `mime: ${mime}`, `detail: ${err.message}`]
        .concat(cfg.debug ? [String(err.stack).split('\n').slice(0, 8).join('\n')] : []),
      [['x-vproxy-error', 'rewrite_failed']],
    );
    return;
  }

  const out = Buffer.from(text, 'utf8');
  const pairs = basePairs(true);
  for (const [k, v] of pairs) {
    if (k.toLowerCase() === 'content-type') {
      // 下面统一以 UTF-8 覆盖，见 withUtf8
      void v;
    }
  }
  const filtered = pairs.filter(([k]) => k.toLowerCase() !== 'content-type');
  filtered.push(['content-type', withUtf8(contentTypeRaw, mime)]);
  filtered.push(['content-length', String(out.length)]);
  applyHeaders(res, filtered);
  res.statusCode = upstream.status;
  res.end(out);
}
