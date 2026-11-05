# 架构与设计决策

## 1. 关键决策一：根路径 1:1 镜像

```
上游   https://example.com/a/b.css?v=1
浏览器  /a/b.css?v=1
```

为什么不用 `/?url=https://example.com/a/b.css`：

- 相对路径解析是**浏览器**做的。页面里 `<img src="img/x.png">` 会相对当前文档 URL 解析，
  与代理的查询参数无关 —— 一旦换成查询参数式，所有相对路径全部失效，
  只能靠全量改写兜住，而全量改写必然漏（`innerHTML`、字符串拼接、CSS-in-JS）。
- 根路径镜像下，页面里**任何**相对/根相对引用天然正确，即使我们完全没改写它。

代价：`target` 必须是站点根（不允许子目录），否则根相对引用会产生歧义。
这个约束在 `lib/config.js` 里显式报错，而不是默默容忍。

无法用根路径表达的情况（跨源、以 `//` 开头的 pathname）走编码通道：

```
/__vp/x/<base64url(绝对 URL)>
```

## 2. 关键决策二：Vercel 路由如何拿到"上游路径"

`vercel.json`：

```json
{ "source": "/:path((?!api/|_vercel/).*)", "destination": "/api/proxy/:path*" }
```

函数收到的 `req.url` 是 `/api/proxy/原始路径?原始查询`。
`lib/url.js::resolveIncoming` 只做一件事：把 `/api/proxy` 前缀削掉，
剩下的字节**原封不动**当作上游路径（不 decode、不 re-encode、不归一化 `//` 和 `%2F`）。

这类代理最常见的 bug 就是"先 decode 再 encode"，导致 `%2F` 变成 `/`、`+` 变成空格。
本实现全程使用原始字符串。

## 3. 关键决策三：HTML 走词法，不走 DOM 树

| 方案 | 问题 |
|---|---|
| 正则替换 | 会在注释、脚本字符串、CDATA 里误伤，还会把文本里的 `<a href>` 当标签 |
| 完整 DOM 解析（cheerio/parse5 建树 + 序列化） | 会重排、补全、规范化标签，改变文档结构 → 改变 CSS 选择器与脚本行为；残缺 HTML 上的容错与浏览器不一致 |
| **词法扫描 + 属性级手术（本实现）** | 不重排、不补全、不改格式，只替换必须替换的属性值区间 |

具体做法：`lib/html.js` 顺序扫描 `<`，识别注释/声明/结束标签/开始标签，
解析开始标签的属性表并记录**源码偏移**，然后对值区间做 splice。
未被改写的部分逐字节透传（包括空白、大小写、条件注释、非法嵌套）。

## 4. 关键决策四：CSS/JS 各自需要真解析

- CSS 用字符级状态机（字符串 / 注释 / 括号栈）。必须区分 `url()` 与 `local()`，
  必须知道 `image-set()` 里的裸字符串也是 URL，必须按**样式表自身 URL** 解析相对路径。
- JS 必须用 AST（`acorn`）。正则扫 JS 无法区分字符串、模板、正则字面量、注释，
  而且不能判断 `open` 后面第二个参数才是 URL。

解析失败时**不猜**：只做 `from "…"` / `import("…")` / `new URL("…")` 这类高置信度模式。

## 5. 关键决策五：静态改写 + 运行时垫片双保险

静态改写只能覆盖"源码里写死的地址"。真实站点大量 URL 来自运行时：

```js
img.src = 'https://example.com/a.png';
fetch(`/api/${id}`);
history.pushState({}, '', '/route');
```

`lib/runtime/client.js` 在页面最前面同步注入（`document.currentScript` 取配置），接管：

- `fetch` / `XMLHttpRequest.open` / `sendBeacon` / `EventSource` / `Worker` / `SharedWorker`
- `window.open` / `history.pushState|replaceState` / `location.assign|replace`
- `document.cookie`（命名空间透明化）
- `MutationObserver`：兜住 `el.src=…`、`innerHTML` 插入等静态改写看不见的路径
- 捕获阶段的 click / submit：兜住"绝对地址跳转"的最后一道口子
- `navigator.serviceWorker`：禁用（见 LIMITS B2）

映射函数**幂等**：已经是代理同源的 URL 原样返回，因此 MutationObserver 不会自激。

## 6. 关键决策六：重定向不跟随

上游 `3xx` 一律改写 `Location` 后原样返回浏览器。

- 服务端跟随会把"登录 → 302 → 403"这类链条变成单一响应，浏览器侧状态全丢；
- 浏览器跟随能保持地址栏、Cookie、后续相对路径解析的正确性。

## 7. 字符集

浏览器认 HTTP 头的 charset，不认 meta。所以：

```
读字节 → 用 头 charset / @charset / <meta charset> 解码 → 改写 → 以 UTF-8 输出
       + 改写 content-type 为 charset=utf-8
       + 改写 <meta charset> 与 @charset 为 utf-8
```

漏掉最后一步就会出现"页面本身是 UTF-8 字节、meta 却声明 GBK"的双重乱码。

解码器优先级：`TextDecoder`（Vercel 完整 ICU）→ `iconv-lite`（纯 JS 表，容器缺 ICU 时兜底）。

## 8. Cookie 命名空间

多个上游主机被压平到一个浏览器源上，同名 Cookie 会互相覆盖。
`scoped` 模式给每个上游主机的 Cookie 名加 `__vp_<fnv1a(host)>_` 前缀：

- 出站：按当前上游主机的 hash 过滤，还原名字，再发给上游；
- 入站（浏览器侧）：`document.cookie` 的 getter/setter 被垫片包了一层，页面看到的是原名。

hosthash 在服务端（`lib/cookies.js`）与浏览器端（运行时）都必须是同一个 FNV-1a 实现 ——
这是唯一的跨端强耦合点，改动时两边必须同步。

## 9. 错误处理原则

| 场景 | 行为 |
|---|---|
| 配置非法 | 启动期抛错，返回明确文案（不静默降级） |
| 上游网络错误 | 502/504 + 错误码头 `x-vproxy-error`，页面给出 target/URL/原因 |
| 改写抛错 | 500，**不吐半成品** |
| 体积超限 | 已知长度则原样透传并标记 `x-vproxy-rewritten: 0`；流式超限则中止 |
| 畸形 HTML/CSS/JS | 按文本透传，交给浏览器自己的容错 |

## 10. 性能

- HTML/CSS/JS 改写都是单遍线性扫描 + 一次 splice，无正则回溯风险。
- 所有改写有编辑次数预算（`maxEdits`），恶意构造的 10MB 页面不会打满 CPU。
- 二进制资源完全不进内存，`Readable.fromWeb().pipe(res)` 直通（含 Range/206）。
- 依赖只有两个：`acorn`（JS 解析）、`iconv-lite`（字符集）。
