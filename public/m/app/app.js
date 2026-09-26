/* 智工 · 移动工作台（APP 雏形）
 * 设计要点：
 *   1) 免安装——用 PWA/H5 承载；打包成 Android APK 时（Capacitor）页面与逻辑零改动。
 *   2) 双端兼容——所有请求走 API.raw()，动态部署走 /api，静态演示走浏览器数据层 store.js。
 *   3) 消息中心——未读角标 + 前台 15s 轮询（WiFi 下即可实时），点击消息按 link 跳转对应业务页。
 *   4) 员工自助——账号密码登录、改密码（需原密码）、改姓名、退出登录。
 */
(function () {
  const $view = document.getElementById('view');
  const $title = document.getElementById('tbTitle');
  const $back = document.getElementById('tbBack');
  const $tabbar = document.getElementById('tabbar');
  const $badge = document.getElementById('tbBadge');
  const $tabBadge = document.querySelector('[data-badge="messages"]');

  const LS_TOKEN = 'mes_token';
  const LS_REMEMBER = 'mes_remember';
  const LS_USERNAME = 'mes_username';
  const LS_PUSH = 'mes_push_on';

  const S = {
    me: null,            // 当前登录用户
    route: '',           // 当前路由（#/home、#/messages…）
    stack: [],           // 简单返回栈
    unread: 0,
    bySource: {},
    sources: [],         // 消息场景字典
    order: null, steps: [], workers: [], badReasons: [],
    sel: new Set(), vals: {},
    msgs: [], msgFilter: '',
    pollTimer: null,
  };
  const ALLOWED = ['admin', 'technician', 'inspector', 'worker'];
  const ROLE_LABEL = { admin: '管理员', technician: '技术员', inspector: '质检员', worker: '操作工' };
  const BADGE = { created: ['待处理', 'b-released'], released: ['已下发', 'b-released'], running: ['生产中', 'b-running'],
    paused: ['已暂停', 'b-paused'], done: ['已完成', 'b-done'], closed: ['已关闭', 'b-closed'] };
  const LEVEL_LABEL = { minor: '轻微', major: '严重', critical: '致命' };
  const ISSUE_STATUS = { open: '待处理', processing: '处理中', verifying: '待验证', closed: '已闭环', cancelled: '已作废' };
  const INSPECT_LABEL = { iqc: '首检', ipqc: '过程检', fqc: '终检' };
  const SRC_ICON = { quality: '⚠️', stock: '📦', assign: '🧰', system: '🔔' };

  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); };
  const token = () => API.getToken();

  function relTime(ts) {
    if (!ts) return '';
    const t = new Date(String(ts).replace(' ', 'T')).getTime();
    if (!Number.isFinite(t)) return String(ts);
    const d = Date.now() - t;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
    return String(ts).slice(0, 16).replace('T', ' ');
  }
  function ago(ts) {
    if (!ts) return '—';
    const t = new Date(String(ts).replace(' ', 'T')).getTime();
    if (!Number.isFinite(t)) return String(ts);
    const d = Date.now() - t;
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  /* ---------------- 基础设施：请求 / toast / 弹层 ---------------- */
  async function get(path) { return API.raw('GET', path); }
  async function post(path, body) { return API.raw('POST', path, body); }
  function toast(msg, ms) {
    const box = document.getElementById('toastBox');
    box.innerHTML = '';   // 同一时刻只显示一条，避免旧提示残留造成误解
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), ms || 2200);
  }
  function sheet(html) {
    const mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.innerHTML = `<div class="sheet">${html}</div>`;
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    document.getElementById('sheetBox').appendChild(mask);
    return mask;
  }
  function okMask(title, detail, buttons) {
    const mask = document.createElement('div');
    mask.className = 'ok-mask';
    mask.innerHTML = `<div class="ok-circle"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18"/></svg></div>
      <div class="big">${esc(title)}</div>${detail ? `<div class="sm">${detail}</div>` : ''}
      <div style="width:100%;max-width:300px;display:flex;flex-direction:column;gap:10px;margin-top:6px">
        ${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.text)}</button>`).join('')}
      </div>`;
    document.body.appendChild(mask);
    mask.querySelectorAll('[data-i]').forEach((el) => {
      el.onclick = () => { mask.remove(); const f = buttons[Number(el.dataset.i)].onClick; if (f) f(); };
    });
    return mask;
  }

  /* ---------------- 未读消息轮询与角标 ---------------- */
  function paintBadge(n) {
    S.unread = n || 0;
    const txt = n > 99 ? '99+' : String(n);
    [$badge, $tabBadge].forEach((el) => {
      if (!el) return;
      el.hidden = !n;
      if (n) el.textContent = txt;
    });
  }
  async function refreshUnread() {
    if (!token()) return paintBadge(0);
    try {
      const r = await get('/api/notifications/unread_count');
      S.bySource = (r && r.by_source) || {};
      paintBadge((r && r.count) || 0);
    } catch (e) { /* 网络抖动忽略 */ }
  }
  function startPoll() {
    stopPoll();
    S.pollTimer = setInterval(() => { if (!document.hidden) refreshUnread(); }, 15000);
  }
  function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token()) refreshUnread(); });

  /* ---------------- 路由 ---------------- */
  const TITLES = {
    home: '工作台', messages: '消息', mine: '我的', order: '报工', inspect: '质检台',
    quality: '质量异常', issue: '异常详情', stocks: '库存预警', profile: '个人资料', password: '修改密码',
  };
  function nav(hash, replace) {
    if (replace) location.replace(hash); else location.hash = hash;
  }
  function parseHash() {
    const h = (location.hash || '#/home').replace(/^#\/?/, '');
    const seg = h.split('/').filter(Boolean);
    return { name: seg[0] || 'home', args: seg.slice(1) };
  }
  async function route() {
    const { name, args } = parseHash();
    S.route = name;
    const needAuth = !!token();
    // 未登录：非 login 页一律回到登录页；已登录还停在 login 页则跳工作台
    if (!needAuth) return renderLogin();
    if (name === 'login') return nav('#/home', true);

    $tabbar.hidden = !['home', 'messages', 'mine'].includes(name);
    $view.className = $tabbar.hidden ? '' : 'has-tab';
    $tabbar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    $back.hidden = !['order', 'inspect', 'quality', 'issue', 'stocks', 'profile', 'password'].includes(name);
    $title.textContent = TITLES[name] || '智工';
    $view.innerHTML = '<div class="loading">加载中…</div>';

    try {
      switch (name) {
        case 'home': return await renderHome();
        case 'messages': return await renderMessages();
        case 'mine': return await renderMine();
        case 'order': return await renderOrder(args[0]);
        case 'inspect': return await renderInspect();
        case 'quality': return await renderQuality();
        case 'issue': return await renderIssue(args[0]);
        case 'stocks': return await renderStocks();
        case 'profile': return await renderProfile();
        case 'password': return await renderPassword();
        default: return void okMask('页面不存在', '即将返回工作台', [{ text: '返回', onClick: () => nav('#/home', true) }]);
      }
    } catch (e) {
      renderError(e.message || '加载失败');
    }
  }
  function renderError(msg) {
    $view.innerHTML = `<div class="empty"><div class="ico">⚠️</div><p>${esc(msg)}</p>
      <div style="margin-top:16px"><button class="btn ghost" id="retry" style="max-width:200px;margin:0 auto">重新加载</button></div></div>`;
    const b = $view.querySelector('#retry');
    if (b) b.onclick = () => route();
  }

  /* ---------------- 登录 / 登出 ---------------- */
  function renderLogin() {
    $tabbar.hidden = true;
    $back.hidden = true;
    $title.textContent = '登录';
    $view.className = '';
    const remembered = localStorage.getItem(LS_REMEMBER) === '1';
    const lastUser = localStorage.getItem(LS_USERNAME) || '';
    $view.innerHTML = `
      <div class="login-wrap">
        <div class="login-logo">智</div>
        <div class="login-title">智工 · 移动工作台</div>
        <div class="login-sub">工单报工 · 质检 · 消息通知</div>
        <div class="login-box">
          <div class="field"><span>账号</span>
            <input class="ipt" id="fUser" type="text" autocomplete="username" placeholder="请输入工号 / 用户名" value="${esc(lastUser)}"></div>
          <div class="field"><span>密码</span>
            <input class="ipt" id="fPass" type="password" autocomplete="current-password" placeholder="请输入密码"></div>
          <label class="remember"><input type="checkbox" id="fRemember" ${remembered ? 'checked' : ''}>记住账号</label>
          <button class="btn" id="fLogin">登 录</button>
          <div class="tiny center" style="margin-top:12px">忘记密码请联系管理员重置</div>
        </div>
        <div class="login-foot">登录后可在「我的」中修改密码<br>员工可用工号登录；二维码扫码报工仍可直接使用</div>
      </div>`;
    const doLogin = async () => {
      const username = $view.querySelector('#fUser').value.trim();
      const password = $view.querySelector('#fPass').value;
      if (!username || !password) return toast('请输入账号和密码');
      const btn = $view.querySelector('#fLogin');
      btn.disabled = true; btn.textContent = '登录中…';
      try {
        const r = await post('/api/login', { username, password });
        if ($view.querySelector('#fRemember').checked) {
          localStorage.setItem(LS_REMEMBER, '1'); localStorage.setItem(LS_USERNAME, username);
        } else {
          localStorage.removeItem(LS_REMEMBER); localStorage.removeItem(LS_USERNAME);
        }
        API.setToken(r.token);
        S.me = r.user;
        if (!ALLOWED.includes(r.user.role)) {
          await post('/api/logout').catch(() => {});
          API.setToken('');
          btn.disabled = false; btn.textContent = '登 录';
          return toast('该角色暂不支持移动端登录');
        }
        toast('欢迎，' + r.user.name);
        startPoll(); refreshUnread();
        nav('#/home', true);
      } catch (e) {
        btn.disabled = false; btn.textContent = '登 录';
        toast(e.message);
      }
    };
    $view.querySelector('#fLogin').onclick = doLogin;
    $view.querySelector('#fPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    $view.querySelector('#fUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $view.querySelector('#fPass').focus(); });
  }

  async function doLogout() {
    const ask = () => new Promise((resolve) => {
      if (typeof window.confirm !== 'function') return resolve(true);
      let done = false;
      try { resolve(Boolean(window.confirm('确定退出登录？'))); done = true; } catch (e) { /* 降级 */ }
      if (!done) resolve(true);
    });
    if (!(await ask())) return;
    try { await post('/api/logout'); } catch (e) { /* 忽略 */ }
    API.setToken('');
    S.me = null; stopPoll(); paintBadge(0);
    nav('#/login', true);
  }

  async function ensureMe() {
    if (S.me) return S.me;
    S.me = await get('/api/me');
    return S.me;
  }

  /* ---------------- 页面：工作台 ---------------- */
  async function renderHome() {
    const me = await ensureMe();
    const isInspector = me.role === 'inspector';
    const isManager = me.role === 'admin' || me.role === 'technician';
    const [orders, openIssues, stocks] = await Promise.all([
      get('/api/app/my_orders').then((r) => r.orders || []).catch(() => []),
      get('/api/quality_issues?open=1').then((r) => r || []).catch(() => []),
      isManager ? get('/api/stock_alerts').then((r) => r || []).catch(() => []) : Promise.resolve([]),
    ]);
    let inspectQ = [];
    if (isInspector || isManager) {
      inspectQ = await get('/api/inspections/queue').then((r) => r.steps || []).catch(() => []);
    }
    // worker 只看自己相关；technician/admin 看全部；inspector 看该班组
    const mineIssues = isManager ? openIssues : openIssues.filter((x) => String(x.assignee_user_id) === String(me.id));
    const blocks = [];

    blocks.push(`<div class="card"><div class="card-b">
      <div class="row" style="align-items:flex-start">
        <div><div class="ocode">你好，${esc(me.name)}</div>
          <div class="pname">${esc(me.team || '未分组')} · ${esc(ROLE_LABEL[me.role] || me.role)}</div></div>
        <button class="inline-link" id="hRefresh">刷新</button>
      </div></div></div>`);

    // 快捷统计
    const tiles = [
      { k: '待报工单', v: orders.length, tab: 'orders', color: '#1d4ed8' },
      { k: isInspector || isManager ? '待检工序' : '待办异常', v: isInspector || isManager ? inspectQ.length : mineIssues.length, tab: isInspector || isManager ? 'inspect' : 'quality', color: '#e08a00' },
      { k: '未读消息', v: S.unread, tab: 'messages', color: '#d93b3b' },
    ];
    if (isManager) tiles.push({ k: '库存预警', v: stocks.length, tab: 'stocks', color: '#0f9d58' });
    blocks.push(`<div class="card nopad"><div style="display:flex;text-align:center">
      ${tiles.map((t) => `<div class="tile" data-go="${t.tab}" style="flex:1 1 0;padding:14px 4px">
        <div style="font-size:22px;font-weight:800;color:${t.color}">${t.v}</div>
        <div class="tiny" style="margin-top:2px">${t.k}</div></div>`).join('')}
    </div></div>`);

    // 待办异常（排最前，最需要处理）
    if (mineIssues.length) {
      blocks.push(`<div class="card"><div class="card-h"><h3>待处理质量异常 <span class="tiny">(${mineIssues.length})</span></h3>
        <button class="inline-link" data-go="quality">全部 ›</button></div>
        <div class="card-b" style="padding:6px 0 0">
        ${mineIssues.slice(0, 3).map((it) => `
          <div class="item" data-issue="${it.id}">
            <div class="avatar" style="background:#fdecec">⚠️</div>
            <div class="body">
              <div class="t1">${esc(it.code)} <span class="badge lv-${esc(it.level)}">${esc(LEVEL_LABEL[it.level] || it.level)}</span></div>
              <div class="t2">${esc(it.process_name || '')} · 不良 ${it.qty_affected} 件<br>${esc(it.bad_summary || '')}</div>
              <div class="t3"><span>${esc(ISSUE_STATUS[it.status] || it.status)}</span><span>${esc(ago(it.created_at))}</span></div>
            </div>
            <div class="chev">›</div>
          </div>`).join('')}
        </div></div>`);
    }

    // 待检（质检员）
    if ((isInspector || isManager) && inspectQ.length) {
      blocks.push(`<div class="card"><div class="card-h"><h3>待检工序 <span class="tiny">(${inspectQ.length})</span></h3>
        <button class="inline-link" data-go="inspect">质检台 ›</button></div>
        <div class="card-b" style="padding:6px 0 0">
        ${inspectQ.slice(0, 3).map((s) => `
          <div class="item" data-go="inspect">
            <div class="avatar" style="background:#e8efff">🔍</div>
            <div class="body">
              <div class="t1">${esc(s.order_code)} · 第 ${s.seq} 道 ${esc(s.process_name)}</div>
              <div class="t2">${esc(s.product_name || '')} · 已报合格 ${s.qty_good}/${s.qty_plan}</div>
              <div class="t3"><span class="badge b-paused">${esc(INSPECT_LABEL[s.inspect_type] || '检验')}</span>
                <span>指派班组 ${esc(s.assignee_team || '暂无')}</span></div>
            </div>
            <div class="chev">›</div>
          </div>`).join('')}
        </div></div>`);
    }

    // 我的工单
    blocks.push(`<div class="card"><div class="card-h"><h3>我的在制工单 <span class="tiny">(${orders.length})</span></h3>
      <button class="inline-link" id="hScan">扫码报工</button></div>
      <div class="card-b" style="padding:6px 0 0">
      ${orders.length ? orders.slice(0, 5).map((o) => {
        const pct = o.qty_plan > 0 ? Math.round((o.qty_done / o.qty_plan) * 100) : 0;
        return `<div class="item" data-order="${o.id}">
          <div class="avatar" style="background:#eef2fb">🧾</div>
          <div class="body">
            <div class="t1">${esc(o.code)} ${badge(o.status)}</div>
            <div class="t2">${esc(o.product_name || '')}${o.spec ? ' · ' + esc(o.spec) : ''}</div>
            <div class="bar" style="margin-top:7px"><i style="width:${pct}%"></i></div>
            <div class="prog-txt"><span>完工 ${o.qty_done}/${o.qty_plan}</span><span>${pct}%</span></div>
          </div>
        </div>`;
      }).join('') : `<div class="empty" style="padding:26px 16px"><p>暂无在制工单</p>
        <p class="tiny">工单下发并指派到「${esc(me.team || '你的班组')}」后会出现在这里</p></div>`}
      </div></div>`);

    if (isManager) {
      blocks.push(`<div class="card"><div class="card-h"><h3>管理快捷入口</h3></div>
        <div class="card-b" style="padding:6px 0 0">
          <div class="item" data-go="stocks"><div class="avatar" style="background:#fff3e0">📦</div>
            <div class="body"><div class="t1">库存预警</div><div class="t2">${stocks.length ? '当前 ' + stocks.length + ' 项物料低于安全库存' : '库存状态正常'}</div></div><div class="chev">›</div></div>
        </div></div>`);
    }

    $view.innerHTML = blocks.join('') + '<div style="height:8px"></div>';
    bindGo();
    $view.querySelectorAll('[data-order]').forEach((el) => el.onclick = () => nav('#/order/' + el.dataset.order));
    $view.querySelectorAll('[data-issue]').forEach((el) => el.onclick = () => nav('#/issue/' + el.dataset.issue));
    const rf = $view.querySelector('#hRefresh');
    if (rf) rf.onclick = async () => { await refreshUnread(); toast('已刷新'); route(); };
    const sc = $view.querySelector('#hScan');
    if (sc) sc.onclick = () => openScanPicker();
  }

  // 首页统计块 / 内联链接 → 跳转
  function bindGo() {
    $view.querySelectorAll('[data-go]').forEach((el) => {
      el.onclick = () => {
        const t = el.dataset.go;
        if (t === 'orders') { const first = $view.querySelector('[data-order]'); if (first) return nav('#/order/' + first.dataset.order); return toast('暂无在制工单'); }
        nav('#/' + t);
      };
    });
  }

  /* ---------------- 页面：报工 ---------------- */
  async function renderOrder(orderId) {
    if (!orderId) {
      const r = await get('/api/app/my_orders');
      const list = r.orders || [];
      if (!list.length) return renderError('暂无在制工单');
      return nav('#/order/' + list[0].id, true);
    }
    const data = await get('/api/app/order/' + orderId);
    S.order = data.order; S.steps = data.steps || []; S.workers = data.workers || [];
    S.badReasons = data.badReasons || [];
    S.sel = new Set(); S.vals = {};
    paintOrder();
  }

  function badge(st) { const m = BADGE[st] || [st, 'b-released']; return `<span class="badge ${m[1]}">${esc(m[0])}</span>`; }
  const canReport = (s) => Number(s.allow_report) !== 0 && s.status !== 'done';

  function paintOrder() {
    const o = S.order;
    const closed = ['done', 'closed'].includes(o.status);
    const pct = o.qty_plan > 0 ? Math.round((o.qty_done / o.qty_plan) * 100) : 0;
    const selCount = S.steps.filter((s) => S.sel.has(s.id) && canReport(s)).length;

    const stepCards = S.steps.map((s) => {
      const lock = Number(s.allow_report) === 0;
      const done = s.status === 'done';
      const sel = S.sel.has(s.id);
      const cls = ['step'];
      if (sel) cls.push('sel');
      if (lock || done) cls.push('locked');
      const v = S.vals[s.id] || { good: '', min: '', badRows: [{ reason: '', qty: '', detail: '' }] };
      const waiting = String(s.inspect_status || '') === 'waiting';
      const failed = String(s.inspect_status || '') === 'failed';
      const note = lock ? '<span class="st-lock">🔒 需管理员/技术员报工</span>'
        : failed ? '<span class="st-lock">⚠️ 检验不合格，待异常处理</span>'
        : waiting ? '<span class="st-lock" style="color:#e08a00;background:#fff3e0">⏳ 已报工，待检验</span>'
        : (done ? '<span class="st-lock" style="color:#6b7682;background:#eef1f5">已完成</span>' : '');
      const body = (sel && canReport(s)) ? `
        <div class="st-body">
          <div class="field" style="margin-bottom:12px"><span>合格数量</span>
            <div class="stepper">
              <button type="button" class="dec" data-dec="${s.id}" aria-label="减少"></button>
              <input id="g${s.id}" type="number" inputmode="numeric" min="0" value="${esc(v.good)}">
              <button type="button" class="inc" data-inc="${s.id}" aria-label="增加"></button>
            </div></div>
          <div class="field" style="margin-bottom:12px"><span>工时（小时，选填）</span>
            <input id="w${s.id}" class="ipt" type="number" inputmode="decimal" min="0" step="0.5" placeholder="如 2" value="${esc(v.min)}"></div>
          <div class="field" style="margin-bottom:4px"><span>不良明细（可多种）</span>
            <div class="badrows" id="br${s.id}"></div></div>
        </div>` : '';
      return `<div class="${cls.join(' ')}" data-s="${s.id}">
        <div class="st-main">
          <div class="st-nm">${s.seq}. ${esc(s.process_name)}</div>
          <div class="st-sub">${esc(s.process_code || '')} · 指派班组 ${esc(s.assignee_team || '暂无')}${
            s.inspect_type ? ' · 检验点 ' + esc(INSPECT_LABEL[s.inspect_type] || '检验') : ''}<br>已报 ${s.qty_good}/${s.qty_plan}${s.qty_bad ? ' · 不良 ' + s.qty_bad : ''}</div>
          ${note}
        </div>
        ${canReport(s) ? `<div class="st-tick">${sel ? '✓' : ''}</div>` : ''}
        ${body}
      </div>`;
    }).join('');

    $view.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">${esc(o.code)}</div>
        <div class="pname">${esc(o.product_name || '')} ${esc(o.spec || '')}</div>
        <div style="margin-top:8px">${badge(o.status)}</div>
        <div class="bar" style="margin-top:10px"><i style="width:${pct}%"></i></div>
        <div class="prog-txt"><span>已完工 ${o.qty_done}/${o.qty_plan}</span><span>${pct}%</span></div>
      </div></div>
      ${closed ? `<div class="card"><div class="card-b center muted">该工单已${o.status === 'closed' ? '关闭' : '完成'}，不可再报工。</div></div>`
      : `<div class="card"><div class="card-h"><h3>选择工序（可多选）</h3>
          <div style="display:flex;gap:12px">
            <button class="inline-link" id="selAll">全选</button>
            <button class="inline-link" id="selNone">清空</button></div></div>
        <div class="card-b">${stepCards}</div>
        <div class="tiny" style="padding:0 15px 14px">已选 <b style="color:#1d4ed8">${selCount}</b> 道工序</div>
      </div>
      <div class="card"><div class="card-h"><h3>提交报工</h3></div><div class="card-b">
        <div class="field"><span>报工人</span><input class="ipt" value="${esc((S.me && S.me.name) || '')}" disabled></div>
        <button class="btn" id="submit" ${selCount ? '' : 'disabled'}>提交报工（${selCount} 道）</button>
      </div></div>`}
      <div style="height:10px"></div>`;

    if (closed) return;
    $view.querySelectorAll('[data-s]').forEach((el) => el.onclick = (e) => {
      if (e.target.closest('.st-body')) return;
      const id = num(el.dataset.s);
      const s = S.steps.find((x) => x.id === id);
      if (!canReport(s)) { toast(s.status === 'done' ? '该工序已完成' : '该工序暂不可由你报工'); return; }
      readVals();
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      paintOrder();
    });
    $view.querySelector('#selAll').onclick = () => { readVals(); S.steps.forEach((s) => { if (canReport(s)) S.sel.add(s.id); }); paintOrder(); };
    $view.querySelector('#selNone').onclick = () => { readVals(); S.sel.clear(); paintOrder(); };
    S.steps.forEach((s) => {
      if (!S.sel.has(s.id) || !canReport(s)) return;
      const g = $view.querySelector('#g' + s.id);
      const clamp = (v) => Math.max(0, Math.floor(num(v)));
      $view.querySelector('[data-dec="' + s.id + '"]').onclick = () => { g.value = Math.max(0, clamp(g.value) - 10); S.vals[s.id] = Object.assign(readOne(s), { good: g.value }); };
      $view.querySelector('[data-inc="' + s.id + '"]').onclick = () => { g.value = clamp(g.value) + 10; S.vals[s.id] = Object.assign(readOne(s), { good: g.value }); };
      renderBadRows(s.id);
    });
    bindBadRows();
    const sb = $view.querySelector('#submit');
    if (sb) sb.onclick = submitReport;
  }

  /* 不良明细多行（一道工序多种不良，填一种自动出下一种） */
  function ensureBadRows(v) {
    if (!v.badRows || !v.badRows.length) v.badRows = [{ reason: '', qty: '', detail: '' }];
    const last = v.badRows[v.badRows.length - 1];
    if (last.reason || last.qty) v.badRows.push({ reason: '', qty: '', detail: '' });
  }
  function renderBadRows(sid) {
    if (!S.vals[sid]) S.vals[sid] = readOne(S.steps.find((x) => x.id === num(sid)) || {});
    const v = S.vals[sid]; if (!v) return;
    ensureBadRows(v);
    const box = $view.querySelector('#br' + sid); if (!box) return;
    box.innerHTML = v.badRows.map((row, i) => {
      const isOther = (S.badReasons || []).find((x) => String(x.id) === String(row.reason) && x.name === '其他');
      return `<div class="brow" data-i="${i}">
        <select class="ipt brow-reason" style="flex:2 1 0;min-width:0;padding-right:30px">
          <option value="">无不良</option>
          ${(S.badReasons || []).map((x) => `<option value="${x.id}"${String(row.reason) === String(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select>
        <input class="ipt brow-qty" type="number" inputmode="numeric" min="0" placeholder="数量" style="flex:1 1 0;min-width:0" value="${esc(row.qty)}">
        ${isOther ? `<input class="ipt brow-detail" type="text" placeholder="具体原因" style="flex:2 1 0;min-width:0" value="${esc(row.detail || '')}">` : ''}
        <button type="button" class="brow-del">×</button>
      </div>`;
    }).join('') + '<div class="mask-hint">填一种不良原因后会自动出现下一行，可登记多种</div>';
  }
  function bindBadRows() {
    if (S._badBound) return; S._badBound = true;
    $view.addEventListener('change', (e) => {
      const br = e.target.closest('.brow'); if (!br) return;
      const box = br.closest('.badrows'); if (!box) return;
      const sid = num(box.id.slice(2)), i = num(br.dataset.i), v = S.vals[sid]; if (!v) return;
      if (e.target.classList.contains('brow-reason')) { v.badRows[i].reason = e.target.value; renderBadRows(sid); }
    });
    $view.addEventListener('input', (e) => {
      const br = e.target.closest('.brow'); if (!br) return;
      const box = br.closest('.badrows'); if (!box) return;
      const sid = num(box.id.slice(2)), i = num(br.dataset.i), v = S.vals[sid]; if (!v) return;
      if (e.target.classList.contains('brow-qty')) v.badRows[i].qty = e.target.value;
      if (e.target.classList.contains('brow-detail')) v.badRows[i].detail = e.target.value;
    });
    $view.addEventListener('click', (e) => {
      if (!e.target.classList.contains('brow-del')) return;
      const br = e.target.closest('.brow'), box = br.closest('.badrows'); if (!box) return;
      const sid = num(box.id.slice(2)), i = num(br.dataset.i), v = S.vals[sid]; if (!v) return;
      if (v.badRows.length > 1) { v.badRows.splice(i, 1); renderBadRows(sid); }
    });
  }
  // 读单个工序的当前输入
  function readOne(s) {
    const g = $view.querySelector('#g' + s.id), w = $view.querySelector('#w' + s.id);
    const prev = S.vals[s.id] || { badRows: [{ reason: '', qty: '', detail: '' }] };
    const box = $view.querySelector('#br' + s.id);
    let badRows = prev.badRows;
    if (box) {
      const rows = [...box.querySelectorAll('.brow')].map((br) => {
        const det = br.querySelector('.brow-detail');
        return { reason: br.querySelector('.brow-reason').value, qty: br.querySelector('.brow-qty').value, detail: det ? det.value : '' };
      });
      badRows = rows.length ? rows : [{ reason: '', qty: '', detail: '' }];
    }
    return {
      good: g ? Math.max(0, Math.floor(num(g.value))) : num(prev.good),
      min: w && w.value !== '' ? Math.max(0, num(w.value)) : (prev.min || ''),
      badRows,
    };
  }
  function readVals() { S.steps.forEach((s) => { if (S.sel.has(s.id) && canReport(s)) S.vals[s.id] = readOne(s); }); }

  async function submitReport() {
    readVals();
    const steps = S.steps.filter((s) => S.sel.has(s.id) && canReport(s)).map((s) => {
      const v = S.vals[s.id] || { good: 0, min: '', badRows: [] };
      const badRows = (v.badRows || []).filter((r) => r.reason && num(r.qty) > 0).map((r) => {
        const isOther = (S.badReasons || []).find((x) => String(x.id) === String(r.reason) && x.name === '其他');
        return { bad_reason_id: num(r.reason), qty: num(r.qty), bad_reason_detail: isOther ? String(r.detail || '').trim() : '' };
      });
      const totalBad = badRows.reduce((a, e) => a + e.qty, 0);
      return { order_step_id: s.id, qty_good: num(v.good), qty_bad: totalBad, bad_reasons: badRows, work_min: num(v.min) * 60 };
    }).filter((x) => (x.qty_good + x.qty_bad) > 0);
    if (!steps.length) return toast('请选择工序并填写合格/不良数量');
    const btn = $view.querySelector('#submit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const r = await post('/api/app/reports', { order_id: S.order.id, steps, report_date: today(), remark: '' });
      const auto = (r && r.steps || []).filter((x) => x.autoFinishIn);
      const autoQty = auto.reduce((a, x) => a + num(x.autoFinishIn.qty), 0);
      const need = (r && r.steps || []).filter((x) => x.needInspect).length;
      okMask('报工成功', [
        autoQty ? `末道工序已自动成品入库 ${autoQty} 件` : '',
        need ? `${need} 道工序已转入待检，质检员已收到通知` : '',
        '已通知对应技术员',
      ].filter(Boolean).join('<br>'), [
        { text: '继续报工本单', cls: 'ghost', onClick: () => renderOrder(S.order.id) },
        { text: '返回工作台', onClick: () => nav('#/home') },
      ]);
    } catch (e) {
      btn.disabled = false; btn.textContent = '提交报工';
      toast(e.message);
    }
  }

  /* 扫码报工入口：解析二维码 URL 后跳转免登录页 */
  function openScanPicker() {
    const mask = sheet(`<h3>扫码报工</h3><div class="sub">用手机相机扫描工单二维码；也可手动输入工单号</div>
      <div class="field"><span>工单号 / 二维码链接</span>
        <input class="ipt" id="scInput" placeholder="如 MO20260918001 或粘贴二维码链接"></div>
      <button class="btn" id="scGo">打开报工页</button>
      <div class="tiny center" style="margin-top:12px">也可用微信/系统相机直接扫工单二维码进入报工页</div>`);
    mask.querySelector('#scGo').onclick = async () => {
      const raw = mask.querySelector('#scInput').value.trim();
      if (!raw) return toast('请输入工单号或链接');
      mask.remove();
      if (/^https?:|^\/m\//.test(raw)) { location.href = raw; return; }
      try {
        const list = await get('/api/app/my_orders');
        const hit = (list.orders || []).find((o) => o.code === raw);
        if (!hit) return toast('未找到该工单（或未指派到你的班组）');
        nav('#/order/' + hit.id);
      } catch (e) { toast(e.message); }
    };
  }

  /* ---------------- 页面：质检台 ---------------- */
  async function renderInspect() {
    const data = await get('/api/inspections/queue');
    const list = data.steps || [];
    S.badReasons = data.badReasons || [];
    $view.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">质检台</div>
        <div class="pname">${esc((S.me && S.me.name) || data.worker.name)} · 待检 <b>${list.length}</b> 道工序</div>
      </div></div>
      ${list.length ? list.map((s) => {
        const isFinal = String(s.inspect_type) === 'fqc';
        return `<div class="card insp" data-s="${s.order_step_id}"><div class="card-b">
          <div class="ocode" style="font-size:16px">${esc(s.order_code)} · 第 ${s.seq} 道 ${esc(s.process_name)}
            <span class="badge ${isFinal ? 'b-paused' : 'b-released'}">${esc(INSPECT_LABEL[s.inspect_type] || '检验')}</span></div>
          <div class="pname">${esc(s.product_name || '')} · 计划 ${s.qty_plan} · 已报合格 ${s.qty_good}${s.qty_bad ? ' · 自报不良 ' + s.qty_bad : ''}</div>
          <div class="pname">指派班组 ${esc(s.assignee_team || '暂无')} · 最近报工人 ${esc(s.last_worker || '—')}</div>
          <div style="margin-top:12px">
            <div class="field" style="margin-bottom:10px"><span>本次受检数（合格）</span>
              <input class="ipt qi-pass" type="number" inputmode="numeric" min="0" value="${s.qty_good}"></div>
            <div class="field" style="margin-bottom:10px"><span>不合格数</span>
              <input class="ipt qi-fail" type="number" inputmode="numeric" min="0" value="0"></div>
            <div class="field" style="margin-bottom:6px"><span>不良明细（不合格时必填）</span>
              <div class="badrows" data-rows="${s.order_step_id}" id="br${s.order_step_id}"></div></div>
          </div>
          <div class="btn-row" style="gap:8px">
            <button class="btn ok sm" data-judge="${s.order_step_id}" data-cc="pass">合格放行</button>
            <button class="btn warn sm" data-judge="${s.order_step_id}" data-cc="concession">让步接收</button>
            <button class="btn danger sm" data-judge="${s.order_step_id}" data-cc="fail">不合格</button>
          </div>
          <div class="mask-hint" style="margin-top:8px">${isFinal ? '终检放行将自动成品入库；' : ''}不合格会自动开质量异常单并通知责任管理人员。</div>
        </div></div>`;
      }).join('') : `<div class="card"><div class="empty"><div class="ico">👍</div><p>当前没有待检工序</p></div></div>`}
      <div style="height:10px"></div>`;
    bindBadRows();
    list.forEach((s) => { S.vals[s.order_step_id] = { badRows: [{ reason: '', qty: '', detail: '' }] }; renderBadRows(s.order_step_id); });
    $view.querySelectorAll('[data-judge]').forEach((b) => b.onclick = () => submitInspect(b.dataset.judge, b.dataset.cc));
  }

  async function submitInspect(stepId, conclusion) {
    const card = $view.querySelector('.insp[data-s="' + stepId + '"]');
    if (!card) return;
    const qtyPass = Math.max(0, Math.floor(num(card.querySelector('.qi-pass').value)));
    const qtyFail = Math.max(0, Math.floor(num(card.querySelector('.qi-fail').value)));
    if (conclusion === 'pass' && qtyFail > 0) return toast('合格放行时不合格数须为 0');
    if (conclusion !== 'pass' && qtyFail <= 0) return toast('请填写不合格数');
    const label = conclusion === 'pass' ? '合格放行' : conclusion === 'concession' ? '让步接收' : '不合格';
    if (!confirm(`判定「${label}」：受检 ${qtyPass} 件 / 不合格 ${qtyFail} 件。确定提交？`)) return;
    const defects = [...card.querySelectorAll('.badrows .brow')].map((br) => {
      const det = br.querySelector('.brow-detail');
      return { bad_reason_id: num(br.querySelector('.brow-reason').value), qty: num(br.querySelector('.brow-qty').value), bad_reason_detail: det ? det.value.trim() : '' };
    }).filter((x) => x.qty > 0);
    try {
      const r = await post('/api/app/inspections', { order_step_id: stepId, qty_pass: qtyPass, qty_fail: qtyFail, conclusion, defects, remark: '' });
      okMask('判定已提交', [
        r && r.autoFinishIn ? `末道工序已自动入库 ${r.autoFinishIn.qty} 件` : '',
        r && r.issue ? `已生成质量异常单 ${r.issue.code}，责任人 ${r.issue.assignee_name || '—'} 已收到待办` : '',
        '已通知对应班组',
      ].filter(Boolean).join('<br>'), [{ text: '继续判定', onClick: () => renderInspect() }]);
    } catch (e) { toast(e.message); }
  }

  /* ---------------- 页面：质量异常 ---------------- */
  async function renderQuality() {
    const me = await ensureMe();
    const isManager = me.role === 'admin' || me.role === 'technician' || me.role === 'inspector';
    const [all, mine] = await Promise.all([
      get('/api/quality_issues').catch(() => []),
      get('/api/quality_issues?mine=1').catch(() => []),
    ]);
    const list = isManager ? all : mine;
    const open = list.filter((x) => ['open', 'processing', 'verifying'].includes(x.status));
    const closed = list.filter((x) => !['open', 'processing', 'verifying'].includes(x.status));
    $view.innerHTML = `
      <div class="seg">
        <button class="on" data-f="open">待处理<i>${open.length}</i></button>
        <button data-f="done">已闭环<i>${closed.length}</i></button>
        <button data-f="all">全部<i>${list.length}</i></button>
      </div>
      <div class="card nopad" id="issueList"></div>
      <div style="height:10px"></div>`;
    const paint = (f) => {
      const rows = f === 'open' ? open : f === 'done' ? closed : list;
      $view.querySelector('#issueList').innerHTML = rows.length ? rows.map((it) => `
        <div class="item" data-issue="${it.id}">
          <div class="avatar" style="background:${it.level === 'critical' ? '#fdecec' : '#fff3e0'}">${it.level === 'critical' ? '🔥' : '⚠️'}</div>
          <div class="body">
            <div class="t1">${esc(it.code)} <span class="badge lv-${esc(it.level)}">${esc(LEVEL_LABEL[it.level] || it.level)}</span>
              <span class="badge ${['open', 'processing', 'verifying'].includes(it.status) ? 'b-paused' : 'b-done'}">${esc(ISSUE_STATUS[it.status] || it.status)}</span></div>
            <div class="t2">${esc(it.order_code || '')} · ${esc(it.process_name || '')}<br>不良 ${it.qty_affected} 件：${esc(it.bad_summary || '未填')}</div>
            <div class="t3"><span>责任人 ${esc(it.assignee_name || '未指派')}</span><span>${esc(ago(it.created_at))}</span></div>
          </div>
          <div class="chev">›</div>
        </div>`).join('') : `<div class="empty"><div class="ico">✅</div><p>没有符合条件的异常单</p></div>`;
      $view.querySelectorAll('[data-issue]').forEach((el) => el.onclick = () => nav('#/issue/' + el.dataset.issue));
    };
    paint('open');
    $view.querySelectorAll('.seg button').forEach((b) => b.onclick = () => {
      $view.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      paint(b.dataset.f);
    });
  }

  async function renderIssue(id) {
    const it = await get('/api/quality_issues/' + id);
    const me = S.me || {};
    const canHandle = ['admin', 'technician', 'inspector'].includes(me.role);
    const isOpen = ['open', 'processing', 'verifying'].includes(it.status);
    const defects = (it.inspection && it.inspection.defects) || [];
    $view.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">${esc(it.code)}</div>
        <div class="pname">${esc(it.order_code || '')} · ${esc(it.process_name || '')}</div>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="badge lv-${esc(it.level)}">${esc(LEVEL_LABEL[it.level] || it.level)}</span>
          <span class="badge ${isOpen ? 'b-paused' : 'b-done'}">${esc(ISSUE_STATUS[it.status] || it.status)}</span>
          ${it.order && it.order.status === 'paused' ? '<span class="badge b-paused">工单已暂停</span>' : ''}
        </div>
      </div></div>

      <div class="card"><div class="card-h"><h3>异常内容</h3></div><div class="card-b">
        <div class="pname" style="margin-top:0">受影响数量：<b>${it.qty_affected}</b> 件</div>
        <div class="pname">不良情况：${esc(it.bad_summary || '未填写')}</div>
        ${defects.length ? `<div class="pname">不良明细：${defects.map((d) => esc(d.bad_reason) + '×' + d.qty).join('、')}</div>` : ''}
        <div class="pname">责任人：${esc(it.assignee_name || '未指派')} · 上报 ${esc(ago(it.created_at))}</div>
        ${it.cause ? `<div class="pname">原因分析：${esc(it.cause)}</div>` : ''}
        ${it.action ? `<div class="pname">纠正措施：${esc(it.action)}</div>` : ''}
        ${it.disposition ? `<div class="pname">处置方式：${esc(it.dispositions && it.dispositions[it.disposition] || it.disposition)}</div>` : ''}
      </div></div>

      ${it.timeline && it.timeline.length ? `<div class="card"><div class="card-h"><h3>处理轨迹</h3></div>
        <div class="card-b" style="padding-top:4px">
          ${it.timeline.map((t) => `<div style="padding:8px 0;border-bottom:1px solid #f2f4f8">
            <div style="font-size:13.5px;font-weight:600">${esc(t.kind_label || t.kind || '')}：${esc(t.title || '')}</div>
            <div class="tiny" style="margin-top:3px">${esc(t.to_name || '')} · ${esc(String(t.sent_at || '').slice(0, 16))}</div>
          </div>`).join('')}
        </div></div>` : ''}

      ${isOpen && canHandle ? `<div class="card"><div class="card-b">
        ${it.status === 'open' ? '<button class="btn" id="actClaim">认领并开始处理</button>' : ''}
        ${it.status === 'processing' ? '<button class="btn" id="actHandle">提交处理结果</button>' : ''}
        ${it.status === 'verifying' && (me.role === 'admin' || me.role === 'technician') ? '<button class="btn ok" id="actClose">验证通过并闭环</button>' : ''}
        ${it.status === 'verifying' && me.role !== 'admin' && me.role !== 'technician' ? '<div class="tiny center muted">已提交处理，等待管理员验证闭环</div>' : ''}
      </div></div>` : ''}
      <div style="height:10px"></div>`;

    const claim = $view.querySelector('#actClaim');
    if (claim) claim.onclick = async () => {
      try { await post('/api/quality_issues/' + id + '/claim'); toast('已认领'); renderIssue(id); } catch (e) { toast(e.message); }
    };
    const close = $view.querySelector('#actClose');
    if (close) close.onclick = async () => {
      if (!confirm('确认异常已处理完成并恢复工单流转？')) return;
      try { await post('/api/quality_issues/' + id + '/close', { release: true }); toast('已闭环'); renderIssue(id); } catch (e) { toast(e.message); }
    };
    const handle = $view.querySelector('#actHandle');
    if (handle) handle.onclick = () => {
      const mask = sheet(`<h3>提交处理结果</h3><div class="sub">${esc(it.code)} · ${esc(it.process_name || '')}</div>
        <div class="field"><span>原因分析</span><textarea class="ipt" id="hCause" placeholder="为什么会发生（如：来料批次公差偏大）"></textarea></div>
        <div class="field"><span>纠正措施</span><textarea class="ipt" id="hAction" placeholder="怎么处理与预防（如：返工并加严首检）"></textarea></div>
        <div class="field"><span>处置方式</span><select class="ipt" id="hDisp">
          ${Object.keys(it.dispositions || {}).map((k) => `<option value="${k}">${esc(it.dispositions[k])}</option>`).join('')}
        </select></div>
        <button class="btn" id="hSubmit">提交（转待验证）</button>`);
      mask.querySelector('#hSubmit').onclick = async () => {
        const cause = mask.querySelector('#hCause').value.trim();
        const action = mask.querySelector('#hAction').value.trim();
        const disposition = mask.querySelector('#hDisp').value;
        if (!cause && !action) return toast('请至少填写原因或措施');
        try {
          await post('/api/quality_issues/' + id + '/handle', { cause, action, disposition });
          mask.remove(); toast('已提交，等待验证'); renderIssue(id);
        } catch (e) { toast(e.message); }
      };
    };
  }

  /* ---------------- 页面：库存预警 ---------------- */
  async function renderStocks() {
    const rows = await get('/api/stock_alerts').catch(() => []);
    $view.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">库存预警</div>
        <div class="pname">${rows.length ? '共 ' + rows.length + ' 项物料触及安全库存上下限' : '当前库存均在安全区间内'}</div>
        <button class="btn ghost sm" id="stScan" style="margin-top:12px">立即重新扫描并通知</button>
      </div></div>
      ${rows.length ? rows.map((r) => `
        <div class="card"><div class="card-b">
          <div class="row" style="align-items:flex-start">
            <div style="min-width:0">
              <div style="font-size:15px;font-weight:700">${esc(r.name || '')}
                <span class="badge ${r.level === 'over' ? 'b-paused' : 'b-released'}">${r.level === 'over' ? '积压' : '缺料'}</span></div>
              <div class="pname">${esc(r.code || '')}${r.unit ? ' · 单位 ' + esc(r.unit) : ''}</div>
            </div>
            <div style="text-align:right;flex:0 0 auto">
              <div style="font-size:19px;font-weight:800;color:${r.level === 'over' ? '#e08a00' : '#d93b3b'}">${r.qty}</div>
              <div class="tiny">安全${r.level === 'over' ? '上限' : '下限'} ${r.level === 'over' ? r.safe_max : r.safe_min}</div>
            </div>
          </div>
        </div></div>`).join('') : `<div class="card"><div class="empty"><div class="ico">📦</div><p>暂无缺料<br>库存低于物料档案的安全下限时会自动提醒</p></div></div>`}
      <div style="height:10px"></div>`;
    $view.querySelector('#stScan').onclick = async () => {
      try {
        const r = await post('/api/stock_alerts/scan');
        toast('扫描完成，已发送 ' + r.sent + ' 条提醒');
        refreshUnread(); renderStocks();
      } catch (e) { toast(e.message); }
    };
  }

  /* ---------------- 页面：消息中心 ---------------- */
  function segHtml() {
    const srcs = [{ key: '', label: '全部' }].concat(S.sources);
    return `<div class="seg">${srcs.map((s) => {
      const n = s.key ? (S.bySource[s.key] || 0) : S.unread;
      return `<button class="${S.msgFilter === s.key ? 'on' : ''}" data-f="${esc(s.key)}">${esc(s.label)}${n ? '<i>' + n + '</i>' : ''}</button>`;
    }).join('')}</div>`;
  }
  async function renderMessages() {
    const [msgs, srcs] = await Promise.all([
      get('/api/notifications' + (S.msgFilter ? '?source=' + encodeURIComponent(S.msgFilter) : '')).catch(() => []),
      get('/api/message_sources').catch(() => []),
    ]);
    S.msgs = msgs || []; S.sources = srcs || [];
    await refreshUnread();
    $view.innerHTML = segHtml() + `
      <div class="card nopad" id="msgList"></div>
      <div class="card"><div class="card-b"><button class="btn ghost sm" id="msgAllRead" ${S.msgFilter ? 'disabled' : ''}>全部标为已读</button></div></div>
      <div style="height:10px"></div>`;
    paintMsgs();
    $view.querySelectorAll('.seg button').forEach((b) => b.onclick = () => { S.msgFilter = b.dataset.f; renderMessages(); });
    $view.querySelector('#msgAllRead').onclick = async () => {
      try {
        await post('/api/notifications/read', S.msgFilter ? { source: S.msgFilter } : {});
        toast('已标为已读'); renderMessages();
      } catch (e) { toast(e.message); }
    };
  }
  function paintMsgs() {
    const rows = S.msgs;
    $view.querySelector('#msgList').innerHTML = rows.length ? rows.map((m) => `
      <div class="item ${m.read_at ? '' : 'unread'}" data-msg="${m.id}" data-link="${esc(m.link || '')}">
        ${m.read_at ? '<div style="width:8px;flex:0 0 auto"></div>' : '<div class="dot-new"></div>'}
        <div class="avatar">${SRC_ICON[m.source] || '🔔'}</div>
        <div class="body">
          <div class="t1">${esc(m.title || '')}</div>
          <div class="t2">${esc(m.body || '')}</div>
          <div class="t3">
            <span class="tag tag-${esc(m.source || 'system')}">${esc(m.source_label || '消息')}</span>
            ${m.kind_label ? '<span>' + esc(m.kind_label) + '</span>' : ''}
            <span>${esc(relTime(m.sent_at))}</span>
          </div>
        </div>
      </div>`).join('') : `<div class="empty"><div class="ico">🔔</div><p>暂无消息<br>质量异常、库存预警、派工待办会出现在这里</p></div>`;
    $view.querySelectorAll('[data-msg]').forEach((el) => el.onclick = async () => {
      const id = num(el.dataset.msg);
      const link = el.dataset.link || '';
      if (el.classList.contains('unread')) {
        try { await post('/api/notifications/read', { id }); } catch (e) { /* 忽略 */ }
        el.classList.remove('unread');
        const dot = el.querySelector('.dot-new'); if (dot) dot.style.visibility = 'hidden';
        refreshUnread();
      }
      if (!link) return;
      // 链接映射到 APP 内视图（PC 的 #/quality/issue/12 → APP 的 #/issue/12）
      const mIssue = link.match(/#\/quality\/issue\/(\d+)/);
      if (mIssue) return nav('#/issue/' + mIssue[1]);
      const mQuality = link.match(/#\/quality/);
      if (mQuality) return nav('#/quality');
      const mInspect = link.match(/#\/inspect/);
      if (mInspect) return nav('#/inspect');
      const mOrder = link.match(/#\/orders/);
      if (mOrder) return nav('#/home');
      toast('该消息关联的是电脑端页面');
    });
  }

  /* ---------------- 页面：我的 / 改密码 / 改资料 ---------------- */
  async function renderMine() {
    const me = await ensureMe();
    const pushOn = localStorage.getItem(LS_PUSH) !== '0';
    const counts = await get('/api/notifications/unread_count').catch(() => ({ count: 0, by_source: {} }));
    const isManager = me.role === 'admin' || me.role === 'technician';
    $view.innerHTML = `
      <div class="profile-head">
        <div class="av">${esc((me.name || '?').slice(0, 1))}</div>
        <div style="min-width:0">
          <div class="nm">${esc(me.name)}<span class="role-chip">${esc(ROLE_LABEL[me.role] || me.role)}</span></div>
          <div class="meta">${esc(me.username || '')} · ${esc(me.team || '未分组')}</div>
        </div>
      </div>

      <div class="card" style="margin-top:-14px;position:relative;z-index:2"><div class="card-b">
        <div class="row" style="padding-bottom:10px"><span class="k">未读消息</span>
          <span class="v">${counts.count || 0} 条 <button class="inline-link" id="mGoMsg">查看 ›</button></span></div>
        ${Object.keys(counts.by_source || {}).map((k) => `<div class="row" style="padding:8px 0"><span class="tiny">${esc((S.sources.find((s) => s.key === k) || {}).label || k)}</span>
          <span class="v">${counts.by_source[k]} 条</span></div>`).join('')}
      </div></div>

      <div class="card nopad">
        <div class="list-row" id="mProfile"><span class="k">修改姓名</span><span class="v">${esc(me.name)} <span class="chev">›</span></span></div>
        <div class="list-row" id="mPwd"><span class="k">修改登录密码</span><span class="v">安全设置 <span class="chev">›</span></span></div>
        <div class="list-row"><span class="k">接收消息通知</span>
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="mPush" ${pushOn ? 'checked' : ''} style="width:20px;height:20px;accent-color:#1d4ed8">
          </label></div>
      </div>

      <div class="card nopad">
        ${isManager ? `<div class="list-row" id="mStocks"><span class="k">库存预警</span><span class="chev">›</span></div>` : ''}
        <div class="list-row" id="mRefresh"><span class="k">刷新数据</span><span class="v">拉取最新 <span class="chev">›</span></span></div>
        <div class="list-row"><span class="k">当前版本</span><span class="v">智工 v1.0</span></div>
      </div>

      <div class="card"><div class="card-b"><button class="btn ghost" id="mLogout">退出登录</button></div></div>
      <div class="hint">提示：把本页面「添加到主屏幕」即可像 APP 一样全屏打开；<br>消息每 15 秒自动刷新，手机通知栏提醒需打包 APK 后启用。</div>
      <div style="height:10px"></div>`;

    $view.querySelector('#mGoMsg').onclick = () => nav('#/messages');
    $view.querySelector('#mPwd').onclick = () => nav('#/password');
    $view.querySelector('#mProfile').onclick = () => nav('#/profile');
    $view.querySelector('#mLogout').onclick = doLogout;
    const ms = $view.querySelector('#mStocks');
    if (ms) ms.onclick = () => nav('#/stocks');
    $view.querySelector('#mRefresh').onclick = async () => { await refreshUnread(); toast('已刷新'); renderMine(); };
    $view.querySelector('#mPush').onchange = (e) => {
      localStorage.setItem(LS_PUSH, e.target.checked ? '1' : '0');
      toast(e.target.checked ? '已开启消息通知' : '已关闭消息提醒（角标仍显示）');
    };
  }

  async function renderProfile() {
    const me = await ensureMe();
    $view.innerHTML = `<div class="card"><div class="card-h"><h3>修改姓名</h3></div><div class="card-b">
        <div class="field"><span>姓名</span><input class="ipt" id="pName" value="${esc(me.name)}"></div>
        <div class="field"><span>账号 / 工号</span><input class="ipt" value="${esc(me.username || '')}" disabled></div>
        <div class="field"><span>班组</span><input class="ipt" value="${esc(me.team || '未分组')}" disabled></div>
        <button class="btn" id="pSave">保存</button>
      </div></div><div style="height:10px"></div>`;
    $view.querySelector('#pSave').onclick = async () => {
      const name = $view.querySelector('#pName').value.trim();
      if (!name) return toast('姓名不能为空');
      try {
        const r = await post('/api/profile', { name });
        S.me = Object.assign({}, S.me, r || { name });
        toast('已保存'); nav('#/mine', true);
      } catch (e) { toast(e.message); }
    };
  }

  async function renderPassword() {
    $view.innerHTML = `<div class="card"><div class="card-h"><h3>修改登录密码</h3></div><div class="card-b">
        <div class="field"><span>原密码</span><input class="ipt" id="pwOld" type="password" autocomplete="current-password" placeholder="请输入当前密码"></div>
        <div class="field"><span>新密码</span><input class="ipt" id="pwNew" type="password" autocomplete="new-password" placeholder="至少 6 位"></div>
        <div class="field"><span>确认新密码</span><input class="ipt" id="pwNew2" type="password" autocomplete="new-password" placeholder="再次输入新密码"></div>
        <button class="btn" id="pwSave">确认修改</button>
        <div class="hint" style="margin:12px 0 0">修改成功后，你在其他设备上的登录会被退出；当前设备保持登录。</div>
      </div></div><div style="height:10px"></div>`;
    $view.querySelector('#pwSave').onclick = async () => {
      const oldPwd = $view.querySelector('#pwOld').value;
      const newPwd = $view.querySelector('#pwNew').value;
      const newPwd2 = $view.querySelector('#pwNew2').value;
      if (!oldPwd || !newPwd) return toast('请填写原密码与新密码');
      if (newPwd.length < 6) return toast('新密码至少 6 位');
      if (newPwd !== newPwd2) return toast('两次输入的新密码不一致');
      if (newPwd === oldPwd) return toast('新密码不能与原密码相同');
      const btn = $view.querySelector('#pwSave');
      btn.disabled = true; btn.textContent = '提交中…';
      try {
        await post('/api/password', { old_password: oldPwd, new_password: newPwd });
        okMask('密码已修改', '其他设备已退出登录，当前设备保持登录状态。', [{ text: '返回我的', onClick: () => nav('#/mine', true) }]);
      } catch (e) {
        btn.disabled = false; btn.textContent = '确认修改';
        toast(e.message);
      }
    };
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    await API.detect();
    API.onUnauthorized(() => {
      if (S.route === 'login') return;
      API.setToken(''); S.me = null; stopPoll(); paintBadge(0);
      toast('登录已过期，请重新登录');
      nav('#/login', true);
    });
    if (token()) { startPoll(); refreshUnread(); }
    await route();
  }
  $back.onclick = () => {
    if (['order', 'inspect', 'quality', 'issue', 'stocks', 'profile', 'password'].includes(S.route)) nav('#/home');
    else nav('#/home');
  };
  $title.onclick = () => { if (token()) nav('#/home'); };
  document.getElementById('tbBell').onclick = () => { if (token()) nav('#/messages'); };
  // 底部导航：工作台 / 消息 / 我的（此前未绑定点击，导致消息、我的点不开）
  $tabbar.querySelectorAll('.tab').forEach((t) => t.onclick = () => { if (token()) nav('#/' + t.dataset.tab); });
  window.addEventListener('hashchange', route);
  boot();
})();
