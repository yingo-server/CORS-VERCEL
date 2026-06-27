// api/[...path].js
export default async function handler(req, res) {
  // 允许所有跨域请求
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // 处理预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 提取目标 URL
  const pathArray = req.query.path || [];
  let targetUrl = pathArray.join('/');
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  // 可选：域名白名单（放开注释生效）
  // const allowed = ['github.com', 'gitee.com'];
  // if (!allowed.some(d => targetUrl.includes(d))) {
  //   return res.status(403).json({ error: 'Forbidden domain' });
  // }

  try {
    const response = await fetch(targetUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';

    // 智能区分返回格式
    if (/application\/json/.test(contentType)) {
      // JSON 直接透传
      try {
        const json = JSON.parse(buffer.toString('utf-8'));
        return res.status(200).json(json);
      } catch (_) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(buffer.toString('utf-8'));
      }
    } else if (/^(text\/|application\/xml|application\/javascript)/.test(contentType)) {
      // 其他文本原文返回
      res.setHeader('Content-Type', contentType);
      return res.status(200).send(buffer.toString('utf-8'));
    } else {
      // 二进制文件返回 Data URL
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${contentType};base64,${base64}`;
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(dataUrl);
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
