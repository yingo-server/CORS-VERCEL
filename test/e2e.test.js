import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';

import { startUpstream } from '../dev/fixture.js';
import { startServer, closeServer, UPSTREAM_PORT, PROXY_PORT, UPSTREAM_ORIGIN } from './helpers.js';

const proxyModule = await import('../api/proxy.js');
const handler = proxyModule.handler;
const proxyServer = proxyModule.default;
const { b64uEncode, b64uDecode } = await import('../lib/url.js');
const { hostHash } = await import('../lib/cookies.js');

const BASE = `http://127.0.0.1:${PROXY_PORT}`;
let upstream;
let proxy;

before(async () => {
  upstream = await startUpstream(UPSTREAM_PORT);
  proxy = await startServer(PROXY_PORT, async (req, res) => {
    const original = req.url || '/';
    req.url = '/api/proxy' + (original.startsWith('/') ? original : '/' + original);
    try {
      await handler(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end('handler crash: ' + err.message);
    }
  });
  // 把升级请求也前缀化后交给代理服务器的 upgrade 监听器
  proxy.on('upgrade', (req, socket, head) => {
    const original = req.url || '/';
    req.url = '/api/proxy' + (original.startsWith('/') ? original : '/' + original);
    proxyServer.emit('upgrade', req, socket, head);
  });
});

after(async () => {
  await closeServer(proxy);
  await closeServer(upstream);
});

test('首页 HTML 全量改写', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html; charset=utf-8/);
  const html = await res.text();

  assert.match(html, /href="\/sub\/page\.html"/);                  // 相对与根相对都落到上游路径
  assert.match(html, /src="\/assets\/app\.js"/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/app\.css">/);
  assert.match(html, /\/__vp\/x\/[A-Za-z0-9_-]+/);                  // 跨源走编码通道
  assert.match(html, /srcset="\/img\/a\.png 1x, \/img\/b\.png 2x"/);
  assert.match(html, /background-image:url\('\/img\/bg\.png'\)/);
  assert.match(html, /<meta http-equiv="refresh" content="5;url=\/next">/);
  assert.match(html, /<script src="\/__vp\/runtime\.js/);
  assert.doesNotMatch(html, /integrity=/);
});

test('CSS 相对路径按样式表位置解析', async () => {
  const res = await fetch(BASE + '/assets/app.css');
  const css = await res.text();
  assert.match(css, /@import "\/assets\/reset\.css"/);
  assert.match(css, /background:url\("\/img\/bg\.png"\)/);
  assert.match(css, /url\("\/assets\/font\.woff2"\)/);
  assert.match(css, /local\("Helvetica"\)/);                        // local() 不动
  assert.match(css, /\/\* url\(\/should\/not\/touch\.png\) \*\//);   // 注释不动
});

test('JS 模块说明符与运行时地址', async () => {
  const res = await fetch(BASE + '/assets/app.js');
  const js = await res.text();
  assert.match(js, /from "\/assets\/mod\.js"/);
  assert.match(js, /const abs = "\/api\/absolute"/);
  assert.match(js, /"https:\/\/cdn\.example\.net\/lib\.js"/);        // 跨源字面量不动
  assert.match(js, /new Worker\("\/worker\.js"\)/);
});

test('重定向：Location 被改写成代理路径', async () => {
  const res = await fetch(BASE + '/redirect', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/target');

  const abs = await fetch(BASE + '/redirect-abs', { redirect: 'manual' });
  assert.equal(abs.headers.get('location'), '/target');
});

test('POST 透传：方法/请求体/Origin/Referer 全部还原', async () => {
  const res = await fetch(BASE + '/api/echo', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      referer: BASE + '/form.html?x=1',
    },
    body: JSON.stringify({ hello: 'world' }),
  });
  const data = await res.json();
  assert.equal(data.method, 'POST');
  assert.equal(data.body, '{"hello":"world"}');
  assert.equal(data.origin, UPSTREAM_ORIGIN);
  assert.equal(data.referer, UPSTREAM_ORIGIN + '/form.html?x=1');
});

test('Cookie：Set-Cookie 加前缀 + 去 Domain，回程还原', async () => {
  const res = await fetch(BASE + '/set-cookie');
  const raw = res.headers.getSetCookie?.() || [res.headers.get('set-cookie')];
  const cookie = raw[0];
  assert.match(cookie, /^__vp_[0-9a-f]{8}_sid=abc123/);
  assert.doesNotMatch(cookie, /Domain=/i);

  const name = /^([^=]+)=/.exec(cookie)[1];
  const echo = await fetch(BASE + '/api/echo', {
    headers: { cookie: `${name}=abc123; unrelated=1` },
  });
  const data = await echo.json();
  assert.equal(data.cookie, 'sid=abc123', '只转发属于该上游主机的 Cookie');
});

test('CSP / HSTS / XFO 等"把人赶出代理"的响应头被摘掉', async () => {
  const res = await fetch(BASE + '/csp.html');
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('strict-transport-security'), null);
  assert.equal(res.headers.get('cross-origin-opener-policy'), null);
});

