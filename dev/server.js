/**
 * 本地联调服务器：模拟 Vercel 的 "rewrite 到 /api/proxy/$1" 行为。
 * 用它可以在没有 Vercel 账号、没有编译的情况下验证整条链路。
 *
 *   npm run dev             # 默认 http://127.0.0.1:4200
 *   TARGET=https://example.com npm run dev
 */
import http from 'node:http';
import { startUpstream } from './fixture.js';
import handler from '../api/proxy.js';

const PROXY_PORT = Number(process.env.PROXY_PORT || 4200);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 4100);

await startUpstream(UPSTREAM_PORT);

const server = http.createServer(async (req, res) => {
  const original = req.url || '/';
  // 模拟 vercel.json: /:path -> /api/proxy/:path
  req.url = '/api/proxy' + (original.startsWith('/') ? original : '/' + original);
  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(`dev 服务器捕获异常: ${err.stack || err}`);
    } else {
      res.destroy();
    }
  }
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`\n  代理:     http://127.0.0.1:${PROXY_PORT}/`);
  console.log(`  上游站点: http://127.0.0.1:${UPSTREAM_PORT}/`);
  console.log(`  诊断:     http://127.0.0.1:${PROXY_PORT}/__vp/health\n`);
});
