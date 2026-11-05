/**
 * 测试辅助：统一构造配置、启动本地服务。
 * 配置通过环境变量注入，避免测试去读仓库里的 proxy.config.json（那是给用户改的）。
 */
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const UPSTREAM_PORT = 4517;
export const PROXY_PORT = 4518;
export const UPSTREAM_ORIGIN = `http://127.0.0.1:${UPSTREAM_PORT}`;

const dir = mkdtempSync(join(tmpdir(), 'vproxy-test-'));
export const CONFIG_PATH = join(dir, 'proxy.config.json');

writeFileSync(CONFIG_PATH, JSON.stringify({
  target: UPSTREAM_ORIGIN,
  allowPrivateHosts: true,
  external: 'proxy',
  cookieMode: 'scoped',
  debug: false,
}), 'utf8');

process.env.PROXY_CONFIG_PATH = CONFIG_PATH;
process.env.PROXY_TARGET = UPSTREAM_ORIGIN;
process.env.PROXY_CONFIG_RELOAD = String(Date.now());

const { loadConfig } = await import('../lib/config.js');

export const cfg = loadConfig({ force: true });

export function startServer(port, requestListener) {
  const server = http.createServer(requestListener);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
