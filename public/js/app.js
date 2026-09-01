/* 应用外壳：登录、菜单、hash 路由 */
window.App = {
  user: null,
  MENU: [
    { k: 'dashboard', v: 'dashboard', t: '看板', roles: ['admin', 'leader', 'worker'] },
    { k: 'orders', v: 'orders', t: '工单', roles: ['admin', 'leader', 'worker'] },
    { k: 'report', v: 'report', t: '报工', roles: ['admin', 'leader', 'worker'] },
    { k: 'basic', v: 'basic', t: '基础数据', roles: ['admin', 'leader', 'worker'] },
    { k: 'scan', v: 'scan', t: '扫码报单', roles: ['admin', 'leader'] },
    { k: 'stats', v: 'stats', t: '报表', roles: ['admin', 'leader', 'worker'] },
    { k: 'logs', v: 'logs', t: '日志', roles: ['admin', 'leader'] },
  ],

  isAdmin: () => App.user && App.user.role === 'admin',
  canEdit: () => App.user && ['admin', 'leader'].includes(App.user.role),

  /* ---------- 渲染 ---------- */
  render() {
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
      .map((m) => `<div class="menu-item" data-k="${m.k}">
          ${UI.icon(Views[m.v] ? Views[m.v].icon : 'dash')}<span>${m.t}</span></div>`).join('');
    menu.querySelectorAll('.menu-item').forEach((m) => m.onclick = () => location.hash = '#/' + m.dataset.k);
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
    document.getElementById('topUser').textContent = `${App.user.name} · ${{ admin: '管理员', leader: '班组长', worker: '操作工' }[App.user.role]}`;
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

    // 操作工默认直接进报工页
    if (!location.hash && App.user.role === 'worker') location.hash = '#/report';
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
