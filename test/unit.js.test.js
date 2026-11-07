import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rewriteJs, rewriteImportMap } = await import('../lib/jsrewrite.js');
const { cfg } = await import('./helpers.js');

const scriptUrl = new URL('http://127.0.0.1:4517/js/app.js');
const P = cfg.prefix;
const r = (src, opts = {}) => rewriteJs(cfg, src, scriptUrl, opts);

test('import / export / 动态 import 的说明符', () => {
  assert.match(r('import a from "./m.js";'), /from "\/js\/m\.js"/);
  assert.match(r('import "/abs/m.js";'), /import "\/abs\/m\.js"/);
  assert.match(r('export * from "../x.js";'), /from "\/x\.js"/);
  assert.match(r('const m = await import("./lazy.js");'), /import\("\/js\/lazy\.js"\)/);
});

test('裸包名（barrel import）绝不改写', () => {
  const src = 'import x from "lodash"; import y from "@scope/pkg/a";';
  assert.equal(r(src), src);
});

test('fetch / XHR 的绝对地址改写，根路径保持', () => {
  assert.match(r('fetch("http://127.0.0.1:4517/api/a")'), /fetch\("\/api\/a"\)/);
  assert.equal(r('fetch("/api/a")'), 'fetch("/api/a")');
  assert.match(r('xhr.open("GET", "http://127.0.0.1:4517/api/b")'), /"GET", "\/api\/b"/);
  assert.match(r('window.open("http://127.0.0.1:4517/w")'), /open\("\/w"\)/);
});

test('字符串里的绝对字面量（target 主机）改写', () => {
  const out = r('const u = "http://127.0.0.1:4517/a/b?x=1";');
  assert.match(out, /"\/a\/b\?x=1"/);
});

test('跨主机字面量保持原样', () => {
  const src = 'const u = "https://cdn.example.net/x.js";';
  assert.equal(r(src), src);
});

test('new Worker / new URL', () => {
  assert.match(r('new Worker("/w.js");'), /new Worker\("\/w\.js"\)/);
  assert.match(r('new Worker("./w.js");'), /new Worker\("\/js\/w\.js"\)/);
  assert.match(r('new URL("http://127.0.0.1:4517/u", import.meta.url);'), /new URL\("\/u"/);
});

test('模板字符串里的地址', () => {
  const out = r('const u = `http://127.0.0.1:4517/t`;');
  assert.match(out, /`\/t`/);
});

test('location.href 赋值', () => {
  assert.match(r('location.href = "http://127.0.0.1:4517/login";'), /location\.href = "\/login"/);
});

test('正则字面量与注释不被误伤', () => {
  const src = 'const re = /https:\\/\\/127\\.0\\.0\\.1:4517\\/a/; // http://127.0.0.1:4517/b';
  assert.equal(r(src), src);
});

test('解析失败时回退到保守改写，仍处理 import 说明符', () => {
  // TS 语法 acorn 无法解析
  const src = 'import a from "./m.ts";\nconst x: string = "http://127.0.0.1:4517/z";\n';
  const out = r(src);
  assert.match(out, /from "\/js\/m\.ts"/);
  assert.match(out, /"\/z"/);
});

test('无法解析且无高置信度模式时原样返回', () => {
  const src = 'const <<<>>> = 1;';
  assert.equal(r(src), src);
});

test('幂等', () => {
  const once = r('import a from "./m.js"; fetch("http://127.0.0.1:4517/a");');
  assert.equal(r(once), once);
});

test('importmap 只改值不改键', () => {
  const map = JSON.stringify({
    imports: { lodash: './vendor/lodash.js', react: 'https://esm.sh/react' },
    scopes: { '/app/': { x: '/x.js' } },
  });
  const out = JSON.parse(rewriteImportMap(cfg, map, scriptUrl));
  assert.equal(out.imports.lodash, '/js/vendor/lodash.js');
  assert.equal(out.imports.react, '/esm.sh/react');
  assert.equal(out.scopes['/app/'].x, '/x.js');
});

test('importmap 非法 JSON 原样返回', () => {
  assert.equal(rewriteImportMap(cfg, '{not json', scriptUrl), '{not json');
});

test('超大脚本直接跳过解析（不阻塞请求）', () => {
  const big = 'var a = 1;\n'.repeat(200000);
  const out = r(big);
  assert.equal(out, big);
});

/* ---------------- location 导航改写（跳转完整性） ---------------- */

test('location.assign/replace 静态改写', () => {
  assert.match(r('location.assign("https://cn.bing.com/search")'), /assign\("\/cn\.bing\.com\/search"\)/);
  assert.match(r('location.replace("https://cdn.example.net/x")'), /replace\("\/cdn\.example\.net\/x"\)/);
  assert.match(r('window.location.assign("https://www.bing.com/a")'), /assign\("\/www\.bing\.com\/a"\)/);
});

test('location.href= / location= / document.location 赋值', () => {
  assert.match(r('location.href = "https://cn.bing.com/x"'), /location\.href = "\/cn\.bing\.com\/x"/);
  assert.match(r('window.location.href = "https://www.bing.com/y"'), /location\.href = "\/www\.bing\.com\/y"/);
  assert.match(r('document.location.href = "https://example.org/z"'), /location\.href = "\/example\.org\/z"/);
  assert.match(r('location = "https://example.org/w"'), /location = "\/example\.org\/w"/);
});

test('运行时求值的 location 地址包装为垫片调用', () => {
  assert.match(r('location.href = "https://cn.bing.com/" + path'), /__VPROXY__\.map\(/);
  assert.match(r('location.href = `https://cn.bing.com/${p}`'), /__VPROXY__\.map\(/);
  assert.match(r('location.assign(getLoginUrl())'), /__VPROXY__\.map\(getLoginUrl\(\)\)/);
  assert.match(r('window.location.replace(buildReturnUrl())'), /__VPROXY__\.map\(/);
});

test('非 location 的同名调用不被包装（fetch 已由垫片运行时拦截）', () => {
  assert.equal(r('fetch(getApiUrl())'), 'fetch(getApiUrl())');
  assert.equal(r('someObj.assign(x)'), 'someObj.assign(x)');
});

test('相对/锚点/hash 不动', () => {
  assert.equal(r('location.href = "/rel"'), 'location.href = "/rel"');
  assert.equal(r('location.hash = "#x"'), 'location.hash = "#x"');
});
