# 能力边界（先说不能做什么）

这份文档存在的意义：任何"什么都能代理"的说法都是假的。下面是逐条核对过的边界，
每一条都写清楚**为什么**和**影响面**，而不是含糊其辞。

> 修订记录：v1.1 —— 更正 WebSocket 结论。此前本文写"Vercel 不支持 WS"，错误：
> Vercel 函数已原生支持（所有套餐可用，Node 导出 `http.Server` 即可）。
> 本项目已实现 WS 代理并有端到端测试覆盖。

---

## A. 平台硬限制（换实现也绕不过）

### A1. WebSocket：**支持**，但有实例粘性与时长约束
Node 函数默认导出 `http.Server` 即可服务 WS（本项目 `api/proxy.js` 就是这么做的）。

- 子协议协商：透传（上游选定的 `Sec-WebSocket-Protocol` 原样回给浏览器）
- 文本/二进制帧保真转发；close code/reason 透传；ping/pong 由各自协议层维护
- 跨源 WS 走 `/__vp/x/<b64>` 编码通道
- 已知约束：连接固定在一个函数实例上（Fluid 下一个实例可挂多条连接）；
  断开后重连不保证回到同一实例；连接受 maxDuration 限制
  （Hobby 300s，Pro 默认 300s / 最大 800s），到期由客户端重连
- 首帧竞态已处理：上游在握手完成瞬间发来的消息会先缓冲再冲刷

### A2. 请求/响应体 4.5MB 上限
Vercel 平台的 payload 限制（与代码无关）。
- 影响：大文件下载、大附件上传会被平台截断。
- 缓解：`lib/upstream.js` 已做体积上限与明确报错；下载请直连源站。

### A3. 函数冷启动与 maxDuration
流式响应、长轮询受同一时长上限约束（同 A1 的 WS 时长）。

---

## B. 语义限制（代理不等于"同一个站点"）

### B1. `location.host` / `location.origin` 仍是代理域名
`Location` 在规范里是 `[LegacyUnforgeable]`：脚本无法替换 `window.location`，
也无法重新定义 `location.href` 的 setter。
- 已缓解：静态改写会处理源码里写死的 `location.href = 'https://target/…'`；
  垫片接管 `assign/replace`、`history.pushState`、点击与表单提交。
- 仍无法覆盖：运行时**拼接**出来的绝对地址赋给 `location.href`
  （例如 `location.href = 'https://' + host + '/login'`）。
- 影响：需要"域名即身份"的逻辑（OAuth `redirect_uri` 白名单、
  `document.domain` 校验）会失败。

### B2. Service Worker 被禁用
代理页面上注册 SW 会让它接管代理域，并缓存已改写的资源，
造成"换 target 后仍是旧站点"的诡异问题。
- 现状：`navigator.serviceWorker.register` 返回 rejected Promise。
- 影响：依赖 SW 的离线/推送/PWA 安装不可用；普通站点无感。

### B3. `httpOnly` Cookie 的页面侧可见性
`scoped` 模式下 Cookie 名加了 `__vp_<hosthash>_` 前缀，`document.cookie` 被垫片还原成原名，
但 **Worker / 非 DOM 上下文**里读到的仍是带前缀的名字。`simple` 模式可关闭前缀。

### B4. 服务器端看到的是 Vercel 的出口 IP
上游按 IP 做的风控、地域限制、速率限制都以 Vercel 的 IP 为准。
`Origin` / `Referer` / `Host` 都已还原成上游视角，但 **源 IP 无法还原**。

### B5. 相对 URL 在"跨主机 base"下由 JS 运行时拼接时可能错
`<base href="https://cdn.other.tld/dir/">` 这种写法：静态改写会把每条引用解析成绝对地址
再编码，所以 HTML/CSS 层面完全正确；但如果页面脚本在那之后再做
`new URL('rel.png', document.baseURI)`，浏览器拿到的是 `/__vp/x/<b64>` 这种不透明路径，
追加相对段会得到非法路由。
- 影响面：极少数把 `<base>` 指向第三方 CDN 的站点。

---

## C. 请求头 / 响应头策略（v1.1 改为"默认放行"）

**请求头：默认全部透传**，不替用户做安全决策。只有三类例外：

