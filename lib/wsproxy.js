/**
 * WebSocket 代理层。
 *
 * Vercel 函数已原生支持 WebSocket（HTTP GET + Upgrade 走同一套 rewrite），
 * 因此 WS 也能享受"根路径 1:1 镜像"：浏览器 /socket 升级后连到上游 /socket。
 * 跨源 WS 用 /__vp/x/<b64> 编码通道。
 *
 * 双向用 `ws` 库分别做客户端与服务器端点，负责：
 *   - 子协议协商（先连上游，拿到上游选定的协议后再回复浏览器）
 *   - 文本/二进制帧保真转发
 *   - close code/reason 透传、ping/pong 由协议层各自维护
 *   - Cookie 命名空间、Origin/Referer 还原（与 HTTP 完全一致）
 */

import { WebSocket, WebSocketServer } from 'ws';
import { resolveIncoming, buildUpstreamUrl, isPrivateHost } from './url.js';
import { isBlockedPath, isBlockedHost } from './config.js';
import { filterRequestCookies } from './cookies.js';

const CLOSE_NORMAL = 1000;

function writeHead(socket, status, reason = '') {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason || httpStatusText(status)}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* 对端可能已断开 */
  }
}

function httpStatusText(code) {
  return {
    400: 'Bad Request', 403: 'Forbidden', 500: 'Internal Server Error',
    502: 'Bad Gateway', 503: 'Service Unavailable',
  }[code] || 'Error';
}

function abortSocket(socket) {
  try {
    socket.destroy();
  } catch { /* noop */ }
}

function parseProtocols(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 把一个可转发 close code 规范化（1005/1006 不能出现在协议帧里）。 */
function safeCloseCode(code) {
  const c = Number(code);
  if (c >= 1000 && c <= 1014 && c !== 1004 && c !== 1005 && c !== 1006) return c;
  if (c >= 3000 && c <= 4999) return c;
  return CLOSE_NORMAL;
}

/**
 * @param {() => object} getCfg 惰性取配置（测试可注入）
 */
export function createUpgradeHandler(getCfg) {
  return function handleUpgrade(req, socket, head) {
    socket.setNoDelay(true);
    socket.on('error', () => {});

    let cfg;
    try {
      cfg = getCfg();
    } catch (err) {
      writeHead(socket, 500, 'bad config');
      return abortSocket(socket);
    }

    if (cfg.websocket === false) {
      writeHead(socket, 403, 'websocket disabled');
      return abortSocket(socket);
    }

    const routed = resolveIncoming(cfg, req.url);

    let upstreamUrl;
    if (routed.kind === 'encoded') {
      if (routed.error) {
        writeHead(socket, 400, 'bad encoded ws target');
        return abortSocket(socket);
      }
      upstreamUrl = routed.upstream;
    } else if (routed.kind === 'page') {
      if (isBlockedPath(cfg, routed.rawPath)) {
        writeHead(socket, 403, 'path blocked');
        return abortSocket(socket);
      }
      try {
        upstreamUrl = buildUpstreamUrl(cfg, routed.rawPath);
      } catch {
        writeHead(socket, 400, 'bad ws path');
        return abortSocket(socket);
      }
    } else {
      writeHead(socket, 404, 'not a websocket endpoint');
      return abortSocket(socket);
    }

    if (isBlockedHost(cfg, upstreamUrl.host) || (!cfg.allowPrivateHosts && isPrivateHost(upstreamUrl.hostname))) {
      writeHead(socket, 403, 'host blocked');
      return abortSocket(socket);
    }

    const wsUrl = new URL(upstreamUrl.href);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    // 构造发给上游的握手头
    const headers = {};
    const raw = req.headers || {};
    for (const key of ['user-agent', 'sec-websocket-version', 'sec-websocket-extensions']) {
      if (raw[key]) headers[key] = Array.isArray(raw[key]) ? raw[key][0] : raw[key];
    }

    // Origin 还原为上游视角（多数 WS 服务端靠它做跨源校验）
    headers.origin = cfg.targetOrigin;

    // Referer 还原
    const referer = raw.referer || raw.referrer;
    if (referer) {
      try {
        const r = new URL(referer);
        const fromEncoded = r.pathname.indexOf(cfg.prefix + '/x/') === 0;
        if (fromEncoded) {
          headers.referer = Buffer.from(r.pathname.slice((cfg.prefix + '/x/').length), 'base64url').toString('utf8');
        } else {
          headers.referer = cfg.targetOrigin + r.pathname + r.search;
        }
      } catch { /* 忽略坏 referer */ }
    }

    // Cookie 命名空间还原
    const cookie = filterRequestCookies(cfg, raw.cookie, upstreamUrl.host);
    if (cookie) headers.cookie = cookie;

    const clientProtocols = parseProtocols(raw['sec-websocket-protocol']);
    let settled = false;

    const upstream = new WebSocket(wsUrl, clientProtocols, {
      headers,
      handshakeTimeout: 15000,
      followRedirects: true,
      perMessageDeflate: false,
      maxPayload: 0, // 不限制，透传
    });

    const cleanup = () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    };

    socket.on('close', cleanup);
    socket.on('end', cleanup);

    upstream.on('error', (err) => {
      if (settled) return;
      settled = true;
      const status = /Unexpected server response/.test(err?.message || '') ? 502 : 503;
      writeHead(socket, status, 'upstream ws failed');
      abortSocket(socket);
    });

    upstream.on('open', () => {
      if (settled) return;
      settled = true;
      const chosenProtocol = upstream.protocol; // 上游选定的子协议（可能为空）

      const wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: 0,
        // 只有上游选定某个协议时，才在响应里宣告同一个
        handleProtocols: chosenProtocol ? () => chosenProtocol : undefined,
      });

      // 握手完成前上游可能已经发来消息（常见于"连接即欢迎语"的服务端），
      // 先缓存，客户端连上后立即冲刷 —— 这是 WS 代理最容易踩丢首帧的竞态。
      const pending = [];
      let clientSocket = null;

      const broadcast = (data, isBinary) => {
        if (clientSocket && clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(data, { binary: isBinary });
        } else {
          pending.push([data, isBinary]);
        }
      };

      wss.on('connection', (client) => {
        clientSocket = client;
        for (const [data, isBinary] of pending.splice(0)) {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        }
        client.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary: isBinary });
          }
        });
        client.on('close', (code, reason) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.close(safeCloseCode(code), reason?.toString?.().slice(0, 123));
          }
        });
        client.on('error', () => cleanup());
      });

      upstream.on('message', broadcast);
      upstream.on('close', (code, reason) => {
        if (clientSocket && clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.close(safeCloseCode(code), reason?.toString?.().slice(0, 123));
        }
      });

      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req);
      });
    });
  };
}
