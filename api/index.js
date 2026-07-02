// api/index.js
export default async function handler(req, res) {
  // 1. 全开 CORS（应对预检和跨域）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  
  // 2. 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. 获取目标 URL（从查询参数中提取）
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    // 4. 收集请求体（支持 POST/PUT 等）
    const bodyBuffer = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // 5. 构建转发请求头（剔除 Host、Connection 等平台级头，保留业务头）
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders['host'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['content-length']; // 交由 fetch 自动计算
    // 如果原始请求有 body 但未指定 Content-Type，可保留原样

    // 6. 发起完整转发的 fetch 请求
    const fetchOptions = {
      method: req.method, // 透传原始请求方法（GET/POST/PUT/DELETE 等）
      headers: forwardHeaders,
    };
    if (bodyBuffer.length > 0) {
      fetchOptions.body = bodyBuffer;
    }

    const response = await fetch(targetUrl, fetchOptions);
    const responseBuffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';

    // 7. 智能返回格式（与之前逻辑一致，但增加了对状态码的透传）
    res.status(response.status);

    // 透传部分重要的响应头（如 Location、Content-Disposition）
    const location = response.headers.get('location');
    if (location) res.setHeader('Location', location);
    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

    // 判断返回类型
    if (/application\/json/.test(contentType)) {
      // JSON 直接透传
      try {
        const json = JSON.parse(responseBuffer.toString('utf-8'));
        return res.status(response.status).json(json);
      } catch (_) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(response.status).send(responseBuffer.toString('utf-8'));
      }
    } else if (/^(text\/|application\/xml|application\/javascript)/.test(contentType)) {
      // 其他文本原文返回
      res.setHeader('Content-Type', contentType);
      return res.status(response.status).send(responseBuffer.toString('utf-8'));
    } else {
      // 二进制文件返回 Data URL
      const base64 = responseBuffer.toString('base64');
      const dataUrl = `data:${contentType};base64,${base64}`;
      res.setHeader('Content-Type', 'text/plain');
      return res.status(response.status).send(dataUrl);
    }
  } catch (error) {
    return res.status(500).json({ error: 'Proxy fetch failed', message: error.message });
  }
}
