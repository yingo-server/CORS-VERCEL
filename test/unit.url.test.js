import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rewriteRef, toProxyHref, resolveIncoming, buildUpstreamUrl, isPrivateHost, b64uEncode, b64uDecode } =
  await import('../lib/url.js');
const { cfg } = await import('./helpers.js');

const doc = new URL('http://127.0.0.1:4517/dir/page.html');
const P = cfg.prefix;

test('同主机绝对 URL -> 根路径镜像', () => {
  assert.equal(rewriteRef(cfg, doc, 'http://127.0.0.1:4517/a/b.js?v=1#x'), '/a/b.js?v=1#x');
});

test('根相对 / 相对 路径', () => {
  assert.equal(rewriteRef(cfg, doc, '/x/y.css'), '/x/y.css');
  assert.equal(rewriteRef(cfg, doc, '../up.png'), '/up.png');
  assert.equal(rewriteRef(cfg, doc, './same.png'), '/dir/same.png');
  assert.equal(rewriteRef(cfg, doc, 'plain.png'), '/dir/plain.png');
});

test('跨源 -> 可读路径覆盖形态', () => {
  // 跨源不再编码：地址栏保持 /cdn.example.net/lib/x.js 可读形态
  assert.equal(rewriteRef(cfg, doc, 'https://cdn.example.net/lib/x.js'), '/cdn.example.net/lib/x.js');
});

test('特殊 scheme 一律不动', () => {
  for (const v of [
    'data:image/png;base64,AAA',
    'blob:http://x/1',
    'javascript:void(0)',
    'mailto:a@b.c',
    'tel:+123',
    'about:blank',
    '#anchor',
    '',
  ]) {
    assert.equal(rewriteRef(cfg, doc, v), v, v);
  }
});

test('protocol-relative 继承文档协议后走路径覆盖', () => {
  // 文档是 http，按 URL 规范继承 http
  assert.equal(rewriteRef(cfg, doc, '//cdn.example.net/a.js'), '/cdn.example.net/a.js');
  const httpsDoc = new URL('https://127.0.0.1:4517/dir/page.html');
  assert.equal(rewriteRef({ ...cfg, targetHost: '127.0.0.1:4517' }, httpsDoc, '//cdn.example.net/a.js'), '/cdn.example.net/a.js');
});

test('协议相对但同主机 -> 根路径', () => {
  assert.equal(rewriteRef(cfg, doc, '//127.0.0.1:4517/z.png'), '/z.png');
});

test('不合法值原样返回（绝不猜测）', () => {
  assert.equal(rewriteRef(cfg, doc, 'http://'), 'http://');
  assert.equal(rewriteRef(cfg, doc, '  '), '  ');
});

test('external=direct 时跨源保持原样', () => {
  const direct = { ...cfg, external: 'direct' };
  assert.equal(rewriteRef(direct, doc, 'https://cdn.example.net/a.js'), 'https://cdn.example.net/a.js');
  assert.equal(rewriteRef(direct, doc, '/a.js'), '/a.js');
});

test('toProxyHref 对 // 开头的 pathname 走编码通道（特例保留）', () => {
  const out = toProxyHref(cfg, new URL('http://127.0.0.1:4517//weird.png'));
  assert.ok(out.startsWith(P + '/x/'));
});

test('resolveIncoming: 页面路径 / 编码通道 / 内部路由', () => {
  assert.equal(resolveIncoming(cfg, '/api/proxy/blog/post?p=2').rawPath, '/blog/post?p=2');
  assert.equal(resolveIncoming(cfg, '/blog/post?p=2').rawPath, '/blog/post?p=2');
  assert.equal(resolveIncoming(cfg, '/api/proxy/').rawPath, '/');
  assert.equal(resolveIncoming(cfg, `${P}/health`).kind, 'health');
  assert.equal(resolveIncoming(cfg, `${P}/runtime.js`).kind, 'runtime');

  const enc = resolveIncoming(cfg, `${P}/x/${b64uEncode('https://other.tld/a')}`);
  assert.equal(enc.kind, 'encoded');
  assert.equal(enc.upstream.href, 'https://other.tld/a');

  assert.equal(resolveIncoming(cfg, `${P}/x/YWJj`).error, 'bad_url');
  assert.equal(resolveIncoming(cfg, `${P}/x/${b64uEncode('file:///etc/passwd')}`).error, 'bad_scheme');
});

test('buildUpstreamUrl 保留原始查询串与百分号编码', () => {
  const u = buildUpstreamUrl(cfg, '/a%20b/c?x=1&y=%2F#frag');
  assert.equal(u.origin, 'http://127.0.0.1:4517');
  assert.equal(u.pathname, '/a%20b/c');
  assert.equal(u.search, '?x=1&y=%2F');
});

test('内网地址判定', () => {
  for (const h of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.1.1', '169.254.169.254', '172.16.0.1', '[::1]', '0.0.0.0']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', 'cdn.jsdelivr.net']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});

test('b64url 往返', () => {
  const s = 'https://例え.jp/路径?q=中文&x=1#片段';
  assert.equal(b64uDecode(b64uEncode(s)), s);
});