test('非 UTF-8 页面：解码后以 UTF-8 输出，meta charset 同步', async () => {
  const res = await fetch(BASE + '/charset.html');
  assert.match(res.headers.get('content-type'), /charset=utf-8/);
  const html = await res.text();
  assert.match(html, /<meta charset="utf-8">/);
  assert.ok(html.includes('中文'), 'GBK 内容必须被正确解码');
});

test('Range 请求原样透传（视频/大文件拖拽依赖）', async () => {
  const res = await fetch(BASE + '/big.bin', { headers: { range: 'bytes=100-199' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 100-199/65536');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 100);
});

test('二进制资源不被改写，字节完全一致', async () => {
  const res = await fetch(BASE + '/img/logo.png');
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('HEAD 请求：有响应头、无响应体', async () => {
  const res = await fetch(BASE + '/assets/app.css', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
  const text = await res.text();
  assert.equal(text, '');
});

test('404 原样透传（附加代理标记）', async () => {
  const res = await fetch(BASE + '/nope');
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /404 not found/);
});

test('编码通道可访问任意主机', async () => {
  const target = `${UPSTREAM_ORIGIN}/api/data?q=1`;
  const res = await fetch(`${BASE}/__vp/x/${b64uEncode(target)}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test('编码通道拒绝非法目标（file://）', async () => {
  const res = await fetch(`${BASE}/__vp/x/${b64uEncode('file:///etc/passwd')}`);
  assert.equal(res.status, 400);
});

test('内部路由：运行时脚本与健康检查', async () => {
  const rt = await fetch(`${BASE}/__vp/runtime.js`);
  assert.match(rt.headers.get('content-type'), /javascript/);
  const code = await rt.text();
  assert.match(code, /__VPROXY__/);
  assert.doesNotThrow(() => new Function(code));   // 语法必须合法

  const health = await fetch(`${BASE}/__vp/health`);
  const data = await health.json();
  assert.equal(data.ok, true);
  assert.equal(data.target, UPSTREAM_ORIGIN);
});

test('gzip 压缩的 HTML 被正确解压并改写', async () => {
  const res = await fetch(BASE + '/gzip.html');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), null);
  const html = await res.text();
  assert.match(html, /href="\/gz\/link\.html"/);
  assert.match(html, /\/__vp\/runtime\.js/);
});

test('content-disposition: attachment 的文档不重写（保证下载字节一致）', async () => {
  const res = await fetch(BASE + '/download.html');
  const html = await res.text();
  assert.match(html, /<a href="\/x\.html">/, '原样透传');
  assert.equal(res.headers.get('x-vproxy-rewritten'), '0');
});

test('CSS @charset 归一为 utf-8', async () => {
  const res = await fetch(BASE + '/gbk.css');
  assert.match(res.headers.get('content-type'), /charset=utf-8/);
  const css = await res.text();
  assert.match(css, /^@charset "utf-8";/);
  assert.match(css, /\/\* 中文 \*\//);
  assert.match(css, /url\("\/rel\.png"\)/);
});

test('@import 与 importmap 页面', async () => {
  const res = await fetch(BASE + '/importmap.html');
  const html = await res.text();
  assert.match(html, /"lodash":"\/vendor\/lodash\.js"/);
});

test('编码通道的 b64 能被客户端运行时正确还原', () => {
  const url = 'https://cdn.example.net/a/b.js?v=1#x';
  assert.equal(b64uDecode(b64uEncode(url)), url);
});

/* ---------------- WebSocket ---------------- */

function wsOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

/** open 前就挂监听：上游欢迎消息可能在 open 事件派发前已到达。 */
function makeWsReader(ws, timeoutMs = 8000) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const w = waiters.shift();
    if (w) w.resolve({ data, isBinary });
    else queue.push({ data, isBinary });
  });
  return function read(timeout = timeoutMs) {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws message timeout')), timeout);
      waiters.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
      });
    });
  };
}

function wsMessage(ws, timeoutMs = 8000) {
  throw new Error('use makeWsReader');
}

test('WebSocket：文本/二进制回显，Origin/Cookie 还原为上游视角', async () => {
  const hash = hostHash(`127.0.0.1:${UPSTREAM_PORT}`);
  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws/echo`, {
    headers: { cookie: `__vp_${hash}_sid=abc123; other=1` },
  });
  ws.on('open', () => console.log('PROBE21 open'));
  ws.on('error', (e) => console.log('PROBE21 error:', e.message));
  ws.on('unexpected-response', (q,r) => console.log('PROBE21 unexpected', r.statusCode));
  const read = makeWsReader(ws);
  await wsOpen(ws);

  const info = JSON.parse((await read()).data.toString());
  assert.equal(info.origin, UPSTREAM_ORIGIN);
  assert.equal(info.cookie, 'sid=abc123', '只转发属于该主机的 Cookie');
  assert.equal(info.path, '/ws/echo');

  ws.send('hello');
  assert.equal((await read()).data.toString(), 'hello');

  const bin = Buffer.from([0, 1, 2, 250, 255]);
  ws.send(bin);
  const back = await read();
  assert.ok(Buffer.isBuffer(back.data), '二进制帧必须保持二进制');
  assert.ok(back.data.equals(bin));

  ws.close();
});

test('WebSocket：子协议协商透传', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws/proto`, ['p1', 'p2']);
  const read = makeWsReader(ws);
  await wsOpen(ws);
  assert.equal(ws.protocol, 'p2', '上游选定的子协议必须回传给浏览器');
  assert.equal((await read()).data.toString(), 'proto:p2');
  ws.close();
});

test('WebSocket：跨源编码通道', async () => {
  const target = `ws://127.0.0.1:${UPSTREAM_PORT}/ws/echo`;
  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/__vp/x/${b64uEncode(target)}`);
  const read = makeWsReader(ws);
  await wsOpen(ws);
  const info = JSON.parse((await read()).data.toString());
  assert.equal(info.origin, UPSTREAM_ORIGIN);
  ws.close();
});

/* ---------------- 路径指定目标 ---------------- */

test('路径覆盖：/http://host/path 切换目标，同源判定随之切换', async () => {
  const res = await fetch(BASE + '/http://127.0.0.1:' + UPSTREAM_PORT + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  // 资源应落到目标 host 的根路径（同源镜像），而不是编码通道
  assert.match(html, /href="\/assets\/app\.css"/);
  assert.match(html, /data-vp-base="http:\/\/127\.0\.0\.1:\d+\/"/);
});

test('路径覆盖：显式 http:// 协议形态', async () => {
  // 无协议形态默认 https（真实站点都是 https）；本地 fixture 是纯 http，走显式协议
  const res = await fetch(BASE + '/http://127.0.0.1:' + UPSTREAM_PORT + '/api/data');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test('路径覆盖：中继丢斜杠形态 /http:/host/path', async () => {
  const res = await fetch(BASE + '/http:/127.0.0.1:' + UPSTREAM_PORT + '/api/data');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test('普通页面路径不受路径覆盖影响（hostlike 正则不误判）', async () => {
  const res = await fetch(BASE + '/blog/post.html');
  assert.equal(res.status, 404); // 上游 fixture 没有这个页面，但绝不能被当成目标覆盖
  const res2 = await fetch(BASE + '/api/data');
  assert.equal(res2.status, 200);
});
