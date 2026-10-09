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
  function load() { try { const s = global.localStorage && global.localStorage.getItem(LS_KEY); if (s) { DB = JSON.parse(s); for (const k of Object.keys(EMPTY)) if (!DB[k]) DB[k] = []; return true; } } catch (e) {} return false; }
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
    const EMPTY = { users: [], customers: [], processes: [], work_centers: [], products: [], routes: [], route_steps: [], bad_reasons: [], orders: [], order_steps: [], reports: [], report_bad_reasons: [], order_bad_reasons: [], logs: [], incoming_materials: [], finished_goods_in: [], material_issues: [], stock_shipments: [], product_boms: [], materials: [], warehouses: [], inventory: [], inventory_tx: [], inspections: [], inspection_defects: [], quality_issues: [], quality_checklists: [], issue_notifications: [], settings: [], stock_alerts: [], equipments: [], equipment_checks: [], sales_orders: [], patrol_records: [] };
    // 打包进原生 APK（Capacitor file:// / 相对根）时，绝对路径 /data/seed.json 会 404，
    // 因此依次尝试「绝对路径 → 相对路径 → 无扩展名同级」，任一成功即用。
    const CANDIDATES = ['/data/seed.json', './data/seed.json', 'data/seed.json'];
    for (const url of CANDIDATES) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res && res.ok) {
          const j = await res.json();
          if (j && Array.isArray(j.users) && j.users.length) { DB = j; break; }
        }
      } catch (e) { /* 换下一个候选 */ }
    }
    if (!DB) DB = EMPTY;
    anchorDates();
    save();
  };
  // 测试/服务端注入
  Store.bootstrap = function (obj) { DB = JSON.parse(JSON.stringify(obj)); Store.currentUser = null; };
  Store.reset = function () { try { global.localStorage && global.localStorage.removeItem(LS_KEY); } catch (e) {} DB = null; };

  const actor = () => Store.currentUser || { id: 1, name: '系统' };
  // 多角色放行：传入若干角色，当前用户不在其中则视为“无权限”（返回 true 表示拦截）
  const requireRole = (...roles) => !Store.currentUser || !roles.includes(Store.currentUser.role);
  const requireOrderMgr = () => requireRole('admin', 'technician');

  /* ------------------------------ 聚合/视图 ------------------------------ */
  function computeOrderAgg(o) {
    const steps = T('order_steps').filter((s) => s.order_id === o.id);
    const goods = steps.map((s) => num(s.qty_good));
    // 完成率口径：仅末道工序（seq 最大）的合格产量，而非各工序合格数最小值
    const last = steps.slice().sort((a, b) => a.seq - b.seq).pop();
    const out = {
      qty_done: last ? num(last.qty_good) : 0,
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
  // 工序在其工单内的显示道次（seq 按 10 递增存储，展示换算为 1 开始的顺序号）
  function stepOrd(s) {
    return T('order_steps').filter((x) => x.order_id === s.order_id && num(x.seq) < num(s.seq)).length + 1;
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
    const badReasons = T('report_bad_reasons').filter((x) => x.report_id === rp.id)
      .map((x) => ({ bad_reason: x.bad_reason, bad_reason_id: x.bad_reason_id, bad_reason_detail: x.bad_reason_detail, qty: x.qty }));
    const isTime = String(rp.wage_type) === 'time';
    const rate = rp.unit_price !== undefined && rp.unit_price !== null ? num(rp.unit_price) : (isTime ? num(o.hourly_rate) : num(pr && pr.std_price));
    const amount = Math.round((isTime ? num(rp.work_hours) * rate : num(rp.qty_good) * rate) * 100) / 100;
    return Object.assign({}, rp, { worker_name: u.name, order_code: o.code, process_name: pr ? pr.name : '', wc_name: w ? w.name : '', bad_reasons: badReasons,
      wage_type: rp.wage_type || 'piece', work_hours: num(rp.work_hours), unit_price: rate, amount });
  }

  /* ------------------------------ 报工核心 ------------------------------ */
  function doReport(b, act) {
    const order = find('orders', Number(b.order_id));
    if (!order) throw new Error('工单不存在');
    if (['done', 'closed'].includes(order.status)) throw new Error('工单已完成，无法继续报工');

    const items = Array.isArray(b.steps)
      ? b.steps.map((s) => ({ order_step_id: Number(s.order_step_id), qty_good: s.qty_good, qty_bad: s.qty_bad, bad_reason: s.bad_reason, bad_reason_id: Number(s.bad_reason_id) || 0, bad_reason_detail: s.bad_reason_detail, work_min: s.work_min, bad_reasons: Array.isArray(s.bad_reasons) ? s.bad_reasons : null }))
      : [{ order_step_id: Number(b.order_step_id), qty_good: b.qty_good, qty_bad: b.qty_bad, bad_reason: b.bad_reason, bad_reason_id: Number(b.bad_reason_id) || 0, bad_reason_detail: b.bad_reason_detail, work_min: b.work_min, bad_reasons: Array.isArray(b.bad_reasons) ? b.bad_reasons : null }];
    if (!items.length) throw new Error('请至少选择一道工序');

    const workerId = Number(b.worker_id) || act.id;
    const results = [];
    // 末道工序（seq 最大）合格数自动计入成品仓
    const product = find('products', order.product_id) || {};
    const lastStep = T('order_steps').filter((s) => s.order_id === order.id).sort((a, b) => b.seq - a.seq)[0];
    const lastStepId = lastStep ? lastStep.id : null;

    items.forEach((it) => {
      const step = find('order_steps', it.order_step_id);
      if (!step || Number(step.order_id) !== Number(b.order_id)) throw new Error('工序不存在（#' + it.order_step_id + '）');
      if (step.assignee_team && act.role !== 'admin' && act.role !== 'technician') {
        const wid = Number(b.worker_id) || act.id;
        const wu = find('users', wid);
        const wteam = (act.team) || (wu && wu.team);
        if (wteam !== step.assignee_team) {
          throw new Error('工序「' + step.seq + '」限「' + step.assignee_team + '」班组报工（您为「' + (wteam || '未分组') + '」）');
        }
      }
      if (step.allow_report === 0 && act.role !== 'admin' && act.role !== 'technician') {
        throw new Error('工序「' + step.seq + '」需由管理员/技术员报工，员工不可申报');
      }
      const good = Math.max(0, Math.floor(num(it.qty_good)));
      // 不良明细：支持一道工序多种不良（bad_reasons 数组）；旧版单原因兜底
      let badEntries = [];
      let bad;
      const rawBad = it.bad_reasons;
      if (Array.isArray(rawBad) && rawBad.length) {
        for (const e of rawBad) {
          const q = Math.max(0, Math.floor(num(e.qty)));
          if (q <= 0) continue;
          let brId = num(e.bad_reason_id) || 0;
          let brName = '';
          const detail = String(e.bad_reason_detail || '').trim();
          if (brId) {
            const br = find('bad_reasons', brId);
            if (!br) throw new Error('不良原因不存在（#' + brId + '）');
            // 选「其他」并填写具体说明 → 以说明作为具体原因；bad_reason_id 置空
            if (br.name === '其他' && detail) { brName = detail; brId = 0; } else { brName = br.name; }
          } else if (e.bad_reason) {
            brName = String(e.bad_reason);
          } else {
            brName = '其他';
          }
          badEntries.push({ bad_reason_id: brId || null, bad_reason: brName, bad_reason_detail: detail, qty: q });
        }
        bad = badEntries.reduce((a, e) => a + e.qty, 0);
      } else {
        bad = Math.max(0, Math.floor(num(it.qty_bad)));
        const detail = String(it.bad_reason_detail || '').trim();
        let resolved = '';
        if (it.bad_reason_id) {
          const br = find('bad_reasons', it.bad_reason_id);
          if (br) resolved = (br.name === '其他' && detail) ? detail : br.name;
          else resolved = it.bad_reason || '';
        } else resolved = it.bad_reason || '';
        if (bad > 0) badEntries.push({ bad_reason_id: it.bad_reason_id ? Number(it.bad_reason_id) : null, bad_reason: resolved || '其他', bad_reason_detail: detail, qty: bad });
      }
      if (good + bad <= 0) throw new Error('工序「' + step.seq + '」合格数与不良数不能同时为 0');
      const finished = (step.qty_good + good) >= step.qty_plan;
      // 检验点：报工后该工序落「待检」，由质检员判定后才放行完工（一期检验模式）
      const needInspect = !!String(step.inspect_type || '').trim();

      // 工资核算快照：计件=合格数×工序单价；计时=工时×工单时薪
      const isTime = String(order.wage_type) === 'time';
      const workHours = Math.max(0, num(it.work_min)) / 60;
      if (isTime && workHours <= 0) throw new Error('计时核算工单报工需填写实动工时（小时）');
      const snapRate = isTime ? (num(order.hourly_rate) || 0) : (num((find('processes', step.process_id) || {}).std_price) || 0);
      const rid = insert('reports', {
        id: nextId('reports'), order_id: Number(b.order_id), order_step_id: step.id, worker_id: workerId,
        work_center_id: b.work_center_id || step.work_center_id, qty_good: good, qty_bad: bad,
        bad_reason: badEntries[0] ? badEntries[0].bad_reason : '', bad_reason_id: badEntries[0] ? badEntries[0].bad_reason_id : null, work_min: num(it.work_min),
        report_date: b.report_date || today(), remark: b.remark || '', created_at: nowISO(),
        unit_price: snapRate, wage_type: isTime ? 'time' : 'piece', work_hours: workHours > 0 ? workHours : null, photos: '[]',
      });
      for (const e of badEntries) {
        insert('report_bad_reasons', { id: nextId('report_bad_reasons'), report_id: rid, bad_reason_id: e.bad_reason_id, bad_reason: e.bad_reason, bad_reason_detail: e.bad_reason_detail, qty: e.qty });
      }
      update('order_steps', step.id, {
        qty_good: step.qty_good + good, qty_bad: step.qty_bad + bad, work_min: step.work_min + num(it.work_min),
        status: needInspect ? (step.status === 'pending' ? 'running' : step.status) : (finished ? 'done' : 'running'),
        start_time: step.start_time || nowISO(),
        finish_time: needInspect ? null : (finished ? nowISO() : null), assignee_id: step.assignee_id || workerId,
        inspect_status: needInspect ? 'waiting' : (step.inspect_status || null),
      });
      if (order.status === 'created' || order.status === 'released') update('orders', order.id, { status: 'running', start_time: order.start_time || nowISO() });
      if (finished && !needInspect) {
        const nxt = T('order_steps').filter((s) => s.order_id === order.id && s.status === 'pending').sort((a, b) => a.seq - b.seq)[0];
        if (nxt) update('order_steps', nxt.id, { status: 'running' });
      }
      // 末道工序报工合格数 → 自动成品入库（需检验的工序改为判定放行时才入库）
      let autoIn = null;
      if (step.id === lastStepId && good > 0 && !needInspect) {
        autoIn = autoFinishInStatic(order, product, good, act, rid);
      }
      results.push({ order_step_id: step.id, seq: step.seq, finished, needInspect, autoFinishIn: autoIn,
        wage: Math.round((isTime ? workHours * snapRate : good * snapRate) * 100) / 100 });
    });

    if (!T('order_steps').some((s) => s.order_id === order.id && s.status !== 'done')) {
      update('orders', order.id, { status: 'done', finish_time: nowISO() });
    }
    const tg = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_good))), 0);
    const tb = items.reduce((a, it) => a + Math.max(0, Math.floor(num((it.bad_reasons ? (it.bad_reasons.reduce((s, e) => s + Math.max(0, Math.floor(num(e.qty))), 0)) : it.qty_bad)))), 0);
    writeLog(act, '生产报工', order.code + (items.length > 1 ? ' 多工序×' + items.length : '') + ' 合格 ' + tg + ' / 不良 ' + tb);
    try { notifyAfterReport(order, act, items, results, product); } catch (e) { /* 通知失败不阻塞报工 */ }
    return { count: items.length, steps: results, finished: results.some((r) => r.finished), total_wage: Math.round(results.reduce((a, r) => a + (r.wage || 0), 0) * 100) / 100 };
  }
  // 报工后的负责人通知：不良率达阈值（minor_ratio，默认5%）才提醒，收件人=责任人+质检员
  function notifyAfterReport(order, act, items, results, product) {
    const totalGood = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_good))), 0);
    const totalBad = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it._bad || it.qty_bad || 0))), 0);
    if (totalBad > 0) {
      const threshold = Math.min(50, Math.max(0, num(getSetting('minor_ratio', 5), 5))) / 100;
      const ratio = (totalGood + totalBad) > 0 ? totalBad / (totalGood + totalBad) : 1;
      if (ratio >= threshold) {
        const firstStep = items.length ? find('order_steps', items[0].order_step_id) : null;
        const ownerRaw = order.owner_user_id ? find('users', order.owner_user_id) : null;
        const owner = (ownerRaw && ownerRaw.active && ownerRaw.role !== 'worker') ? ownerRaw : null;
        const resp = owner || resolveIssueAssignee(firstStep, order);
        const tos = [resp].concat(T('users').filter((u) => u.active && u.role === 'inspector' && u.id !== act.id && (!resp || u.id !== resp.id)));
        const pct = Math.round(ratio * 1000) / 10;
        pushMessage({
          source: 'quality', toUsers: tos, kind: 'created', ref_type: 'order', ref_id: order.id, link: '#/quality',
          title: `报工不良提醒：${order.code} 不良 ${totalBad} 件（${pct}%）`,
          body: `${act.name} 报工登记合格 ${totalGood} 件、不良 ${totalBad} 件（${product ? product.name : '-'}），不良率 ${pct}% 已达提醒阈值。请核实是否开异常单并跟进处置。`,
        });
      }
    }
    const waiting = results.filter((r) => r.needInspect);
    if (waiting.length) {
      const tos = T('users').filter((u) => u.active && u.role === 'inspector' && u.id !== act.id);
      if (tos.length) {
        const names = waiting.map((r) => {
          const s = find('order_steps', r.order_step_id);
          const p = s ? find('processes', s.process_id) : null;
          const nm = s ? (s.process_name || (p ? p.name : '')) : '';
          const no = s ? stepOrd(s) : r.seq;
          return nm ? nm + '（第' + no + '道）' : '第' + no + '道';
        });
        pushMessage({
          source: 'quality', toUsers: tos, kind: 'created', ref_type: 'order', ref_id: order.id, link: '#/inspect',
          title: `待检任务：${order.code} 有 ${waiting.length} 道工序待检验`,
          body: `${act.name} 已报工提交：${names.join('、')}。请到「质检台」判定。`,
        });
      }
    }
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
        // 撤销报工后若该工序回到零产量，待检标记一并清除（避免留下无来源的待检）
        inspect_status: ((step.qty_good + step.qty_bad - r.qty_good - r.qty_bad) === 0 && step.inspect_status === 'waiting') ? null : step.inspect_status,
      });
      const o = find('orders', step.order_id);
      if (o) {
        const remaining = T('order_steps').filter((s) => s.order_id === o.id && s.status !== 'done');
        if (!remaining.length && o.status === 'done') update('orders', o.id, { status: 'running', finish_time: null });
      }
    }
    // 末道工序自动入库联动回滚：按 report_id 定位并冲销对应成品入库单
    const fins = T('finished_goods_in').filter((f) => Number(f.report_id) === Number(id));
    let rolled = 0;
    for (const f of fins) {
      revertStock('finished_goods_in', f.id, (actor() && actor().name) || '系统');
      DB.finished_goods_in = T('finished_goods_in').filter((x) => x.id !== f.id);
      rolled += Number(f.qty) || 0;
    }
    remove('reports', id);
    DB.report_bad_reasons = T('report_bad_reasons').filter((x) => x.report_id !== id);
    const o = find('orders', r.order_id);
    const detail = (o ? o.code : '') + ' 合格 ' + r.qty_good + (rolled ? '，联动回滚成品入库 ' + rolled + ' 件' : '');
    writeLog(actor(), '撤销报工', detail);
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

  /* 账号：改密码 / 重置密码 / 改资料（APP 员工自助） */
  R('POST', '/password', async (_p, b) => {
    if (!Store.currentUser) return fail('未登录', 401);
    const me = find('users', Store.currentUser.id);
    if (!me) return fail('用户不存在', 404);
    const oldPwd = String(b.old_password || '');
    const newPwd = String(b.new_password || '');
    if (!oldPwd || !newPwd) return fail('原密码与新密码不能为空');
    if (newPwd.length < 6) return fail('新密码至少 6 位');
    if (newPwd === oldPwd) return fail('新密码不能与原密码相同');
    if (me.password !== (await sha256hex('mes:' + oldPwd))) return fail('原密码不正确');
    me.password = await sha256hex('mes:' + newPwd);
    save();
    return ok(true);
  });
  R('POST', '/users/(\\d+)/reset_password', async (m, b) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const target = find('users', m[0]);
    if (!target) return fail('用户不存在', 404);
    const newPwd = String(b.new_password || '');
    if (newPwd.length < 6) return fail('新密码至少 6 位');
    target.password = await sha256hex('mes:' + newPwd);
    save();
    return ok(true);
  });
  R('POST', '/profile', (_p, b) => {
    if (!Store.currentUser) return fail('未登录', 401);
    const name = String(b.name || '').trim();
    if (!name) return fail('姓名不能为空');
    const me = find('users', Store.currentUser.id);
    if (!me) return fail('用户不存在', 404);
    me.name = name;
    Store.currentUser.name = name;
    save();
    return ok({ id: me.id, username: me.username, name: me.name, role: me.role, team: me.team, work_center_id: me.work_center_id });
  });

  /* meta */
  R('GET', '/meta', () => ok({
    products: T('products'), processes: T('processes'), workCenters: T('work_centers'),
    customers: T('customers').map((r) => ({ id: r.id, code: r.code, name: r.name })),
    suppliers: [...new Set(T('incoming_materials').map((r) => r.supplier).filter(Boolean).concat(T('customers').map((r) => r.name)))],
    badReasons: T('bad_reasons'),
    workers: T('users').filter((u) => u.role === 'worker' && u.active).map((r) => ({ id: r.id, name: r.name, team: r.team, work_center_id: r.work_center_id })),
    inspectors: T('users').filter((u) => u.role === 'inspector' && u.active).map((r) => ({ id: r.id, name: r.name, team: r.team, username: r.username })),
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
    out.steps = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b) => a.seq - b.seq).map((s, i) => Object.assign(stepView(s), { seq_no: i + 1 }));
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
      status: 'created', remark: b.remark || '', created_by: actor().id,
      owner_user_id: b.owner_user_id ? num(b.owner_user_id) : null,
      owner_name: b.owner_user_id ? ((u8) => (u8 && u8.active && u8.role !== 'worker' ? u8.name : null))(find('users', b.owner_user_id)) : null,
      wage_type: String(b.wage_type) === 'time' ? 'time' : 'piece',
      hourly_rate: String(b.wage_type) === 'time' ? Math.max(0, num(b.hourly_rate)) : null,
      created_at: nowISO(), start_time: null, finish_time: null, close_reason: '',
    });
    T('route_steps').filter((s) => s.route_id === route.id).sort((a, b) => a.seq - b.seq)
      .forEach((s) => insert('order_steps', { id: 0, order_id: oid, seq: s.seq, process_id: s.process_id, work_center_id: s.work_center_id, assignee_id: null, qty_plan: qty, qty_good: 0, qty_bad: 0, work_min: 0, status: 'pending', start_time: null, finish_time: null, inspect_type: s.inspect_type || (find('processes', s.process_id) || {}).inspect_type || '', inspect_status: null }));
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
    const ownerPatch = {};
    if (Object.prototype.hasOwnProperty.call(b, 'owner_user_id') && b.owner_user_id) {
      const u9 = find('users', b.owner_user_id);
      if (!u9 || !u9.active) return fail('所选责任人不存在或未启用', 400);
      if (u9.role === 'worker') return fail('责任人不能选操作工，请选技术员/质检员/管理员', 400);
      ownerPatch.owner_user_id = num(b.owner_user_id);
      ownerPatch.owner_name = u9.name;
    } else if (Object.prototype.hasOwnProperty.call(b, 'owner_user_id')) {
      ownerPatch.owner_user_id = null;
      ownerPatch.owner_name = null;
    }
    const wagePatch = {};
    if (Object.prototype.hasOwnProperty.call(b, 'wage_type')) {
      const wt = String(b.wage_type) === 'time' ? 'time' : 'piece';
      const hr = wt === 'time' ? Math.max(0, num(b.hourly_rate)) : null;
      if (wt === 'time' && !(hr > 0)) return fail('计时核算工单需填写时薪（元/小时）', 400);
      wagePatch.wage_type = wt;
      wagePatch.hourly_rate = hr;
    }
    update('orders', before.id, {
      product_id: num(b.product_id), route_id: num(b.route_id), customer_id: b.customer_id ? num(b.customer_id) : null,
      qty_plan: num(b.qty_plan), priority: num(b.priority, 2), plan_start: b.plan_start, plan_end: b.plan_end, remark: b.remark || '',
      ...ownerPatch, ...wagePatch,
    });
    if (num(b.route_id) !== before.route_id || num(b.qty_plan) !== before.qty_plan) {
      DB.order_steps = T('order_steps').filter((s) => s.order_id !== before.id);
      T('route_steps').filter((s) => s.route_id === route.id).sort((a, b) => a.seq - b.seq)
        .forEach((s) => insert('order_steps', { id: 0, order_id: before.id, seq: s.seq, process_id: s.process_id, work_center_id: s.work_center_id, assignee_id: null, qty_plan: num(b.qty_plan), qty_good: 0, qty_bad: 0, work_min: 0, status: 'pending', start_time: null, finish_time: null, inspect_type: s.inspect_type || (find('processes', s.process_id) || {}).inspect_type || '', inspect_status: null }));
    } else {
      T('order_steps').filter((s) => s.order_id === before.id).forEach((s) => update('order_steps', s.id, { qty_plan: num(b.qty_plan) }));
    }
    writeLog(actor(), '修改工单', before.code);
    return ok(true);
  });
  R('PUT', '/orders/(\\d+)/owner', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    const uid = b.owner_user_id ? num(b.owner_user_id) : null;
    let uname = null;
    if (uid) {
      const u = find('users', uid);
      if (!u || !u.active) return fail('所选用户不存在或未启用', 400);
      if (u.role === 'worker') return fail('责任人不能选操作工，请选技术员/质检员/管理员', 400);
      uname = u.name;
    }
    update('orders', o.id, { owner_user_id: uid, owner_name: uname });
    writeLog(actor(), '指派工单负责人', o.code + (uname ? ' → ' + uname : ' → 取消负责人'));
    return ok({ owner_user_id: uid, owner_name: uname });
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
    // 下发时通知已指派班组（派工待办）
    if (to === 'released') { try { notifyAssign(o, o.id); } catch (e) { /* 忽略 */ } }
    return ok(true);
  });
  R('PATCH', '/orders/(\\d+)/steps/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    update('order_steps', m[1], { assignee_team: b.assignee_team || null, work_center_id: b.work_center_id ? num(b.work_center_id) : null, allow_report: (b.allow_report === 0 || b.allow_report === '0' || b.allow_report === false) ? 0 : 1 });
    const o = find('orders', m[0]);
    writeLog(actor(), '工序派工', (o ? o.code : m[0]) + ' 工序#' + m[1] + (b.assignee_team ? ' → ' + b.assignee_team : ''));
    // 单独指派工序班组时也通知（工单须已在制/已下发）
    if (b.assignee_team && o && ['released', 'running', 'paused'].indexOf(o.status) >= 0) {
      try {
        const step = T('order_steps').filter((s) => s.id === Number(m[1]) && s.order_id === o.id)[0];
        notifyAssign(o, o.id, step ? [step] : null);
      } catch (e) { /* 忽略 */ }
    }
    return ok(true);
  });
  /* 工单工序增减：待下发/已下发/生产中/已暂停 可调整；已完成、已关闭禁止；已报工工序不可删 */
  const STEP_EDIT = { created: 1, released: 1, running: 1, paused: 1 };
  const STATUS_LABEL2 = { created: '待下发', released: '已下发', running: '生产中', paused: '已暂停', done: '已完成', closed: '已关闭' };
  R('POST', '/orders/(\\d+)/steps', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    if (!STEP_EDIT[o.status]) return fail('工单处于「' + (STATUS_LABEL2[o.status] || o.status) + '」状态，不能调整工序');
    const pid = num(b.process_id);
    if (!pid || !find('processes', pid)) return fail('请选择要增加的工序');
    const qty = num(b.qty_plan) > 0 ? num(b.qty_plan) : num(o.qty_plan);
    const steps = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b2) => a.seq - b2.seq);
    const atPos = num(b.at_pos);
    let seq;
    if (atPos > 0 && atPos <= steps.length) {
      seq = num(steps[atPos - 1].seq);
      steps.slice(atPos - 1).forEach((s) => update('order_steps', s.id, { seq: num(s.seq) + 10 }));
    } else {
      seq = (steps.length ? Math.max.apply(null, steps.map((s) => num(s.seq))) : 0) + 10;
    }
    const proc = find('processes', pid);
    insert('order_steps', {
      id: 0, order_id: o.id, seq, process_id: pid, work_center_id: b.work_center_id ? num(b.work_center_id) : null,
      assignee_id: null, assignee_team: b.assignee_team || null, allow_report: (b.allow_report === 0 || b.allow_report === '0' || b.allow_report === false) ? 0 : 1,
      qty_plan: qty, qty_good: 0, qty_bad: 0, work_min: 0, status: 'pending', start_time: null, finish_time: null,
      inspect_type: b.inspect_type !== undefined ? String(b.inspect_type || '') : ((proc && proc.inspect_type) || ''), inspect_status: null,
    });
    writeLog(actor(), '工单增加工序', o.code + ' 增加「' + (proc ? proc.name : pid) + '」×' + qty);
    return ok({ seq });
  });
  R('DELETE', '/orders/(\\d+)/steps/(\\d+)', (m) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    if (!STEP_EDIT[o.status]) return fail('工单处于「' + (STATUS_LABEL2[o.status] || o.status) + '」状态，不能调整工序');
    const st = find('order_steps', m[1]);
    if (!st || st.order_id !== o.id) return fail('工序不存在', 404);
    const rc = T('reports').filter((r) => Number(r.order_step_id) === Number(m[1])).length;
    if (rc) return fail('该工序已有 ' + rc + ' 条报工记录，不能删除（请先在报工流水中撤销）');
    if (num(st.qty_good) || num(st.qty_bad)) return fail('该工序已有报工数量，不能删除（请先在报工流水中撤销）');
    if (T('order_steps').filter((s) => s.order_id === o.id).length <= 1) return fail('至少要保留一道工序');
    const proc = find('processes', st.process_id);
    remove('order_steps', st.id);
    writeLog(actor(), '工单删除工序', o.code + ' 删除「' + (proc ? proc.name : '#' + st.id) + '」');
    return ok(true);
  });
  R('PUT', '/orders/(\\d+)/steps/order', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    if (!STEP_EDIT[o.status]) return fail('工单处于「' + (STATUS_LABEL2[o.status] || o.status) + '」状态，不能调整工序');
    const ids = Array.isArray(b.order) ? b.order.map((x) => num(x)).filter((x) => x > 0) : [];
    if (!ids.length) return fail('缺少工序顺序');
    const steps = T('order_steps').filter((s) => s.order_id === o.id);
    const have = new Set(steps.map((s) => s.id));
    if (ids.length !== steps.length) return fail('工序顺序必须包含该工单的全部 ' + steps.length + ' 道工序');
    if (!ids.every((id) => have.has(id))) return fail('工序顺序中包含不属于该工单的工序');
    ids.forEach((id, i) => update('order_steps', id, { seq: (i + 1) * 10 }));
    writeLog(actor(), '工单工序排序', o.code + ' 调整为 ' + ids.length + ' 道工序的新顺序');
    return ok(true);
  });
  R('PUT', '/orders/(\\d+)/steps/(\\d+)/inspect', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    const st = find('order_steps', m[1]);
    if (!st || st.order_id !== o.id) return fail('工序不存在', 404);
    const t = String((b || {}).inspect_type || '').trim();
    if (t && !['iqc', 'ipqc', 'fqc'].includes(t)) return fail('无效的检验类型');
    // 取消检验：任何状态都允许（含已完成/已关闭），仅清空检验标记；待检/不合格一并放行流转
    if (!t) {
      const was = String(st.inspect_status || '');
      if (was === 'waiting' || was === 'failed') {
        const fin = num(st.qty_good) >= num(st.qty_plan);
        update('order_steps', st.id, { inspect_type: '', inspect_status: null, status: fin ? 'done' : 'running', finish_time: fin ? nowISO() : null });
        if (fin) {
          const nx = T('order_steps').filter((x) => x.order_id === o.id && x.status === 'pending').sort((a, b2) => a.seq - b2.seq)[0];
          if (nx) update('order_steps', nx.id, { status: 'running' });
        }
        const left = T('order_steps').filter((x) => x.order_id === o.id && x.status !== 'done').length;
        if (left === 0) update('orders', o.id, { status: 'done', finish_time: nowISO() });
        else if (o.status === 'paused') update('orders', o.id, { status: 'running' });
      } else {
        update('order_steps', st.id, { inspect_type: '' });
      }
      writeLog(actor(), '取消工序检验', o.code + ' 工序#' + st.id + ' 已按普通工序放行流转');
      return ok({ inspect_type: '' });
    }
    // 设置新检验点：要求工单处于可编辑状态且无报工、未进入检验流程
    if (!STEP_EDIT[o.status]) return fail('工单处于「' + (STATUS_LABEL2[o.status] || o.status) + '」状态，不能设置检验点');
    const hasRep = T('reports').some((r) => r.order_step_id === st.id) || num(st.qty_good) || num(st.qty_bad);
    if (hasRep) return fail('该工序已有报工记录，不能设置检验点');
    if (st.inspect_status) return fail('该工序已在检验流程中，不能设置检验点');
    update('order_steps', st.id, { inspect_type: t });
    writeLog(actor(), '工单设置检验点', o.code + ' → ' + t);
    return ok({ inspect_type: t });
  });

  /* ---------- 领料退料 / 成品出库 / 盘点调整 / 产出比 / 收发存汇总 ---------- */
  const ISSUE_LBL = { pick: '领料', return: '退料' };
  const issueView = (i) => {
    const o = i.order_id ? find('orders', i.order_id) : null;
    const m = i.material_id ? find('materials', i.material_id) : {};
    const w = i.warehouse_id ? find('warehouses', i.warehouse_id) : null;
    return Object.assign({}, i, { order_code: o ? o.code : '', m_code: m.code || '', m_name: m.name || '', warehouse_name: w ? w.name : '' });
  };
  const shipView = (s) => {
    const o = s.order_id ? find('orders', s.order_id) : null;
    const m = s.material_id ? find('materials', s.material_id) : {};
    const w = s.warehouse_id ? find('warehouses', s.warehouse_id) : null;
    return Object.assign({}, s, { order_code: o ? o.code : '', m_code: m.code || '', m_name: m.name || '', warehouse_name: w ? w.name : '' });
  };
  R('GET', '/material_issues', (_p, _b, q) => {
    let rows = T('material_issues').slice().sort((a, b) => b.id - a.id);
    if (q && q.order_id) rows = rows.filter((r) => Number(r.order_id) === Number(q.order_id));
    if (q && q.type) rows = rows.filter((r) => r.type === q.type);
    return ok(rows.map(issueView));
  });
  R('POST', '/material_issues', (_p, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const type = b.type === 'return' ? 'return' : 'pick';
    const qty = num(b.qty);
    if (!(qty > 0)) return fail('数量必须大于 0');
    if (type === 'pick' && !b.order_id) return fail('领料必须关联工单（退料可选）');
    const m = find('materials', num(b.material_id));
    if (!m) return fail('请选择物料');
    const code = (b.code && b.code.trim()) ? b.code.trim() : genCode(type === 'pick' ? 'LL' : 'TL');
    if (T('material_issues').some((r) => r.code === code)) return fail('该单号已存在');
    const date = b.issue_date || today();
    const id = insert('material_issues', { id: 0, code, type, issue_date: date, order_id: b.order_id ? num(b.order_id) : null,
      material_id: m.id, material_code: m.code, material_name: m.name, material_spec: m.spec || null,
      qty, unit: b.unit || m.unit || '件', warehouse_id: b.warehouse_id ? num(b.warehouse_id) : null, batch: b.batch || null,
      reason: b.reason || null, operator: b.operator || actor().name, remark: b.remark || null, created_by: actor().id, created_at: nowISO() });
    applyStock({ material_id: m.id, warehouse_id: b.warehouse_id, batch: b.batch, qty: type === 'pick' ? -qty : qty,
      tx_type: type === 'pick' ? 'out_pick' : 'in_return', ref_type: 'material_issues', ref_id: id, ref_code: code,
      order_id: b.order_id, operator: actor().name, tx_date: date, remark: ISSUE_LBL[type] + ' ' + code });
    writeLog(actor(), ISSUE_LBL[type], code + ' ' + m.name + ' ×' + qty);
    return ok({ id, code });
  });
  R('PUT', '/material_issues/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const row = find('material_issues', m[0]);
    if (!row) return fail('单据不存在', 404);
    const type = b.type === 'return' ? 'return' : (b.type === 'pick' ? 'pick' : row.type);
    const qty = num(b.qty) > 0 ? num(b.qty) : num(row.qty);
    const mrec = find('materials', num(b.material_id) || row.material_id);
    revertStock('material_issues', row.id, actor().name);
    update('material_issues', row.id, { type, issue_date: b.issue_date || row.issue_date,
      order_id: b.order_id !== undefined ? (b.order_id ? num(b.order_id) : null) : row.order_id,
      material_id: mrec ? mrec.id : row.material_id, material_code: mrec ? mrec.code : row.material_code,
      material_name: mrec ? mrec.name : row.material_name, material_spec: mrec ? mrec.spec : row.material_spec,
      qty, unit: b.unit || row.unit, warehouse_id: b.warehouse_id !== undefined ? (b.warehouse_id ? num(b.warehouse_id) : null) : row.warehouse_id,
      batch: b.batch !== undefined ? (b.batch || null) : row.batch,
      reason: b.reason !== undefined ? (b.reason || null) : row.reason,
      operator: b.operator || row.operator, remark: b.remark !== undefined ? (b.remark || null) : row.remark });
    applyStock({ material_id: mrec ? mrec.id : row.material_id, warehouse_id: b.warehouse_id, batch: b.batch,
      qty: type === 'pick' ? -qty : qty, tx_type: type === 'pick' ? 'out_pick' : 'in_return',
      ref_type: 'material_issues', ref_id: row.id, ref_code: row.code, order_id: row.order_id,
      operator: actor().name, tx_date: b.issue_date || row.issue_date, remark: ISSUE_LBL[type] + '(改) ' + row.code });
    writeLog(actor(), '修改' + ISSUE_LBL[type] + '单', row.code);
    return ok(true);
  });
  R('DELETE', '/material_issues/(\\d+)', (m) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const row = find('material_issues', m[0]);
    if (!row) return fail('单据不存在', 404);
    revertStock('material_issues', row.id, actor().name);
    DB.material_issues = T('material_issues').filter((x) => x.id !== row.id);
    writeLog(actor(), '删除' + ISSUE_LBL[row.type] + '单', row.code);
    return ok(true);
  });
  R('GET', '/stock_shipments', (_p, _b, q) => {
    let rows = T('stock_shipments').slice().sort((a, b) => b.id - a.id);
    if (q && q.order_id) rows = rows.filter((r) => Number(r.order_id) === Number(q.order_id));
    return ok(rows.map(shipView));
  });
  R('POST', '/stock_shipments', (_p, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const qty = num(b.qty);
    if (!(qty > 0)) return fail('数量必须大于 0');
    const m = find('materials', num(b.material_id));
    if (!m) return fail('请选择物料');
    const code = (b.code && b.code.trim()) ? b.code.trim() : genCode('CK');
    if (T('stock_shipments').some((r) => r.code === code)) return fail('该出库单号已存在');
    const date = b.ship_date || today();
    const id = insert('stock_shipments', { id: 0, code, ship_date: date, customer: b.customer || null,
      order_id: b.order_id ? num(b.order_id) : null, sale_ref: b.sale_ref || null,
      material_id: m.id, material_code: m.code, material_name: m.name, material_spec: m.spec || null,
      qty, unit: b.unit || m.unit || '件', warehouse_id: b.warehouse_id ? num(b.warehouse_id) : null, batch: b.batch || null,
      operator: b.operator || actor().name, remark: b.remark || null, created_by: actor().id, created_at: nowISO() });
    applyStock({ material_id: m.id, warehouse_id: b.warehouse_id, batch: b.batch, qty: -qty, tx_type: 'out_ship',
      ref_type: 'stock_shipments', ref_id: id, ref_code: code, order_id: b.order_id,
      operator: actor().name, tx_date: date, remark: '成品出库 ' + code });
    writeLog(actor(), '成品出库', code + ' ' + m.name + ' ×' + qty);
    if (b.sale_ref) salesSync(b.sale_ref);
    return ok({ id, code });
  });
  R('PUT', '/stock_shipments/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const row = find('stock_shipments', m[0]);
    if (!row) return fail('单据不存在', 404);
    const qty = num(b.qty) > 0 ? num(b.qty) : num(row.qty);
    const mrec = find('materials', num(b.material_id) || row.material_id);
    revertStock('stock_shipments', row.id, actor().name);
    update('stock_shipments', row.id, { ship_date: b.ship_date || row.ship_date,
      customer: b.customer !== undefined ? (b.customer || null) : row.customer,
      order_id: b.order_id !== undefined ? (b.order_id ? num(b.order_id) : null) : row.order_id,
      sale_ref: b.sale_ref !== undefined ? (b.sale_ref || null) : row.sale_ref,
      material_id: mrec ? mrec.id : row.material_id, material_code: mrec ? mrec.code : row.material_code,
      material_name: mrec ? mrec.name : row.material_name, material_spec: mrec ? mrec.spec : row.material_spec,
      qty, unit: b.unit || row.unit, warehouse_id: b.warehouse_id !== undefined ? (b.warehouse_id ? num(b.warehouse_id) : null) : row.warehouse_id,
      batch: b.batch !== undefined ? (b.batch || null) : row.batch,
      operator: b.operator || row.operator, remark: b.remark !== undefined ? (b.remark || null) : row.remark });
    applyStock({ material_id: mrec ? mrec.id : row.material_id, warehouse_id: b.warehouse_id, batch: b.batch, qty: -qty,
      tx_type: 'out_ship', ref_type: 'stock_shipments', ref_id: row.id, ref_code: row.code, order_id: row.order_id,
      operator: actor().name, tx_date: b.ship_date || row.ship_date, remark: '成品出库(改) ' + row.code });
    writeLog(actor(), '修改成品出库', row.code);
    salesSync(b.sale_ref !== undefined ? b.sale_ref : row.sale_ref);
    if (b.sale_ref !== undefined && row.sale_ref && b.sale_ref !== row.sale_ref) salesSync(row.sale_ref);
    return ok(true);
  });
  R('DELETE', '/stock_shipments/(\\d+)', (m) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const row = find('stock_shipments', m[0]);
    if (!row) return fail('单据不存在', 404);
    revertStock('stock_shipments', row.id, actor().name);
    DB.stock_shipments = T('stock_shipments').filter((x) => x.id !== row.id);
    writeLog(actor(), '删除成品出库', row.code);
    if (row.sale_ref) salesSync(row.sale_ref);
    return ok(true);
  });
  R('POST', '/inventory/adjust', (_p, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const m = find('materials', num(b.material_id));
    if (!m) return fail('物料不存在', 404);
    const physical = num(b.physical_qty, -1);
    if (physical < 0) return fail('请填写有效的实盘数量');
    const wid = b.warehouse_id ? num(b.warehouse_id) : null;
    const bt = String(b.batch || '').trim();
    const inv = T('inventory').find((x) => x.material_id === m.id && (x.warehouse_id || null) === wid && (x.batch || '') === bt);
    const bookQty = inv ? num(inv.qty) : 0;
    const diff = Math.round((physical - bookQty) * 1e6) / 1e6;
    if (!diff) return fail('实盘数与账面数一致（' + bookQty + '），无需调整');
    const code = genCode('PD');
    applyStock({ material_id: m.id, warehouse_id: wid, batch: bt || null, qty: diff, tx_type: 'adjust',
      ref_type: 'adjust', ref_id: null, ref_code: code, order_id: null, operator: actor().name, tx_date: today(),
      remark: '盘点调整 ' + code + '：账面 ' + bookQty + ' → 实盘 ' + physical + (b.remark ? '，' + b.remark : '') });
    writeLog(actor(), '盘点调整', m.name + ' 账面 ' + bookQty + ' → 实盘 ' + physical + '（差异 ' + diff + '）');
    return ok({ code, book: bookQty, physical, diff });
  });
  R('GET', '/stats/yield', (_p, _b, q) => {
    const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
    const monthsMap = { month: 1, quarter: 3, year: 12, all: 0 };
    const months = monthsMap[q.period] !== undefined ? monthsMap[q.period] : 1;
    let start = null;
    if (months > 0) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (months - 1)); start = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01'; }
    const okRes = q.include_pending === '1' ? ['qualified', 'pending'] : ['qualified'];
    const incAll = T('incoming_materials').filter((r) => okRes.includes(r.result) && (!start || r.incoming_date >= start));
    const finAll = T('finished_goods_in').filter((r) => okRes.includes(r.result) && (!start || r.in_date >= start));
    const incTotal = r2(incAll.reduce((s2, r) => s2 + num(r.qty), 0));
    const finTotal = r2(finAll.reduce((s2, r) => s2 + num(r.qty), 0));
    const incPublic = r2(incAll.filter((r) => !r.order_id).reduce((s2, r) => s2 + num(r.qty), 0));
    const incBy = {}; incAll.forEach((r) => { if (r.order_id) incBy[r.order_id] = (incBy[r.order_id] || 0) + num(r.qty); });
    const finBy = {}; finAll.forEach((r) => { if (r.order_id) finBy[r.order_id] = (finBy[r.order_id] || 0) + num(r.qty); });
    const ids = [...new Set([...Object.keys(incBy), ...Object.keys(finBy)])];
    const orders = ids.map((oid) => {
      const o = find('orders', Number(oid)) || {};
      const iq = r2(incBy[oid] || 0), fq = r2(finBy[oid] || 0);
      const st = T('order_steps').filter((s2) => s2.order_id === o.id).map((s2) => num(s2.qty_good));
      const doneQty = o.qty_done !== undefined ? num(o.qty_done) : (st.length ? Math.min.apply(null, st) : 0);
      return { order_id: o.id, order_code: o.code, product_name: o.product_name || (find('products', o.product_id) || {}).name || '', qty_plan: num(o.qty_plan), qty_done: doneQty,
        incoming_qty: iq, finished_qty: fq, ratio: iq > 0 ? r2(fq / iq * 100) : null };
    }).sort((a, b) => b.order_id - a.order_id);
    const d6 = new Date(); d6.setDate(1); d6.setMonth(d6.getMonth() - 5);
    const mStart = d6.getFullYear() + '-' + pad(d6.getMonth() + 1) + '-01';
    const im = {}; T('incoming_materials').forEach((r) => { if (okRes.includes(r.result) && r.incoming_date >= mStart) { const ym = String(r.incoming_date).slice(0, 7); im[ym] = (im[ym] || 0) + num(r.qty); } });
    const fm = {}; T('finished_goods_in').forEach((r) => { if (okRes.includes(r.result) && r.in_date >= mStart) { const ym = String(r.in_date).slice(0, 7); fm[ym] = (fm[ym] || 0) + num(r.qty); } });
    const monthly = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 5 + i);
      const ym = d.getFullYear() + '-' + pad(d.getMonth() + 1);
      const iq = r2(im[ym] || 0), fq = r2(fm[ym] || 0);
      monthly.push({ month: ym, incoming_qty: iq, finished_qty: fq, ratio: iq > 0 ? r2(fq / iq * 100) : null });
    }
    return ok({ period: months === 0 ? 'all' : (q.period || 'month'), start, include_pending: q.include_pending === '1',
      summary: { incoming_qty: incTotal, finished_qty: finTotal, ratio: incTotal > 0 ? r2(finTotal / incTotal * 100) : null, orders_count: ids.length, public_incoming: incPublic },
      monthly, orders });
  });
  /* 产品单耗（简易 BOM）镜像 */
  R('GET', '/boms', () => ok(T('product_boms').map((b) => {
    const p = find('products', b.product_id) || {}, m = find('materials', b.material_id) || {};
    return Object.assign({}, b, { product_name: p.name, product_code: p.code, material_name: m.name, material_code: m.code, unit: m.unit });
  })));
  R('PUT', '/products/(\\d+)/bom', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const pid = num(m[1]);
    if (!find('products', pid)) return fail('产品不存在', 404);
    const items = Array.isArray(b.items) ? b.items : [];
    const seen = new Set();
    for (const it of items) {
      if (!num(it.material_id) || !(num(it.qty_per_unit) > 0)) return fail('BOM 项无效');
      if (seen.has(num(it.material_id))) return fail('同一物料不能重复添加');
      seen.add(num(it.material_id));
    }
    const bomArr = T('product_boms');
    bomArr.splice(0, bomArr.length, ...bomArr.filter((x) => x.product_id !== pid));
    items.forEach((it) => insert('product_boms', { id: 0, product_id: pid, material_id: num(it.material_id), qty_per_unit: num(it.qty_per_unit), loss_rate: num(it.loss_rate), created_at: nowISO() }));
    writeLog(actor(), '配置产品单耗', '产品#' + pid + ' 共 ' + items.length + ' 项材料');
    return ok(true);
  });
  /* 材料损耗率分析镜像（口径与后端一致：应耗 = 成品入库 × 单耗 × (1+损耗率)） */
  R('GET', '/stats/material_loss', (_p, _b, q) => {
    const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
    const d = new Date();
    const start = q.start || d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01';
    const end = q.end || today();
    const finBy = {};
    T('finished_goods_in').forEach((r) => { if (r.result === 'qualified' && r.order_id && r.in_date >= start && r.in_date <= end) finBy[r.order_id] = (finBy[r.order_id] || 0) + num(r.qty); });
    const pickBy = {};
    T('material_issues').forEach((r) => { if (r.order_id && r.issue_date >= start && r.issue_date <= end) pickBy[r.order_id + ':' + r.material_id] = (pickBy[r.order_id + ':' + r.material_id] || 0) + (r.type === 'pick' ? num(r.qty) : -num(r.qty)); });
    const rows = [];
    T('product_boms').forEach((b) => {
      const prod = find('products', b.product_id) || {};
      T('orders').filter((o) => o.product_id === b.product_id && finBy[o.id] > 0).forEach((o) => {
        const finQty = finBy[o.id];
        const should = r2(finQty * num(b.qty_per_unit) * (1 + num(b.loss_rate) / 100));
        const actual = r2(pickBy[o.id + ':' + b.material_id] || 0);
        const mat = find('materials', b.material_id) || {};
        rows.push({ order_id: o.id, order_code: o.code, product_name: prod.name, qty_plan: num(o.qty_plan),
          material_id: b.material_id, material_code: mat.code, material_name: mat.name, unit: mat.unit,
          qty_per_unit: num(b.qty_per_unit), loss_rate_std: num(b.loss_rate), finished_qty: r2(finQty), should_use: should, actual_pick: actual,
          loss_rate: should > 0 ? Math.round((actual - should) / should * 1000) / 10 : null });
      });
    });
    rows.sort((a, b) => (a.order_code < b.order_code ? -1 : 1));
    return ok({ start, end, rows, hint: rows.length ? null : '未配置产品单耗或期间内无成品入库' });
  });
  R('GET', '/stats/inventory_summary', (_p, _b, q) => {
    const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
    const d = new Date();
    const start = q.start || d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01';
    const end = q.end || today();
    // 口径与后端一致：期末=台账；期初倒推（tx 含冲销红字，直接按 tx 净算会与台账不一致）
    const invBy = {};
    T('inventory').forEach((r) => { invBy[r.material_id] = (invBy[r.material_id] || 0) + num(r.qty); });
    const txBy = {};
    T('inventory_tx').forEach((t) => {
      if (t.tx_date < start || t.tx_date > end) return;
      const b = txBy[t.material_id] || (txBy[t.material_id] = { in_qty: 0, out_qty: 0 });
      if (num(t.qty) > 0) b.in_qty += num(t.qty); else b.out_qty -= num(t.qty);
    });
    const rows = [];
    T('materials').forEach((m) => {
      const closing = r2(invBy[m.id] || 0);
      const b = txBy[m.id] || { in_qty: 0, out_qty: 0 };
      const inq = r2(b.in_qty), outq = r2(b.out_qty);
      const opening = r2(closing - inq + outq);
      if (opening || inq || outq || closing) rows.push({ material_id: m.id, material_code: m.code, material_name: m.name, unit: m.unit, category: m.category, opening, in_qty: inq, out_qty: outq, closing });
    });
    rows.sort((a, b) => (a.material_code < b.material_code ? -1 : 1));
    return ok({ start, end, rows });
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
    // 新模型：按 report_bad_reasons 明细聚合
    for (const x of T('report_bad_reasons')) {
      const r = find('reports', x.report_id);
      if (!r || r.report_date < from || num(x.qty) <= 0) continue;
      const name = x.bad_reason_id ? (find('bad_reasons', x.bad_reason_id) || {}).name : x.bad_reason;
      if (name) map[name] = (map[name] || 0) + num(x.qty);
    }
    // 旧模型：无明细行的 reports 仍按原 bad_reason 聚合
    const hasDetail = new Set(T('report_bad_reasons').map((x) => x.report_id));
    for (const r of T('reports')) {
      if (r.report_date >= from && num(r.qty_bad) > 0 && !hasDetail.has(r.id)) {
        const name = r.bad_reason_id ? (find('bad_reasons', r.bad_reason_id) || {}).name : r.bad_reason;
        if (name) map[name] = (map[name] || 0) + num(r.qty_bad);
      }
    }
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
  /* 设备稼动分析（静态镜像）：稼动率=实动工时÷(N天×班制基准 shift_hours，默认8h)，上限100% */
  R('GET', '/stats/equip_util', (_p, _b, q) => {
    const days = Math.min(90, Math.max(3, num(q.days, 7)));
    const sh = Math.min(24, Math.max(1, num(getSetting('shift_hours', 8))));
    const from = dayOffset(-(days - 1));
    const CAP = days * sh * 60;
    const acc = {};
    for (const r of T('reports')) {
      if (r.report_date < from || !r.work_center_id) continue;
      const e = acc[r.work_center_id] || (acc[r.work_center_id] = { cnt: 0, good: 0, bad: 0, minu: 0 });
      e.cnt++; e.good += num(r.qty_good); e.bad += num(r.qty_bad); e.minu += num(r.work_min);
    }
    const rows = T('work_centers').map((w) => {
      const e = acc[w.id] || { cnt: 0, good: 0, bad: 0, minu: 0 };
      return Object.assign({}, w, e, {
        util_pct: Math.min(100, Math.round(e.minu * 1000 / CAP) / 10),
        rate_pct: Math.round(e.good * 1000 / Math.max(1, e.good + e.bad)) / 10,
      });
    }).sort((a, b) => b.minu - a.minu || String(a.code).localeCompare(String(b.code)));
    const used = rows.filter((r) => r.cnt > 0);
    return ok({
      days, shift_hours: sh,
      summary: {
        total_machines: rows.length, used_machines: used.length,
        total_hours: Math.round(used.reduce((s, r) => s + r.minu, 0) / 6) / 10,
        avg_util: used.length ? Math.round(used.reduce((s, r) => s + r.util_pct, 0) / used.length * 10) / 10 : 0,
        good: used.reduce((s, r) => s + r.good, 0), bad: used.reduce((s, r) => s + r.bad, 0),
      },
      rows,
    });
  });
  R('GET', '/equip/settings', () => {
    return ok({ shift_hours: Math.min(24, Math.max(1, num(getSetting('shift_hours', 8)))) });
  });
  R('POST', '/equip/settings', (_p, b) => {
    const me = Store.currentUser || {};
    if (me.role !== 'admin') return { ok: false, msg: '仅管理员可修改' };
    const v = Math.min(24, Math.max(1, num(b.shift_hours, 8)));
    setSetting('shift_hours', String(v));
    return ok({ shift_hours: v });
  });

  /* 二维码 + 免登录（静态版无需令牌，直接返回可访问链接） */
  /* 工资核算（静态镜像）：计件=合格数×单价快照；计时=工时×时薪快照；普通员工仅本人；
   * 附管理层汇总 summary（总额/构成/工时/人数）、teams 班组汇总、trend 近6月趋势 */
  R('GET', '/stats/piece_wage', (_p, _b, q) => {
    const me = Store.currentUser || {};
    const canAll = ['admin', 'technician'].includes(me.role);
    const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : null;
    const days = Math.min(180, Math.max(1, num(q.days, 30)));
    const selfId = canAll ? (num(q.worker_id) || null) : me.id;
    const inRange = (d) => month ? String(d || '').slice(0, 7) === month : d >= dayOffset(-(days - 1));
    const wageOf = (r) => {
      const s = r.order_step_id ? find('order_steps', r.order_step_id) : null;
      const pr = s ? find('processes', s.process_id) : null;
      const o = r.order_id ? find('orders', r.order_id) : null;
      const isTime = String(r.wage_type) === 'time';
      const rate = r.unit_price !== undefined && r.unit_price !== null ? num(r.unit_price) : (isTime ? num(o && o.hourly_rate) : num(pr && pr.std_price));
      return { isTime, rate, hrs: num(r.work_hours) || num(r.work_min) / 60 || 0, amt: isTime ? (num(r.work_hours) || num(r.work_min) / 60 || 0) * rate : num(r.qty_good) * rate };
    };
    const map = {};
    for (const r of T('reports')) {
      if (!inRange(r.report_date)) continue;
      if (selfId && num(r.worker_id) !== selfId) continue;
      const u = find('users', r.worker_id) || { name: '?', team: '' };
      const w = wageOf(r);
      const e = map[r.worker_id] || (map[r.worker_id] = { id: r.worker_id, name: u.name, team: u.team, good: 0, bad: 0, minu: 0, cnt: 0, wage: 0 });
      e.good += num(r.qty_good); e.bad += num(r.qty_bad); e.minu += num(r.work_min); e.cnt++;
      e.wage = Math.round((e.wage + w.amt) * 100) / 100;
    }
    /* 管理层汇总 */
    const sum = { total_wage: 0, time_wage: 0, piece_wage: 0, total_hours: 0, total_good: 0, total_bad: 0, headcount: 0, cnt: 0 };
    const tMap = {};
    for (const r of T('reports')) {
      if (!inRange(r.report_date)) continue;
      if (selfId && num(r.worker_id) !== selfId) continue;
      const w = wageOf(r);
      const u = find('users', r.worker_id) || {};
      const team = u.team || '未分组';
      const t = tMap[team] || (tMap[team] = { team, headcount: 0, good: 0, hours: 0, cnt: 0, wage: 0, _ids: {} });
      if (!t._ids[r.worker_id]) { t._ids[r.worker_id] = 1; t.headcount++; }
      t.good += num(r.qty_good); t.hours = Math.round((t.hours + w.hrs) * 10) / 10; t.cnt++;
      t.wage = Math.round((t.wage + w.amt) * 100) / 100;
      sum.total_wage = Math.round((sum.total_wage + w.amt) * 100) / 100;
      if (w.isTime) sum.time_wage = Math.round((sum.time_wage + w.amt) * 100) / 100;
      else sum.piece_wage = Math.round((sum.piece_wage + w.amt) * 100) / 100;
      sum.total_hours = Math.round((sum.total_hours + w.hrs) * 10) / 10;
      sum.total_good += num(r.qty_good); sum.total_bad += num(r.qty_bad); sum.cnt++;
    }
    sum.headcount = Object.keys(map).length;
    Object.values(tMap).forEach((t) => delete t._ids);
    const teams = Object.values(tMap).sort((a, b) => b.wage - a.wage);
    const ymNow = new Date().toISOString().slice(0, 7);
    const trendMap = {};
    for (const r of T('reports')) {
      const ym = String(r.report_date || '').slice(0, 7);
      if (!ym || ym > ymNow) continue;
      if (ym < new Date(new Date(ymNow + '-15').setMonth(new Date(ymNow + '-15').getMonth() - 5)).toISOString().slice(0, 7)) continue;
      if (selfId && num(r.worker_id) !== selfId) continue;
      const w = wageOf(r);
      const t = trendMap[ym] || (trendMap[ym] = { ym, wage: 0, time_wage: 0, hours: 0 });
      t.wage = Math.round((t.wage + w.amt) * 100) / 100;
      if (w.isTime) t.time_wage = Math.round((t.time_wage + w.amt) * 100) / 100;
      t.hours = Math.round((t.hours + w.hrs) * 10) / 10;
    }
    const trend = Object.values(trendMap).sort((a, b) => a.ym.localeCompare(b.ym));
    let detail = null;
    if (selfId && q.detail) {
      const oById = {}; T('orders').forEach((o) => oById[o.id] = o);
      detail = T('reports').filter((r) => num(r.worker_id) === selfId && inRange(r.report_date))
        .map((r) => { const s = r.order_step_id ? find('order_steps', r.order_step_id) : null; const pr = s ? find('processes', s.process_id) : null;
          const w = wageOf(r);
          return { report_date: r.report_date, qty_good: r.qty_good, qty_bad: r.qty_bad, wage_type: r.wage_type, work_hours: w.hrs, unit_price: w.rate,
            amount: Math.round(w.amt * 100) / 100, order_code: (oById[r.order_id] || {}).code || '', process_name: pr ? pr.name : '' }; })
        .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    }
    return ok({ month, days, rows: Object.values(map).sort((a, b) => b.wage - a.wage || b.good - a.good), detail, summary: sum, teams, trend, self_only: !canAll });
  });

  /* 批次/工单双向追溯（静态镜像） */
  R('GET', '/trace/(.+)', (m) => {
    const code = decodeURIComponent(m[1]).trim();
    const procName = (x) => { const s = x && x.order_step_id ? find('order_steps', x.order_step_id) : null; const pr = s ? find('processes', s.process_id) : null; return pr ? pr.name : ''; };
    const result = { code, type: 'none', suppliers: [], customers: [], orders: [] };
    const order = T('orders').find((o) => o.code === code);
    if (order) {
      result.type = 'order';
      const p = find('products', order.product_id) || {};
      result.order = { id: order.id, code: order.code, status: order.status, qty_plan: order.qty_plan, plan_start: order.plan_start, plan_end: order.plan_end, product_name: p.name, spec: p.spec };
      result.materials = T('material_issues').filter((x) => x.order_id === order.id && x.type === 'pick')
        .map((x) => ({ material_code: x.material_code, material_name: x.material_name, material_spec: x.material_spec, qty: x.qty, unit: x.unit, issue_date: x.issue_date, batch: (T('inventory_tx').find((t) => t.ref_type === 'material_issues' && t.ref_id === x.id) || {}).batch || '', warehouse_name: (find('warehouses', x.warehouse_id) || {}).name || '' }));
      result.reports = T('reports').filter((x) => x.order_id === order.id)
        .map((x) => ({ report_date: x.report_date, qty_good: x.qty_good, qty_bad: x.qty_bad, worker_name: (find('users', x.worker_id) || {}).name, process_name: procName(x) }));
      result.inspections = T('inspections').filter((x) => x.order_id === order.id)
        .map((x) => ({ code: x.code, process_name: x.process_name, conclusion: x.conclusion, qty_check: x.qty_check, qty_pass: x.qty_pass, qty_fail: x.qty_fail, inspector: x.inspector, created_at: x.created_at }));
      result.finished = T('finished_goods_in').filter((x) => x.order_id === order.id)
        .map((x) => ({ code: x.code, in_date: x.in_date, batch: x.batch, qty: x.qty, unit: x.unit }));
      result.shipments = T('stock_shipments').filter((x) => x.order_id === order.id)
        .map((x) => ({ code: x.code, ship_date: x.ship_date, qty: x.qty, unit: x.unit, batch: x.batch, customer: x.customer }));
      result.customers = [...new Set(result.shipments.map((s2) => s2.customer).filter(Boolean))];
    } else {
      const txs = T('inventory_tx').filter((t) => t.batch === code);
      if (txs.length) {
        result.type = 'batch';
        result.txs = txs.map((t) => {
          const m2 = find('materials', t.material_id) || {};
          return { id: t.id, tx_type: t.tx_type, qty: t.qty, batch: t.batch, tx_date: t.tx_date, ref_code: t.ref_code,
            material_code: m2.code, material_name: m2.name, unit: m2.unit,
            warehouse_name: (find('warehouses', t.warehouse_id) || {}).name || '', order_code: (find('orders', t.order_id) || {}).code || '' };
        });
        const ids = [...new Set(txs.map((t) => t.order_id).filter(Boolean))];
        result.orders = ids.map((id) => {
          const o = find('orders', id); if (!o) return null;
          const p = find('products', o.product_id) || {};
          return { id: o.id, code: o.code, status: o.status, qty_plan: o.qty_plan, product_name: p.name,
            reports: T('reports').filter((x) => x.order_id === id).map((x) => ({ report_date: x.report_date, qty_good: x.qty_good, qty_bad: x.qty_bad, worker_name: (find('users', x.worker_id) || {}).name, process_name: procName(x) })),
            inspections: T('inspections').filter((x) => x.order_id === id).map((x) => ({ code: x.code, conclusion: x.conclusion, qty_pass: x.qty_pass, qty_fail: x.qty_fail, created_at: x.created_at })) };
        }).filter(Boolean);
        result.finished = T('finished_goods_in').filter((x) => x.batch === code).map((x) => ({ code: x.code, in_date: x.in_date, qty: x.qty, unit: x.unit }));
        result.shipments = T('stock_shipments').filter((x) => x.batch === code).map((x) => ({ code: x.code, ship_date: x.ship_date, qty: x.qty, unit: x.unit, customer: x.customer }));
        result.customers = [...new Set(result.shipments.map((s2) => s2.customer).filter(Boolean))];
      }
    }
    if (result.type === 'none') return fail('未找到匹配的批次或工单：' + code, 404);
    return ok(result);
  });

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
    const stepsAll = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b) => a.seq - b.seq);
    const lastStep = stepsAll[stepsAll.length - 1];
    const order = { id: o.id, code: o.code, status: o.status, qty_plan: o.qty_plan, qty_done: lastStep ? num(lastStep.qty_good) : 0, qty_bad: T('order_steps').filter((s) => s.order_id === o.id).reduce((a, s) => a + num(s.qty_bad), 0), product_name: p.name, spec: p.spec };
    const steps = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b) => a.seq - b.seq).map((s) => { const pr = find('processes', s.process_id) || {}; const au = s.assignee_id ? find('users', s.assignee_id) : null; return { id: s.id, seq: s.seq, seq_no: stepOrd(s), qty_plan: s.qty_plan, qty_good: s.qty_good, qty_bad: s.qty_bad, status: s.status, assignee_id: s.assignee_id, assignee_team: s.assignee_team || '', assignee_name: au ? au.name : '', allow_report: s.allow_report === 0 ? 0 : 1, inspect_type: s.inspect_type || '', inspect_status: s.inspect_status || '', process_name: pr.name, process_code: pr.code }; });
    const workers = T('users').filter((u) => ['worker', 'technician'].includes(u.role) && u.active).map((u) => ({ id: u.id, name: u.name, team: u.team }));
    return ok({ order, steps, workers });
  });
  R('GET', '/orders/(\\d+)/bad-reasons', (m) => {
    const oid = Number(m[0]);
    const reasons = T('bad_reasons') || [];
    const obr = T('order_bad_reasons') || [];
    const sel = obr.filter((x) => Number(x.order_id) === oid).map((x) => Number(x.bad_reason_id));
    const configured = sel.length > 0;
    const selected = configured ? reasons.filter((r) => sel.indexOf(r.id) >= 0) : reasons;
    return ok({ configured, reasons, selected });
  });
  R('PUT', '/orders/(\\d+)/bad-reasons', (m, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const oid = Number(m[0]);
    if (!find('orders', oid)) return fail('工单不存在', 404);
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => Number(x)).filter((x) => x > 0) : [];
    const valid = new Set((T('bad_reasons') || []).map((r) => r.id));
    const clean = [...new Set(ids)].filter((x) => valid.has(x));
    DB.order_bad_reasons = (T('order_bad_reasons') || []).filter((x) => Number(x.order_id) !== oid);
    for (const id of clean) DB.order_bad_reasons.push({ id: nextId('order_bad_reasons'), order_id: oid, bad_reason_id: id });
    save();
    return ok({ count: clean.length });
  });
  R('GET', '/public/worker/(\\d+)', (m) => {
    const w = find('users', m[0]); if (!w) return fail('员工不存在', 404);
    const orders = T('orders').filter((o) => ['released', 'running', 'paused'].includes(o.status) && (T('order_steps').some((s) => s.order_id === o.id && s.assignee_team === w.team) || T('order_steps').some((s) => s.order_id === o.id && !s.assignee_team)))
      .map(orderRow).map((o) => ({ id: o.id, code: o.code, status: o.status, qty_plan: o.qty_plan, qty_done: o.qty_done, qty_bad: o.qty_bad, product_name: o.product_name }))
      .sort((a, b) => a.priority - b.priority || (a.plan_end > b.plan_end ? 1 : -1));
    return ok({ worker: { id: w.id, name: w.name, team: w.team }, orders });
  });
  R('POST', '/public/reports', (_p, b) => { try { return ok(doReport({ ...b, order_id: num(b.order_id), worker_id: num(b.worker_id) }, find('users', num(b.worker_id)) || actor())); } catch (e) { return fail(e.message, 400); } });

  /* ---- APP 登录态接口（与后端 /api/app/* 同口径）---- */
  const myOrdersOf = (u) => T('orders').filter((o) => ['released', 'running', 'paused'].includes(o.status)
    && (T('order_steps').some((s) => s.order_id === o.id && s.assignee_team === u.team)
      || T('order_steps').some((s) => s.order_id === o.id && !s.assignee_team)))
    .map(orderRow).map((o) => ({ id: o.id, code: o.code, status: o.status, qty_plan: o.qty_plan, qty_done: o.qty_done, qty_bad: o.qty_bad, product_name: o.product_name, spec: o.spec }));
  R('GET', '/app/my_orders', () => {
    if (!Store.currentUser) return fail('未登录', 401);
    const u = Store.currentUser;
    return ok({ worker: { id: u.id, name: u.name, team: u.team, role: u.role }, orders: myOrdersOf(u) });
  });
  R('GET', '/app/order/(\\d+)', (m) => {
    if (!Store.currentUser) return fail('未登录', 401);
    const u = Store.currentUser;
    const o = find('orders', m[0]); if (!o) return fail('工单不存在', 404);
    const p = find('products', o.product_id) || {};
    const stepsAll = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b) => a.seq - b.seq);
    const lastStep = stepsAll[stepsAll.length - 1];
    const canManage = ['admin', 'technician'].includes(u.role);
    const order = { id: o.id, code: o.code, status: o.status, qty_plan: o.qty_plan,
      qty_done: lastStep ? num(lastStep.qty_good) : 0,
      qty_bad: stepsAll.reduce((a, s) => a + num(s.qty_bad), 0), product_name: p.name, spec: p.spec,
      wage_type: o.wage_type || 'piece', hourly_rate: num(o.hourly_rate) };
    const steps = stepsAll.map((s) => {
      const pr = find('processes', s.process_id) || {};
      let allow = s.allow_report === 0 ? 0 : 1;
      if (s.assignee_team && s.assignee_team !== u.team && !canManage) allow = 0;
      return { id: s.id, seq: s.seq, seq_no: stepOrd(s), qty_plan: s.qty_plan, qty_good: s.qty_good, qty_bad: s.qty_bad,
        status: s.status, assignee_team: s.assignee_team || '', allow_report: allow,
        inspect_type: s.inspect_type || '', inspect_status: s.inspect_status || '',
        process_name: pr.name, process_code: pr.code };
    });
    const allR = T('bad_reasons') || [];
    const sel = (T('order_bad_reasons') || []).filter((x) => Number(x.order_id) === o.id).map((x) => Number(x.bad_reason_id));
    const badReasons = (sel.length ? allR.filter((r) => sel.indexOf(r.id) >= 0) : allR).map((r) => ({ id: r.id, name: r.name }));
    return ok({ order, steps, workers: [{ id: u.id, name: u.name, team: u.team }], badReasons });
  });
  R('POST', '/app/reports', (_p, b) => {
    if (!Store.currentUser) return fail('未登录', 401);
    try { return ok(doReport({ ...b, worker_id: Store.currentUser.id }, Store.currentUser)); } catch (e) { return fail(e.message, 400); }
  });
  R('POST', '/app/inspections', (_p, b) => {
    if (canInspect()) return fail('无权限', 403);
    try { return ok(doInspection(b, actor())); } catch (e) { return fail(e.message, 400); }
  });
  R('GET', '/inspections/queue', () => {
    if (canInspect()) return fail('无权限', 403);
    const u = actor();
    const steps = T('order_steps').filter((s) => String(s.inspect_status || '') === 'waiting')
      .map((s) => {
        const o = find('orders', s.order_id); if (!o || o.status === 'closed') return null;
        const p = find('processes', s.process_id) || {};
        const od = find('products', o.product_id) || {};
        const lw = s.assignee_id ? find('users', s.assignee_id) : null;
        return { order_step_id: s.id, order_id: s.order_id, seq: s.seq, seq_no: stepOrd(s), inspect_type: s.inspect_type,
          qty_plan: s.qty_plan, qty_good: s.qty_good, qty_bad: s.qty_bad, assignee_team: s.assignee_team,
          process_name: p.name, order_code: o.code, product_name: od.name, last_worker: lw ? lw.name : '' };
      }).filter(Boolean).sort((a, b) => b.order_step_id - a.order_step_id);
    return ok({ worker: { id: u.id, name: u.name, team: u.team, role: u.role }, steps, badReasons: T('bad_reasons') || [] });
  });

  // 免登录：质检员待检队列（扫码即判）
  R('GET', '/public/inspector/(\\d+)', (m, _b, q) => {
    const w = find('users', m[0]);
    if (!w) return fail('用户不存在', 404);
    const steps = T('order_steps').filter((s) => String(s.inspect_status || '') === 'waiting')
      .map((s) => {
        const o = find('orders', s.order_id); if (!o || o.status === 'closed') return null;
        const p = find('processes', s.process_id) || {};
        const od = find('products', o.product_id) || {};
        const lastWorker = s.assignee_id ? find('users', s.assignee_id) : null;
        return {
          order_step_id: s.id, order_id: s.order_id, seq: s.seq, inspect_type: s.inspect_type,
          qty_plan: s.qty_plan, qty_good: s.qty_good, qty_bad: s.qty_bad, assignee_team: s.assignee_team,
          process_name: p.name, process_code: p.code, order_code: o.code, order_status: o.status,
          product_name: od.name, last_worker: lastWorker ? lastWorker.name : '',
        };
      }).filter(Boolean).sort((a, b) => b.order_step_id - a.order_step_id);
    return ok({ worker: { id: w.id, name: w.name, team: w.team, role: w.role }, steps, badReasons: T('bad_reasons').map((r) => ({ id: r.id, name: r.name })) });
  });

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
  crud('equipments', '设备', { roles: ['admin', 'technician'], unique: 'code' });

  /* 销售订单（P2）：接单 → 转工单 → 出货核销 */
  const salesSync = (saleRef) => {
    const code = String(saleRef || '').trim();
    if (!code) return;
    const so = T('sales_orders').find((r) => r.code === code);
    if (!so) return;
    const shipped = T('stock_shipments').filter((r) => r.sale_ref === code).reduce((a, r) => a + num(r.qty), 0);
    let status = so.status;
    if (status !== 'cancelled') status = shipped <= 0 ? 'open' : (shipped + 1e-9 >= num(so.qty) ? 'done' : 'partial');
    update('sales_orders', so.id, { shipped_qty: shipped, status });
  };
  R('GET', '/sales_orders', (_p, _b, q) => {
    let list = T('sales_orders').map((s) => Object.assign({}, s, { has_order: s.produced_order_id && T('orders').some((o) => o.id === s.produced_order_id) ? 1 : 0 }));
    if (q && q.status) list = list.filter((r) => r.status === q.status);
    if (q && q.keyword) { const k = q.keyword; list = list.filter((r) => (r.code || '').includes(k) || (r.customer_name || '').includes(k) || (r.product_name || '').includes(k)); }
    const W = { open: 0, partial: 1, done: 2, cancelled: 3 };
    list.sort((a, b) => (W[a.status] - W[b.status]) || String(a.delivery_date || '').localeCompare(String(b.delivery_date || '')) || b.id - a.id);
    return ok(list);
  });
  R('POST', '/sales_orders', (_p, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const qty = num(b.qty);
    if (!(qty > 0)) return fail('请填写有效的销售数量');
    const p = find('products', num(b.product_id));
    if (!p) return fail('请选择产品');
    const c = b.customer_id ? find('customers', num(b.customer_id)) : null;
    const code = (b.code && b.code.trim()) ? b.code.trim() : 'SO' + dayOffset(0).replace(/-/g, '').slice(2) + String(Math.floor(Math.random() * 900) + 100);
    if (T('sales_orders').some((r) => r.code === code)) return fail('销售单号已存在');
    const id = insert('sales_orders', { id: 0, code, customer_id: c ? c.id : null, customer_name: c ? c.name : null,
      product_id: p.id, product_name: p.name, spec: p.spec || null, unit: p.unit || '件', qty,
      price: num(b.price, num(p.price, 0)), order_date: b.order_date || today(), delivery_date: b.delivery_date || null,
      status: 'open', shipped_qty: 0, produced_order_id: null, remark: b.remark || null, created_by: actor().id, created_at: nowISO() });
    writeLog(actor(), '创建销售订单', code + ' ' + p.name + ' ×' + qty);
    return ok({ id, code });
  });
  R('PUT', '/sales_orders/(\\d+)', (m, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const row = find('sales_orders', m[0]);
    if (!row) return fail('销售订单不存在', 404);
    if (row.status === 'cancelled') return fail('已取消的订单不能编辑');
    const qty = b.qty !== undefined ? num(b.qty) : num(row.qty);
    if (!(qty > 0)) return fail('请填写有效的销售数量');
    const c = b.customer_id !== undefined ? (b.customer_id ? find('customers', num(b.customer_id)) : null) : null;
    update('sales_orders', row.id, {
      customer_id: b.customer_id !== undefined ? (c ? c.id : null) : row.customer_id,
      customer_name: b.customer_id !== undefined ? (c ? c.name : null) : row.customer_name,
      qty, price: b.price !== undefined ? num(b.price, 0) : row.price,
      order_date: b.order_date || row.order_date,
      delivery_date: b.delivery_date !== undefined ? (b.delivery_date || null) : row.delivery_date,
      remark: b.remark !== undefined ? (b.remark || null) : row.remark });
    salesSync(row.code);
    writeLog(actor(), '修改销售订单', row.code);
    return ok(true);
  });
  R('DELETE', '/sales_orders/(\\d+)', (m) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const row = find('sales_orders', m[0]);
    if (!row) return fail('销售订单不存在', 404);
    if (num(row.shipped_qty) > 0) return fail('该订单已有出货记录，不能删除（可改为「已取消」）');
    remove('sales_orders', row.id);
    writeLog(actor(), '删除销售订单', row.code);
    return ok(true);
  });
  R('POST', '/sales_orders/(\\d+)/convert', (m, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const s = find('sales_orders', m[0]);
    if (!s) return fail('销售订单不存在', 404);
    if (s.status === 'cancelled') return fail('已取消的订单不能转工单');
    if (s.produced_order_id) { const ex = find('orders', s.produced_order_id); if (ex) return ok({ order_id: ex.id, code: ex.code, existed: true }); }
    const route = T('routes').filter((r) => r.product_id === s.product_id).sort((a, b2) => a.id - b2.id)[0];
    if (!route) return fail('该产品还没有工艺路线，请先在基础数据中建立');
    const qty = Math.max(1, Math.floor(num(b.qty, num(s.qty, 1))));
    const code = 'WO' + dayOffset(0).replace(/-/g, '').slice(2) + String(Math.floor(Math.random() * 9000) + 1000);
    const oid = insert('orders', { id: 0, code, product_id: s.product_id, route_id: route.id, customer_id: s.customer_id,
      qty_plan: qty, priority: num(b.priority, 2), plan_start: b.plan_start || today(), plan_end: b.plan_end || s.delivery_date || today(),
      status: 'created', remark: '销售订单 ' + s.code + (s.customer_name ? '（' + s.customer_name + '）' : ''),
      created_by: actor().id, created_at: nowISO(), start_time: null, finish_time: null, close_reason: '' });
    T('route_steps').filter((st) => st.route_id === route.id).sort((a, b2) => a.seq - b2.seq)
      .forEach((st) => insert('order_steps', { id: 0, order_id: oid, seq: st.seq, process_id: st.process_id, work_center_id: st.work_center_id, assignee_id: null, qty_plan: qty, qty_good: 0, qty_bad: 0, work_min: 0, status: 'pending', start_time: null, finish_time: null, inspect_type: st.inspect_type || (find('processes', st.process_id) || {}).inspect_type || '', inspect_status: null }));
    update('sales_orders', s.id, { produced_order_id: oid });
    writeLog(actor(), '销售订单转工单', s.code + ' → ' + code);
    return ok({ order_id: oid, code });
  });
  R('PATCH', '/sales_orders/(\\d+)/status', (m, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const row = find('sales_orders', m[0]);
    if (!row) return fail('销售订单不存在', 404);
    if (!['open', 'partial', 'done', 'cancelled'].includes(b.status)) return fail('无效的状态');
    if (b.status === 'cancelled' && num(row.shipped_qty) > 0) return fail('该订单已有出货记录，不能取消');
    update('sales_orders', row.id, { status: b.status });
    writeLog(actor(), '销售订单状态', row.code + ' → ' + b.status);
    return ok(true);
  });
  // 出货核销：出库单新增/修改/删除后回写销售订单 shipped_qty 与状态（与 server 同口径）

  /* 齐套分析（P2）：静态镜像统一返回「未维护BOM」提示 */
  R('GET', '/orders/(\\d+)/kit', (m) => {
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    return ok({ order_id: o.id, code: o.code, product_id: o.product_id, qty_plan: o.qty_plan, has_bom: false, kit_pct: null, shortage: 0, lines: [] });
  });
  R('GET', '/stats/kit', () => {
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = new Date(today + 'T00:00:00Z').getTime();
    const dayMs = 86400000;
    const d7ago = new Date(todayMs - 7 * dayMs).toISOString().slice(0, 10);
    const list = T('orders').filter((o) => !['done', 'closed'].includes(o.status)).sort((a, b) => (a.priority - b.priority) || String(a.plan_end || '').localeCompare(String(b.plan_end || '')));
    const view = (o) => {
      const p = find('products', o.product_id) || {}; const c = o.customer_id ? find('customers', o.customer_id) : null;
      /* 进度/瓶颈/预测：与 server 同口径（MIN 各工序 qty_good） */
      const steps = T('order_steps').filter((s) => s.order_id === o.id).sort((a, b) => a.seq - b.seq)
        .map((s) => ({ ...s, pname: (find('processes', s.process_id) || {}).name || '' }));
      const goods = steps.map((s) => num(s.qty_good));
      const qtyDone = goods.length ? Math.min(...goods) : 0;
      const progressPct = num(o.qty_plan) > 0 ? Math.min(100, Math.round(qtyDone / num(o.qty_plan) * 100)) : 0;
      let bottleneck = null;
      const unfinished = steps.filter((s) => s.status !== 'done');
      if (unfinished.length) {
        const ranked = unfinished.map((s) => ({ s, pct: num(s.qty_plan) > 0 ? num(s.qty_good) / num(s.qty_plan) : 1 }))
          .sort((a, b) => (a.pct - b.pct) || (b.s.seq - a.s.seq));
        bottleneck = { step_id: ranked[0].s.id, seq: ranked[0].s.seq, name: ranked[0].s.pname, pct: Math.floor(ranked[0].pct * 100) };
      }
      let dailyRate = 0;
      if (bottleneck) {
        const r7 = T('reports').filter((x) => x.order_id === o.id && x.order_step_id === bottleneck.step_id && x.report_date >= d7ago);
        dailyRate = Math.round((r7.reduce((a, x) => a + num(x.qty_good), 0) / 7) * 100) / 100;
      } else if (steps.length) {
        const r7 = T('reports').filter((x) => x.order_id === o.id && x.report_date >= d7ago);
        dailyRate = Math.round((r7.reduce((a, x) => a + num(x.qty_good), 0) / 7) * 100) / 100;
      }
      const remaining = Math.max(0, num(o.qty_plan) - qtyDone);
      let forecastEnd = null; let delayDays = null;
      if (remaining <= 0) forecastEnd = today;
      else if (dailyRate > 0) forecastEnd = new Date(todayMs + Math.ceil(remaining / dailyRate) * dayMs).toISOString().slice(0, 10);
      if (forecastEnd && o.plan_end) delayDays = Math.round((new Date(forecastEnd + 'T00:00:00Z') - new Date(o.plan_end + 'T00:00:00Z')) / dayMs);
      let dueClass = 'none';
      if (o.plan_end) {
        const diff = Math.round((todayMs - new Date(o.plan_end + 'T00:00:00Z').getTime()) / dayMs);
        if (diff > 0) dueClass = diff >= 3 ? 'overdue_3p' : 'overdue_1_3';
        else if (diff >= -2) dueClass = 'due_soon';
      }
      return { id: o.id, code: o.code, product_id: o.product_id, product_name: p.name || '', product_code: p.code || '', qty_plan: o.qty_plan, priority: o.priority, plan_start: o.plan_start, plan_end: o.plan_end, status: o.status, customer_name: c ? c.name : null, has_bom: false, kit_pct: null, shortage: 0, shortages: [],
        qty_done: qtyDone, progress_pct: progressPct, steps_total: steps.length, steps_done: steps.filter((s) => s.status === 'done').length,
        bottleneck, daily_rate: dailyRate, forecast_end: forecastEnd, delay_days: delayDays, due_class: dueClass };
    };
    const rs = list.map(view);
    return ok({ orders: rs, today,
      summary: { total: rs.length, full_kit: 0, shortage: 0, no_bom: rs.length,
        due_today: rs.filter((r) => r.plan_end === today).length,
        due_soon: rs.filter((r) => r.due_class === 'due_soon').length,
        overdue: rs.filter((r) => r.due_class.startsWith('overdue')).length,
        delayed_forecast: rs.filter((r) => r.delay_days !== null && r.delay_days > 0).length,
        running: rs.filter((r) => r.status === 'running').length,
        paused: rs.filter((r) => r.status === 'paused').length,
        plan_qty: rs.reduce((a, r) => a + num(r.qty_plan), 0),
        done_qty: rs.reduce((a, r) => a + r.qty_done, 0) } });
  });
  R('PUT', '/orders/(\\d+)/schedule', (m, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const o = find('orders', m[0]);
    if (!o) return fail('工单不存在', 404);
    if (['done', 'closed'].includes(o.status)) return fail('已完工/已关闭的工单不能再排产');
    const prio = b.priority !== undefined ? num(b.priority, o.priority) : o.priority;
    if (![1, 2, 3].includes(prio)) return fail('优先级无效（1 高 / 2 中 / 3 低）');
    const ps = b.plan_start !== undefined ? (b.plan_start || '') : o.plan_start;
    const pe = b.plan_end !== undefined ? (b.plan_end || '') : o.plan_end;
    if (ps && pe && ps > pe) return fail('计划开工不能晚于计划完工');
    update('orders', o.id, { plan_start: ps, plan_end: pe, priority: prio });
    writeLog(actor(), '工单排产调整', o.code);
    return ok(true);
  });


  /* 设备点检（P1）：异常可生成质量异常单，口径与 server 一致 */
  R('POST', '/equipments/(\\d+)/check', (m, b) => {
    if (requireRole('admin', 'technician', 'worker')) return fail('无权限', 403);
    const eq = find('equipments', m[0]);
    if (!eq) return fail('设备不存在', 404);
    const result = b.result === 'abnormal' ? 'abnormal' : 'ok';
    const act = actor();
    insert('equipment_checks', { id: nextId('equipment_checks'), equipment_id: eq.id, result, note: b.note || null, issue_id: null, checked_by: act.id, checked_name: act.name, created_at: nowISO() });
    update('equipments', eq.id, { last_check_at: nowISO() });
    if (result === 'abnormal' && b.fault) update('equipments', eq.id, { status: 'fault' });
    let issue = null;
    if (result === 'abnormal' && b.report) {
      const lv = act.role === 'inspector' && ['minor', 'major', 'critical'].includes(b.level) ? b.level : 'pending';
      issue = createQualityIssue({ level: lv, source: 'report', process_name: '设备点检 · ' + eq.name, qty_affected: 0, bad_summary: `设备点检异常：${eq.code} ${eq.name}${b.note ? '：' + b.note : ''}`, created_by: act.id });
      const rec = T('equipment_checks').slice(-1)[0];
      if (rec) rec.issue_id = issue.id;
      if (act.role !== 'inspector' && ['major', 'critical'].includes(b.level)) {
        T('users').filter((u2) => u2.role === 'inspector' && u2.active).forEach((ip) => {
          notifyIssue(issue, { id: ip.id, name: ip.name }, 'created', `操作工上报重大异常，请及时定级：${issue.code}`, `设备点检异常：${eq.code} ${eq.name}（申报等级：${ISSUE_LEVEL_LABEL[b.level] || b.level}）`);
        });
      }
    }
    writeLog(act, '设备点检', eq.code + ' ' + (result === 'ok' ? '正常' : '异常'));
    return ok({ issue });
  });
  R('GET', '/equipments/(\\d+)/checks', (m) => {
    const list = T('equipment_checks').filter((c) => Number(c.equipment_id) === Number(m[0])).slice().sort((a, b) => b.id - a.id).slice(0, 100)
      .map((c) => { const q = c.issue_id ? find('quality_issues', c.issue_id) : null; return Object.assign({}, c, { issue_code: q ? q.code : null, issue_level: q ? q.level : null }); });
    return ok(list);
  });
  /* 工序 SOP：静态版仅保存元数据（无文件系统） */
  R('POST', '/processes/(\\d+)/sop', (m, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const p = find('processes', m[0]);
    if (!p) return fail('工序不存在', 404);
    update('processes', p.id, { sop_file: 'static_' + p.id + '_' + (b.name || 'sop'), sop_name: b.name || 'sop' });
    writeLog(actor(), '上传工序SOP', p.code + ' ' + (b.name || ''));
    return ok({ sop_name: b.name || 'sop' });
  });
  R('DELETE', '/processes/(\\d+)/sop', (m) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const p = find('processes', m[0]);
    if (!p) return fail('工序不存在', 404);
    update('processes', p.id, { sop_file: null, sop_name: null });
    writeLog(actor(), '删除工序SOP', p.code);
    return ok(true);
  });
  crud('materials', '物料档案', { roles: ['admin', 'technician'], unique: 'code', onDelete: (id) => { if (T('inventory_tx').some((t) => Number(t.material_id) === id)) return '该物料已有库存流水，不能删除（可停用）'; return ''; } });
  crud('warehouses', '仓库', { roles: ['admin', 'technician'], unique: 'code', onDelete: (id) => { if (T('inventory').some((r) => Number(r.warehouse_id) === id)) return '该仓库已有库存记录，不能删除'; return ''; } });

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
    // 出库未指定批次：自动按批次分扣（先扣无批次行，再按更新时间先进先出），与后端规则一致
    if (qty < 0 && !String(o.batch || '').trim() && !o._autoBatch) {
      const lines = T('inventory').filter((r) => Number(r.material_id) === mid && Number(r.warehouse_id || 0) === Number(wh || 0) && num(r.qty) > 1e-9)
        .sort((a, b) => ((a.batch ? 1 : 0) - (b.batch ? 1 : 0)) || String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || a.id - b.id);
      const total = lines.reduce((s, r) => s + num(r.qty), 0);
      if (total < -qty - 1e-9) throw new Error('库存不足：' + (m0.name || mid) + '，当前库存 ' + (Math.round(total * 1e6) / 1e6) + '，本次出库 ' + Math.abs(qty));
      let need = -qty, first = null;
      for (const r of lines) {
        if (need <= 1e-9) break;
        const take = Math.min(num(r.qty), need);
        need -= take;
        const r2 = applyStock(Object.assign({}, o, { _autoBatch: 1, qty: -take, batch: r.batch || '' }));
        if (!first) first = r2;
      }
      return first;
    }
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
  // 报工自动成品入库（末道工序）：成品物料按产品编码映射，缺成品仓建 FG
  function ensureFgWarehouseStatic() {
    let w = T('warehouses').find((x) => x.code === 'FG');
    if (w) return w.id;
    w = T('warehouses').find((x) => (x.name || '').indexOf('成品') >= 0);
    if (w) return w.id;
    return insert('warehouses', { code: 'FG', name: '成品仓', remark: '报工自动入库默认仓库', created_at: nowISO() });
  }
  function ensureFgMaterialStatic(product) {
    if (!product || !product.code) return null;
    let m = T('materials').find((x) => x.code === product.code);
    if (m) return m.id;
    const wid = ensureFgWarehouseStatic();
    return insert('materials', { code: product.code, name: product.name, spec: product.spec || null, material: null, category: '成品', unit: product.unit || '件', warehouse_id: wid, location: null, safe_min: 0, safe_max: null, active: 1, remark: '报工自动入库生成', created_at: nowISO() });
  }
  function autoFinishInStatic(order, product, good, act, reportId, remarkTag) {
    const mid = ensureFgMaterialStatic(product);
    if (!mid) return null;
    const wh = ensureFgWarehouseStatic();
    const code = 'RK' + String(new Date().getFullYear()).slice(2) + pad(new Date().getMonth() + 1) + pad(new Date().getDate()) + String(Math.floor(Math.random() * 900) + 100);
    const id = insert('finished_goods_in', {
      code, in_date: today(), order_id: order.id, report_id: reportId || null, material_id: mid, warehouse_id: wh,
      product_code: product.code || null, product_name: product.name, spec: product.spec || null,
      qty: good, unit: product.unit || '件', batch: null, location: null, inspector: null, result: 'qualified',
      remark: '报工自动入库（末道工序）' + (remarkTag || ''), created_by: act.id, created_at: nowISO(),
    });
    applyStock({ material_id: mid, warehouse_id: wh, batch: null, location: null, qty: good, tx_type: 'in_finish', ref_type: 'finished_goods_in', ref_id: id, ref_code: code, order_id: order.id, operator: act.name, tx_date: today(), remark: '成品入库 ' + code });
    return { id, code, qty: good };
  }
  // 完工入库补齐（静态模式镜像 server.js /api/warehouse/sync_finished）：按工单重算并重建 source='sync' 的补齐单
  function syncFinishedStatic() {
    const act = actor();
    const result = { order_count: 0, created: 0, qty: 0, removed: 0 };
    for (const o of T('orders')) {
      const steps = T('order_steps').filter((s) => Number(s.order_id) === Number(o.id)).sort((a, b) => b.seq - a.seq);
      const done = steps.length ? Number(steps[0].qty_good || 0) : 0;
      const product = find('products', o.product_id);
      if (!product || !product.code) continue;
      // 该工单自动入库量（末道报工自动单：report_id 非空）
      const autoIn = T('finished_goods_in').filter((f) => Number(f.order_id) === Number(o.id) && f.report_id).reduce((s, f) => s + Number(f.qty || 0), 0);
      // 先移除旧的补齐单（source='sync'），保证幂等并支持反向调整
      for (const f of T('finished_goods_in').filter((x) => Number(x.order_id) === Number(o.id) && x.source === 'sync')) {
        revertStock('finished_goods_in', f.id, act.name);
        DB.finished_goods_in = T('finished_goods_in').filter((x) => Number(x.id) !== Number(f.id));
        result.removed++;
      }
      const need = done - autoIn;
      if (need > 0) {
        const mid = ensureFgMaterialStatic(product);
        const wh = ensureFgWarehouseStatic();
        const code = 'RK' + String(new Date().getFullYear()).slice(2) + pad(new Date().getMonth() + 1) + pad(new Date().getDate()) + String(Math.floor(Math.random() * 900) + 100);
        const id = insert('finished_goods_in', {
          code, in_date: today(), order_id: o.id, report_id: null, material_id: mid, warehouse_id: wh,
          product_code: product.code || null, product_name: product.name, spec: product.spec || null,
          qty: need, unit: product.unit || '件', batch: null, location: null, inspector: null, result: 'qualified',
          remark: '完工入库补齐（历史报工未自动入库）', source: 'sync', created_by: act.id, created_at: nowISO(),
        });
        applyStock({ material_id: mid, warehouse_id: wh, batch: null, location: null, qty: need, tx_type: 'in_finish', ref_type: 'finished_goods_in', ref_id: id, ref_code: code, order_id: o.id, operator: act.name, tx_date: today(), remark: '完工入库补齐 ' + code });
        result.created++;
        result.qty += need;
      }
      result.order_count++;
    }
    writeLog(act, '同步完工入库', `补齐 ${result.created} 张 / ${result.qty} 件（重算 ${result.removed} 张补齐单）`);
    return result;
  }
  // 仅传 material_id 时，从物料档案回带编码/名称/规格/单位/默认仓库
  function fillFromMaterial(b, mid) {
    if (!mid) return b;
    const m = T('materials').find((x) => Number(x.id) === Number(mid));
    if (!m) return b;
    if (!String(b.material_code || '').trim()) b.material_code = m.code;
    if (!String(b.material_name || '').trim()) b.material_name = m.name;
    if (!String(b.product_code || '').trim()) b.product_code = m.code;
    if (!String(b.product_name || '').trim()) b.product_name = m.name;
    if (!String(b.material_spec || '').trim()) b.material_spec = m.spec || null;
    if (!String(b.spec || '').trim()) b.spec = m.spec || null;
    if (!String(b.unit || '').trim()) b.unit = m.unit || '件';
    if (!b.warehouse_id && m.warehouse_id) b.warehouse_id = m.warehouse_id;
    return b;
  }
  function docWrite(table, name, txType, prefix) {
    const check = () => (requireRole('admin', 'technician') ? fail('无权限', 403) : null);
    R('POST', '/' + table, (_p, b) => {
      const f = check(); if (f) return f;
      const code = b.code || prefix + String(new Date().getFullYear()).slice(2) + pad(new Date().getMonth() + 1) + pad(new Date().getDate()) + String(Math.floor(Math.random() * 900) + 100);
      let mid = b.material_id ? num(b.material_id) : null;
      if (!mid) { const c = String(b.material_code || b.product_code || '').trim(); const m = c ? T('materials').find((x) => x.code === c) : null; if (m) mid = m.id; }
      fillFromMaterial(b, mid);
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
      fillFromMaterial(b, mid);
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
  crud('incoming_materials', '来料记录', { roles: ['admin', 'technician'], noWrite: true, noDelete: true });
  crud('finished_goods_in', '成品入库', { roles: ['admin', 'technician'], noWrite: true, noDelete: true });
  docWrite('incoming_materials', '来料入库', 'in_incoming', 'LM');
  docWrite('finished_goods_in', '成品入库', 'in_finish', 'RK');
  // 完工入库补齐：把工单末道完工量与该工单自动入库量的差额补生成成品入库单（幂等，可反复执行）
  R('POST', '/warehouse/sync_finished', () => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    try { return ok(syncFinishedStatic()); } catch (e) { return fail(e.message, 400); }
  });
  crud('users', '用户', { admin: true, unique: 'username', onDelete: (id) => { if (Store.currentUser && id === Store.currentUser.id) return '不能删除当前登录的账号'; const rep = T('reports').filter((r) => r.worker_id === id).length; const asg = T('order_steps').filter((s) => s.assignee_id === id).length; if (rep || asg) return `该员工已有 ${rep} 条报工、${asg} 条派工记录，无法删除；如需停用，请在“编辑”中将其状态设为“停用”。`; return ''; } });
  // 工艺路线：写操作走下方专用处理器（会展开 steps → route_steps），故这里 noWrite
  crud('routes', '工艺路线', { roles: ['admin', 'technician'], unique: 'code', noWrite: true, onDelete: (id) => { if (T('orders').some((o) => o.route_id === id)) return '该工艺路线已被工单使用，无法删除'; return ''; } });
  // 工艺路线工序明细（编辑回显）
  R('GET', '/routes/(\\d+)/steps', (m) => ok(T('route_steps').filter((s) => s.route_id === Number(m[0])).sort((a, b) => a.seq - b.seq).map((s) => { const pr = find('processes', s.process_id) || {}; const w = s.work_center_id ? find('work_centers', s.work_center_id) : null; return Object.assign({}, s, { process_name: pr.name, process_code: pr.code, wc_name: w ? w.name : '' }); })));
  R('POST', '/routes', (_p, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    if (T('routes').some((r) => r.code === b.code)) return fail('工艺路线编码已存在');
    const rid = insert('routes', { code: b.code, name: b.name, product_id: num(b.product_id), created_at: nowISO() });
    (b.steps || []).forEach((s) => { const p = find('processes', s.process_id) || { std_time: 0, std_price: 0 }; insert('route_steps', { route_id: rid, seq: num(s.seq), process_id: num(s.process_id), work_center_id: s.work_center_id ? num(s.work_center_id) : null, std_time: num(s.std_time, p.std_time), std_price: num(s.std_price, p.std_price), need_report: 1, inspect_type: s.inspect_type !== undefined ? String(s.inspect_type || '') : (p.inspect_type || '') }); });
    writeLog(actor(), '新增工艺路线', b.code + ' ' + b.name);
    return ok({ id: rid });
  });
  R('PUT', '/routes/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    update('routes', m[0], { code: b.code, name: b.name, product_id: num(b.product_id) });
    DB.route_steps = T('route_steps').filter((s) => s.route_id !== Number(m[0]));
    (b.steps || []).forEach((s) => { const p = find('processes', s.process_id) || { std_time: 0, std_price: 0 }; insert('route_steps', { route_id: Number(m[0]), seq: num(s.seq), process_id: num(s.process_id), work_center_id: s.work_center_id ? num(s.work_center_id) : null, std_time: num(s.std_time, p.std_time), std_price: num(s.std_price, p.std_price), need_report: 1, inspect_type: s.inspect_type !== undefined ? String(s.inspect_type || '') : (p.inspect_type || '') }); });
    writeLog(actor(), '修改工艺路线', '#' + m[0] + ' ' + b.code);
    return ok(true);
  });

  /* ==================== 检验与质量异常（一期 · 静态模式镜像 server.js） ==================== */
  const INSPECT_LABEL = { iqc: '首检', ipqc: '过程检', fqc: '终检' };
  const ISSUE_LEVEL_LABEL = { pending: '待定级', minor: '轻微', major: '严重', critical: '致命' };
  const DISPOSITION_LABEL = { rework: '返工', repair: '返修', concession: '让步接收', scrap: '报废' };
  const canInspect = () => requireRole('admin', 'technician', 'inspector');

  const genCode = (prefix) => {
    const d = new Date();
    const day = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
    const n = T('inspections').filter((x) => String(x.code || '').indexOf(prefix + day) === 0).length
      + T('quality_issues').filter((x) => String(x.code || '').indexOf(prefix + day) === 0).length + 1;
    return prefix + day + String(100 + n).slice(1);
  };
  const getSetting = (key, def) => {
    const r = T('settings').find((x) => x.key === key);
    return r && r.value !== undefined && r.value !== null ? r.value : def;
  };
  const setSetting = (key, val) => {
    const r = T('settings').find((x) => x.key === key);
    if (r) r.value = String(val); else insert('settings', { key, value: String(val) });
  };
  // 定责：工序指派班组 → 该班组 technician → 工单创建人（非 worker） → 管理员
  function resolveIssueAssignee(step, order) {
    const team = step && step.assignee_team;
    if (team) {
      const l = T('users').find((u) => u.role === 'technician' && u.team === team && u.active);
      if (l) return { id: l.id, name: l.name };
    }
    if (order && order.created_by) {
      const c = find('users', order.created_by);
      if (c && c.active && c.role !== 'worker') return { id: c.id, name: c.name };
    }
    const a = T('users').find((u) => u.role === 'admin' && u.active);
    return a ? { id: a.id, name: a.name } : { id: null, name: '未指派' };
  }
  /* ---- 通用消息中心（APP 通知）：场景 quality 质量异常 | stock 库存预警 | assign 派工待办 | system 系统消息 ---- */
  const MSG_SOURCE_LABEL = { quality: '质量异常', stock: '库存预警', assign: '派工待办', system: '系统消息' };
  const MSG_KIND_LABEL = { created: '新消息', remind: '催办', escalate: '升级', graded: '定级', handled: '已处理', closed: '已闭环', cancelled: '已作废' };
  function pushMessage(opt) {
    const ts = nowISO();
    const src = opt.source || 'system';
    const users = (Array.isArray(opt.toUsers) ? opt.toUsers : [opt.toUsers]).filter((u) => u && u.id);
    const seen = {};
    let n = 0;
    users.forEach((u) => {
      if (seen[u.id]) return;
      seen[u.id] = 1; n++;
      insert('issue_notifications', {
        id: nextId('issue_notifications'), issue_id: opt.issue_id || null, to_user_id: u.id, to_name: u.name || '',
        channel: 'inbox', kind: opt.kind || 'created', title: opt.title || '', body: opt.body || '',
        source: src, ref_type: opt.ref_type || null, ref_id: opt.ref_id || null, link: opt.link || null,
        read_at: null, sent_at: ts, ok: 1,
      });
    });
    return n;
  }
  function notifyAssign(order, orderId, onlySteps) {
    const steps = onlySteps && onlySteps.length
      ? onlySteps.filter((s) => s.assignee_team)
      : T('order_steps').filter((s) => s.order_id === Number(orderId) && s.assignee_team);
    if (!steps.length) return 0;
    const byTeam = {};
    steps.forEach((s) => { (byTeam[s.assignee_team] = byTeam[s.assignee_team] || []).push(s); });
    let sent = 0;
    Object.keys(byTeam).forEach((team) => {
      const members = T('users').filter((u) => u.team === team && u.active && u.role !== 'admin');
      if (!members.length) return;
      const names = byTeam[team].map((s) => s.process_name || ('工序' + stepOrd(s)));
      const plan = byTeam[team][0].qty_plan;
      sent += pushMessage({
        source: 'assign', toUsers: members, kind: 'created',
        title: `新任务：${order.code} 待报工`,
        body: `产品 ${order.product_name || '-'}　计划 ${plan} 件\n工序：${names.join('、')}\n请到「报工」扫码或选择工单开始生产。`,
        ref_type: 'order', ref_id: Number(orderId), link: '#/orders',
      });
    });
    return sent;
  }
  function scanStockAlerts() {
    const todayStr = today();
    const targets = T('users').filter((u) => u.active && (u.role === 'admin' || u.role === 'technician' || String(u.team || '').indexOf('仓') >= 0));
    let fired = 0;
    T('materials').filter((m) => m.active !== 0 && Number(m.safe_min) > 0).forEach((m) => {
      const qty = T('inventory').filter((i) => i.material_id === m.id).reduce((s, i) => s + Number(i.qty || 0), 0);
      if (!(qty < Number(m.safe_min))) return;
      const dup = T('stock_alerts').some((a) => a.material_id === m.id && a.alert_date === todayStr);
      if (dup) return;
      insert('stock_alerts', { id: nextId('stock_alerts'), material_id: m.id, alert_date: todayStr, level: 'short', qty, safe_min: m.safe_min, created_at: nowISO() });
      fired += pushMessage({
        source: 'stock', toUsers: targets, kind: 'created',
        title: `库存预警：${m.name} 低于安全库存`,
        body: `物料 ${m.code} ${m.name}\n当前库存 ${qty} ${m.unit}　安全下限 ${m.safe_min} ${m.unit}\n缺口 ${Math.max(0, Number(m.safe_min) - qty)} ${m.unit}，请及时补货。`,
        ref_type: 'material', ref_id: m.id, link: '#/warehouse',
      });
    });
    return fired;
  }
  function notifyIssue(issue, toUser, kind, title, body) {
    const ts = nowISO();
    insert('issue_notifications', {
      id: nextId('issue_notifications'), issue_id: issue.id, to_user_id: toUser && toUser.id ? toUser.id : null,
      to_name: toUser ? toUser.name : '', channel: 'inbox', kind, title, body,
      source: 'quality', ref_type: 'issue', ref_id: issue.id, link: '#/quality/issue/' + issue.id,
      read_at: null, sent_at: ts, ok: 1,
    });
    if (kind === 'escalate') {
      T('users').filter((u) => u.role === 'admin' && u.active).forEach((a) => {
        if (toUser && a.id === toUser.id) return;
        insert('issue_notifications', {
          id: nextId('issue_notifications'), issue_id: issue.id, to_user_id: a.id, to_name: a.name,
          channel: 'inbox', kind, title, body,
          source: 'quality', ref_type: 'issue', ref_id: issue.id, link: '#/quality/issue/' + issue.id,
          read_at: null, sent_at: ts, ok: 1,
        });
      });
    }
  }
  function createQualityIssue(opt) {
    const ts = nowISO();
    const code = genCode('QA');
    const step = opt.order_step_id ? find('order_steps', opt.order_step_id) : null;
    const order = opt.order_id ? find('orders', opt.order_id) : null;
    // 工单负责人优先：若工单指定了负责人，则该工单的检验反馈异常首推负责人处理；否则沿用原定责链路
    const orderOwner = (order && order.owner_user_id) ? find('users', num(order.owner_user_id)) : null;
    const assignee = (orderOwner && orderOwner.active) ? { id: orderOwner.id, name: orderOwner.name } : resolveIssueAssignee(step, order);
    const id = insert('quality_issues', {
      id: nextId('quality_issues'), code, level: opt.level || 'major', source: opt.source || 'inspect',
      order_id: opt.order_id || null, order_step_id: opt.order_step_id || null, inspection_id: opt.inspection_id || null,
      product_id: opt.product_id || null, product_name: opt.product_name || null,
      order_code: order ? order.code : null, process_name: opt.process_name || null,
      qty_affected: num(opt.qty_affected), bad_summary: opt.bad_summary || null,
      status: 'open', assignee_user_id: assignee.id, assignee_name: assignee.name,
      claimed_at: null, due_at: ts.slice(0, 19), escalated: 0, photos: '[]',
      cause: null, action: null, disposition: null, verifier: null, closed_at: null,
      created_by: opt.created_by || null, created_at: ts,
    });
    const issue = find('quality_issues', id);
    const title = `${order ? order.code : '工单'} · ${opt.process_name || '工序'} 出现${ISSUE_LEVEL_LABEL[issue.level]}质量异常`;
    const body = `不良${issue.qty_affected}件：${issue.bad_summary || '未填写原因'}（待处理）`;
    // 上报口径（2026-10-06 修订）：致命级（任何来源）→ 通知责任人 + 管理层；
    // 检验员上报/检验判定/来料判定开单（非致命）→ 仅通知责任人；
    // 非检验员上报（source=report）→ 只留存记录，申报重大时由上报接口另行通知检验员
    const creator = opt.created_by ? find('users', num(opt.created_by)) : null;
    const creatorIsInspector = !!(creator && creator.role === 'inspector');
    if (issue.level === 'critical') {
      notifyIssue(issue, assignee, 'created', title, body);
      const admins = T('users').filter((u2) => u2.role === 'admin' && u2.active && (!assignee || u2.id !== assignee.id));
      pushMessage({
        source: 'quality', toUsers: admins, kind: 'escalate', issue_id: issue.id,
        ref_type: 'issue', ref_id: issue.id, link: '#/quality/issue/' + issue.id,
        title: `重大质量异常：${issue.code}`, body: `${title}　${body}`,
      });
    } else if (creatorIsInspector || (opt.source || 'inspect') !== 'report') {
      notifyIssue(issue, assignee, 'created', title, body);
    }
    return issue;
  }
  function doInspection(b, act) {
    const step = find('order_steps', Number(b.order_step_id));
    if (!step) throw new Error('工序不存在');
    const order = find('orders', step.order_id);
    if (!order) throw new Error('工单不存在');
    if (String(step.inspect_status || '') !== 'waiting') throw new Error('该工序当前不在待检状态，无需检验');

    // 检验方式：sample 抽检（受检数=样本数）
    const mode = String(b.inspect_mode || '') === 'sample' ? 'sample' : 'full';
    let qtyPass = Math.max(0, Math.floor(num(b.qty_pass)));
    const qtyFail = Math.max(0, Math.floor(num(b.qty_fail)));
    let sampleQty = null;
    if (mode === 'sample') {
      sampleQty = num(b.sample_qty) > 0 ? Math.floor(num(b.sample_qty)) : qtyPass + qtyFail;
      if (qtyFail > sampleQty) throw new Error('不合格数不能大于样本数');
      qtyPass = sampleQty - qtyFail;
    }
    let conclusion = String(b.conclusion || '').trim();
    if (!['pass', 'fail', 'concession'].includes(conclusion)) conclusion = qtyFail > 0 ? 'fail' : 'pass';
    if (conclusion === 'pass' && qtyFail > 0) throw new Error('判定合格时不合格数必须为 0');
    if (conclusion !== 'pass' && qtyFail <= 0) throw new Error('判定不合格/让步接收时须填写不合格数');
    // 检查表 NG 项并入不良明细
    const clResults = (Array.isArray(b.checklist) ? b.checklist : [])
      .filter((c) => String(c.name || '').trim())
      .map((c) => ({ name: String(c.name || '').trim(), standard: String(c.standard || '').trim(),
        result: ['ok', 'ng', 'skip'].includes(c.result) ? c.result : 'skip', qty: Math.max(0, Math.floor(num(c.qty))), remark: '' }));
    const ngItems = clResults.filter((c) => c.result === 'ng' && c.qty > 0);
    if (conclusion === 'pass' && ngItems.length) throw new Error('存在 NG 检验项，不能判定合格');

    const insCode = genCode('QC');
    const inspId = insert('inspections', {
      id: nextId('inspections'), code: insCode, order_id: order.id, order_step_id: step.id,
      report_id: num(b.report_id) || null, process_name: step.process_name || (find('processes', step.process_id) || {}).name || null,
      inspector_id: act.id, inspector: act.name,
      qty_check: mode === 'sample' ? sampleQty : qtyPass + qtyFail, qty_pass: qtyPass, qty_fail: qtyFail,
      conclusion, remark: b.remark || '', inspect_mode: mode, sample_qty: sampleQty,
      checklist_result: clResults.length ? JSON.stringify(clResults) : null, created_at: nowISO(),
    });
    const defects = Array.isArray(b.defects) ? b.defects : [];
    const summary = [];
    for (const d of defects) {
      const q = Math.max(0, Math.floor(num(d.qty)));
      if (q <= 0) continue;
      let brId = num(d.bad_reason_id) || 0;
      let name = '';
      const detail = String(d.bad_reason_detail || '').trim();
      if (brId) {
        const br = find('bad_reasons', brId);
        if (!br) throw new Error('不良原因不存在（#' + brId + '）');
        if (br.name === '其他' && detail) { name = detail; brId = 0; } else { name = br.name; }
      } else { name = String(d.bad_reason || detail || '其他'); }
      insert('inspection_defects', { id: nextId('inspection_defects'), inspection_id: inspId, bad_reason_id: brId || null, bad_reason: name, bad_reason_detail: detail, qty: q });
      summary.push(name + '×' + q);
    }
    if (conclusion !== 'pass' && !summary.length) summary.push((b.bad_summary || '未分类不良') + '×' + qtyFail);
    for (const c of ngItems) {
      insert('inspection_defects', { id: nextId('inspection_defects'), inspection_id: inspId, bad_reason_id: null, bad_reason: c.name, bad_reason_detail: c.remark || '', qty: c.qty });
      summary.push(c.name + '×' + c.qty);
    }

    const ratio = (qtyPass + qtyFail) > 0 ? qtyFail / (qtyPass + qtyFail) : 0;
    const isFinal = String(step.inspect_type) === 'fqc';
    const criticalRatio = Math.min(100, Math.max(1, num(getSetting('critical_ratio', 20), 20))) / 100;
    const minorRatio = Math.min(50, Math.max(0, num(getSetting('minor_ratio', 5), 5))) / 100;
    let level = 'major';
    if (conclusion === 'fail' && (isFinal || ratio >= criticalRatio)) level = 'critical';
    else if (ratio > 0 && ratio <= minorRatio) level = 'minor';

    const result = { inspection_id: inspId, code: insCode, conclusion, qty_pass: qtyPass, qty_fail: qtyFail, issue: null, autoFinishIn: null };
    const product = find('products', order.product_id) || {};
    const steps = T('order_steps').filter((s) => s.order_id === order.id).sort((a, b2) => a.seq - b2.seq);
    const lastStepId = steps.length ? steps[steps.length - 1].id : null;
    const finished = (num(step.qty_good) + qtyPass) >= num(step.qty_plan);

    if (conclusion === 'pass' || conclusion === 'concession') {
      update('order_steps', step.id, { inspect_status: 'passed', status: finished ? 'done' : 'running', finish_time: finished ? nowISO() : null });
      if (finished) {
        const nxt = T('order_steps').filter((s) => s.order_id === order.id && s.status === 'pending').sort((a, b2) => a.seq - b2.seq)[0];
        if (nxt) update('order_steps', nxt.id, { status: 'running' });
      }
      if (step.id === lastStepId && qtyPass > 0) {
        result.autoFinishIn = autoFinishInStatic(order, product, qtyPass, act, null, conclusion === 'concession' ? '（特采放行）' : '');
      }
      if (!T('order_steps').some((s) => s.order_id === order.id && s.status !== 'done')) {
        update('orders', order.id, { status: 'done', finish_time: nowISO() });
      }
    } else {
      update('order_steps', step.id, { inspect_status: 'failed' });
      // 上报口径与 server.js 一致：仅重大异常（critical）自动开异常单并暂停工单；一般不合格待返工重检
      if (level === 'critical') {
        result.issue = createQualityIssue({
          level, source: 'inspect', order_id: order.id, order_step_id: step.id, inspection_id: inspId,
          product_id: order.product_id, product_name: product.name,
          process_name: step.process_name || (find('processes', step.process_id) || {}).name || ('工序' + stepOrd(step)),
          qty_affected: qtyFail, bad_summary: summary.join('；'), created_by: act.id,
        });
        if (['running', 'released'].includes(order.status)) update('orders', order.id, { status: 'paused' });
      }
    }
    writeLog(act, '提交检验判定', insCode + ' ' + (INSPECT_LABEL[step.inspect_type] || '') + ' ' + conclusion + ' 合格' + qtyPass + '/不合格' + qtyFail);
    // 通知责任班组：放行 → 可继续流转；不合格 → 已开异常单/工单可能暂停
    try {
      const pass = conclusion === 'pass' || conclusion === 'concession';
      const tos = T('users').filter((u) => u.active && u.role !== 'admin' && (
        (step.assignee_team && u.team === step.assignee_team) || (step.assignee_id && u.id === step.assignee_id)
      ) && u.id !== act.id);
      if (tos.length) {
        const tail = pass
          ? `合格 ${qtyPass} 件${conclusion === 'concession' ? '（让步接收）' : ''}${result.autoFinishIn ? '，已自动成品入库 ' + result.autoFinishIn.qty + ' 件' : ''}。`
          : `不合格 ${qtyFail} 件，已生成质量异常单 ${result.issue ? result.issue.code : ''}${level === 'critical' ? '，工单已暂停待处理' : ''}。`;
        pushMessage({
          source: 'quality', toUsers: tos, kind: pass ? 'closed' : 'created',
          issue_id: result.issue ? result.issue.id : null, ref_type: 'order', ref_id: order.id,
          link: result.issue ? '#/quality/issue/' + result.issue.id : '#/inspect',
          title: `${INSPECT_LABEL[step.inspect_type] || '检验'}${pass ? '合格放行' : '不合格'}：${order.code}`,
          body: `${act.name} 判定：合格 ${qtyPass} / 不合格 ${qtyFail}。${tail}`,
        });
      }
    } catch (e) { /* 通知失败不阻塞检验 */ }
    return result;
  }

  R('GET', '/inspections/pending', () => {
    if (canInspect()) return fail('无权限', 403);
    return ok(T('order_steps').filter((s) => String(s.inspect_status || '') === 'waiting')
      .map((s) => {
        const o = find('orders', s.order_id); if (!o || o.status === 'closed') return null;
        const p = find('processes', s.process_id) || {};
        const od = find('products', o.product_id) || {};
        const w = s.assignee_id ? find('users', s.assignee_id) : null;
        return {
          order_step_id: s.id, order_id: s.order_id, seq: s.seq, inspect_type: s.inspect_type,
          qty_plan: s.qty_plan, qty_good: s.qty_good, qty_bad: s.qty_bad, assignee_team: s.assignee_team,
          process_name: p.name, order_code: o.code, order_status: o.status, product_name: od.name,
          start_time: s.start_time, last_worker: w ? w.name : '',
        };
      }).filter(Boolean).sort((a, b) => b.order_step_id - a.order_step_id));
  });
  R('GET', '/inspections', () => ok(T('inspections').slice().sort((a, b) => b.id - a.id).slice(0, 200)
    .map((i) => Object.assign({}, i, {
      order_code: (find('orders', i.order_id) || {}).code || '',
      defect_summary: T('inspection_defects').filter((d) => Number(d.inspection_id) === Number(i.id))
        .map((d) => (d.bad_reason || '其他') + '×' + d.qty).join('；') || '',
    }))));
  R('GET', '/inspections/(\\d+)', (m) => {
    const i = find('inspections', m[0]);
    if (!i) return fail('检验记录不存在', 404);
    return ok(Object.assign({}, i, {
      order_code: (find('orders', i.order_id) || {}).code || '',
      defects: T('inspection_defects').filter((d) => Number(d.inspection_id) === Number(i.id)),
    }));
  });
  R('POST', '/inspections', (_p, b) => {
    if (canInspect()) return fail('无权限', 403);
    try { return ok(doInspection(b, actor())); } catch (e) { return fail(e.message, 400); }
  });

  R('GET', '/quality_issues', (_p, _b, q) => {
    let rows = T('quality_issues').slice();
    if (q.status) rows = rows.filter((x) => x.status === q.status);
    if (q.mine === '1' && Store.currentUser) rows = rows.filter((x) => Number(x.assignee_user_id) === Number(Store.currentUser.id));
    if (q.open === '1') rows = rows.filter((x) => ['open', 'processing', 'verifying'].includes(x.status));
    const rank = { critical: 0, major: 1, minor: 2 };
    return ok(rows.sort((a, b) => (rank[a.level] === undefined ? 3 : rank[a.level]) - (rank[b.level] === undefined ? 3 : rank[b.level]) || b.id - a.id).slice(0, 200));
  });
  R('GET', '/quality_issues/(\\d+)', (m) => {
    const it = find('quality_issues', m[0]);
    if (!it) return fail('异常单不存在', 404);
    const insp = it.inspection_id ? find('inspections', it.inspection_id) : null;
    if (insp) insp.defects = T('inspection_defects').filter((d) => Number(d.inspection_id) === Number(insp.id));
    const step = it.order_step_id ? find('order_steps', it.order_step_id) : null;
    const pr = step ? find('processes', step.process_id) : null;
    const ord = it.order_id ? find('orders', it.order_id) : null;
    const lastStep = ord ? T('order_steps').filter((s) => s.order_id === ord.id).sort((a, b) => b.seq - a.seq)[0] : null;
    return ok(Object.assign({}, it, {
      inspection: insp,
      timeline: T('issue_notifications').filter((n) => Number(n.issue_id) === Number(it.id)).sort((a, b) => a.id - b.id)
        .map((n) => Object.assign({}, n, { source_label: MSG_SOURCE_LABEL[n.source || 'system'] || '消息', kind_label: MSG_KIND_LABEL[n.kind] || n.kind || '' })),
      step: step ? { id: step.id, seq: step.seq, status: step.status, inspect_status: step.inspect_status,
        qty_plan: step.qty_plan, qty_good: step.qty_good, qty_bad: step.qty_bad, assignee_team: step.assignee_team,
        process_name: (step.process_name || (pr ? pr.name : '')) || '' } : null,
      order: ord ? { id: ord.id, code: ord.code, status: ord.status, qty_plan: ord.qty_plan,
        qty_done: lastStep ? num(lastStep.qty_good) : 0 } : null,
      dispositions: DISPOSITION_LABEL,
    }));
  });
  R('POST', '/quality_issues/(\\d+)/claim', (m) => {
    if (canInspect()) return fail('无权限', 403);
    const it = find('quality_issues', m[0]);
    if (!it) return fail('异常单不存在', 404);
    if (it.status !== 'open') return fail('该异常单已被认领或已关闭');
    const act = actor();
    update('quality_issues', it.id, { status: 'processing', assignee_user_id: act.id, assignee_name: act.name, claimed_at: nowISO() });
    writeLog(act, '认领质量异常', it.code);
    return ok(true);
  });
  R('POST', '/quality_issues/(\\d+)/handle', (m, b) => {
    if (canInspect()) return fail('无权限', 403);
    const it = find('quality_issues', m[0]);
    if (!it) return fail('异常单不存在', 404);
    if (['closed', 'cancelled'].includes(it.status)) return fail('该异常单已关闭');
    update('quality_issues', it.id, { status: 'verifying', cause: b.cause || null, action: b.action || null, disposition: b.disposition || null,
      loss_qty: (b.loss_qty !== undefined && b.loss_qty !== null && b.loss_qty !== '') ? num(b.loss_qty) : (b.disposition === 'scrap' && it.loss_qty == null ? it.qty_affected : (it.loss_qty != null ? it.loss_qty : null)),
      loss_amount: (b.loss_amount !== undefined && b.loss_amount !== null && b.loss_amount !== '') ? num(b.loss_amount) : (it.loss_amount != null ? it.loss_amount : null),
      claimed_at: it.claimed_at || nowISO() });
    // 抄送原上报人：他关心自己报的异常处理到哪一步了
    const owners = it.assignee_user_id ? [{ id: it.assignee_user_id, name: it.assignee_name }] : [];
    const reporter = it.created_by ? T('users').filter((u) => u.id === it.created_by && u.active) : [];
    pushMessage({
      source: 'quality', toUsers: owners.concat(reporter), kind: 'handled',
      issue_id: it.id, ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id,
      title: `质量异常处理中：${it.code}`,
      body: `${actor().name} 已提交处理：处置 ${DISPOSITION_LABEL[b.disposition] || '未填'}${b.action ? '，措施：' + b.action : ''}。待验证关闭。`,
    });
    writeLog(actor(), '处理质量异常', it.code + ' ' + (DISPOSITION_LABEL[b.disposition] || ''));
    return ok(true);
  });
  R('POST', '/quality_issues/(\\d+)/close', (m, b) => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    const it = find('quality_issues', m[0]);
    if (!it) return fail('异常单不存在', 404);
    if (it.status === 'closed') return fail('该异常单已关闭');
    const act = actor();
    update('quality_issues', it.id, { status: 'closed', verifier: act.name, closed_at: nowISO() });
    if (it.order_step_id) {
      const step = find('order_steps', it.order_step_id);
      if (step && String(step.inspect_status) === 'failed' && b.release !== false) {
        const fin = num(step.qty_good) >= num(step.qty_plan);
        update('order_steps', step.id, { inspect_status: 'passed', status: fin ? 'done' : 'running', finish_time: fin ? nowISO() : null });
      }
    }
    if (it.order_id) {
      const o = find('orders', it.order_id);
      if (o && o.status === 'paused') {
        const left = T('order_steps').filter((s) => Number(s.order_id) === Number(o.id) && s.status !== 'done');
        update('orders', o.id, { status: left.length ? 'running' : 'done' });
      }
    }
    notifyIssue(it, { id: it.assignee_user_id, name: it.assignee_name }, 'closed', `质量异常已闭环：${it.code}`, `验证人 ${act.name}，处置：${DISPOSITION_LABEL[it.disposition] || '未填'}`);
    // 上报人也收到闭环消息
    if (it.created_by && Number(it.created_by) !== Number(it.assignee_user_id)) {
      const rep = T('users').filter((u) => u.id === it.created_by && u.active);
      if (rep.length) {
        pushMessage({
          source: 'quality', toUsers: rep, kind: 'closed', issue_id: it.id,
          ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id,
          title: `质量异常已闭环：${it.code}`,
          body: `验证人 ${act.name}；处置 ${DISPOSITION_LABEL[it.disposition] || '未填'}。工单已恢复流转。`,
        });
      }
    }
    writeLog(act, '关闭质量异常', it.code);
    return ok(true);
  });
  R('POST', '/quality_issues/(\\d+)/cancel', (m, b) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const it = find('quality_issues', m[0]);
    if (!it) return fail('异常单不存在', 404);
    update('quality_issues', it.id, { status: 'cancelled', cause: b.reason || '作废', closed_at: nowISO() });
    writeLog(actor(), '作废质量异常', it.code);
    return ok(true);
  });
  R('POST', '/quality_issues', (_p, b) => {
    if (canInspect()) return fail('无权限', 403);
    const act = actor();
    // 上报口径（2026-10-06）：非检验员上报正式等级一律「待定级」（检验员判定），只留存记录；
    // 检验员上报可直接定级（缺省 major）；操作工申报重大（严重/致命）→ 另通知全体检验员
    const lv = (b.source || 'report') === 'report'
      ? (act.role === 'inspector' && ['minor', 'major', 'critical'].includes(b.level) ? b.level : 'pending')
      : (b.level || 'major');
    const it = createQualityIssue({
      level: lv, source: b.source || 'report',
      order_id: num(b.order_id) || null, order_step_id: num(b.order_step_id) || null,
      product_name: b.product_name || null, process_name: b.process_name || null,
      qty_affected: num(b.qty_affected), bad_summary: b.bad_summary || b.title || '', created_by: act.id,
    });
    if ((b.source || 'report') === 'report' && act.role !== 'inspector' && ['major', 'critical'].includes(b.level)) {
      T('users').filter((u2) => u2.role === 'inspector' && u2.active).forEach((ip) => {
        notifyIssue(it, ip, 'created', `操作工上报重大异常，请及时定级：${it.code}`,
          `${it.process_name || ''} 不良${it.qty_affected}件：${it.bad_summary || ''}（申报等级：${ISSUE_LEVEL_LABEL[b.level]}）`);
      });
    }
    // 检验员主动上报：无论等级均知会管理层（致命级已由 createQualityIssue 升级）
    if ((b.source || 'report') === 'report' && act.role === 'inspector' && it.level !== 'critical') {
      const admins = T('users').filter((u2) => u2.role === 'admin' && u2.active && u2.id !== it.assignee_user_id);
      pushMessage({
        source: 'quality', toUsers: admins, kind: 'created', issue_id: it.id,
        ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id,
        title: `检验员上报质量异常（${ISSUE_LEVEL_LABEL[it.level] || it.level}）：${it.code}`,
        body: `${it.order_code || '工单'} · ${it.process_name || '工序'} 不良${it.qty_affected}件：${it.bad_summary || '未填原因'}`,
      });
    }
    writeLog(act, '上报质量异常', it.code + ' ' + (b.bad_summary || ''));
    return ok(it);
  });
  // 检验员定级：工人/现场上报的异常严重等级交由检验员判定；判定致命级时上报厂部管理层
  R('PUT', '/quality_issues/(\\d+)/level', (m, b) => {
    if (requireRole('inspector', 'admin')) return fail('无权限', 403);
    const it = find('quality_issues', m[0]);
    if (!it) return fail('异常单不存在', 404);
    const lv = b.level;
    if (!['minor', 'major', 'critical'].includes(lv)) return fail('等级必须是 minor/major/critical');
    if (it.level === lv) return ok(it);
    update('quality_issues', it.id, { level: lv });
    const upd = find('quality_issues', it.id);
    const assignee = { id: it.assignee_user_id, name: it.assignee_name };
    if (lv === 'critical') {
      notifyIssue(upd, assignee, 'graded', `${it.code} 经 ${actor().name} 判定为致命级`, `等级更新为致命，请厂部关注并督促处理`);
      const admins = T('users').filter((u) => u.role === 'admin' && u.active);
      pushMessage({ source: 'quality', toUsers: admins, kind: 'escalate', issue_id: it.id, ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id, title: `重大质量异常（检验员判定）：${it.code}`, body: `${it.order_code || ''} · ${it.process_name || ''} 不良${it.qty_affected}件，判定为致命级。` });
    } else {
      notifyIssue(upd, assignee, 'graded', `${it.code} 等级更新为${ISSUE_LEVEL_LABEL[lv]}`, `由 ${actor().name} 判定`);
    }
    writeLog(actor(), '质量异常定级', it.code + ' → ' + lv);
    return ok(upd);
  });

  R('GET', '/notifications', (_p, _b, q) => {
    if (!Store.currentUser) return ok([]);
    const query = q || {};
    let rows = T('issue_notifications').filter((n) => Number(n.to_user_id) === Number(Store.currentUser.id) && n.channel === 'inbox');
    if (query.source) rows = rows.filter((n) => (n.source || 'system') === String(query.source));
    if (query.unread === '1') rows = rows.filter((n) => !n.read_at);
    const limit = Math.min(200, Math.max(1, num(query.limit, 100)));
    return ok(rows.sort((a, b) => b.id - a.id).slice(0, limit)
      .map((n) => {
        const q2 = find('quality_issues', n.issue_id);
        return Object.assign({}, n, {
          issue_code: q2 ? q2.code : '', level: q2 ? q2.level : '', issue_status: q2 ? q2.status : '',
          source_label: MSG_SOURCE_LABEL[n.source || 'system'] || '消息',
          kind_label: MSG_KIND_LABEL[n.kind] || n.kind || '',
        });
      }));
  });
  R('GET', '/notifications/unread_count', () => {
    if (!Store.currentUser) return ok({ count: 0, by_source: {} });
    const rows = T('issue_notifications').filter((n) => Number(n.to_user_id) === Number(Store.currentUser.id) && n.channel === 'inbox' && !n.read_at);
    const bySource = {};
    rows.forEach((n) => { const s = n.source || 'system'; bySource[s] = (bySource[s] || 0) + 1; });
    return ok({ count: rows.length, by_source: bySource });
  });
  R('POST', '/notifications/read', (_p, b) => {
    if (!Store.currentUser) return ok(true);
    const uid = Number(Store.currentUser.id);
    T('issue_notifications').forEach((n) => {
      if (Number(n.to_user_id) !== uid || n.channel !== 'inbox' || n.read_at) return;
      if (b.id && Number(b.id) !== Number(n.id)) return;
      if (b.source && String(b.source) !== String(n.source || 'system')) return;
      n.read_at = nowISO();
    });
    save();
    return ok(true);
  });
  R('GET', '/message_sources', () => ok(Object.keys(MSG_SOURCE_LABEL).map((k) => ({ key: k, label: MSG_SOURCE_LABEL[k] }))));
  R('POST', '/stock_alerts/scan', () => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    return ok({ sent: scanStockAlerts() });
  });
  R('GET', '/stock_alerts', () => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    return ok(T('materials').filter((m) => m.active !== 0).map((m) => {
      const qty = T('inventory').filter((i) => i.material_id === m.id).reduce((s, i) => s + Number(i.qty || 0), 0);
      let lv = 'ok';
      if (Number(m.safe_min) > 0 && qty < Number(m.safe_min)) lv = 'short';
      else if (m.safe_max != null && Number(m.safe_max) > 0 && qty > Number(m.safe_max)) lv = 'over';
      return { id: m.id, code: m.code, name: m.name, unit: m.unit, safe_min: m.safe_min, safe_max: m.safe_max, qty, level: lv };
    }).filter((r) => r.level !== 'ok'));
  });

  R('GET', '/quality/settings', () => {
    if (requireRole('admin', 'technician')) return fail('无权限', 403);
    return ok({
      webhook_url: getSetting('webhook_url', ''),
      escalate_minutes: num(getSetting('escalate_minutes', 240), 240),
      remind_minutes: num(getSetting('remind_minutes', 30), 30),
      critical_ratio: num(getSetting('critical_ratio', 20), 20),
      minor_ratio: num(getSetting('minor_ratio', 5), 5),
    });
  });
  R('POST', '/quality/settings', (_p, b) => {
    if (requireRole('admin')) return fail('无权限', 403);
    if (b.webhook_url !== undefined) setSetting('webhook_url', b.webhook_url || '');
    if (b.escalate_minutes !== undefined) setSetting('escalate_minutes', num(b.escalate_minutes, 240));
    if (b.remind_minutes !== undefined) setSetting('remind_minutes', num(b.remind_minutes, 30));
    if (b.critical_ratio !== undefined) setSetting('critical_ratio', Math.min(100, Math.max(1, num(b.critical_ratio, 20))));
    if (b.minor_ratio !== undefined) setSetting('minor_ratio', Math.min(50, Math.max(0, num(b.minor_ratio, 5))));
    writeLog(actor(), '修改质量设置', JSON.stringify(b));
    save();
    return ok(true);
  });

  /* ---- 现场巡检（静态镜像）：自由巡检在产工单，异常联动质量异常单 ---- */
  const patrolOut = (r) => {
    const o = find('orders', r.order_id) || {};
    const p = o.product_id ? find('products', o.product_id) : null;
    const s = r.order_step_id ? find('order_steps', r.order_step_id) : null;
    const pr = s ? find('processes', s.process_id) : null;
    return Object.assign({}, r, {
      order_code: o.code || '', product_name: p ? p.name : '', step_seq: s ? s.seq : null, step_name: pr ? pr.name : '',
      checklist_result: r.checklist_result ? (typeof r.checklist_result === 'string' ? JSON.parse(r.checklist_result) : r.checklist_result) : null,
      photos: r.photos ? (typeof r.photos === 'string' ? JSON.parse(r.photos) : r.photos) : [],
    });
  };
  R('GET', '/patrols', (_p, _b, q) => {
    if (requireRole('admin', 'technician', 'inspector')) return fail('无权限', 403);
    const days = Math.min(180, Math.max(1, num(q.days, 7)));
    const from = dayOffset(-(days - 1));
    return ok(T('patrol_records')
      .filter((r) => String(r.created_at).slice(0, 10) >= from && (q.mine !== '1' || r.inspector_id === (Store.currentUser || {}).id) && (!q.result || r.result === q.result))
      .sort((a, b) => b.id - a.id).slice(0, 200).map(patrolOut));
  });
  R('POST', '/patrols', (_p, b) => {
    if (requireRole('admin', 'technician', 'inspector')) return fail('无权限', 403);
    const me = Store.currentUser || {};
    const result = String(b.result || '') === 'abnormal' ? 'abnormal' : 'normal';
    const order = b.order_id ? find('orders', b.order_id) : null;
    if (!order || ['closed', 'cancelled'].includes(order.status)) return { ok: false, msg: '请选择要巡查的在产工单' };
    const step = b.order_step_id ? find('order_steps', b.order_step_id) : null;
    const cl = (Array.isArray(b.checklist) ? b.checklist : []).filter((c) => String(c.name || '').trim());
    const ng = cl.filter((c) => c.result === 'ng');
    const findings = String(b.findings || '').trim();
    if (result === 'normal' && (num(b.qty_bad) > 0 || ng.length)) return { ok: false, msg: '存在不良或 NG 检查项，不能记为正常' };
    if (result === 'abnormal' && !findings && !ng.length && !num(b.qty_bad)) return { ok: false, msg: '异常巡检请填写异常描述或勾选 NG 检查项' };
    let issue = null;
    if (result === 'abnormal' && b.create_issue !== false) {
      const level = ['minor', 'major', 'critical'].includes(b.level) ? b.level : 'major';
      const product = order.product_id ? find('products', order.product_id) : null;
      const summary = ng.map((c) => c.name + (c.qty ? '×' + c.qty : '')).concat(findings ? [findings] : []).join('；');
      const assignee = resolveIssueAssignee(step, order);
      issue = insert('quality_issues', {
        id: nextId('quality_issues'), code: genCode('QA'), level, source: 'patrol',
        order_id: order.id, order_step_id: step ? step.id : null, inspection_id: null,
        product_id: product ? product.id : null, product_name: product ? product.name : null,
        order_code: order.code, process_name: step && step.process_id ? (find('processes', step.process_id) || {}).name : null,
        qty_affected: num(b.qty_bad) || num(b.qty_checked) || 0, bad_summary: summary || '现场巡检发现异常',
        status: 'open', assignee_user_id: assignee.id, assignee_name: assignee.name, claimed_at: null,
        due_at: nowISO().slice(0, 19), escalated: 0, cause: null, action: null, disposition: null,
        verifier: null, closed_at: null, created_by: me.id, created_at: nowISO(), supplier: null,
      });
      issue = find('quality_issues', issue);
    }
    const day = String(new Date().getFullYear()).slice(2) + pad(new Date().getMonth() + 1) + pad(new Date().getDate());
    const n = T('patrol_records').filter((x) => String(x.code || '').indexOf('XL' + day) === 0).length + 1;
    const rec = insert('patrol_records', {
      id: nextId('patrol_records'), code: 'XL' + day + String(100 + n).slice(1),
      inspector_id: me.id, inspector_name: me.name, order_id: order.id, order_step_id: step ? step.id : null,
      checklist_id: num(b.checklist_id) || null,
      checklist_result: cl.length ? JSON.stringify(cl) : null, result,
      qty_checked: Math.max(0, Math.floor(num(b.qty_checked))), qty_bad: Math.max(0, Math.floor(num(b.qty_bad))),
      findings: findings || (ng.length ? '检查项 NG：' + ng.map((c) => c.name).join('、') : ''),
      issue_id: issue ? issue.id : null, photos: '[]', created_at: nowISO(),
    });
    writeLog(me, '现场巡检', order.code + ' ' + (result === 'normal' ? '正常' : '异常' + (issue ? '（开单 ' + issue.code + '）' : '')));
    save();
    return ok({ id: rec, code: (find('patrol_records', rec) || {}).code, issue: issue ? { id: issue.id, code: issue.code, assignee_name: issue.assignee_name } : null });
  });
  R('GET', '/patrols/(\\d+)', (m) => {
    if (requireRole('admin', 'technician', 'inspector')) return fail('无权限', 403);
    const r = find('patrol_records', m[1]);
    if (!r) return { ok: false, msg: '巡检记录不存在', status: 404 };
    return ok(patrolOut(r));
  });
  R('POST', '/patrols/(\\d+)/photos', (m, b) => {
    if (requireRole('admin', 'technician', 'inspector')) return fail('无权限', 403);
    const r = find('patrol_records', m[1]);
    if (!r) return { ok: false, msg: '巡检记录不存在', status: 404 };
    const photos = r.photos ? (typeof r.photos === 'string' ? JSON.parse(r.photos) : r.photos) : [];
    if (photos.length >= 6) return { ok: false, msg: '每条巡检最多 6 张照片' };
    photos.push({ file: 'static_' + Date.now(), name: String(b.name || 'photo.jpg').slice(-120), at: nowISO() });
    r.photos = JSON.stringify(photos);
    save();
    return ok({ photos });
  });
  /* APP 拍照留证（静态镜像）：报工照片 / 异常单照片 */
  R('POST', '/reports/(\\d+)/photos', (m, b) => {
    const me = Store.currentUser || {};
    const r = find('reports', m[1]);
    if (!r) return { ok: false, msg: '报工记录不存在', status: 404 };
    if (num(r.worker_id) !== num(me.id) && !['admin', 'technician'].includes(me.role)) return fail('仅报工人本人或管理员可补充照片', 403);
    const photos = r.photos ? (typeof r.photos === 'string' ? JSON.parse(r.photos) : r.photos) : [];
    if (photos.length >= 6) return { ok: false, msg: '每条报工最多 6 张照片' };
    photos.push({ file: 'static_' + Date.now(), name: String(b.name || 'photo.jpg').slice(-120), at: nowISO() });
    r.photos = JSON.stringify(photos);
    save();
    return ok({ photos });
  });
  R('POST', '/quality_issues/(\\d+)/photos', (m, b) => {
    if (requireRole('admin', 'technician', 'inspector')) return fail('无权限', 403);
    const r = find('quality_issues', m[1]);
    if (!r) return { ok: false, msg: '异常单不存在', status: 404 };
    const photos = r.photos ? (typeof r.photos === 'string' ? JSON.parse(r.photos) : r.photos) : [];
    if (photos.length >= 6) return { ok: false, msg: '每张异常单最多 6 张照片' };
    photos.push({ file: 'static_' + Date.now(), name: String(b.name || 'photo.jpg').slice(-120), at: nowISO() });
    r.photos = JSON.stringify(photos);
    save();
    return ok({ photos });
  });
  R('GET', '/stats/patrol', () => {
    if (requireRole('admin', 'technician', 'inspector')) return fail('无权限', 403);
    const t10 = today();
    const week = T('patrol_records').filter((r) => String(r.created_at).slice(0, 10) >= dayOffset(-6));
    const todayRows = T('patrol_records').filter((r) => String(r.created_at).slice(0, 10) === t10);
    const byUser = {};
    week.forEach((r) => {
      const e = byUser[r.inspector_id] || (byUser[r.inspector_id] = { id: r.inspector_id, name: r.inspector_name, total: 0, abnormal: 0 });
      e.total++; if (r.result === 'abnormal') e.abnormal++;
    });
    const trend = {};
    week.forEach((r) => {
      const d = String(r.created_at).slice(0, 10);
      const e = trend[d] || (trend[d] = { d, total: 0, abnormal: 0 });
      e.total++; if (r.result === 'abnormal') e.abnormal++;
    });
    return ok({
      today: { total: todayRows.length, abnormal: todayRows.filter((r) => r.result === 'abnormal').length },
      week: { total: week.length, abnormal: week.filter((r) => r.result === 'abnormal').length,
        rate: week.length ? Math.round(week.filter((r) => r.result === 'abnormal').length * 1000 / week.length) / 10 : 0,
        inspectors: Object.keys(byUser).length },
      by_user: Object.values(byUser).sort((a, b) => b.total - a.total),
      trend: Object.values(trend).sort((a, b) => String(a.d).localeCompare(String(b.d))),
    });
  });


  R('GET', '/stats/quality', () => {
    const openRows = T('quality_issues').filter((x) => ['open', 'processing', 'verifying'].includes(x.status));
    const lv = {};
    openRows.forEach((x) => { lv[x.level] = (lv[x.level] || 0) + 1; });
    const paretoMap = {};
    T('inspection_defects').forEach((d) => {
      const n = String(d.bad_reason || '').trim(); if (!n) return;
      if (!paretoMap[n]) paretoMap[n] = { name: n, qty: 0, times: 0 };
      paretoMap[n].qty += num(d.qty); paretoMap[n].times++;
    });
    const procMap = {};
    T('inspections').forEach((i) => {
      const n = i.process_name || '未命名工序';
      if (!procMap[n]) procMap[n] = { process_name: n, chk: 0, fail: 0 };
      procMap[n].chk += num(i.qty_check); procMap[n].fail += num(i.qty_fail);
    });
    const claimed = T('quality_issues').filter((x) => x.claimed_at && x.created_at);
    const avg = claimed.length
      ? Math.round(claimed.reduce((s, x) => s + (new Date(String(x.claimed_at).replace(' ', 'T')) - new Date(String(x.created_at).replace(' ', 'T'))) / 60000, 0) / claimed.length)
      : null;
    const lossRows = T('quality_issues').filter((x) => x.status !== 'cancelled');
    return ok({
      total_open: openRows.length,
      total_closed: T('quality_issues').filter((x) => x.status === 'closed').length,
      open_by_level: Object.keys(lv).map((k) => ({ level: k, c: lv[k] })),
      pareto: Object.values(paretoMap).sort((a, b) => b.qty - a.qty).slice(0, 10),
      by_process: Object.values(procMap).sort((a, b) => b.fail - a.fail).slice(0, 10),
      overdue: openRows.filter((x) => x.due_at && x.due_at < nowISO()).slice(0, 20),
      avg_claim_minutes: avg,
      scrap_qty: lossRows.reduce((s, x) => s + (num(x.loss_qty) || 0), 0),
      loss_amount: lossRows.reduce((s, x) => s + (num(x.loss_amount) || 0), 0),
    });
  });

  /* ---------- 检验项目模板 / 来料检验 IQC / 供应商质量 / FPY / 趋势（静态镜像） ---------- */
  R('GET', '/checklists', () => ok(T('quality_checklists').slice().sort((a, b) => b.id - a.id).map((c) => {
    let items = [];
    try { items = JSON.parse(c.items || '[]'); } catch (e) { /* 忽略 */ }
    const p = c.process_id ? find('processes', c.process_id) : null;
    return Object.assign({}, c, { items: Array.isArray(items) ? items : [], process_name: p ? p.name : null });
  })));
  R('POST', '/checklists', (_p, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const name = String(b.name || '').trim();
    const items = (Array.isArray(b.items) ? b.items : []).map((it) => ({ name: String(it.name || '').trim(), standard: String(it.standard || '').trim() })).filter((x) => x.name);
    if (!name) return fail('请填写模板名称');
    if (!items.length) return fail('至少填写一个检验项目');
    const id = insert('quality_checklists', { id: nextId('quality_checklists'), name, process_id: num(b.process_id) || null, items: JSON.stringify(items), created_at: nowISO() });
    save();
    return ok({ id });
  });
  R('PUT', '/checklists/(\\d+)', (m, b) => {
    if (requireOrderMgr()) return fail('无权限', 403);
    const it = find('quality_checklists', m[0]);
    if (!it) return fail('模板不存在', 404);
    const items = (Array.isArray(b.items) ? b.items : []).map((x) => ({ name: String(x.name || '').trim(), standard: String(x.standard || '').trim() })).filter((x) => x.name);
    if (!String(b.name || '').trim()) return fail('请填写模板名称');
    if (!items.length) return fail('至少填写一个检验项目');
    update('quality_checklists', it.id, { name: String(b.name).trim(), process_id: num(b.process_id) || null, items: JSON.stringify(items) });
    save();
    return ok(true);
  });
  R('DELETE', '/checklists/(\\d+)', (m) => {
    if (requireRole('admin')) return fail('无权限', 403);
    const it = find('quality_checklists', m[0]);
    if (!it) return fail('模板不存在', 404);
    DB.quality_checklists = T('quality_checklists').filter((x) => x.id !== it.id);
    save();
    return ok(true);
  });
  R('POST', '/incoming_inspections', (_p, b) => {
    if (requireRole('admin', 'technician', 'inspector')) return fail('无权限', 403);
    const rec = find('incoming_materials', num(b.id));
    if (!rec) return fail('来料单不存在', 404);
    if (rec.result !== 'pending') return fail('该来料单已完成检验，无需重复判定');
    const conclusion = ['pass', 'fail', 'concession'].includes(b.conclusion) ? b.conclusion : 'pass';
    const qtyFail = Math.max(0, Math.floor(num(b.qty_fail)));
    if (conclusion === 'pass' && qtyFail > 0) return fail('判定合格时不合格数必须为 0');
    if (conclusion !== 'pass' && qtyFail <= 0) return fail('判定不合格/让步接收时须填写不合格数');
    update('incoming_materials', rec.id, {
      result: conclusion === 'fail' ? 'rejected' : 'qualified', inspector: actor().name,
      remark: ((b.remark || '').trim() + (conclusion === 'concession' ? '（让步接收）' : '')).trim() || rec.remark,
    });
    save();
    return ok({ id: rec.id, result: conclusion === 'fail' ? 'rejected' : 'qualified', qty_fail: qtyFail, issue: null });
  });
  R('GET', '/stats/supplier_quality', () => {
    const map = {};
    T('incoming_materials').forEach((i) => {
      const k = i.supplier || '未知供应商';
      if (!map[k]) map[k] = { name: k, total: 0, qualified: 0, rejected: 0, pending: 0 };
      map[k].total += num(i.qty);
      if (i.result === 'qualified') map[k].qualified += num(i.qty);
      else if (i.result === 'rejected') map[k].rejected += num(i.qty);
      else if (i.result === 'pending') map[k].pending += num(i.qty);
    });
    return ok(Object.values(map).sort((a, b) => b.total - a.total).map((r) => {
      const judged = r.qualified + r.rejected;
      return Object.assign(r, { pass_rate: judged > 0 ? r.qualified / judged : null });
    }));
  });
  R('GET', '/stats/fpy', () => {
    const fqcMap = {};
    T('inspections').forEach((i) => {
      const st = find('order_steps', i.order_step_id);
      if (!st || String(st.inspect_type || '') !== 'fqc') return;
      if (!fqcMap[i.order_id] || i.id < fqcMap[i.order_id].id) fqcMap[i.order_id] = i;
    });
    const rows = Object.values(fqcMap);
    if (!rows.length) return ok({ total: 0, first_pass: 0, fpy: null, by_product: [], by_month: [] });
    const byProduct = {}; const byMonth = {};
    let firstPass = 0;
    rows.forEach((i) => {
      const o = find('orders', i.order_id) || {};
      const p = o.product_id ? find('products', o.product_id) : null;
      const pass = i.conclusion === 'pass' ? 1 : 0;
      firstPass += pass;
      const pk = p ? p.name : '未命名产品';
      if (!byProduct[pk]) byProduct[pk] = { name: pk, total: 0, pass: 0 };
      byProduct[pk].total++; byProduct[pk].pass += pass;
      const ym = String(i.created_at || '').slice(0, 7);
      if (ym) { if (!byMonth[ym]) byMonth[ym] = { name: ym, total: 0, pass: 0 }; byMonth[ym].total++; byMonth[ym].pass += pass; }
    });
    const rate = (o) => Object.assign(o, { fpy: o.total > 0 ? o.pass / o.total : null });
    return ok({
      total: rows.length, first_pass: firstPass, fpy: firstPass / rows.length,
      by_product: Object.values(byProduct).map(rate).sort((a, b) => a.fpy - b.fpy).slice(0, 10),
      by_month: Object.values(byMonth).map(rate).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });
  R('GET', '/stats/quality_trend', () => {
    const map = {};
    T('inspections').forEach((i) => {
      const ym = String(i.created_at || '').slice(0, 7);
      if (!ym) return;
      if (!map[ym]) map[ym] = { name: ym, chk: 0, pass: 0, insp_n: 0, issue_n: 0, avg_close_h: null };
      map[ym].chk += num(i.qty_check); map[ym].pass += num(i.qty_pass); map[ym].insp_n++;
    });
    T('quality_issues').forEach((x) => {
      const ym = String(x.created_at || '').slice(0, 7);
      if (!ym) return;
      if (!map[ym]) map[ym] = { name: ym, chk: 0, pass: 0, insp_n: 0, issue_n: 0, avg_close_h: null };
      map[ym].issue_n++;
    });
    return ok(Object.values(map).sort((a, b) => a.name.localeCompare(b.name)).map((r) => Object.assign(r, { pass_rate: r.chk > 0 ? r.pass / r.chk : null })));
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
