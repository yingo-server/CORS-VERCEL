/**
 * 下发给浏览器的运行时垫片。
 *
 * 存在理由：
 *   静态改写只能覆盖"源码里写死的 URL"。真实站点大量 URL 来自运行时拼接
 *   （fetch('/api/x')、img.src = 'https://…'、history.pushState…）。
 *   我们无法改写 Location 对象（[LegacyUnforgeable]），但可以拦截所有
 *   "URL 消费点"的入口，把跨源绝对地址导流回代理。
 *
 * 这个函数只作为源码模板使用（toString() 下发），服务端从不执行它。
 */

export function clientRuntimeSource() {
  'use strict';

  var script = document.currentScript;
  var CFG = {
    base: (script && script.getAttribute('data-vp-base')) || location.href,
    prefix: (script && script.getAttribute('data-vp-prefix')) || '/__vp',
    cookie: (script && script.getAttribute('data-vp-cookie')) || 'scoped',
    external: (script && script.getAttribute('data-vp-ext')) || 'proxy'
  };

  var upstream = null;
  try {
    upstream = new URL(CFG.base);
  } catch (e) {
    upstream = null;
  }
  if (!upstream) return;

  var PREFIX = CFG.prefix;
  var HOST = upstream.host;
  var ORIGIN = location.origin;

  function b64url(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    var CHUNK = 0x4000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function toProxy(abs) {
    if (abs.host === HOST) {
      var p = abs.pathname || '/';
      if (p.charAt(0) === '/' && p.charAt(1) === '/') return PREFIX + '/x/' + b64url(abs.href);
      return p + abs.search + abs.hash;
    }
    if (CFG.external === 'direct') return abs.href;
    // 跨源走可读的路径覆盖形态 /<host>/<path>，与服务端 parsePathOverride 一致
    return '/' + abs.host.toLowerCase() + (abs.pathname || '/') + abs.search + abs.hash;
  }

  /**
   * 把一个 URL（相对或绝对）映射为"当前代理下可访问"的形式。
   * 同源（代理自身）原样返回 —— 这是幂等的关键，避免 MutationObserver 死循环。
   */
  function mapUrl(input) {
    if (!input) return input;
    var str = String(input);
    var abs;
    try {
      abs = new URL(str, document.baseURI || location.href);
    } catch (e) {
      return input;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return input;
    if (abs.origin === ORIGIN) return input;            // 已经在代理上
    if (abs.host === HOST) return toProxy(abs);          // 上游同主机
    if (CFG.external === 'direct') return input;
    return toProxy(abs);
  }

  function safeMap(input) {
    try {
      return mapUrl(input);
    } catch (e) {
      return input;
    }
  }

  window.__VPROXY__ = {
    config: CFG,
    map: safeMap,
    upstream: upstream.href,
    prefix: PREFIX
  };

  /* ---------------- fetch ---------------- */
  if (window.fetch) {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var target = input;
      try {
        if (typeof input === 'string' || input instanceof URL) {
          target = safeMap(String(input));
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
          var mapped = safeMap(input.url);
          if (mapped !== input.url) {
            target = new Request(mapped, input);
          }
        }
      } catch (e) { /* 交给原生 fetch 抛错 */ }
      return nativeFetch.call(this, target, init);
    };
  }

  /* ---------------- XMLHttpRequest ---------------- */
  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof url === 'string' && args.length > 1) args[1] = safeMap(url);
      return nativeOpen.apply(this, args);
    };
  }

  /* ---------------- sendBeacon ---------------- */
  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon.call(navigator, safeMap(url), data);
    };
  }

  /* ---------------- EventSource（SSE 走代理流式透传） ---------------- */
  if (window.EventSource) {
    var NativeES = window.EventSource;
    window.EventSource = function (url, opts) {
      return new NativeES(safeMap(url), opts);
    };
    window.EventSource.prototype = NativeES.prototype;
  }

  /* ---------------- Worker ---------------- */
  ['Worker', 'SharedWorker'].forEach(function (name) {
    var Native = window[name];
    if (!Native) return;
    window[name] = function (url, opts) {
      return new Native(safeMap(url), opts);
    };
    window[name].prototype = Native.prototype;
  });

  /* ---------------- window.open ---------------- */
  if (window.open) {
    var nativeOpenWin = window.open;
    window.open = function (url, name, features) {
      if (typeof url === 'string') return nativeOpenWin.call(window, safeMap(url), name, features);
      return nativeOpenWin.call(window, url, name, features);
    };
  }

  /* ---------------- location 导航方法（尽力而为） ----------------
     实测 Chrome：location.assign 是 configurable:false 的实例自有属性，
     覆盖会被静默忽略（严格模式抛错）。Safari/旧 Firefox 部分版本可覆盖。
     这里仍然尝试 —— 能拦就拦，拦不住的（location.href=、location.assign）
     属浏览器安全模型硬边界，由捕获阶段 click、form submit、
     MutationObserver、HTTP 30x 改写共同兜底。 */
  try {
    ['assign', 'replace'].forEach(function (fn) {
      var native_ = location[fn];
      if (typeof native_ !== 'function') return;
      var patched = function (url) {
        try {
          return native_.call(location, safeMap(url));
        } catch (e) {
          return native_.call(location, url);
        }
      };
      try { location[fn] = patched; } catch (e) { /* 不可写：忽略 */ }
      try {
        Object.defineProperty(location, fn, { value: patched, writable: false, configurable: false });
      } catch (e) { /* 同上 */ }
    });
  } catch (e) { /* 尽力而为 */ }

  /* ---------------- history.pushState / replaceState ---------------- */
  ['pushState', 'replaceState'].forEach(function (fn) {
    var native = history[fn];
    if (typeof native !== 'function') return;
    history[fn] = function (state, title, url) {
      if (typeof url === 'string') {
        var mapped = safeMap(url);
        try {
          return native.call(history, state, title, mapped);
        } catch (e) {
          return native.call(history, state, title, url);
        }
      }
      return native.call(history, state, title, url);
    };
  });

  /* ---------------- Service Worker 禁用 ---------------- */
  if (navigator.serviceWorker) {
    try {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          register: function () {
            return Promise.reject(new Error('serviceWorker disabled by proxy'));
          },
          getRegistration: function () { return Promise.resolve(undefined); },
          getRegistrations: function () { return Promise.resolve([]); },
          addEventListener: function () {},
          removeEventListener: function () {},
          controller: null
        }
      });
    } catch (e) { /* 某些浏览器不可配置，忽略 */ }
  }

  /* ---------------- Cookie 命名空间还原 ---------------- */
  function fnv(host) {
    var h = 0x811c9dc5;
    var s = String(host || '').toLowerCase();
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  var COOKIE_HASH = fnv(HOST);

  if (CFG.cookie === 'scoped') {
    var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (desc && desc.get && desc.set) {
      Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          var raw = desc.get.call(this);
          if (!raw) return raw;
          var prefix = '__vp_' + COOKIE_HASH + '_';
          var out = [];
          var parts = raw.split(';');
          for (var i = 0; i < parts.length; i++) {
            var item = parts[i].replace(/^\s+/, '');
            if (item.indexOf(prefix) === 0) out.push(item.slice(prefix.length));
          }
          return out.join('; ');
        },
        set: function (value) {
          var v = String(value);
          var semi = v.indexOf(';');
          var pair = semi === -1 ? v : v.slice(0, semi);
          var attrs = semi === -1 ? '' : v.slice(semi);
          var eq = pair.indexOf('=');
          if (eq <= 0) {
            desc.set.call(this, v);
            return;
          }
          var name = pair.slice(0, eq);
          var rest = pair.slice(eq);
          // 去掉 Domain，代理侧统一 host-only
          attrs = attrs.replace(/;\s*domain=[^;]*/gi, '');
          desc.set.call(this, '__vp_' + COOKIE_HASH + '_' + name + rest + attrs);
        }
      });
    }
  }

  /* ---------------- DOM 兜底：JS 直接赋值/插入的元素 ---------------- */
  var URL_ATTRS = ['src', 'href', 'poster', 'action', 'data', 'formaction'];

  function fixElement(el) {
    if (!el || el.nodeType !== 1) return;
    for (var i = 0; i < URL_ATTRS.length; i++) {
      var attr = URL_ATTRS[i];
      var value = el.getAttribute && el.getAttribute(attr);
      if (!value) continue;
      if (!/^(https?:)?\/\//i.test(value)) continue;   // 相对路径本来就是对的
      var mapped = safeMap(value);
      if (mapped !== value) el.setAttribute(attr, mapped);
    }
    var srcset = el.getAttribute && el.getAttribute('srcset');
    if (srcset && /(https?:)?\/\//i.test(srcset)) {
      el.setAttribute('srcset', srcset.split(',').map(function (part) {
        var m = /^(\s*)(\S+)([\s\S]*)$/.exec(part);
        if (!m) return part;
        return m[1] + safeMap(m[2]) + m[3];
      }).join(','));
    }
  }

  if (window.MutationObserver) {
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (rec.type === 'attributes') {
          fixElement(rec.target);
        } else if (rec.type === 'childList') {
          for (var j = 0; j < rec.addedNodes.length; j++) {
            var node = rec.addedNodes[j];
            if (node.nodeType === 1) {
              fixElement(node);
              var kids = node.querySelectorAll ? node.querySelectorAll('[src],[href],[poster],[action],[data],[srcset]') : [];
              for (var k = 0; k < kids.length; k++) fixElement(kids[k]);
            }
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: URL_ATTRS.concat(['srcset'])
    });
  }

  /* ---------------- 兜底导航：绝对地址的点击 / 表单提交 ---------------- */
  document.addEventListener('click', function (event) {
    var el = event.target;
    while (el && el.nodeType === 1) {
      if (el.tagName === 'A' && el.href) {
        var abs;
        try {
          abs = new URL(el.href);
        } catch (e) { return; }
        if (abs.protocol === 'http:' || abs.protocol === 'https:') {
          if (abs.origin !== ORIGIN) {
            event.preventDefault();
            location.assign(toProxy(abs));
          }
        }
        return;
      }
      el = el.parentNode;
    }
  }, true);

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.tagName !== 'FORM') return;
    var action = form.getAttribute('action');
    if (!action) return;
    if (!/^(https?:)?\/\//i.test(action)) return;
    var mapped = safeMap(action);
    if (mapped !== action) form.setAttribute('action', mapped);
  }, true);
}

/** 供函数返回的完整脚本文本。 */
export function buildRuntimeScript() {
  return `(${clientRuntimeSource.toString()})();`;
}
