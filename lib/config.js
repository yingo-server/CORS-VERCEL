/**
 * 配置加载与校验。
 *
 * 设计约束：
 *  - 配置只在进程内解析一次（Vercel 实例复用），但文件变更后开发模式可热读。
 *  - 任何非法配置都在启动期（首个请求）直接抛错，绝不静默降级：
 *    静默降级会让"看起来能跑但代理语义错了"，比崩溃更难排查。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONFIG_PATH = process.env.PROXY_CONFIG_PATH || join(ROOT, 'proxy.config.json');

/** 默认值必须与 proxy.config.json 一致，缺字段时补齐。 */
const DEFAULTS = {
  target: '',
  routePrefix: '/__vp',
  external: 'proxy',          // 'proxy' = 第三方资源也走代理；'direct' = 保持原样直连
  cookieMode: 'scoped',       // 'scoped' = 按上游主机加前缀；'simple' = 原样
  injectRuntime: true,
  stripSecurityHeaders: true,
  websocket: true,
  rewrite: {
    html: true,
    css: true,
    js: true,
    svg: true,
    importmap: true,
    inlineHandlers: true,
    absoluteLiterals: true,
    // 硬上限：单文件重写预算，防止恶意页面把函数 CPU 打满
    maxEdits: 50000,
  },
  upstream: {
    timeoutMs: 25000,
    maxBodyBytes: 12 * 1024 * 1024,
    maxRewritesPerRequest: 50000,
    userAgent: null,
    headers: {},
    followRedirects: false,
  },
  block: { paths: [], hosts: [] },
  allowPrivateHosts: false,
  debug: false,
};

let cached = null;
let cachedStamp = 0;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：对象递归，数组与标量直接替换（配置语义里更可预期）。 */
function merge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function fail(msg) {
  const err = new Error(`[vproxy] 配置错误: ${msg}`);
  err.code = 'BAD_CONFIG';
  throw err;
}

function normalize(raw) {
  const cfg = merge(DEFAULTS, raw);

  // target 允许被环境变量覆盖（部署后改域名不用改仓库）
  const targetRaw = (process.env.PROXY_TARGET || cfg.target || '').trim();
  if (!targetRaw) fail('缺少 target（proxy.config.json 的 target 字段或 PROXY_TARGET 环境变量）');

  let target;
  try {
    target = new URL(targetRaw);
  } catch {
    fail(`target 不是合法 URL: ${targetRaw}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    fail(`target 必须是 http/https: ${targetRaw}`);
  }
  if (target.search || target.hash) {
    fail('target 不允许携带 query 或 hash');
  }

  /*
   * target 只接受站点根（origin）。
   * 理由：根路径 1:1 镜像要求"浏览器路径 == 上游路径"，
   * 若允许 target 带子目录，`/assets/x.css` 这类根相对链接就会产生歧义
   * （究竟映射到 origin/assets 还是 origin/sub/assets）。子目录站点
   * 直接在代理上访问 `/sub/` 即可，相对路径解析天然正确。
   */
  if (target.pathname && target.pathname !== '/') {
    fail(`target 必须是站点根地址（如 https://example.com），不要带子路径。子目录站点请直接在代理上访问对应路径，例如 /sub/。当前: ${targetRaw}`);
  }
  const targetBase = target.origin;

  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(cfg.routePrefix) || cfg.routePrefix.endsWith('/')) {
    fail(`routePrefix 非法: ${cfg.routePrefix}（必须以 / 开头、字母数字、不带尾部斜杠）`);
  }
  if (cfg.external !== 'proxy' && cfg.external !== 'direct') {
    fail(`external 只能是 proxy 或 direct，当前: ${cfg.external}`);
  }
  if (cfg.cookieMode !== 'scoped' && cfg.cookieMode !== 'simple') {
    fail(`cookieMode 只能是 scoped 或 simple，当前: ${cfg.cookieMode}`);
  }

  // 本地联调便利：仅当显式设置环境变量时放开内网访问
  if (process.env.PROXY_ALLOW_PRIVATE === '1') cfg.allowPrivateHosts = true;

  cfg.target = targetBase;
  cfg.targetUrl = new URL(targetBase);
  cfg.targetOrigin = target.origin;
  cfg.targetHost = target.host;
  cfg.targetHostname = target.hostname;
  cfg.targetProtocol = target.protocol;
  cfg.targetPath = '';

  cfg.prefix = cfg.routePrefix;
  cfg.blockPaths = (cfg.block.paths || []).map(String);
  cfg.blockHosts = (cfg.block.hosts || []).map((h) => String(h).toLowerCase());

  return Object.freeze(cfg);
}

export function loadConfig({ force = false } = {}) {
  const envStamp = Number(process.env.PROXY_CONFIG_RELOAD || 0);
  if (cached && !force && cachedStamp === envStamp) return cached;

  let raw = {};
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(`找不到配置文件 ${CONFIG_PATH}`);
    }
    fail(`无法解析 ${CONFIG_PATH}: ${err.message}`);
  }

  cached = normalize(raw);
  cachedStamp = envStamp;
  return cached;
}

export function isBlockedPath(cfg, pathname) {
  for (const p of cfg.blockPaths) {
    if (p && pathname.startsWith(p)) return true;
  }
  return false;
}

export function isBlockedHost(cfg, host) {
  const h = String(host || '').toLowerCase();
  return cfg.blockHosts.includes(h);
}
