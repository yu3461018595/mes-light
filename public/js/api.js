/* 接口封装：同一套前端，自动适配两种后端
 *   - 动态版：存在 /api/meta 的真实 Node 后端 → 走 fetch('/api...')
 *   - 静态版：CloudStudio 等纯静态托管 → 浏览器内 Store 数据层（localStorage）
 * 视图层只调用 API.get/post/...（路径不含 /api），移动 H5 调用 API.raw（含 /api）。
 */
window.API = (function () {
  const TOKEN_KEY = 'mes_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let on401 = () => {};
  let mode = 'unknown';      // 'dynamic' | 'static' | 'unknown'
  let detectPromise = null;

  // 探测当前是动态后端还是静态部署
  async function detect() {
    if (mode === 'dynamic' || mode === 'static') return mode;
    if (detectPromise) return detectPromise;
    detectPromise = (async () => {
      // 没有 Store（理论上不会，index.html 已加载 store.js）则按动态处理
      if (typeof Store === 'undefined') { mode = 'dynamic'; return mode; }
      try {
        const res = await fetch('/api/meta', { method: 'GET', cache: 'no-store' });
        const ct = res.headers.get('content-type') || '';
        // 静态托管常把未知路径回退为 HTML（text/html），必须校验 JSON 才认作动态
        if (res.ok && ct.indexOf('application/json') >= 0) { mode = 'dynamic'; return mode; }
      } catch (e) { /* 无网络 / 无后端 → 静态 */ }

      // 静态模式：初始化浏览器数据层，并按令牌恢复会话
      try { await Store.init(); } catch (e) { /* ignore */ }
      if (token && token.indexOf('static-') === 0) {
        try { Store.restoreFromToken(token); } catch (e) { /* ignore */ }
      }
      mode = 'static';
      return mode;
    })();
    return detectPromise;
  }

  async function fromStore(method, url, body) {
    const data = await Store.handle(method, url, body || {});
    if (!data.ok) throw new Error(data.msg || '操作失败');
    return data.data;
  }

  async function fromServer(method, url, body) {
    const res = await fetch('/api' + url, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('服务返回异常'); }
    if (res.status === 401) on401();
    if (!data.ok) throw new Error(data.msg || '操作失败');
    return data.data;
  }

  async function req(method, url, body) {
    await detect();
    return mode === 'static'
      ? fromStore(method, url, body)
      : fromServer(method, url, body);
  }

  return {
    // 探测（通常在页面启动早期主动调用一次，便于同步提示）
    detect,
    setToken(t) { token = t || ''; t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },
    getToken() { return token; },
    onUnauthorized(fn) { on401 = fn; },
    get: (u) => req('GET', u),
    post: (u, b) => req('POST', u, b),
    put: (u, b) => req('PUT', u, b),
    patch: (u, b) => req('PATCH', u, b),
    del: (u) => req('DELETE', u),
    // 移动 H5 直接传 /api/... 全路径：剥掉 /api 前缀后再路由
    raw(method, fullPath, body) {
      const inner = String(fullPath).replace(/^\/api/, '');
      return req(method, inner, body);
    },
  };
})();
