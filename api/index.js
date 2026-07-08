// api/index.js
import { URL } from 'url';

// ========== 可配置常量 ==========
const VERCELL_MAX_PAYLOAD = 4.5 * 1024 * 1024;   // Vercel 平台响应体硬上限 (4.5 MB)
const HEADER_RESERVE = 200 * 1024;               // 预留空间给响应头及错误信息 (200 KB)
const REQUEST_TIMEOUT = 10000;                   // 请求超时时间 (毫秒)
const ALLOWED_ORIGINS = ['*'];                  // CORS 白名单，可替换为具体域名数组

// 不同返回模式下的安全上限（确保最终响应体不超平台限制）
const LIMITS = {
  raw: Math.floor(VERCELL_MAX_PAYLOAD - HEADER_RESERVE),                         // ≈ 4.3 MB
  dataurl: Math.floor((VERCELL_MAX_PAYLOAD - HEADER_RESERVE) * 0.75),           // ≈ 3.22 MB (Base64 膨胀 4/3)
};

// ========== SSRF 防护：内网 IPv4 黑名单 ==========
const PRIVATE_IP_RANGES = [
  { start: '127.0.0.0', end: '127.255.255.255' },
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
  { start: '169.254.0.0', end: '169.254.255.255' },
];

function ipToNumber(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIP(hostname) {
  // 仅当 hostname 是 IPv4 字面量时检查，域名不做解析以避免延迟和复杂性
  const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!isIP) return false;
  const ipNum = ipToNumber(hostname);
  for (const range of PRIVATE_IP_RANGES) {
    const start = ipToNumber(range.start);
    const end = ipToNumber(range.end);
    if (ipNum >= start && ipNum <= end) return true;
  }
  return false;
}

function isSafeUrl(urlString) {
  try {
    const url = new URL(urlString);
    // 只允许 http/https 协议
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    // 禁止访问内网 IP
    if (isPrivateIP(url.hostname)) return false;
    // 可选：增加域名白名单检查 (通过 ALLOWED_HOSTS 数组)
    // if (!ALLOWED_HOSTS.includes(url.hostname)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// ========== 主处理函数 ==========
export default async function handler(req, res) {
  // ----- 1. CORS 处理 -----
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Cache-Control, Expires, ETag, Last-Modified');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ----- 2. 解析参数与安全校验 -----
  const { url, format = 'dataurl' } = req.query;  // 默认旧行为 dataurl
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  if (!isSafeUrl(targetUrl)) {
    return res.status(403).json({ error: 'Forbidden URL' });
  }

  // ----- 3. 读取请求体（仅非 GET/HEAD，并限制大小） -----
  let bodyBuffer = Buffer.alloc(0);
  if (!['GET', 'HEAD'].includes(req.method)) {
    try {
      bodyBuffer = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.raw) {  // 请求体使用较宽松限制
            req.destroy();
            reject(new Error('Request body too large'));
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
    } catch (_) {
      return res.status(413).json({ error: 'Request body too large' });
    }
  }

  // ----- 4. 发起代理请求（带超时） -----
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders['host'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['content-length'];

    const fetchOptions = {
      method: req.method || 'GET',
      headers: forwardHeaders,
      signal: controller.signal,
    };
    if (bodyBuffer.length > 0 && !['GET', 'HEAD'].includes(req.method)) {
      fetchOptions.body = bodyBuffer;
    }

    // ----- 4a. HEAD 预检（提前拦截大文件） -----
    let contentLength = null;
    try {
      const headRes = await fetch(targetUrl, {
        method: 'HEAD',
        headers: forwardHeaders,
        signal: controller.signal,
      });
      if (headRes.ok) {
        const len = headRes.headers.get('content-length');
        if (len) contentLength = parseInt(len, 10);
      }
    } catch (_) { /* HEAD 失败则忽略，后续会再次检查 */ }

    const mode = (format === 'raw') ? 'raw' : 'dataurl';
    const maxSize = LIMITS[mode];

    if (contentLength !== null && contentLength > maxSize) {
      clearTimeout(timeout);
      return res.status(413).json({
        error: 'Response too large (HEAD)',
        message: `目标文件大小 ${contentLength} 字节超过 ${mode} 模式上限 (${maxSize} 字节)`,
        mode,
        limit: maxSize,
      });
    }

    // ----- 4b. 正式请求 -----
    const response = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeout);

    const responseBuffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const finalSize = responseBuffer.length;

    // 二次检查，防止 HEAD 长度不准确
    if (finalSize > maxSize) {
      return res.status(413).json({
        error: 'Response too large',
        message: `实际响应大小 ${finalSize} 字节超过 ${mode} 模式上限 (${maxSize} 字节)`,
        mode,
        limit: maxSize,
      });
    }

    // ----- 5. 透传关键响应头 -----
    res.status(response.status);
    const headersToForward = [
      'location', 'content-disposition', 'cache-control',
      'expires', 'etag', 'last-modified', 'accept-ranges',
      'content-range', 'content-encoding', 'vary'
    ];
    for (const h of headersToForward) {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    // ----- 6. 智能返回（向下兼容） -----
    const isText = /^(text\/|application\/json|application\/xml|application\/javascript)/.test(contentType);

    if (isText) {
      // 文本类型始终返回 UTF-8 字符串（可改进编码检测）
      res.setHeader('Content-Type', contentType);
      return res.status(response.status).send(responseBuffer.toString('utf-8'));
    } else {
      // 二进制类型
      if (format === 'raw') {
        // 新功能：返回原始二进制
        res.setHeader('Content-Type', contentType);
        return res.status(response.status).send(responseBuffer);
      } else {
        // 旧行为（默认）：返回 Data URL
        const base64 = responseBuffer.toString('base64');
        const dataUrl = `data:${contentType};base64,${base64}`;
        // 保险检查（理论上不会触发）
        if (dataUrl.length > VERCELL_MAX_PAYLOAD) {
          return res.status(413).json({
            error: 'Response too large (DataURL)',
            message: `Base64 编码后大小 ${dataUrl.length} 字节超过平台限制 (${VERCELL_MAX_PAYLOAD})`,
          });
        }
        res.setHeader('Content-Type', 'text/plain');
        return res.status(response.status).send(dataUrl);
      }
    }
  } catch (error) {
    clearTimeout(timeout);
    // ----- 7. 错误分类处理 -----
    let statusCode = 500;
    let errorMessage = error.message;
    if (error.name === 'AbortError') {
      statusCode = 504;
      errorMessage = '请求目标服务器超时';
    } else if (error.code === 'ENOTFOUND' || error.message.includes('DNS')) {
      statusCode = 502;
      errorMessage = '目标域名无法解析';
    } else if (error.message.includes('fetch')) {
      statusCode = 502;
      errorMessage = '连接目标服务器失败';
    }
    return res.status(statusCode).json({
      error: 'Proxy fetch error',
      message: errorMessage,
      code: error.name || 'UNKNOWN',
    });
  }
}
