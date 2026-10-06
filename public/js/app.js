/* 应用外壳：登录、菜单、hash 路由 */
window.App = {
  user: null,
  MENU: [
    { k: 'dashboard', v: 'dashboard', t: '看板', roles: ['admin', 'technician', 'worker'] },
    { k: 'orders', v: 'orders', t: '工单', roles: ['admin', 'technician', 'worker'] },
    { k: 'report', v: 'report', t: '报工', roles: ['admin', 'technician', 'worker'] },
    { k: 'equip', v: 'equip', t: '设备', roles: ['admin', 'technician', 'worker'] },
    { k: 'quality', v: 'quality', t: '质量', roles: ['admin', 'technician', 'inspector'] },
    { k: 'basic', v: 'basic', t: '基础数据', roles: ['admin', 'technician', 'worker'] },
    { k: 'warehouse', v: 'warehouse', t: '物料仓储', roles: ['admin', 'technician'] },
    { k: 'scan', v: 'scan', t: '扫码报单', roles: ['admin', 'technician'] },
    { k: 'stats', v: 'stats', t: '报表', roles: ['admin', 'technician', 'worker'] },
    { k: 'logs', v: 'logs', t: '日志', roles: ['admin', 'technician'] },
    { k: 'app', v: 'app', t: '手机端', href: '/install.html', roles: ['admin', 'technician', 'worker', 'inspector'] },
    { k: 'board', v: 'board', t: '车间大屏', href: '/board.html', ico: 'dash', roles: ['admin', 'technician', 'worker', 'inspector'] },
    { k: 'manual', v: 'manual', t: '使用手册', href: '/manual.html', ico: 'basic', roles: ['admin', 'technician', 'worker', 'inspector'] },
  ],

  isAdmin: () => App.user && App.user.role === 'admin',
  canEdit: () => App.user && ['admin', 'technician'].includes(App.user.role),
  // 质检员：可判定与处理异常单，但不能改工单/基础数据
  isQC: () => App.user && App.user.role === 'inspector',

  /* ---------- 渲染 ---------- */
  render() {
    if (App._dashTimer) { clearInterval(App._dashTimer); App._dashTimer = null; } // 清掉上一个看板的自动刷新
    const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
    const parts = hash.split('/').filter(Boolean);
    const key = parts[0];
    const view = Views[key] || Views.dashboard;

    document.querySelectorAll('.menu-item').forEach((m) => m.classList.toggle('active', m.dataset.k === key));
    document.getElementById('pageTitle').textContent = view.title;

    const el = document.getElementById('view');
    el.scrollTop = 0;
    view.render(el, parts[1], parts[2]).catch((e) => {
      el.innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`;
    });
  },

  buildMenu() {
    const menu = document.getElementById('menu');
    menu.innerHTML = App.MENU
      .filter((m) => m.roles.includes(App.user.role))
      .map((m) => {
        if (m.href) {
          return `<a class="menu-item" href="${m.href}" target="_blank" rel="noopener">${UI.icon(m.ico || 'phone')}<span>${m.t}</span></a>`;
        }
        return `<div class="menu-item" data-k="${m.k}">${UI.icon(Views[m.v] ? Views[m.v].icon : 'dash')}<span>${m.t}</span></div>`;
      }).join('');
    menu.querySelectorAll('.menu-item[data-k]').forEach((m) => m.onclick = () => location.hash = '#/' + m.dataset.k);
  },

  /* ---------- 登录 ---------- */
  async boot() {
    API.onUnauthorized(() => App.logout(true));
    const d = new Date();
    document.getElementById('topDate').textContent =
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (API.getToken()) {
      try {
        App.user = await API.get('/me');
        return App.enter();
      } catch (e) { API.setToken(''); }
    }
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('loginForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector('button');
      btn.disabled = true;
      try {
        const r = await API.post('/login', {
          username: document.getElementById('lgUser').value.trim(),
          password: document.getElementById('lgPwd').value,
        });
        API.setToken(r.token);
        App.user = r.user;
        UI.toast('欢迎回来，' + r.user.name, 'ok');
        App.enter();
      } catch (e) { UI.toast(e.message, 'err'); }
      finally { btn.disabled = false; }
    };
  },

  enter() {
    document.getElementById('login').classList.add('hidden');
    document.getElementById('shell').classList.remove('hidden');
    const ROLE_LABEL = { admin: '管理员', technician: '技术员', worker: '操作工', inspector: '质检员' };
    document.getElementById('topUser').textContent = `${App.user.name} · ${ROLE_LABEL[App.user.role] || App.user.role}`;
    document.getElementById('sideUser').innerHTML =
      `<span class="avatar">${UI.esc(App.user.name.slice(0, 1))}</span><span>${UI.esc(App.user.name)}</span>`;
    document.getElementById('btnLogout').onclick = () => App.logout();
    const btnReset = document.getElementById('btnReset');
    if (btnReset) btnReset.onclick = () => {
      if (!confirm('确定要清除本浏览器中的全部本地数据并恢复初始状态吗？此操作不可撤销。')) return;
      try { Store.reset(); } catch (e) { /* 忽略 */ }
      location.reload();
    };
    document.getElementById('btnBack').onclick = () => location.hash = '#/dashboard';
    App.buildMenu();
    if (window.Notify) Notify.mount();

    // 操作工默认直接进报工页；质检员默认直接进质检台
    if (!location.hash) {
      if (App.user.role === 'worker') location.hash = '#/report';
      else if (App.user.role === 'inspector') location.hash = '#/quality';
    }
    window.addEventListener('hashchange', App.render);
    App.render();
  },

  async logout(silent) {
    try { await API.post('/logout'); } catch (e) { /* 忽略 */ }
    API.setToken('');
    location.hash = '';
    location.reload();
  },
};

document.addEventListener('DOMContentLoaded', App.boot);
