// api/index.js
export default async function handler(req, res) {
  // ----- 1. CORS 全开 -----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ----- 2. 获取目标 URL -----
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  // ----- 3. 准备请求选项（透传方法、头、体） -----
  const fetchOptions = {
    method: req.method,
    headers: {
      // 透传大部分请求头，但过滤掉 host、connection 等
      ...Object.fromEntries(
        Object.entries(req.headers)
          .filter(([key]) => !['host', 'connection', 'content-length'].includes(key.toLowerCase()))
      ),
      // 确保 User-Agent 不太奇怪
      'User-Agent': 'CORS-Proxy/1.0',
    },
  };

  // 对于非 GET/HEAD 请求，需要读取请求体
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 读取原始请求体（Buffer）
    const bodyBuffer = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
    if (bodyBuffer.length > 0) {
      fetchOptions.body = bodyBuffer;
      // 如果请求头有 Content-Type，保留
      if (req.headers['content-type']) {
        fetchOptions.headers['Content-Type'] = req.headers['content-type'];
      }
    }
  }

  // ----- 4. 发起代理请求 -----
  try {
    const response = await fetch(targetUrl, fetchOptions);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';

    // ----- 5. 智能返回 -----
    if (/application\/json/.test(contentType)) {
      // JSON：直接透传
      try {
        const json = JSON.parse(buffer.toString('utf-8'));
        return res.status(response.status).json(json);
      } catch (_) {
        // 解析失败则当文本返回
        res.setHeader('Content-Type', 'text/plain');
        return res.status(response.status).send(buffer.toString('utf-8'));
      }
    } else if (/^(text\/|application\/xml|application\/javascript)/.test(contentType)) {
      // 文本类型：原样返回，保留 Content-Type
      res.setHeader('Content-Type', contentType);
      return res.status(response.status).send(buffer.toString('utf-8'));
    } else {
      // 二进制：返回 Data URL
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${contentType};base64,${base64}`;
      res.setHeader('Content-Type', 'text/plain');
      return res.status(response.status).send(dataUrl);
    }
  } catch (error) {
    console.error('代理错误:', error);
    return res.status(500).json({ error: error.message });
  }
}
