/**
 * 本地测试用的"上游站点"。
 *
 * 刻意把真实世界里最折磨代理的构造全部塞进来：
 * 相对/根相对/绝对 URL、srcset、inline style、@import、字体、
 * meta refresh、302、Cookie、POST 回显、Range 请求、字节流下载。
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export const FIXTURE_PAGES = {};

export function startUpstream(port = 4100) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const hostHeader = req.headers.host || `127.0.0.1:${port}`;

    const send = (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };

    if (p === '/' || p === '/index.html') {
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="preload" as="font" href="/assets/font.woff2" crossorigin>
<script src="/assets/app.js" integrity="sha384-xxx"></script>
<script>window.__ABS = "https://${hostHeader}/api/absolute";</script>
<style>.inline{background:url(/img/inline.png)}</style>
</head><body>
<a id="rel" href="sub/page.html">rel</a>
<a id="root" href="/sub/page.html">root</a>
<a id="abs" href="https://${hostHeader}/sub/page.html">abs</a>
<a id="cdn" href="https://cdn.example.net/x">cdn</a>
<img id="img" src="/img/logo.png">
<img id="srcset" srcset="/img/a.png 1x, /img/b.png 2x">
<div id="bg" style="background-image:url('../img/bg.png')"></div>
<form id="form" action="/submit" method="post"><input name="a" value="1"></form>
<iframe id="frame" src="/sub/frame.html"></iframe>
<iframe id="srcdoc" srcdoc="&lt;img src=&quot;/img/srcdoc.png&quot;&gt;"></iframe>
<meta http-equiv="refresh" content="5;url=/next">
</body></html>`;
      return send(200, { 'content-type': 'text/html; charset=utf-8' }, html);
    }

    if (p === '/base.html') {
      const html = `<!doctype html><html><head><base href="https://${hostHeader}/deep/"></head>
<body><a id="rel" href="page.html">rel</a><script src="x.js"></script></body></html>`;
      return send(200, { 'content-type': 'text/html' }, html);
    }

    if (p === '/charset.html') {
      // GBK 编码页面：代理必须解码后以 UTF-8 下发
      const gbk = Buffer.from([
        0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e,
        0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65,
        0x74, 0x3d, 0x67, 0x62, 0x6b, 0x3e, 0x3c, 0x2f, 0x68, 0x65, 0x61, 0x64,
        0x3e, 0x3c, 0x62, 0x6f, 0x64, 0x79, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f,
        0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e,
      ]);
      return send(200, { 'content-type': 'text/html' }, gbk);
    }

    if (p === '/assets/app.css') {
      const css = `@import "reset.css";
@import url('/assets/theme.css') screen;
body{background:url(../img/bg.png) no-repeat}
.hero{background-image:image-set("hero1.png" 1x, url("/assets/hero2.png") 2x)}
@font-face{font-family:X;src:local("Helvetica"),url(./font.woff2) format("woff2")}
.esc{content:"}` + `"no-rewrite-here"}` + `"}
/* url(/should/not/touch.png) */
`;
      return send(200, { 'content-type': 'text/css' }, css);
    }

    if (p === '/assets/app.js') {
      const js = `import { x } from "./mod.js";
const data = await fetch("/api/data");
const abs = "https://${hostHeader}/api/absolute";
const cdn = "https://cdn.example.net/lib.js";
const w = new Worker("/worker.js");
const u = new URL("/u", import.meta.url);
document.title = "a string with /path but not a url";
`;
      return send(200, { 'content-type': 'application/javascript' }, js);
    }

    if (p === '/importmap.html') {
      const html = `<!doctype html><html><head>
<script type="importmap">{"imports":{"lodash":"/vendor/lodash.js","x":"https://${hostHeader}/vendor/x.js"}}</script>
</head><body><script type="module">import _ from "lodash";</script></body></html>`;
      return send(200, { 'content-type': 'text/html' }, html);
    }

    if (p === '/img/logo.png' || p === '/img/bg.png' || p === '/img/a.png' || p === '/img/b.png') {
      return send(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=60' }, PNG);
    }

    if (p === '/api/data') {
      return send(200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, host: hostHeader }));
    }

    if (p === '/api/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        send(200, { 'content-type': 'application/json' }, JSON.stringify({
          method: req.method,
          url: req.url,
          origin: req.headers.origin || null,
          referer: req.headers.referer || null,
          cookie: req.headers.cookie || null,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      return;
    }

    if (p === '/set-cookie') {
      return send(200, {
        'content-type': 'text/plain',
        'set-cookie': 'sid=abc123; Path=/; HttpOnly; Domain=127.0.0.1',
      }, 'ok');
    }

    if (p === '/redirect') {
      return send(302, { location: '/target' }, '');
    }
    if (p === '/redirect-abs') {
      return send(301, { location: `http://${hostHeader}/target` }, '');
    }
    if (p === '/target') {
      return send(200, { 'content-type': 'text/html' }, `<html><body><img src="/img/logo.png"></body></html>`);
    }

    if (p === '/big.bin') {
      const buf = Buffer.alloc(1024 * 64, 7);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d+)?/.exec(range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : buf.length - 1;
        return send(206, {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${end}/${buf.length}`,
          'accept-ranges': 'bytes',
        }, buf.subarray(start, end + 1));
      }
      return send(200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' }, buf);
    }

    if (p === '/gzip.html') {
      const body = zlib.gzipSync(Buffer.from(
        '<!doctype html><html><body><a href="/gz/link.html">g</a></body></html>', 'utf8',
      ));
      return send(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }, body);
    }

    if (p === '/download.html') {
      return send(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': 'attachment; filename="page.html"',
      }, '<html><body><a href="/x.html">x</a></body></html>');
    }

    if (p === '/gbk.css') {
      // @charset "gbk" + GBK 编码注释；代理必须以 UTF-8 输出并改写 @charset
      const head = Buffer.from('@charset "gbk";\n/* ', 'latin1');
      const cn = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
      const tail = Buffer.from(' */\na{background:url(rel.png)}\n', 'latin1');
      return send(200, { 'content-type': 'text/css' }, Buffer.concat([head, cn, tail]));
    }

    if (p === '/csp.html') {
      return send(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'none'",
        'x-frame-options': 'DENY',
        'strict-transport-security': 'max-age=31536000',
        'cross-origin-opener-policy': 'same-origin',
      }, '<html><body>csp</body></html>');
    }

    return send(404, { 'content-type': 'text/html' }, '<html><body>404 not found</body></html>');
  });

  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has && protocols.has('p2') ? 'p2' : false),
  });

  wss.on('connection', (ws, req) => {
    const path = (req.url || '').split('?')[0];
    const echo = (data, isBinary) => { if (ws.readyState === 1) ws.send(data, { binary: isBinary }); };

    if (path === '/ws/echo') {
      ws.send(JSON.stringify({
        origin: req.headers.origin || null,
        cookie: req.headers.cookie || null,
        referer: req.headers.referer || null,
        path,
      }));
      ws.on('message', echo);
      return;
    }
    if (path === '/ws/proto') {
      ws.send('proto:' + (ws.protocol || ''));
      ws.on('message', echo);
      return;
    }
    ws.close(4404, 'unknown ws path');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
