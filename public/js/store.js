/* 浏览器端数据层（静态版核心）
 * 在浏览器内重现后端全部接口：登录 / 看板 / 工单 / 报工 / 基础数据 / 扫码。
 * 数据持久化于 localStorage；首次加载从 data/seed.json 初始化，并自动把报工日期锚定到今天。
 * 与后端返回结构完全一致（{ok,data,msg}），api.js 切换为本地模式时视图无需改动。
 */
(function (global) {
  'use strict';

  const LS_KEY = 'mes_static_v1';
  let DB = null;
  const Store = { currentUser: null };

  /* ------------------------------ 工具 ------------------------------ */
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const nowISO = () => { const d = new Date(); return today() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  async function sha256hex(s) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (typeof require !== 'undefined') { const c = require('node:crypto'); return c.createHash('sha256').update(s).digest('hex'); }
    throw new Error('no sha256');
  }
  function makeQr(text) {
    try {
      if (typeof qrcode === 'function') {
        let qr = null;
        for (let t = 1; t <= 10; t++) { try { qr = qrcode(t, 'M'); qr.addData(text); qr.make(); break; } catch (e) { /* 容量不足则升版 */ } }
        if (qr) return qr.createSvgTag({ cellSize: 5, margin: 2 });
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  /* ------------------------------ 数据访问 ------------------------------ */
  const T = (name) => DB[name];
  const find = (name, id) => T(name).find((r) => r.id === Number(id));
  const nextId = (name) => (T(name).length ? Math.max(...T(name).map((r) => r.id)) + 1 : 1);
  function insert(name, obj) { obj.id = nextId(name); T(name).push(obj); return obj.id; }
  function update(name, id, patch) { const r = find(name, id); if (r) Object.assign(r, patch); return r; }
  function remove(name, id) { DB[name] = T(name).filter((r) => r.id !== Number(id)); }

  /* ------------------------------ 持久化 ------------------------------ */
  function load() { try { const s = global.localStorage && global.localStorage.getItem(LS_KEY); if (s) { DB = JSON.parse(s); return true; } } catch (e) {} return false; }
  function save() { try { global.localStorage && global.localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) {} }

  function anchorDates() {
    const reps = T('reports');
    if (!reps.length) return;
    let max = reps[0].report_date;
    for (const r of reps) if (r.report_date > max) max = r.report_date;
    const t = today();
    if (max < t) {
      const delta = daysBetween(max, t);
      for (const r of reps) r.report_date = addDays(r.report_date, delta);
    }
  }

  Store.init = async function () {
    if (DB) return;
    if (load()) return;
    const EMPTY = { users: [], customers: [], processes: [], work_centers: [], products: [], routes: [], route_steps: [], bad_reasons: [], orders: [], order_steps: [], reports: [], logs: [], incoming_materials: [], finished_goods_in: [], materials: [], warehouses: [], inventory: [], inventory_tx: [] };
    try {
      const res = await fetch('/data/seed.json', { cache: 'no-store' });
      DB = res.ok ? await res.json() : EMPTY;
    } catch (e) {
      DB = EMPTY;
    }
    anchorDates();
    save();
  };
  // 测试/服务端注入
  Store.bootstrap = function (obj) { DB = JSON.parse(JSON.stringify(obj)); Store.currentUser = null; };
  Store.reset = function () { try { global.localStorage && global.localStorage.removeItem(LS_KEY); } catch (e) {} DB = null; };

  const actor = () => Store.currentUser || { id: 1, name: '系统' };
  // 多角色放行：传入若干角色，当前用户不在其中则视为“无权限”（返回 true 表示拦截）
  const requireRole = (...roles) => !Store.currentUser || !roles.includes(Store.currentUser.role);
  const requireOrderMgr = () => requireRole('admin', 'leader');

  /* ------------------------------ 聚合/视图 ------------------------------ */
  function computeOrderAgg(o) {
    const steps = T('order_steps').filter((s) => s.order_id === o.id);
    const goods = steps.map((s) => num(s.qty_good));
    const out = {
      qty_done: goods.length ? Math.min(...goods) : 0,
      qty_max: goods.length ? Math.max(...goods) : 0,
      qty_bad: steps.reduce((a, s) => a + num(s.qty_bad), 0),
      work_min: steps.reduce((a, s) => a + num(s.work_min), 0),
      step_done: steps.filter((s) => s.status === 'done').length,
      step_total: steps.length,
    };
    return Object.assign({}, o, out);
  }
  function orderRow(o) {
    const p = find('products', o.product_id) || {};
    const r = find('routes', o.route_id) || {};
    const c = o.customer_id ? find('customers', o.customer_id) : null;
    return computeOrderAgg(Object.assign({}, o, {
      product_code: p.code, product_name: p.name, spec: p.spec, unit: p.unit, product_price: p.price,
      route_code: r.code, route_name: r.name, customer_name: c ? c.name : '',
    }));
  }
  function stepView(s) {
    const pr = find('processes', s.process_id) || {};
    const w = s.work_center_id ? find('work_centers', s.work_center_id) : null;
    const u = s.assignee_id ? find('users', s.assignee_id) : null;
    const repNames = [...new Set(T('reports').filter((rp) => rp.order_step_id === s.id && rp.worker_id)
      .map((rp) => { const wu = find('users', rp.worker_id); return wu ? wu.name : null; }).filter(Boolean))];
    return Object.assign({}, s, {
      process_code: pr.code, process_name: pr.name, wc_name: w ? w.name : '', assignee_name: u ? u.name : '',
      assignee_team: s.assignee_team || '', reporter_names: repNames,
    });
  }
  function reportView(rp) {
    const u = find('users', rp.worker_id) || {};
    const o = find('orders', rp.order_id) || {};
    const s = rp.order_step_id ? find('order_steps', rp.order_step_id) : null;
    const pr = s ? find('processes', s.process_id) : null;
    const w = rp.work_center_id ? find('work_centers', rp.work_center_id) : null;
    return Object.assign({}, rp, { worker_name: u.name, order_code: o.code, process_name: pr ? pr.name : '', wc_name: w ? w.name : '' });
  }

  /* ------------------------------ 报工核心 ------------------------------ */
  function doReport(b, act) {
    const order = find('orders', Number(b.order_id));
    if (!order) throw new Error('工单不存在');
    if (['done', 'closed'].includes(order.status)) throw new Error('工单已完成，无法继续报工');

    const items = Array.isArray(b.steps)
      ? b.steps.map((s) => ({ order_step_id: Number(s.order_step_id), qty_good: s.qty_good, qty_bad: s.qty_bad, bad_reason: s.bad_reason, work_min: s.work_min }))
      : [{ order_step_id: Number(b.order_step_id), qty_good: b.qty_good, qty_bad: b.qty_bad, bad_reason: b.bad_reason, work_min: b.work_min }];
    if (!items.length) throw new Error('请至少选择一道工序');

    const workerId = Number(b.worker_id) || act.id;
    const results = [];

    items.forEach((it) => {
      const step = find('order_steps', it.order_step_id);
      if (!step || Number(step.order_id) !== Number(b.order_id)) throw new Error('工序不存在（#' + it.order_step_id + '）');
      if (step.assignee_team && act.role !== 'admin' && act.role !== 'leader') {
        const wid = Number(b.worker_id) || act.id;
        const wu = find('users', wid);
        const wteam = (act.team) || (wu && wu.team);
        if (wteam !== step.assignee_team) {
          throw new Error('工序「' + step.seq + '」限「' + step.assignee_team + '」班组报工（您为「' + (wteam || '未分组') + '」）');
        }
      }
      if (step.allow_report === 0 && act.role !== 'admin' && act.role !== 'leader') {
        throw new Error('工序「' + step.seq + '」需由管理员/班组长报工，员工不可申报');
      }
      const good = Math.max(0, Math.floor(num(it.qty_good)));
      const bad = Math.max(0, Math.floor(num(it.qty_bad)));
      if (good + bad <= 0) throw new Error('工序「' + step.seq + '」合格数与不良数不能同时为 0');
      const finished = (step.qty_good + good) >= step.qty_plan;

      insert('reports', {
        id: nextId('reports'), order_id: Number(b.order_id), order_step_id: step.id, worker_id: workerId,
        work_center_id: b.work_center_id || step.work_center_id, qty_good: good, qty_bad: bad,
        bad_reason: bad ? (it.bad_reason || '其他') : '', work_min: num(it.work_min),
        report_date: b.report_date || today(), remark: b.remark || '', created_at: nowISO(),
      });
      update('order_steps', step.id, {
        qty_good: step.qty_good + good, qty_bad: step.qty_bad + bad, work_min: step.work_min + num(it.work_min),
        status: finished ? 'done' : 'running', start_time: step.start_time || nowISO(),
        finish_time: finished ? nowISO() : null, assignee_id: step.assignee_id || workerId,
      });
      if (order.status === 'created' || order.status === 'released') update('orders', order.id, { status: 'running', start_time: order.start_time || nowISO() });
      if (finished) {
        const nxt = T('order_steps').filter((s) => s.order_id === order.id && s.status === 'pending').sort((a, b) => a.seq - b.seq)[0];
        if (nxt) update('order_steps', nxt.id, { status: 'running' });
      }
      results.push({ order_step_id: step.id, seq: step.seq, finished });
    });

    if (!T('order_steps').some((s) => s.order_id === order.id && s.status !== 'done')) {
      update('orders', order.id, { status: 'done', finish_time: nowISO() });
    }
    const tg = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_good))), 0);
    const tb = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_bad))), 0);
    writeLog(act, '生产报工', order.code + (items.length > 1 ? ' 多工序×' + items.length : '') + ' 合格 ' + tg + ' / 不良 ' + tb);
    return { count: items.length, steps: results, finished: results.some((r) => r.finished) };
  }
  function undoReport(id) {
    const r = find('reports', id);
    if (!r) throw new Error('记录不存在');
    const step = find('order_steps', r.order_step_id);
    if (step) {
      update('order_steps', step.id, {
        qty_good: Math.max(0, step.qty_good - r.qty_good), qty_bad: Math.max(0, step.qty_bad - r.qty_bad),
        work_min: Math.max(0, step.work_min - r.work_min),
        status: (step.qty_good + step.qty_bad - r.qty_good - r.qty_bad) === 0 ? 'pending' : (step.qty_good >= step.qty_plan ? 'done' : 'running'),
        finish_time: step.qty_good >= step.qty_plan ? step.finish_time : null,
      });
      const o = find('orders', step.order_id);
      if (o) {
        const remaining = T('order_steps').filter((s) => s.order_id === o.id && s.status !== 'done');
        if (!remaining.length && o.status === 'done') update('orders', o.id, { status: 'running', finish_time: null });
      }
    }
    remove('reports', id);
    const o = find('orders', r.order_id);
    writeLog(actor(), '撤销报工', (o ? o.code : '') + ' 合格 ' + r.qty_good);
    return true;
  }
  function writeLog(u, action, detail) {
    insert('logs', { id: nextId('logs'), user_id: u ? u.id : null, user_name: u ? u.name : '系统', action, detail, created_at: nowISO() });
  }

  /* ------------------------------ 路由表 ------------------------------ */
  const routes = [];
  const R = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), fn });
  const ok = (data) => ({ ok: true, data });
  const fail = (msg, code = 400) => ({ ok: false, msg, code });

  /* 登录 */
  R('POST', '/login', async (_, b) => {
    const u = T('users').find((x) => x.username === b.username);
    if (!u || u.password !== (await sha256hex('mes:' + (b.password || '')))) return fail('账号或密码错误', 401);
    const user = { id: u.id, name: u.name, role: u.role, team: u.team, work_center_id: u.work_center_id };
    Store.currentUser = user;
    return ok({ token: 'static-' + u.id, user });
  });

  /* 当前用户 / 登出（让 app.js 的会话恢复与登出逻辑在静态版同样可用） */
  R('GET', '/me', () => {
    if (!Store.currentUser) return fail('未登录', 401);
    return ok(Store.currentUser);
  });
  R('POST', '/logout', () => { Store.currentUser = null; return ok(true); });

  /* meta */
  R('GET', '/meta', () => ok({
    products: T('products'), processes: T('processes'), workCenters: T('work_centers'),
    customers: T('customers').map((r) => ({ id: r.id, code: r.code, name: r.name })),
    badReasons: T('bad_reasons'),
    workers: T('users').filter((u) => u.role === 'worker' && u.active).map((r) => ({ id: r.id, name: r.name, team: r.team, work_center_id: r.work_center_id })),
    teams: [...new Set(T('users').map((u) => u.team).filter(Boolean))].sort(),
    routes: T('routes').map((r) => Object.assign({}, r, { product_name: (find('products', r.product_id) || {}).name || '' })),
    statuses: [['created', '待下发'], ['released', '已下发'], ['running', '生产中'], ['paused', '已暂停'], ['done', '已完成'], ['closed', '已关闭']],
  }));

  /* 工单列表 */
  R('GET', '/orders', (_p, _b, q) => {
    let list = T('orders').map(orderRow);
    if (q.status) { const arr = String(q.status).split(','); list = list.filter((o) => arr.includes(o.status)); }
    if (q.keyword) { const k = String(q.keyword).toLowerCase(); list = list.filter((o) => [o.code, o.product_name, o.product_code, o.customer_name].some((v) => (v || '').toLowerCase().includes(k))); }
    if (q.onlyOverdue) list = list.filter((o) => o.plan_end < today() && !['done', 'closed'].includes(o.status));
    const rank = { running: 0, paused: 1, released: 2, created: 3 };
    list.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.priority - b.priority || (a.plan_end > b.plan_end ? 1 : -1));
    return ok(list);
  });
  R('GET', '/orders/(\\d+)', (m) => {
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    const out = orderRow(o);
    out.steps = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b) => a.seq - b.seq).map(stepView);
    out.reports = T('reports').filter((r) => r.order_id === o.id).sort((a, b) => b.id - a.id).slice(0, 100).map(reportView);
    return ok(out);
  });
  R('POST', '/orders', (_p, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const qty = Math.max(1, Math.floor(num(b.qty_plan, 1)));
    const code = b.code && b.code.trim() ? b.code.trim() : 'WO' + dayOffset(0).replace(/-/g, '').slice(2) + String(Math.floor(Math.random() * 9000) + 1000);
    if (T('orders').some((o) => o.code === code)) return fail('工单号已存在');
    const route = find('routes', b.route_id);
    if (!route) return fail('工艺路线不存在');
    const oid = insert('orders', {
      id: 0, code, product_id: num(b.product_id), route_id: num(b.route_id), customer_id: b.customer_id ? num(b.customer_id) : null,
      qty_plan: qty, priority: num(b.priority, 2), plan_start: b.plan_start || today(), plan_end: b.plan_end || today(),
      status: 'created', remark: b.remark || '', created_by: actor().id, created_at: nowISO(), start_time: null, finish_time: null, close_reason: '',
    });
    T('route_steps').filter((s) => s.route_id === route.id).sort((a, b) => a.seq - b.seq)
      .forEach((s) => insert('order_steps', { id: 0, order_id: oid, seq: s.seq, process_id: s.process_id, work_center_id: s.work_center_id, assignee_id: null, qty_plan: qty, qty_good: 0, qty_bad: 0, work_min: 0, status: 'pending', start_time: null, finish_time: null }));
    writeLog(actor(), '创建工单', code + ' 数量 ' + qty);
    return ok({ id: oid, code });
  });
  R('PUT', '/orders/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const before = find('orders', m[0]);
    if (!before) return fail('工单不存在', 404);
    if (before.status !== 'created') return fail('只有「待下发」状态的工单可以修改');
    const route = find('routes', b.route_id);
    if (!route) return fail('工艺路线不存在');
    update('orders', before.id, {
      product_id: num(b.product_id), route_id: num(b.route_id), customer_id: b.customer_id ? num(b.customer_id) : null,
      qty_plan: num(b.qty_plan), priority: num(b.priority, 2), plan_start: b.plan_start, plan_end: b.plan_end, remark: b.remark || '',
    });
    if (num(b.route_id) !== before.route_id || num(b.qty_plan) !== before.qty_plan) {
      DB.order_steps = T('order_steps').filter((s) => s.order_id !== before.id);
      T('route_steps').filter((s) => s.route_id === route.id).sort((a, b) => a.seq - b.seq)
        .forEach((s) => insert('order_steps', { id: 0, order_id: before.id, seq: s.seq, process_id: s.process_id, work_center_id: s.work_center_id, assignee_id: null, qty_plan: num(b.qty_plan), qty_good: 0, qty_bad: 0, work_min: 0, status: 'pending', start_time: null, finish_time: null }));
    } else {
      T('order_steps').filter((s) => s.order_id === before.id).forEach((s) => update('order_steps', s.id, { qty_plan: num(b.qty_plan) }));
    }
    writeLog(actor(), '修改工单', before.code);
    return ok(true);
  });
  R('PATCH', '/orders/(\\d+)/status', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    if (b.status === 'released' && !T('order_steps').some((s) => s.order_id === o.id)) return fail('该工单还没有工序，无法下发（请检查工艺路线是否包含工序）', 400);
    const to = b.status;
    const label = { created: '待下发', released: '已下发', running: '生产中', paused: '已暂停', done: '已完成', closed: '已关闭' }[to] || to;
    if (to === 'running') update('orders', o.id, { status: 'running', start_time: o.start_time || nowISO() });
    else if (to === 'done') update('orders', o.id, { status: 'done', finish_time: nowISO() });
    else if (to === 'closed') update('orders', o.id, { status: 'closed', finish_time: o.finish_time || nowISO(), close_reason: b.close_reason || '' });
    else update('orders', o.id, { status: to });
    if (to === 'running') { const nxt = T('order_steps').filter((s) => s.order_id === o.id && s.status === 'pending').sort((a, b) => a.seq - b.seq)[0]; if (nxt) update('order_steps', nxt.id, { status: 'running' }); }
    writeLog(actor(), '工单状态变更', o.code + ' → ' + label);
    return ok(true);
  });
  R('PATCH', '/orders/(\\d+)/steps/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    update('order_steps', m[1], { assignee_team: b.assignee_team || null, work_center_id: b.work_center_id ? num(b.work_center_id) : null, allow_report: (b.allow_report === 0 || b.allow_report === '0' || b.allow_report === false) ? 0 : 1 });
    const o = find('orders', m[0]);
    writeLog(actor(), '工序派工', (o ? o.code : m[0]) + ' 工序#' + m[1] + (b.assignee_team ? ' → ' + b.assignee_team : ''));
    return ok(true);
  });
  R('DELETE', '/orders/(\\d+)', (m) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    DB.order_steps = T('order_steps').filter((s) => s.order_id !== o.id);
    DB.reports = T('reports').filter((r) => r.order_id !== o.id);
    remove('orders', o.id);
    writeLog(actor(), '删除工单', o.code);
    return ok(true);
  });

  /* 扫码定位 */
  R('GET', '/scan/(.+)', (m) => {
    const key = decodeURIComponent(m[0]).trim();
    const o = T('orders').map(orderRow).find((x) => x.code === key);
    if (o) return ok({ type: 'order', order: o });
    const p = find('products', 0) || T('products').find((x) => x.code === key);
    if (p) { const list = T('orders').map(orderRow).filter((x) => x.product_id === p.id && ['released', 'running', 'paused'].includes(x.status)); return ok({ type: 'product', product: p, orders: list }); }
    return fail('未找到对应的工单或产品：' + key, 404);
  });

  /* 报工 */
  R('GET', '/reports', (_p, _b, q) => {
    let list = T('reports').map(reportView);
    if (q.date) list = list.filter((r) => r.report_date === q.date);
    if (q.order_id) list = list.filter((r) => r.order_id === num(q.order_id));
    if (q.worker_id) list = list.filter((r) => r.worker_id === num(q.worker_id));
    list.sort((a, b) => b.id - a.id);
    return ok(list.slice(0, 300));
  });
  R('POST', '/reports', (_p, b) => { try { return ok(doReport(b, actor())); } catch (e) { return fail(e.message, 400); } });
  R('DELETE', '/reports/(\\d+)', (m) => { try { return ok(undoReport(num(m[0]))); } catch (e) { return fail(e.message, 404); } });

  /* 统计 */

  /* 全流程合格完工量：一件产品所有工序都合格才算合格，
     故工单完工量 = 该工单各工序累计合格数的**最小值**（瓶颈工序），
     某区间产量 = 期末完工量 - 期初完工量。
     历史累计用「当前工序合格数 - 该日之后的报工合计」回推，
     这样即使工序合格数被手工改过（无对应报工记录），也不会凭空算成当日产量。 */
  const finishedByOrder = (upTo) => {
    const after = {};
    for (const r of T('reports')) {
      if (r.report_date > upTo) {
        const sid = num(r.order_step_id);
        after[sid] = (after[sid] || 0) + num(r.qty_good);
      }
    }
    const m = {};
    for (const s of T('order_steps')) {
      const v = Math.max(0, num(s.qty_good) - (after[num(s.id)] || 0));
      const k = num(s.order_id);
      m[k] = m[k] === undefined ? v : Math.min(m[k], v);
    }
    return m;
  };
  const flowDelta = (upTo, prevTo) => {
    const now = finishedByOrder(upTo), prev = finishedByOrder(prevTo);
    let good = 0, cum = 0;
    for (const k of Object.keys(now)) {
      good += Math.max(0, now[k] - (prev[k] === undefined ? now[k] : prev[k]));
      cum += now[k];
    }
    return { good, cum };
  };

  R('GET', '/stats/overview', () => {
    const t = today();
    const day = T('reports').filter((r) => r.report_date === t);
    const good = day.reduce((a, r) => a + num(r.qty_good), 0);
    const bad = day.reduce((a, r) => a + num(r.qty_bad), 0);
    const minu = day.reduce((a, r) => a + num(r.work_min), 0);
    const people = new Set(day.map((r) => r.worker_id)).size;
    const ord = { running: 0, paused: 0, waiting: 0, done: 0, overdue: 0 };
    for (const o of T('orders')) {
      if (o.status === 'running') ord.running++;
      else if (o.status === 'paused') ord.paused++;
      else if (o.status === 'created' || o.status === 'released') ord.waiting++;
      else if (o.status === 'done') ord.done++;
      if (o.plan_end < t && !['done', 'closed'].includes(o.status)) ord.overdue++;
    }
    const wc = { running: 0, fault: 0, maintain: 0, total: T('work_centers').length };
    for (const w of T('work_centers')) { if (w.status === 'running') wc.running++; else if (w.status === 'fault') wc.fault++; else if (w.status === 'maintain') wc.maintain++; }
    const monthGood = T('reports').filter((r) => r.report_date >= t.slice(0, 8) + '01').reduce((a, r) => a + num(r.qty_good), 0);

    const monthStart = t.slice(0, 8) + '01';
    const monthStepGood = T('reports').filter((r) => r.report_date >= monthStart).reduce((a, r) => a + num(r.qty_good), 0);
    const monthPrev = new Date(Date.parse(monthStart) - 86400000).toISOString().slice(0, 10);
    const fg = flowDelta(t, dayOffset(-1));      // 今日新增完工
    const fgm = flowDelta(t, monthPrev);         // 本月新增完工

    return ok({
      // good = 全流程合格（新增完工）；stepGood = 工序级作业合格量（各工序累加，未去重）
      today: { good: fg.good, stepGood: good, cumulative: fg.cum, bad, hours: +(minu / 60).toFixed(1), people },
      yield: good + bad > 0 ? +((good / (good + bad)) * 100).toFixed(1) : 100,
      orders: ord, workCenters: wc, monthGood: fgm.good, monthStepGood,
    });
  });
  R('GET', '/stats/trend', (_p, _b, q) => {
    const days = Math.min(90, Math.max(3, num(q.days, 14)));
    const from = dayOffset(-(days - 1));
    // 工序级：不良、工时（一人一道工序，按工序口径统计）
    const map = {};
    for (const r of T('reports')) {
      if (r.report_date >= from) {
        const e = map[r.report_date] || (map[r.report_date] = { d: r.report_date, bad: 0, minu: 0 });
        e.bad += num(r.qty_bad); e.minu += num(r.work_min);
      }
    }
    // 全流程：每日新增完工数 = 当日完工量 - 前一日完工量
    const out = [];
    let prev = finishedByOrder(dayOffset(-days));
    for (let i = 0; i < days; i++) {
      const d = dayOffset(-(days - 1 - i));
      const now = finishedByOrder(d);
      let good = 0;
      for (const k of Object.keys(now)) good += Math.max(0, now[k] - (prev[k] === undefined ? now[k] : prev[k]));
      prev = now;
      const e = map[d] || {};
      out.push({ d, good, bad: e.bad || 0, minu: e.minu || 0 });
    }
    return ok(out);
  });
  R('GET', '/stats/bad', (_p, _b, q) => {
    const days = Math.min(90, Math.max(3, num(q.days, 14)));
    const from = dayOffset(-(days - 1));
    const map = {};
    for (const r of T('reports')) { if (r.report_date >= from && num(r.qty_bad) > 0 && r.bad_reason) { map[r.bad_reason] = (map[r.bad_reason] || 0) + num(r.qty_bad); } }
    return ok(Object.keys(map).map((k) => ({ name: k, qty: map[k] })).sort((a, b) => b.qty - a.qty));
  });
  R('GET', '/stats/ranking', (_p, _b, q) => {
    const days = Math.min(90, Math.max(3, num(q.days, 7)));
    const from = dayOffset(-(days - 1));
    const map = {};
    for (const r of T('reports')) {
      if (r.report_date >= from) {
        const u = find('users', r.worker_id) || { name: '?', team: '' };
        const e = map[r.worker_id] || (map[r.worker_id] = { id: r.worker_id, name: u.name, team: u.team, good: 0, bad: 0, minu: 0, cnt: 0, dys: {} });
        e.good += num(r.qty_good); e.bad += num(r.qty_bad); e.minu += num(r.work_min); e.cnt++; e.dys[r.report_date] = 1;
      }
    }
    return ok(Object.values(map).map((e) => { const d = e.dys; delete e.dys; e.dys = Object.keys(d).length; return e; }).sort((a, b) => b.good - a.good));
  });
  R('GET', '/stats/orders', () => {
    const list = T('orders').filter((o) => o.status !== 'closed').map(orderRow)
      .map((o) => ({ code: o.code, status: o.status, plan_end: o.plan_end, product_name: o.product_name, qty_plan: o.qty_plan, qty_done: o.qty_done }))
      .sort((a, b) => a.priority - b.priority || (a.plan_end > b.plan_end ? 1 : -1));
    return ok(list.slice(0, 200));
  });

  /* 二维码 + 免登录（静态版无需令牌，直接返回可访问链接） */
  R('GET', '/qr/order/(\\d+)', (m) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const o = find('orders', m[0]); if (!o) return fail('工单不存在', 404);
    const p = find('products', o.product_id) || {};
    const url = (global.location ? global.location.origin : '') + '/m/index.html?o=' + o.id + '&t=static';
    return ok({ order: { id: o.id, code: o.code, product_name: p.name }, token: 'static', url, svg: makeQr(url) });
  });
  R('GET', '/qr/worker/(\\d+)', (m) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const w = find('users', m[0]); if (!w) return fail('员工不存在', 404);
    const url = (global.location ? global.location.origin : '') + '/m/index.html?w=' + w.id + '&t=static';
    return ok({ worker: { id: w.id, name: w.name, team: w.team }, token: 'static', url, svg: makeQr(url) });
  });
  R('GET', '/public/order/(\\d+)', (m, _b, q) => {
    const o = find('orders', m[0]); if (!o) return fail('工单不存在', 404);
    const wTeam = q.wid ? (find('users', num(q.wid)) || {}).team : null;
    const orderOpen = T('order_steps').some((s) => s.order_id === o.id && !s.assignee_team);
    const workerHere = wTeam && T('order_steps').some((s) => s.order_id === o.id && s.assignee_team === wTeam);
    if (q.t && wTeam && !workerHere && !orderOpen) return fail('您暂无该工单的报工权限', 403);
    const p = find('products', o.product_id) || {};
    const order = { id: o.id, code: o.code, status: o.status, qty_plan: o.qty_plan, qty_done: T('order_steps').filter((s) => s.order_id === o.id).reduce((a, s) => a + num(s.qty_good), 0), qty_bad: T('order_steps').filter((s) => s.order_id === o.id).reduce((a, s) => a + num(s.qty_bad), 0), product_name: p.name, spec: p.spec };
    const steps = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b) => a.seq - b.seq).map((s) => { const pr = find('processes', s.process_id) || {}; const au = s.assignee_id ? find('users', s.assignee_id) : null; return { id: s.id, seq: s.seq, qty_plan: s.qty_plan, qty_good: s.qty_good, qty_bad: s.qty_bad, status: s.status, assignee_id: s.assignee_id, assignee_team: s.assignee_team || '', assignee_name: au ? au.name : '', allow_report: s.allow_report === 0 ? 0 : 1, process_name: pr.name, process_code: pr.code }; });
    const workers = T('users').filter((u) => ['worker', 'leader'].includes(u.role) && u.active).map((u) => ({ id: u.id, name: u.name, team: u.team }));
    return ok({ order, steps, workers });
  });
  R('GET', '/public/worker/(\\d+)', (m) => {
    const w = find('users', m[0]); if (!w) return fail('员工不存在', 404);
    const orders = T('orders').filter((o) => ['released', 'running', 'paused'].includes(o.status) && (T('order_steps').some((s) => s.order_id === o.id && s.assignee_team === w.team) || T('order_steps').some((s) => s.order_id === o.id && !s.assignee_team)))
      .map(orderRow).map((o) => ({ id: o.id, code: o.code, status: o.status, qty_plan: o.qty_plan, qty_done: o.qty_done, qty_bad: o.qty_bad, product_name: o.product_name }))
      .sort((a, b) => a.priority - b.priority || (a.plan_end > b.plan_end ? 1 : -1));
    return ok({ worker: { id: w.id, name: w.name, team: w.team }, orders });
  });
  R('POST', '/public/reports', (_p, b) => { try { return ok(doReport({ ...b, order_id: num(b.order_id), worker_id: num(b.worker_id) }, find('users', num(b.worker_id)) || actor())); } catch (e) { return fail(e.message, 400); } });

  /* 日志 */
  R('GET', '/logs', (_p, _b, q) => ok(T('logs').slice().sort((a, b) => b.id - a.id).slice(0, num(q.limit, 100))));

  /* ------------------------------ 通用 CRUD ------------------------------ */
  function crud(table, name, opts) {
    opts = opts || {};
    // 支持按角色放行：opts.roles 传角色数组；否则沿用 opts.admin（仅 admin）
    const forbid = () => opts.roles ? requireRole(...opts.roles) : (opts.admin ? requireRole('admin') : false);
    R('GET', '/' + table, () => {
      if (table === 'users') return ok(T('users').map((u) => { const w = u.work_center_id ? find('work_centers', u.work_center_id) : null; return Object.assign({}, u, { wc_name: w ? w.name : '' }); }));
      return ok(T(table));
    });
    if (!opts.noWrite) {
      R('POST', '/' + table, (_p, b) => {
        if (forbid()) return fail('无权限', 403);
        if (opts.unique) { const ex = T(table).find((r) => r[opts.unique] === b[opts.unique]); if (ex) return fail(opts.unique + ' 已存在'); }
        const row = Object.assign({}, b);
        delete row.id;
        insert(table, row);
        if (opts.log !== false) writeLog(actor(), '新增' + name, b.code || b.name || '');
        return ok({ id: nextId(table) - 1 });
      });
      R('PUT', '/' + table + '/(\\d+)', (m, b) => {
        if (forbid()) return fail('无权限', 403);
        if (opts.unique) { const ex = T(table).find((r) => r[opts.unique] === b[opts.unique] && r.id !== Number(m[0])); if (ex) return fail(opts.unique + ' 已存在'); }
        const patch = Object.assign({}, b); delete patch.id;
        update(table, m[0], patch);
        writeLog(actor(), '修改' + name, b.code || b.name || '');
        return ok(true);
      });
    }
    if (opts.noDelete) return;
    R('DELETE', '/' + table + '/(\\d+)', (m) => {
      if (forbid()) return fail('无权限', 403);
      const id = Number(m[0]);
      if (opts.onDelete) { const msg = opts.onDelete(id); if (msg) return fail(msg, 409); }
      remove(table, id);
      writeLog(actor(), '删除' + name, '#' + id);
      return ok(true);
    });
  }
  crud('products', '产品', { unique: 'code', onDelete: (id) => { const routeIds = T('routes').filter((r) => r.product_id === id).map((r) => r.id); if (routeIds.length && T('orders').some((o) => routeIds.includes(o.route_id))) return '该产品已被工单使用，无法删除'; return ''; } });
  crud('processes', '工序', { unique: 'code', onDelete: (id) => { const routeIds = T('route_steps').filter((s) => s.process_id === id).map((s) => s.route_id); if (routeIds.length && T('orders').some((o) => routeIds.includes(o.route_id))) return '该工序已被工单使用，无法删除'; return ''; } });
  crud('work_centers', '工作中心', { unique: 'code', onDelete: (id) => { if (T('order_steps').some((s) => s.work_center_id === id) || T('users').some((u) => u.work_center_id === id) || T('route_steps').some((s) => s.work_center_id === id)) return '该工作中心已被使用，无法删除'; return ''; } });
  crud('customers', '客户', { unique: 'code' });
  crud('bad_reasons', '不良原因', { unique: 'name' });
  crud('materials', '物料档案', { roles: ['admin', 'leader'], unique: 'code', onDelete: (id) => { if (T('inventory_tx').some((t) => Number(t.material_id) === id)) return '该物料已有库存流水，不能删除（可停用）'; return ''; } });
  crud('warehouses', '仓库', { roles: ['admin', 'leader'], unique: 'code', onDelete: (id) => { if (T('inventory').some((r) => Number(r.warehouse_id) === id)) return '该仓库已有库存记录，不能删除'; return ''; } });

  R('POST', '/materials/import_products', () => {
    if (requireOrderMgr()) return fail('无权限', 403);
    let n = 0;
    T('products').forEach((p) => {
      if (!p.code || T('materials').some((m) => m.code === p.code)) return;
      insert('materials', { code: p.code, name: p.name, spec: p.spec || null, material: null, category: '成品', unit: p.unit || '件', warehouse_id: null, location: null, safe_min: 0, safe_max: null, active: 1, remark: '从产品档案导入', created_at: nowISO() });
      n++;
    });
    return ok({ imported: n });
  });

  /* ------------------------------ 库存台账 / 收发明细 ------------------------------ */
  R('GET', '/inventory', () => ok(T('inventory').map((r) => {
    const m = find('materials', r.material_id) || {};
    const w = r.warehouse_id ? find('warehouses', r.warehouse_id) : null;
    return Object.assign({}, r, { material_code: m.code, material_name: m.name, spec: m.spec, unit: m.unit, category: m.category, safe_min: m.safe_min, safe_max: m.safe_max, warehouse_name: w ? w.name : '' });
  })));
  R('GET', '/inventory_tx', (_p, _b, q) => {
    let rows = T('inventory_tx').slice().sort((a, b) => b.id - a.id);
    if (q.material_id) rows = rows.filter((t) => Number(t.material_id) === Number(q.material_id));
    if (q.tx_type) rows = rows.filter((t) => t.tx_type === q.tx_type);
    if (q.order_id) rows = rows.filter((t) => Number(t.order_id) === Number(q.order_id));
    return ok(rows.slice(0, num(q.limit, 500)).map((t) => {
      const m = find('materials', t.material_id) || {};
      const w = t.warehouse_id ? find('warehouses', t.warehouse_id) : null;
      const o = t.order_id ? find('orders', t.order_id) : null;
      return Object.assign({}, t, { material_code: m.code, material_name: m.name, unit: m.unit, warehouse_name: w ? w.name : '', order_code: o ? o.code : '' });
    }));
  });

  /* 单据写操作：同步生成收发明细并更新库存台账（与后端规则一致） */
  function applyStock(o) {
    const mid = Number(o.material_id);
    const qty = num(o.qty);
    if (!mid || !qty) return;
    const m0 = find('materials', mid) || {};
    const wh = o.warehouse_id ? Number(o.warehouse_id) : (m0.warehouse_id ? Number(m0.warehouse_id) : null);
    let row = T('inventory').find((r) => Number(r.material_id) === mid && Number(r.warehouse_id || 0) === Number(wh || 0) && String(r.batch || '') === String(o.batch || ''));
    if (!row) {
      const id = insert('inventory', { material_id: mid, warehouse_id: wh, batch: o.batch || null, location: o.location || null, qty: 0, updated_at: nowISO() });
      row = find('inventory', id);
    }
    const m = find('materials', mid) || {};
    const before = num(row.qty), after = before + qty;
    if (after < -1e-9) throw new Error('库存不足：' + (m.name || mid) + '，当前库存 ' + before + '，本次出库 ' + Math.abs(qty));
    row.qty = after;
    if (o.location) row.location = o.location;
    row.updated_at = nowISO();
    insert('inventory_tx', {
      material_id: mid, warehouse_id: wh, batch: row.batch, tx_type: o.tx_type, qty,
      before_qty: before, after_qty: after, ref_type: o.ref_type || null, ref_id: o.ref_id || null,
      ref_code: o.ref_code || null, order_id: o.order_id ? Number(o.order_id) : null, operator: o.operator || null,
      tx_date: o.tx_date || today(), remark: o.remark || null, created_at: nowISO(),
    });
  }
  function revertStock(refType, refId, operator) {
    T('inventory_tx').filter((t) => t.ref_type === refType && Number(t.ref_id) === Number(refId)).forEach((t) => {
      applyStock({ material_id: t.material_id, warehouse_id: t.warehouse_id, batch: t.batch, qty: -num(t.qty), tx_type: t.tx_type, order_id: t.order_id, operator: operator || t.operator, tx_date: today(), remark: '单据修改/删除冲销' });
    });
    DB.inventory_tx = T('inventory_tx').filter((t) => !(t.ref_type === refType && Number(t.ref_id) === Number(refId)));
  }
  function docWrite(table, name, txType, prefix) {
    const check = () => (requireRole('admin', 'leader') ? fail('无权限', 403) : null);
    R('POST', '/' + table, (_p, b) => {
      const f = check(); if (f) return f;
      const code = b.code || prefix + String(new Date().getFullYear()).slice(2) + pad(new Date().getMonth() + 1) + pad(new Date().getDate()) + String(Math.floor(Math.random() * 900) + 100);
      let mid = b.material_id ? num(b.material_id) : null;
      if (!mid) { const c = String(b.material_code || b.product_code || '').trim(); const m = c ? T('materials').find((x) => x.code === c) : null; if (m) mid = m.id; }
      const id = insert(table, Object.assign({}, b, { code, material_id: mid || null, created_by: actor().id, created_at: nowISO() }));
      try {
        if (mid && b.result !== 'rejected') applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: num(b.qty), tx_type: txType, ref_type: table, ref_id: id, ref_code: code, order_id: b.order_id, operator: actor().name, tx_date: b.incoming_date || b.in_date || today(), remark: name + ' ' + code });
      } catch (e) { remove(table, id); return fail(e.message, 400); }
      writeLog(actor(), '新增' + name, code);
      return ok({ id, code });
    });
    R('PUT', '/' + table + '/(\\d+)', (m, b) => {
      const f = check(); if (f) return f;
      let mid = b.material_id ? num(b.material_id) : null;
      if (!mid) { const c = String(b.material_code || b.product_code || '').trim(); const mm = c ? T('materials').find((x) => x.code === c) : null; if (mm) mid = mm.id; }
      const before = Object.assign({}, find(table, m[0]));
      try {
        revertStock(table, m[0], actor().name);
        update(table, m[0], Object.assign({}, b, { material_id: mid || null }));
        if (mid && b.result !== 'rejected') applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: num(b.qty), tx_type: txType, ref_type: table, ref_id: Number(m[0]), ref_code: b.code || '', order_id: b.order_id, operator: actor().name, tx_date: b.incoming_date || b.in_date || today(), remark: name + ' ' + (b.code || '') });
      } catch (e) { update(table, m[0], before); return fail(e.message, 400); }
      writeLog(actor(), '修改' + name, '#' + m[0]);
      return ok(true);
    });
    R('DELETE', '/' + table + '/(\\d+)', (m) => {
      if (requireRole('admin')) return fail('无权限', 403);
      const id = Number(m[0]);
      try { revertStock(table, id, actor().name); } catch (e) { return fail(e.message, 400); }
      remove(table, id);
      writeLog(actor(), '删除' + name, '#' + id);
      return ok(true);
    });
  }
  crud('incoming_materials', '来料记录', { roles: ['admin', 'leader'], noWrite: true, noDelete: true });
  crud('finished_goods_in', '成品入库', { roles: ['admin', 'leader'], noWrite: true, noDelete: true });
  docWrite('incoming_materials', '来料入库', 'in_incoming', 'LM');
  docWrite('finished_goods_in', '成品入库', 'in_finish', 'RK');
  crud('users', '用户', { admin: true, unique: 'username', onDelete: (id) => { if (Store.currentUser && id === Store.currentUser.id) return '不能删除当前登录的账号'; const rep = T('reports').filter((r) => r.worker_id === id).length; const asg = T('order_steps').filter((s) => s.assignee_id === id).length; if (rep || asg) return `该员工已有 ${rep} 条报工、${asg} 条派工记录，无法删除；如需停用，请在“编辑”中将其状态设为“停用”。`; return ''; } });
  // 工艺路线：写操作走下方专用处理器（会展开 steps → route_steps），故这里 noWrite
  crud('routes', '工艺路线', { roles: ['admin', 'leader'], unique: 'code', noWrite: true, onDelete: (id) => { if (T('orders').some((o) => o.route_id === id)) return '该工艺路线已被工单使用，无法删除'; return ''; } });
  // 工艺路线工序明细（编辑回显）
  R('GET', '/routes/(\\d+)/steps', (m) => ok(T('route_steps').filter((s) => s.route_id === Number(m[0])).sort((a, b) => a.seq - b.seq).map((s) => { const pr = find('processes', s.process_id) || {}; const w = s.work_center_id ? find('work_centers', s.work_center_id) : null; return Object.assign({}, s, { process_name: pr.name, process_code: pr.code, wc_name: w ? w.name : '' }); })));
  R('POST', '/routes', (_p, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    if (T('routes').some((r) => r.code === b.code)) return fail('工艺路线编码已存在');
    const rid = insert('routes', { code: b.code, name: b.name, product_id: num(b.product_id), created_at: nowISO() });
    (b.steps || []).forEach((s) => { const p = find('processes', s.process_id) || { std_time: 0, std_price: 0 }; insert('route_steps', { route_id: rid, seq: num(s.seq), process_id: num(s.process_id), work_center_id: s.work_center_id ? num(s.work_center_id) : null, std_time: num(s.std_time, p.std_time), std_price: num(s.std_price, p.std_price), need_report: 1 }); });
    writeLog(actor(), '新增工艺路线', b.code + ' ' + b.name);
    return ok({ id: rid });
  });
  R('PUT', '/routes/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    update('routes', m[0], { code: b.code, name: b.name, product_id: num(b.product_id) });
    DB.route_steps = T('route_steps').filter((s) => s.route_id !== Number(m[0]));
    (b.steps || []).forEach((s) => { const p = find('processes', s.process_id) || { std_time: 0, std_price: 0 }; insert('route_steps', { route_id: Number(m[0]), seq: num(s.seq), process_id: num(s.process_id), work_center_id: s.work_center_id ? num(s.work_center_id) : null, std_time: num(s.std_time, p.std_time), std_price: num(s.std_price, p.std_price), need_report: 1 }); });
    writeLog(actor(), '修改工艺路线', '#' + m[0] + ' ' + b.code);
    return ok(true);
  });

  /* 会话恢复（静态版：令牌形如 static-<userId>） */
  Store.restoreFromToken = function (tk) {
    if (!tk || tk.indexOf('static-') !== 0) return false;
    const id = Number(tk.slice('static-'.length));
    const u = T('users').find((x) => x.id === id);
    if (!u) return false;
    Store.currentUser = { id: u.id, name: u.name, role: u.role, team: u.team, work_center_id: u.work_center_id };
    return true;
  };

  /* ------------------------------ 分发 ------------------------------ */
  async function handle(method, url, body) {
    const qi = String(url).indexOf('?');
    const pathname = qi < 0 ? url : url.slice(0, qi);
    const query = {};
    if (qi >= 0) new URLSearchParams(url.slice(qi + 1)).forEach((v, k) => { query[k] = v; });
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return await r.fn(m.slice(1), body || {}, query);
    }
    return fail('接口不存在: ' + method + ' ' + pathname, 404);
  }
  Store.handle = handle;

  /* 导出：浏览器挂到 window，Node 测试可 require */
  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
  global.Store = Store;
  if (typeof window !== 'undefined') window.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
