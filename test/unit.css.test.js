import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rewriteCss } = await import('../lib/css.js');
const { cfg } = await import('./helpers.js');

const sheet = new URL('http://127.0.0.1:4517/css/app.css');
const P = cfg.prefix;

const r = (css, url = sheet) => rewriteCss(cfg, css, url);

test('url() 各种引号与空白写法', () => {
  assert.equal(r('a{background:url(img.png)}'), 'a{background:url("img.png")}'.replace('img.png', '/css/img.png'));
  assert.match(r("a{background:url('/abs.png')}"), /url\('\/abs\.png'\)/);
  // 引号内的多余空白被裁掉（CSS 里那是非法 URL），值本身已是根路径
  assert.equal(r('a{background:url(  "  /sp.png"  )}'), 'a{background:url(  "/sp.png"  )}');
  // 未加引号的 url() 里的换行本身是非法 CSS：值未变化时不擅自重写
  assert.equal(r('a{background:url(\n/img.png\n)}'), 'a{background:url(\n/img.png\n)}');
  assert.match(r('a{background:url(\n../img.png\n)}'), /url\(\s*"\/img\.png"\)/);
});

test('相对路径按样式表位置解析（不是按页面）', () => {
  assert.match(r('a{background:url(../img/x.png)}'), /url\("\/img\/x\.png"\)/);
  assert.match(r('a{background:url(./x.png)}'), /url\("\/css\/x\.png"\)/);
});

test('@import 两种写法都改写', () => {
  assert.match(r('@import "reset.css";'), /@import "\/css\/reset\.css"/);
  assert.match(r("@import url('theme.css') screen;"), /@import url\('\/css\/theme\.css'\) screen;/);
  assert.match(r('@import url(theme.css);'), /@import url\("\/css\/theme\.css"\);/);
});

test('image-set 里的裸字符串是 URL', () => {
  const out = r('.a{background-image:image-set("h1.png" 1x, "h2.png" 2x)}');
  assert.match(out, /"\/css\/h1\.png" 1x/);
  assert.match(out, /"\/css\/h2\.png" 2x/);
});

test('local() 里的字符串不是 URL', () => {
  const out = r('@font-face{src:local("Arial"),url(f.woff2)}');
  assert.match(out, /local\("Arial"\)/);
  assert.match(out, /url\("\/css\/f\.woff2"\)/);
});

test('注释与字符串内容不被误改写', () => {
  const css = '/* url(/no.png) */ .a{content:"url(/no2.png)"}';
  assert.equal(r(css), css);
});

test('data: 与 #fragment 的 url 不动', () => {
  const css = 'a{background:url(data:image/png;base64,AAA)}b{filter:url(#f)}';
  assert.equal(r(css), css);
});

test('跨源走可读路径覆盖', () => {
  const out = r('@font-face{src:url(https://cdn.example.net/f.woff2)}');
  assert.match(out, /url\("\/cdn\.example\.net\/f\.woff2"\)/);
});

test('自定义属性里的 url 也改写', () => {
  assert.match(r(':root{--bg:url("/a.png")}'), /--bg:url\("\/a\.png"\)/);
});

test('转义序列不打断词法', () => {
  const css = 'a{content:"\\"quoted\\""}b{background:url(ok.png)}';
  const out = r(css);
  assert.match(out, /content:"\\"quoted\\""/);
  assert.match(out, /url\("\/css\/ok\.png"\)/);
});

test('幂等：重复改写结果不变', () => {
  const once = r('a{background:url(x.png)}@import "y.css";');
  assert.equal(r(once), once);
});

test('非法/异常输入不抛错', () => {
  for (const s of ['', 'url(', 'url("unclosed', '@import', '}}}', 'url()']) {
    assert.doesNotThrow(() => r(s));
  }
});
