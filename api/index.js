export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 从查询参数获取目标 URL
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const response = await fetch(targetUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';

    if (/application\/json/.test(contentType)) {
      try {
        const json = JSON.parse(buffer.toString('utf-8'));
        return res.status(200).json(json);
      } catch (_) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(buffer.toString('utf-8'));
      }
    } else if (/^(text\/|application\/xml|application\/javascript)/.test(contentType)) {
      res.setHeader('Content-Type', contentType);
      return res.status(200).send(buffer.toString('utf-8'));
    } else {
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${contentType};base64,${base64}`;
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(dataUrl);
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
