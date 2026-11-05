/**
 * Cookie 处理。
 *
 * 问题：代理把多个上游主机压平到一个浏览器源上，不同主机的同名 Cookie 会互相覆盖。
 * 方案：
 *   - scoped（默认）：Set-Cookie 的 name 加上 `__vp_<主机指纹>_` 前缀并去掉 Domain，
 *     出站时按上游主机筛选并还原 name。浏览器侧 document.cookie 由运行时垫片
 *     还原成"看起来是原生的"，页面 JS 无感。
 *   - simple：不加前缀，只去 Domain。适合单主机、且不希望任何改名的场景。
 */

/** FNV-1a 32bit，服务端与浏览器端运行时必须完全一致。 */
export function hostHash(host) {
  let h = 0x811c9dc5;
  const s = String(host || '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function scopedName(cfg, host, name) {
  if (cfg.cookieMode !== 'scoped') return name;
  return `__vp_${hostHash(host)}_${name}`;
}

export function unscopedName(name) {
  const m = /^__vp_([0-9a-f]{8})_(.+)$/.exec(name);
  if (!m) return null;
  return { hash: m[1], name: m[2] };
}

/** 单个 Set-Cookie 值 -> 面向浏览器的值。 */
export function rewriteSetCookie(cfg, raw, upstreamHost) {
  if (typeof raw !== 'string' || !raw) return null;

  // 拆出 name=value 与属性段（属性段里可能有逗号，不能整体 split(',')）
  const firstSemi = raw.indexOf(';');
  const pair = firstSemi === -1 ? raw : raw.slice(0, firstSemi);
  const attrsRaw = firstSemi === -1 ? '' : raw.slice(firstSemi);

  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  const keep = [];
  let hasPath = false;

  for (const part of attrsRaw.split(';')) {
    const attr = part.trim();
    if (!attr) continue;
    const lower = attr.toLowerCase();
    if (lower.startsWith('domain=')) continue;              // 一律去 Domain，避免污染代理域
    if (lower.startsWith('path=')) {
      hasPath = true;
      keep.push(attr);
      continue;
    }
    keep.push(attr);
  }
  if (!hasPath) keep.push('Path=/');

  return `${scopedName(cfg, upstreamHost, name)}=${value}${keep.length ? '; ' + keep.join('; ') : ''}`;
}

/** 浏览器 Cookie 头 -> 发给上游主机的 Cookie 头。 */
export function filterRequestCookies(cfg, header, upstreamHost) {
  if (!header) return '';
  if (cfg.cookieMode !== 'scoped') return header;

  const want = hostHash(upstreamHost);
  const out = [];
  for (const piece of String(header).split(';')) {
    const item = piece.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    const name = eq === -1 ? item : item.slice(0, eq);
    const meta = unscopedName(name);
    if (meta && meta.hash === want) out.push(meta.name + (eq === -1 ? '' : item.slice(eq)));
    // 无前缀（用户直接访问代理时写的）不下发，避免串味
  }
  return out.join('; ');
}
