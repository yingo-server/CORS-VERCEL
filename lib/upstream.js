/**
 * 上游请求层。
 *
 * 只做三件事：发请求、错误归一、体积上限。
 * 重定向默认不跟随——3xx 原样交还浏览器（改写 Location），
 * 这样浏览器地址栏、Cookie、后续相对路径解析都保持一致。
 */

import { isPrivateHost } from './url.js';

export class UpstreamError extends Error {
  constructor(message, { code = 'upstream_error', status = 502, cause = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

const RETRYABLE = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ENOTFOUND']);

function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code || '';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new UpstreamError(`无法解析上游域名：${err?.cause?.hostname || ''}`.trim(), {
      code: 'dns_error', status: 502, cause: err,
    });
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new UpstreamError('上游响应超时', { code: 'timeout', status: 504, cause: err });
  }
  if (code === 'ECONNREFUSED') {
    return new UpstreamError('上游拒绝连接', { code: 'conn_refused', status: 502, cause: err });
  }
  if (code.startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new UpstreamError(`上游 TLS 证书校验失败（${code}）`, { code: 'tls_error', status: 502, cause: err });
  }
  if (err?.name === 'AbortError') {
    return new UpstreamError('上游响应超时', { code: 'timeout', status: 504, cause: err });
  }
  return new UpstreamError(`上游请求失败：${err?.message || err}`, { code: 'network_error', status: 502, cause: err });
}

/**
 * @param {object} cfg
 * @param {URL} url
 * @param {{method:string, headers:Headers, body?:any}} init
 * @returns {Promise<Response>}
 */
export async function fetchUpstream(cfg, url, init) {
  if (!cfg.allowPrivateHosts && isPrivateHost(url.hostname)) {
    throw new UpstreamError(`拒绝访问内网地址：${url.hostname}（如需放开把配置 allowPrivateHosts 设为 true）`, {
      code: 'blocked_private', status: 403,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.upstream.timeoutMs || 25000);

  const request = () => fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: cfg.upstream.followRedirects ? 'follow' : 'manual',
    signal: controller.signal,
    // 不依赖 Vercel 的 fetch 缓存，语义必须由我们控制
    cache: 'no-store',
    duotone: undefined,
  });

  try {
    let res;
    try {
      res = await request();
    } catch (err) {
      const code = err?.cause?.code || err?.code || '';
      if (RETRYABLE.has(code)) {
        res = await request(); // 幂等重试一次；非幂等方法不重试由调用方保证（见 api/proxy.js）
      } else {
        throw err;
      }
    }
    return res;
  } catch (err) {
    throw classifyNetworkError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** 读取完整 body，超过上限直接抛错（不静默截断）。 */
export async function readBodyCapped(response, maxBytes) {
  const limit = maxBytes || 12 * 1024 * 1024;
  const lenHeader = Number(response.headers.get('content-length') || 0);
  if (lenHeader && lenHeader > limit) {
    throw new UpstreamError(`响应体过大（${lenHeader} 字节，上限 ${limit}）`, { code: 'too_large', status: 502 });
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new UpstreamError(`响应体过大（超过 ${limit} 字节上限）`, { code: 'too_large', status: 502 });
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}
