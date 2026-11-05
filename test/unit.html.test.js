import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rewriteHtml, decodeEntities } = await import('../lib/html.js');
const { cfg } = await import('./helpers.js');

const doc = new URL('http://127.0.0.1:4517/dir/page.html');
const P = cfg.prefix;

function run(html, url = doc) {
  return rewriteHtml(cfg, html, url, { injectRuntime: false });
}

test('基础属性：相对 / 根相对 / 绝对 / 跨源', () => {
  const html = `<a href="x.html">1</a><a href="/y.html">2</a>
<a href="http://127.0.0.1:4517/z.html">3</a><a href="https://cdn.example.net/w.js">4</a>`;
  const out = run(html);
  assert.match(out, /href="\/dir\/x.html"/);
  assert.match(out, /href="\/y.html"/);
  assert.match(out, /href="\/z.html"/);
  assert.match(out, new RegExp(`href="${P}/x/`));
});

test('data / javascript / mailto / 锚点 不改写', () => {
  const html = `<img src="data:image/png;base64,AAA"><a href="javascript:void(0)">j</a>
<a href="mailto:a@b.c">m</a><a href="#top">t</a>`;
  assert.equal(run(html), html);
});

test('srcset 描述符保留，逐项改写', () => {
  const html = `<img srcset="/a.png 1x, https://cdn.example.net/b.png 2x, c.png 300w">`;
  const out = run(html);
  assert.match(out, /\/a\.png 1x/);
  assert.match(out, new RegExp(`${P}/x/[A-Za-z0-9_-]+ 2x`));
  assert.match(out, /\/dir\/c\.png 300w/);
});

test('meta refresh 改写 url', () => {
  const out = run(`<meta http-equiv="refresh" content="5; url=/next">`);
  assert.match(out, /content="5; url=\/next"/);
  const out2 = run(`<meta http-equiv="refresh" content="0;URL='https://127.0.0.1:4517/a'">`);
  assert.match(out2, /url='\/a'/i);
});

test('meta charset 归一为 utf-8', () => {
  assert.match(run(`<meta charset="gbk">`), /charset="utf-8"/);
  assert.match(run(`<meta http-equiv="content-type" content="text/html; charset=gb2312">`), /charset=utf-8/);
});

test('<base href> 既改写也让后续相对路径按它解析', () => {
  const html = `<html><head><base href="https://127.0.0.1:4517/deep/"></head><body><a href="p.html">p</a></body></html>`;
  const out = run(html);
  assert.match(out, /<base href="\/deep\/">/);
  assert.match(out, /href="\/deep\/p.html"/);
});

test('srcdoc 递归改写并保持实体转义', () => {
  const html = `<iframe srcdoc="&lt;img src=&quot;/i.png&quot;&gt;"></iframe>`;
  const out = run(html);
  // 内侧被改写（这里 /i.png 已是根路径，值不变），且外层引号未被破坏
  assert.match(out, /srcdoc="&lt;img src=&quot;\/i\.png&quot;&gt;"/);
});

test('integrity 必须移除（内容已变，SRI 必失败）', () => {
  const out = run(`<script src="/app.js" integrity="sha384-abc" crossorigin="anonymous"></script>`);
  assert.doesNotMatch(out, /integrity/);
  assert.match(out, /crossorigin="anonymous"/);
  assert.match(out, /src="\/app.js"\s*>?[^<]*<\/script>/);
});

test('内联 style 走 CSS 重写，相对路径按文档解析', () => {
  const out = run(`<div style="background:url('img/bg.png')"></div>`);
  assert.match(out, /url\('\/dir\/img\/bg\.png'\)/);
});

test('内联事件里的绝对地址被改写', () => {
  const out = run(`<button onclick="location.href='http://127.0.0.1:4517/go'">x</button>`);
  assert.match(out, /location\.href='\/go'/);
});

test('注释与脚本字符串中的标签不动', () => {
  const html = `<!-- <a href="/x"> --><script>var s = "<a href='/x'>";</script>`;
  const out = run(html);
  assert.match(out, /<!-- <a href="\/x"> -->/);
  assert.match(out, /"<a href='\/x'>"/);
});

test('script 内容按 JS 规则改写，style 内容按 CSS 规则改写', () => {
  const html = `<style>.a{background:url(../up.png)}</style>
<script type="module">import x from "./m.js"; const u = "http://127.0.0.1:4517/api";</script>`;
  const out = run(html);
  assert.match(out, /url\('\/up\.png'\)|url\("\/up\.png"\)/);
  assert.match(out, /from "\/dir\/m\.js"/);
  assert.match(out, /"\/api"/);
});

test('畸形 HTML 不被"修复"，只做属性替换', () => {
  const html = `<div><p>未闭合<a href="/a.html">链接<div><span>`;
  const out = run(html);
  assert.equal(out.replace('href="/a.html"', 'href="/a.html"'), out);
  assert.match(out, /href="\/a.html"/);
});

test('未闭合引号的标签按文本透传（交给浏览器容错）', () => {
  const html = `<a href="/x>broken`;
  assert.equal(run(html), html);
});

test('svg 的 xlink:href / use', () => {
  const html = `<svg><use xlink:href="/sprite.svg#icon"></use><image href="/i.png"/></svg>`;
  const out = run(html);
  assert.match(out, /xlink:href="\/sprite\.svg#icon"/);
  assert.match(out, /href="\/i\.png"/);
});

test('实体不重复编码', () => {
  const out = run(`<a href="/search?q=1&amp;r=2">x</a>`);
  assert.equal(out, `<a href="/search?q=1&amp;r=2">x</a>`);
});

test('注入运行时脚本在 head 之后', () => {
  const html = rewriteHtml(cfg, `<html><head><title>t</title></head><body></body></html>`, doc);
  assert.match(html, /<head><script src="\/__vp\/runtime\.js/);
  const noHead = rewriteHtml(cfg, `<html><body>x</body></html>`, doc);
  assert.match(noHead, /<html><script src="\/__vp\/runtime\.js/);
  const bare = rewriteHtml(cfg, `<p>x</p>`, doc);
  assert.match(bare, /^<script src="\/__vp\/runtime\.js/);
});

test('decodeEntities 覆盖数字与命名实体', () => {
  assert.equal(decodeEntities('&amp;&lt;&#65;&#x42;&quot;'), '&<AB"');
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;');
});
