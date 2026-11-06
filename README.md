# vproxy · Vercel 通用网页代理

把自己的 Vercel 域名变成任意站点的镜像：改一行配置换目标站点，页面里的 **CSS / JS / 图片 / 字体 / 表单 / 重定向 / Cookie** 全部按上游语义重新解析。

```
浏览器 ──▶ 你的域名  https://my-proxy.vercel.app/assets/app.css
                        │  (vercel.json rewrite)
                        ▼
                    api/proxy.js ──▶ 上游 https://example.com/assets/app.css
                        │
                        ▼  改写 HTML / CSS / JS 里的每一处路径引用
```

---

## 1. 改目标域名

只改 `proxy.config.json` 的 `target`：

```json
{ "target": "https://example.com" }
```

也可以在 Vercel 上用环境变量覆盖（不用重新提交代码）：`PROXY_TARGET=https://example.com`。

> `target` 必须是**站点根**（`https://example.com`），不要带路径。
> 子目录站点直接在代理上访问 `/sub/` 即可，相对路径解析天然正确。

## 2. 本地跑

```bash
npm install
npm run dev            # http://127.0.0.1:4200  上游是内置测试站点
npm test               # 79 项单元 + 端到端测试
```

真实站点本地试：

```bash
PROXY_TARGET=https://example.com PROXY_PORT=4200 node dev/server.js
```

## 3. 部署

```bash
npm i -g vercel
vercel            # 首次部署（预览）
vercel --prod     # 生产
```

部署后第一件事：打开 `https://你的域名/__vp/health`。
它会告诉你函数收到的原始 URL、解析结果、当前配置。**路径映射有问题，这一页立刻就能看出来。**

## 4. 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `target` | — | 上游站点根地址 |
| `routePrefix` | `/__vp` | 内部路由前缀（运行时脚本 / 编码通道 / 诊断） |
| `external` | `proxy` | 跨源资源：`proxy` 全部绕经代理（能穿透封锁），`direct` 保持直连（更快、更少出错） |
| `cookieMode` | `scoped` | `scoped` 按上游主机给 Cookie 加前缀并还原（多主机不串味），`simple` 只去 Domain |
| `injectRuntime` | `true` | 注入浏览器端垫片，接管运行时拼接的 URL |
| `stripSecurityHeaders` | `true` | 摘掉 CSP / HSTS / XFO 等会打断代理的响应头 |
| `rewrite.html/css/js/svg` | `true` | 分类开关 |
| `rewrite.importmap` | `true` | `<script type="importmap">` 改写 |
| `rewrite.inlineHandlers` | `true` | `onclick="location.href='…'"` 这类内联处理器 |
| `rewrite.absoluteLiterals` | `true` | JS 里指向目标主机的绝对 URL 字面量 |
| `upstream.timeoutMs` | `25000` | 上游超时 |
| `upstream.maxBodyBytes` | `12MB` | 可改写文档的体积上限，超限改为原样透传 |
| `upstream.userAgent` | `null` | 覆盖 UA（部分站点按 UA 分流） |
| `upstream.headers` | `{}` | 附加到每个上游请求的固定头 |
| `block.paths` / `block.hosts` | `[]` | 拉黑 |
| `allowPrivateHosts` | `false` | 允许访问内网地址（SSRF 兜底，本地调试时开） |
| `debug` | `false` | 错误页附带堆栈 |

## 5. 目录

```
api/proxy.js            Vercel 入口（唯一的函数）
lib/url.js              URL 映射：根路径镜像 + /__vp/x/<b64> 编码通道
lib/html.js             HTML 词法扫描 + 属性级改写
lib/css.js              CSS 词法改写（url() / @import / image-set / @charset）
lib/jsrewrite.js        acorn AST 改写（import / fetch / Worker / new URL …）
lib/runtime/client.js   注入浏览器的运行时垫片
lib/headers.js          请求头还原、响应头清洗、Link/Refresh 改写
lib/cookies.js          Cookie 命名空间
lib/content.js          类型判定、字符集嗅探与解码（含 iconv 兜底）
lib/upstream.js         上游请求、超时、错误归一、体积上限
dev/                    本地联调服务器 + 测试用上游站点
test/                   79 项测试
docs/                   架构说明与能力边界
```

## 6. 能力边界（请先读）

`docs/LIMITS.md` 把"做不到的事"逐条列清楚了。先看三条最重要的：

1. **WebSocket 不能代理** —— Vercel 的 Serverless/Edge 都不支持双向 WS。垫片把 `wss://` 交回浏览器直连，所以聊天室类站点在目标域名可达时正常、在被封锁时不可用。
2. **改写发生在传输层，不是浏览器内部** —— 页面里 `location.host` 仍然是你的代理域名。任何把"域名本身"当业务数据的站点（OAuth 回调白名单、`document.domain` 校验）无法完全透明。
3. **Vercel 函数有 4.5MB 请求/响应体上限**（平台限制）。大文件下载/上传请直连源站或换自建 Node 部署。

除这三条之外，CSS 与 JS 的路径解析是**完整覆盖**的，不是"常见写法覆盖"：

- CSS：`url()` 带引号/不带引号/多行/转义、`@import` 两种写法、`image-set()` 裸字符串、`local()` 不改、注释与字符串不误伤、相对路径按**样式表自身**解析、`@charset` 归一为 UTF-8。
- JS：`import`/`export … from`/动态 `import()`、`importmap`、`fetch`/`XHR.open`/`sendBeacon`/`Worker`/`EventSource`/`window.open`/`location.href=`、`new URL(x, import.meta.url)`、绝对 URL 字面量、模板字符串；解析失败自动降级为保守改写（绝不在语法不确定时乱改）。
- 运行时：`fetch`/XHR 等 API 级拦截 + `MutationObserver` 兜住 `el.src = '…'` 这类动态插入，`document.cookie` 命名空间透明化。

## 7. 自检清单（部署后 2 分钟）

1. `/__vp/health` → `ok: true` 且 `resolved: "page"`
2. 首页源码里出现 `<script src="/__vp/runtime.js`
3. 打开 devtools，`window.__VPROXY__.map('https://example.com/a')` 返回 `/a`
4. 样式表请求 200 且 `content-type: text/css; charset=utf-8`
5. 站内跳转、登录、表单提交各点一次

---

MIT

## 9. Gate 中继

访问受限的站点可经 `https://proxy.344977.xyz/{完整URL}` 中继（路径式 gate，不是网络代理）。
本仓库的 git 远程已配置 gate 通道：`git push gate main`。