| 例外 | 原因 |
|---|---|
| `host` / `content-length` / `accept-encoding` | 协议层面必须由代理自己控制，改了请求发不出去或语义错乱 |
| `cookie` / `referer` / `origin` | 不是丢弃，是**还原成上游视角**（见 ARCHITECTURE §6/§8） |
| `x-vercel-id` 等平台内部签名头 | 透传无意义，还可能触发上游风控 |

`x-forwarded-*`、`x-real-ip`、`cf-*`、`x-vercel-ip-*`、UA、自定义头……全部原样到达上游。

**响应头**分两级：

- `DROP_RESPONSE_ALWAYS`：`transfer-encoding` 等逐跳头、`content-length`（由代理重算）、
  `content-encoding`（已解压）、`location`（改写后返回）、`set-cookie`（改写后返回）。
  这五个不动请求就发不出去，与"是否信任上游"无关。
- `DROP_RESPONSE_SECURITY`：CSP / XFO / HSTS / COOP / COEP / CORP / Permissions-Policy 等。
  由 `stripSecurityHeaders` 控制，**默认摘除**（这些头的存在会让浏览器拒绝加载代理页）；
  设为 `false` 则全部透传。

---

## D. 改写粒度（哪些一定会改、哪些不改）

### 一定改写
| 位置 | 覆盖面 |
|---|---|
| HTML 属性 | `href src action formaction poster data cite background longdesc manifest codebase xlink:href ping srcset imagesrcset style srcdoc` |
| HTML 结构 | `<base href>`、`<meta http-equiv=refresh>`、`<meta charset>`（归一 UTF-8）、CSP meta |
| HTML 内容 | `<style>` 按 CSS 规则、`<script>` 按 JS 规则、`<script type=importmap>`、`srcdoc` 递归 |
| CSS | `url()`、`@import`、`image-set()`、自定义属性、`@charset` |
| JS | `import`/`export from`/`import()`、`fetch`、`XHR.open`、`sendBeacon`、`Worker`、`SharedWorker`、`EventSource`、`window.open`、`location.href=`、`new URL()`、绝对 URL 字面量 |
| 响应头 | `Location`、`Set-Cookie`、`Link`、`Refresh` |
| WebSocket | 子协议协商、首帧竞态、二进制帧、close code 透传 |

### 明确不改（改了会更糟）
| 位置 | 原因 |
|---|---|
| `data:` `blob:` `javascript:` `mailto:` `tel:` `about:` `chrome-extension:` … | 非网络资源或特殊语义 |
| `integrity` 属性 | 内容已变，SRI 必失败 → 直接删除 |
| `<textarea>` `<title>` `<noscript>` `<xmp>` | 原始文本，改了就破坏内容 |
| 注释、`<!--[if IE]>`、CDATA | 文本，不参与解析 |
| `text/plain`、JSON、XML | 不含路径语义，硬改会破坏数据 |
| `Content-Disposition: attachment` 的响应 | 下载必须字节一致 |
| 视图层动态生成的 `innerHTML` 字符串 | 无法静态分析；已由 MutationObserver 在插入后兜底 |

### 降级策略（宁可少改，不可改错）
- JS 解析失败（TS/JSX/更新的语法）→ 只做高置信度的保守改写，其余原样。
- 文档超过 `maxBodyBytes` → 原样透传，附 `x-vproxy-rewritten: 0`。
- 未知字符集 → iconv-lite 兜底，仍不行才按 UTF-8 尽力解码。
- 任何改写抛错 → 返回 500 错误页（**绝不吐半成品**）。

---

## E. 安全说明（按当前配置的真实状态陈述）

- `allowPrivateHosts` 默认 `false`：拒绝内网/元数据地址（`127.0.0.1`、`10/8`、`169.254/16`、`::1`…）。
  这是**唯一**的访问控制。设为 `true` 后代理对目标不做任何限制。
- `external: proxy` 意味着**任何人**都能借你的域名访问任意站点，请自行加访问控制
  （Vercel 密码保护 / IP 白名单 / 自建鉴权），并注意法律与上游 ToS 风险。
- 请求头全量透传（v1.1 起）：上游能看到 `x-forwarded-for` 等 Vercel 附加头。
  这是刻意行为，不是疏漏。
