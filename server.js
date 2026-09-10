/**
 * 轻量生产管理系统（类黑湖小工单）· 服务端
 * 零第三方依赖：Node 内置 http + node:sqlite
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('./lib/db');
const qrcode = require('./public/lib/qrcode.js');

const { all, get, run, insert, tx, seed, hashPassword, log: writeLog, now, today } = D;

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

seed();

/* 列类型缓存：把空串按数值列转成 0，避免 NOT NULL 约束失败（新增/编辑时用户留空数字） */
const colTypes = {};
for (const t of ['products', 'processes', 'work_centers', 'customers', 'bad_reasons', 'routes', 'users', 'orders', 'order_steps', 'reports', 'logs', 'sessions', 'incoming_materials', 'finished_goods_in', 'materials', 'warehouses', 'inventory', 'inventory_tx']) {
  try {
    colTypes[t] = {};
    for (const row of all(`PRAGMA table_info(${t})`)) colTypes[t][row.name] = (row.type || '').toUpperCase();
  } catch (e) { colTypes[t] = {}; }
}

/* ------------------------------ 工具 ------------------------------ */
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const ok = (res, data) => json(res, 200, { ok: true, data });
const fail = (res, msg, code = 400) => json(res, code, { ok: false, msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      if (!b) return resolve({});
      try {
        resolve(JSON.parse(b));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function currentUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : new URL(req.url, 'http://x').searchParams.get('token');
  if (!token) return null;
  const s = get('SELECT * FROM sessions WHERE token=? AND expire_at > ?', [token, now()]);
  if (!s) return null;
  return get('SELECT id,username,name,role,team,work_center_id FROM users WHERE id=? AND active=1', [s.user_id]);
}

const need = (u, ...roles) => u && (!roles.length || roles.includes(u.role));

/* 路由表：[方法, 正则, 处理函数, 允许角色] */
const routes = [];
const route = (method, pattern, roles, fn) => routes.push([method, new RegExp('^' + pattern + '$'), roles, fn]);
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
// 自动单号：前缀 + 年月日(2位年) + 3位随机序号，例如 LM260909123
const genCode = (p) => p + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 900) + 100);

/* ------------------------------ 扫码报工（免登录令牌） ------------------------------
 * 用 HMAC(密钥, type:id) 生成二维码令牌，无需新增表，重启后仍稳定、不可伪造。
 * 两种令牌：order:<id>（机台/工单码，扫码后可选报工人） 与 worker:<id>（员工码，绑定本人）。
 * 密钥保存在数据目录（DATA_DIR，Docker 持久卷）下，镜像重建/重新部署不会丢失，
 * 从而保证已印刷的工单/员工二维码永久有效；旧版密钥（应用根目录 .secret）会自动迁移。 */
const SECRET = (() => {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const f = path.join(dataDir, '.secret');
  const legacy = path.join(__dirname, '.secret');
  const gen = () => crypto.randomBytes(32).toString('hex');
  const save = (p, s) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, { mode: 0o600 }); } catch (e) { /* ignore */ } };
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    if (fs.existsSync(legacy)) {
      const s = fs.readFileSync(legacy, 'utf8').trim();
      if (s) { save(f, s); return s; } // 迁移到数据目录，容器重建不再丢失
    }
    const s = gen();
    save(f, s);
    if (!fs.existsSync(f)) save(legacy, s); // 数据目录不可写时退回旧位置
    return s;
  } catch (e) { /* ignore */ }
  return gen();
})();
const qrToken = (type, id) => crypto.createHmac('sha256', SECRET).update(type + ':' + id).digest('base64url');
function checkQrToken(token, type, id) {
  if (!token) return false;
  const exp = Buffer.from(qrToken(type, id));
  const got = Buffer.from(String(token));
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}
function baseUrl(req) {
  // 优先使用显式配置的公网域名（如已 ICP 备案的自定义域名），
  // 避免经过反向代理/负载均衡时取到内部 host，导致二维码链接域名错误、微信无法直接打开。
  const forced = process.env.PUBLIC_BASE_URL;
  if (forced) return forced.replace(/\/+$/, '');
  const h = req.headers.host || 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  return proto + '://' + h;
}
function makeQr(text, cellSize = 6) {
  for (let t = 1; t <= 10; t++) {
    try {
      const qr = qrcode(t, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize, margin: 2 });
    } catch (e) { /* 容量不足，尝试更高版本 */ }
  }
  throw new Error('二维码内容过长');
}

/* ------------------------------ 认证 ------------------------------ */
route('POST', '/api/login', [], (req, res, _m, body) => {
  const u = get('SELECT * FROM users WHERE username=? AND active=1', [String(body.username || '').trim()]);
  if (!u || u.password !== hashPassword(String(body.password || ''))) return fail(res, '账号或密码错误', 401);
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions(token,user_id,created_at,expire_at) VALUES(?,?,?,?)', [
    token, u.id, now(), new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 19).replace('T', ' '),
  ]);
  writeLog(u, '用户登录', u.name + ' 登录系统');
  ok(res, { token, user: { id: u.id, username: u.username, name: u.name, role: u.role, team: u.team } });
});

route('POST', '/api/logout', [], (req, res, _m, _b, u) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token) run('DELETE FROM sessions WHERE token=?', [token]);
  ok(res, true);
});

route('GET', '/api/me', [], (req, res) => {
  const u = currentUser(req);
  if (!u) return fail(res, '未登录', 401);
  ok(res, u);
});

/* ------------------------------ 元数据 ------------------------------ */
route('GET', '/api/meta', [], (req, res) => {
  ok(res, {
    products: all('SELECT * FROM products ORDER BY code'),
    processes: all('SELECT * FROM processes ORDER BY code'),
    workCenters: all('SELECT * FROM work_centers ORDER BY code'),
    customers: all('SELECT id,code,name FROM customers ORDER BY code'),
    badReasons: all('SELECT * FROM bad_reasons ORDER BY id'),
    workers: all("SELECT id,name,team,work_center_id FROM users WHERE role='worker' AND active=1 ORDER BY name"),
    teams: all("SELECT DISTINCT team FROM users WHERE team IS NOT NULL AND team<>'' ORDER BY team").map((r) => r.team),
    routes: all('SELECT r.*, p.name product_name FROM routes r JOIN products p ON p.id=r.product_id ORDER BY r.code'),
    statuses: [
      ['created', '待下发'], ['released', '已下发'], ['running', '生产中'],
      ['paused', '已暂停'], ['done', '已完成'], ['closed', '已关闭'],
    ],
  });
});

/* ------------------------------ 通用 CRUD ------------------------------ */
function crud(table, name, opts = {}) {
  const order = opts.order || 'id DESC';
  route('GET', '/api/' + table, [], (req, res) => {
    ok(res, all(`SELECT * FROM ${table} ORDER BY ${order}`));
  });
  route('POST', '/api/' + table, ['admin', 'leader'], (req, res, _m, b, u) => {
    if (opts.unique) {
      const ex = get(`SELECT id FROM ${table} WHERE ${opts.unique}=?`, [b[opts.unique]]);
      if (ex) return fail(res, '该编码已存在');
    }
    const cv = (f) => {
      const raw = b[f];
      if (raw === undefined) return f === 'created_at' ? now() : null;
      if (raw === '') {
        const t = (colTypes[table] && colTypes[table][f]) || '';
        if (t === 'INTEGER' || t === 'REAL' || t === 'NUMERIC') return 0;
        return null;
      }
      return raw;
    };
    const id = insert(`INSERT INTO ${table}(${opts.fields.join(',')}) VALUES(${opts.fields.map(() => '?').join(',')})`,
      opts.fields.map(cv));
    writeLog(u, '新增' + name, JSON.stringify(b));
    ok(res, { id });
  });
  route('PUT', '/api/' + table + '/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
    const sets = opts.editFields || opts.fields.filter((f) => f !== 'created_at');
    const cv = (f) => {
      const raw = b[f];
      if (raw === undefined) return null;
      if (raw === '') {
        const t = (colTypes[table] && colTypes[table][f]) || '';
        if (t === 'INTEGER' || t === 'REAL' || t === 'NUMERIC') return 0;
        return null;
      }
      return raw;
    };
    run(`UPDATE ${table} SET ${sets.map((f) => f + '=?').join(',')} WHERE id=?`, [...sets.map(cv), m[1]]);
    writeLog(u, '修改' + name, `#${m[1]} ` + JSON.stringify(b));
    ok(res, true);
  });
  route('DELETE', '/api/' + table + '/(\\d+)', ['admin'], (req, res, m, _b, u) => {
    const id = m[1];
    if (opts.onDelete) {
      const r = opts.onDelete(id, u);
      if (r && r.block) return fail(res, r.block, r.code || 409);
      if (r && r.cascade) for (const sql of r.cascade) run(sql);
    }
    run(`DELETE FROM ${table} WHERE id=?`, [id]);
    writeLog(u, '删除' + name, '#' + id);
    ok(res, true);
  });
}

crud('products', '产品', {
  fields: ['code', 'name', 'spec', 'unit', 'price', 'created_at'],
  editFields: ['code', 'name', 'spec', 'unit', 'price'],
  unique: 'code', order: 'code',
  onDelete: (id) => {
    const c = get('SELECT COUNT(*) c FROM orders WHERE product_id=?', [id]).c;
    if (c) return { block: `该产品已被 ${c} 个工单使用，无法删除；请先关闭或删除相关工单后再试。` };
    return null; // 未被工单引用时，外键 ON DELETE CASCADE 会自动清理其工艺路线与工序明细
  },
});
crud('processes', '工序', {
  fields: ['code', 'name', 'std_time', 'std_price', 'remark'],
  editFields: ['code', 'name', 'std_time', 'std_price', 'remark'],
  unique: 'code', order: 'code',
  onDelete: (id) => {
    const c = get('SELECT COUNT(*) c FROM order_steps WHERE process_id=?', [id]).c;
    if (c) return { block: `该工序已被 ${c} 个工单工序使用，无法删除；请先关闭或删除相关工单后再试。`, code: 409 };
    // 未被工单使用时，先清理引用该工序的工艺路线明细，再删除工序；落空的工艺路线一并移除
    return { cascade: [
      `DELETE FROM route_steps WHERE process_id=${Number(id)}`,
      `DELETE FROM routes WHERE id NOT IN (SELECT DISTINCT route_id FROM route_steps)`,
    ] };
  },
});
crud('work_centers', '工作中心', {
  fields: ['code', 'name', 'workshop', 'status', 'remark'],
  editFields: ['code', 'name', 'workshop', 'status', 'remark'],
  unique: 'code', order: 'code',
  onDelete: (id) => {
    const c = get('SELECT COUNT(*) c FROM users WHERE work_center_id=?', [id]).c
            + get('SELECT COUNT(*) c FROM route_steps WHERE work_center_id=?', [id]).c
            + get('SELECT COUNT(*) c FROM reports WHERE work_center_id=?', [id]).c;
    if (c) return { block: `该工作中心已被 ${c} 条记录（人员/工序/报工）引用，无法删除。` };
    return null;
  },
});
crud('customers', '客户', {
  fields: ['code', 'name', 'contact', 'phone', 'created_at'],
  editFields: ['code', 'name', 'contact', 'phone'],
  unique: 'code', order: 'code',
});
crud('bad_reasons', '不良原因', { fields: ['name'], editFields: ['name'], unique: 'name', order: 'id' });

route('GET', '/api/users', [], (req, res) => {
  ok(res, all('SELECT u.id,u.username,u.name,u.role,u.team,u.work_center_id,u.active,u.created_at, w.name wc_name FROM users u LEFT JOIN work_centers w ON w.id=u.work_center_id ORDER BY u.id'));
});
route('POST', '/api/users', ['admin'], (req, res, _m, b, u) => {
  const ex = get('SELECT id FROM users WHERE username=?', [b.username]);
  if (ex) return fail(res, '登录账号已存在');
  const id = insert('INSERT INTO users(username,name,password,role,team,work_center_id,active,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [b.username, b.name, hashPassword(b.password || '123456'), b.role || 'worker', b.team, b.work_center_id || null,
      b.active === undefined ? 1 : b.active ? 1 : 0, now()]);
  writeLog(u, '新增用户', b.username + ' ' + b.name);
  ok(res, { id });
});
route('PUT', '/api/users/(\\d+)', ['admin'], (req, res, m, b, u) => {
  const sets = ['username=?,name=?,role=?,team=?,work_center_id=?,active=?'];
  const params = [b.username, b.name, b.role, b.team, b.work_center_id || null, b.active ? 1 : 0, m[1]];
  if (b.password) {
    sets.push('password=?');
    params.splice(params.length - 1, 0, hashPassword(b.password));
  }
  run('UPDATE users SET ' + sets.join(',') + ' WHERE id=?', params);
  writeLog(u, '修改用户', '#' + m[1] + ' ' + b.name);
  ok(res, true);
});
route('DELETE', '/api/users/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const id = Number(m[1]);
  if (id === u.id) return fail(res, '不能删除当前登录的账号');
  const rep = get('SELECT COUNT(*) c FROM reports WHERE worker_id=?', [id]).c;
  const asg = get('SELECT COUNT(*) c FROM order_steps WHERE assignee_id=?', [id]).c;
  if (rep || asg) return fail(res, `该员工已有 ${rep} 条报工、${asg} 条派工记录，无法删除；如需停用，请在“编辑”中将其状态设为“停用”。`, 409);
  run('DELETE FROM sessions WHERE user_id=?', [id]);
  run('DELETE FROM users WHERE id=?', [id]);
  writeLog(u, '删除用户', '#' + id);
  ok(res, true);
});

/* 工艺路线（含工序明细） */
route('GET', '/api/routes', [], (req, res) => {
  const list = all(`SELECT r.*, p.name product_name, p.code product_code,
      (SELECT COUNT(*) FROM route_steps s WHERE s.route_id=r.id) step_count
    FROM routes r JOIN products p ON p.id=r.product_id ORDER BY r.code`);
  ok(res, list);
});
route('GET', '/api/routes/(\\d+)/steps', [], (req, res, m) => {
  ok(res, all(`SELECT s.*, p.name process_name, p.code process_code, w.name wc_name
    FROM route_steps s JOIN processes p ON p.id=s.process_id LEFT JOIN work_centers w ON w.id=s.work_center_id
    WHERE s.route_id=? ORDER BY s.seq`, [m[1]]));
});
route('POST', '/api/routes', ['admin', 'leader'], (req, res, _m, b, u) => {
  const rid = insert('INSERT INTO routes(code,name,product_id,created_at) VALUES(?,?,?,?)', [b.code, b.name, b.product_id, now()]);
  (b.steps || []).forEach((s) => {
    run('INSERT INTO route_steps(route_id,seq,process_id,work_center_id,std_time,std_price,need_report) VALUES(?,?,?,?,?,?,?)',
      [rid, s.seq, s.process_id, s.work_center_id || null, num(s.std_time), num(s.std_price), 1]);
  });
  writeLog(u, '新增工艺路线', b.code + ' ' + b.name);
  ok(res, { id: rid });
});
route('PUT', '/api/routes/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
  run('UPDATE routes SET code=?,name=?,product_id=? WHERE id=?', [b.code, b.name, b.product_id, m[1]]);
  run('DELETE FROM route_steps WHERE route_id=?', [m[1]]);
  (b.steps || []).forEach((s) => {
    run('INSERT INTO route_steps(route_id,seq,process_id,work_center_id,std_time,std_price,need_report) VALUES(?,?,?,?,?,?,?)',
      [m[1], s.seq, s.process_id, s.work_center_id || null, num(s.std_time), num(s.std_price), 1]);
  });
  writeLog(u, '修改工艺路线', '#' + m[1] + ' ' + b.code);
  ok(res, true);
});
route('DELETE', '/api/routes/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const id = m[1];
  const c = get('SELECT COUNT(*) c FROM orders WHERE route_id=?', [id]).c;
  if (c) return fail(res, `该工艺路线已被 ${c} 个工单使用，无法删除；请先关闭或删除相关工单后再试。`, 409);
  run('DELETE FROM routes WHERE id=?', [id]);
  writeLog(u, '删除工艺路线', '#' + id);
  ok(res, true);
});

/* ------------------------------ 工单 ------------------------------ */
const ORDER_SQL = `SELECT o.*, p.code product_code, p.name product_name, p.spec, p.unit, p.price product_price,
    r.code route_code, r.name route_name, c.name customer_name,
    (SELECT COALESCE(MIN(s.qty_good),0) FROM order_steps s WHERE s.order_id=o.id) qty_done,
    (SELECT COALESCE(MAX(s.qty_good),0) FROM order_steps s WHERE s.order_id=o.id) qty_max,
    (SELECT COALESCE(SUM(s.qty_bad),0)  FROM order_steps s WHERE s.order_id=o.id) qty_bad,
    (SELECT COALESCE(SUM(s.work_min),0) FROM order_steps s WHERE s.order_id=o.id) work_min,
    (SELECT COUNT(*) FROM order_steps s WHERE s.order_id=o.id AND s.status='done') step_done,
    (SELECT COUNT(*) FROM order_steps s WHERE s.order_id=o.id) step_total
  FROM orders o
  JOIN products p ON p.id=o.product_id
  JOIN routes r ON r.id=o.route_id
  LEFT JOIN customers c ON c.id=o.customer_id`;

route('GET', '/api/orders', [], (req, res, _m, _b, _u, query) => {
  const w = [];
  const p = [];
  if (query.status) { w.push('o.status IN (' + query.status.split(',').map(() => '?').join(',') + ')'); p.push(...query.status.split(',')); }
  if (query.keyword) {
    w.push('(o.code LIKE ? OR p.name LIKE ? OR p.code LIKE ? OR IFNULL(c.name,"") LIKE ?)');
    const k = '%' + query.keyword + '%';
    p.push(k, k, k, k);
  }
  if (query.onlyOverdue) { w.push("o.plan_end < ? AND o.status NOT IN ('done','closed')"); p.push(today()); }
  const sql = ORDER_SQL + (w.length ? ' WHERE ' + w.join(' AND ') : '') +
    " ORDER BY CASE o.status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'released' THEN 2 WHEN 'created' THEN 3 ELSE 4 END, o.priority, o.plan_end";
  ok(res, all(sql, p));
});

route('GET', '/api/orders/(\\d+)', [], (req, res, m) => {
  const o = get(ORDER_SQL + ' WHERE o.id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  o.steps = all(`SELECT s.*, pr.code process_code, pr.name process_name, w.name wc_name, s.assignee_team
    FROM order_steps s
    JOIN processes pr ON pr.id=s.process_id
    LEFT JOIN work_centers w ON w.id=s.work_center_id
    WHERE s.order_id=? ORDER BY s.seq`, [m[1]]);
  // 责任人 = 实际报工的人（可多人）；未报工则为空数组
  const repsQ = all(`SELECT rp.order_step_id sid, u.name wname FROM reports rp JOIN users u ON u.id=rp.worker_id WHERE rp.order_step_id IN (SELECT id FROM order_steps WHERE order_id=?)`, [m[1]]);
  const repMap = {};
  for (const r of repsQ) { (repMap[r.sid] = repMap[r.sid] || new Set()).add(r.wname); }
  o.steps.forEach((s) => { s.reporter_names = repMap[s.id] ? [...repMap[s.id]] : []; });
  // 班组下拉数据源
  o.teams = all("SELECT DISTINCT team FROM users WHERE team IS NOT NULL AND team<>'' ORDER BY team").map((r) => r.team);
  o.reports = all(`SELECT rp.*, u.name worker_name, pr.name process_name
    FROM reports rp LEFT JOIN users u ON u.id=rp.worker_id LEFT JOIN order_steps s ON s.id=rp.order_step_id
    LEFT JOIN processes pr ON pr.id=s.process_id
    WHERE rp.order_id=? ORDER BY rp.id DESC LIMIT 100`, [m[1]]);
  ok(res, o);
});

route('POST', '/api/orders', ['admin', 'leader'], (req, res, _m, b, u) => {
  const qty = Math.max(1, Math.floor(num(b.qty_plan, 1)));
  const code = b.code && b.code.trim() ? b.code.trim()
    : 'WO' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 9000) + 1000);
  if (get('SELECT id FROM orders WHERE code=?', [code])) return fail(res, '工单号已存在');
  const id = tx(() => {
    const oid = insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,plan_start,plan_end,status,remark,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, b.product_id, b.route_id, b.customer_id || null, qty, num(b.priority, 2),
        b.plan_start || today(), b.plan_end || today(), 'created', b.remark || '', u.id, now()]);
    all('SELECT * FROM route_steps WHERE route_id=? ORDER BY seq', [b.route_id]).forEach((s) => {
      insert('INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,status) VALUES(?,?,?,?,?,?)',
        [oid, s.seq, s.process_id, s.work_center_id, qty, 'pending']);
    });
    return oid;
  });
  writeLog(u, '创建工单', code + ' 数量 ' + qty);
  ok(res, { id, code });
});

route('PATCH', '/api/orders/(\\d+)/status', ['admin', 'leader'], (req, res, m, b, u) => {
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  if (b.status === 'released' && !get('SELECT 1 FROM order_steps WHERE order_id=? LIMIT 1', [m[1]])) return fail(res, '该工单还没有工序，无法下发（请检查工艺路线是否包含工序）', 400);
  const to = b.status;
  const label = { created: '待下发', released: '已下发', running: '生产中', paused: '已暂停', done: '已完成', closed: '已关闭' }[to] || to;
  const st = now();
  if (to === 'running') run('UPDATE orders SET status=?, start_time=IFNULL(start_time,?) WHERE id=?', [to, st, m[1]]);
  else if (to === 'done') run('UPDATE orders SET status=?, finish_time=? WHERE id=?', [to, st, m[1]]);
  else if (to === 'closed') run("UPDATE orders SET status=?, finish_time=IFNULL(finish_time,?), close_reason=? WHERE id=?", [to, st, b.close_reason || '', m[1]]);
  else run('UPDATE orders SET status=? WHERE id=?', [to, m[1]]);
  if (to === 'running') {
    run(`UPDATE order_steps SET status='running' WHERE id=(SELECT MIN(id) FROM order_steps WHERE order_id=? AND status='pending')`, [m[1]]);
  }
  writeLog(u, '工单状态变更', o.code + ' → ' + label);
  ok(res, true);
});

route('PATCH', '/api/orders/(\\d+)/steps/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
  const allowReport = (b.allow_report === 0 || b.allow_report === '0' || b.allow_report === false) ? 0 : 1;
  run('UPDATE order_steps SET assignee_team=?, work_center_id=?, allow_report=? WHERE id=? AND order_id=?',
    [b.assignee_team || null, b.work_center_id || null, allowReport, m[2], m[1]]);
  const o = get('SELECT code FROM orders WHERE id=?', [m[1]]);
  writeLog(u, '工序派工', (o ? o.code : m[1]) + ' 工序#' + m[2] + (b.assignee_team ? ' → ' + b.assignee_team : '') + (allowReport ? '' : '（员工不可申报）'));
  ok(res, true);
});

route('PUT', '/api/orders/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
  const before = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!before) return fail(res, '工单不存在', 404);
  if (before.status !== 'created') return fail(res, '只有「待下发」状态的工单可以修改');
  tx(() => {
    run('UPDATE orders SET product_id=?,route_id=?,customer_id=?,qty_plan=?,priority=?,plan_start=?,plan_end=?,remark=? WHERE id=?',
      [b.product_id, b.route_id, b.customer_id || null, num(b.qty_plan), num(b.priority, 2), b.plan_start, b.plan_end, b.remark || '', m[1]]);
    if (num(b.route_id) !== before.route_id || num(b.qty_plan) !== before.qty_plan) {
      run('DELETE FROM order_steps WHERE order_id=?', [m[1]]);
      all('SELECT * FROM route_steps WHERE route_id=? ORDER BY seq', [b.route_id]).forEach((s) => {
        insert('INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,status) VALUES(?,?,?,?,?,?)',
          [m[1], s.seq, s.process_id, s.work_center_id, num(b.qty_plan), 'pending']);
      });
    } else {
      run('UPDATE order_steps SET qty_plan=? WHERE order_id=?', [num(b.qty_plan), m[1]]);
    }
  });
  writeLog(u, '修改工单', before.code);
  ok(res, true);
});

route('DELETE', '/api/orders/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const o = get('SELECT code FROM orders WHERE id=?', [m[1]]);
  run('DELETE FROM orders WHERE id=?', [m[1]]);
  writeLog(u, '删除工单', o ? o.code : '#' + m[1]);
  ok(res, true);
});

/* 扫码：按工单号 / 产品编码定位 */
route('GET', '/api/scan/(.+)', [], (req, res, m) => {
  const key = decodeURIComponent(m[1]).trim();
  const o = get(ORDER_SQL + ' WHERE o.code=?', [key]);
  if (o) return ok(res, { type: 'order', order: o });
  const p = get('SELECT * FROM products WHERE code=?', [key]);
  if (p) {
    const list = all(ORDER_SQL + " WHERE o.product_id=? AND o.status IN ('released','running','paused') ORDER BY o.priority, o.plan_end", [p.id]);
    return ok(res, { type: 'product', product: p, orders: list });
  }
  fail(res, '未找到对应的工单或产品：' + key, 404);
});

/* 工序流转上限校验已于 2026-09-08 按业务需求移除（存在库存缓冲，下工序可超上工序合格数报工）。
   如需恢复，可从 git 历史找回 flowInfo / withFlow / checkFlow 三函数及 doReport 中对应调用。 */

/* ------------------------------ 报工 ------------------------------ */
route('GET', '/api/reports', [], (req, res, _m, _b, _u, query) => {
  const w = [];
  const p = [];
  if (query.date) { w.push('rp.report_date=?'); p.push(query.date); }
  if (query.order_id) { w.push('rp.order_id=?'); p.push(query.order_id); }
  if (query.worker_id) { w.push('rp.worker_id=?'); p.push(query.worker_id); }
  const sql = `SELECT rp.*, u.name worker_name, o.code order_code, pr.name process_name, w.name wc_name
    FROM reports rp LEFT JOIN users u ON u.id=rp.worker_id
    LEFT JOIN orders o ON o.id=rp.order_id
    LEFT JOIN order_steps s ON s.id=rp.order_step_id
    LEFT JOIN processes pr ON pr.id=s.process_id
    LEFT JOIN work_centers w ON w.id=rp.work_center_id
    ${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY rp.id DESC LIMIT 300`;
  ok(res, all(sql, p));
});

/* 报工核心逻辑（登录态与扫码免登录态共用）。actor 为 {id,name,role,team} 形式的操作人。
 * 支持两种调用形态：
 *   1) 单工序（向后兼容）：b = { order_id, order_step_id, qty_good, qty_bad, bad_reason, ... }
 *   2) 多工序一次性申报：b = { order_id, worker_id, steps: [ {order_step_id, qty_good, qty_bad, bad_reason}, ... ] }
 *      用于「员工身兼多岗」场景：一次提交同时申报多道工序。 */
function doReport(b, actor) {
  const order_id = num(b.order_id);
  const order = get('SELECT * FROM orders WHERE id=?', [order_id]);
  if (!order) throw new Error('工单不存在');
  if (['done', 'closed'].includes(order.status)) throw new Error('工单已完成，无法继续报工');

  // 归一化为「工序条目」数组
  const items = Array.isArray(b.steps)
    ? b.steps.map((s) => ({
        order_step_id: num(s.order_step_id),
        qty_good: s.qty_good, qty_bad: s.qty_bad,
        bad_reason: s.bad_reason, work_center_id: s.work_center_id,
        work_min: s.work_min,
        report_date: s.report_date || b.report_date, remark: s.remark || '',
      }))
    : [{
        order_step_id: num(b.order_step_id),
        qty_good: b.qty_good, qty_bad: b.qty_bad,
        bad_reason: b.bad_reason, work_center_id: b.work_center_id,
        work_min: b.work_min,
        report_date: b.report_date, remark: b.remark || '',
      }];
  if (!items.length) throw new Error('请至少选择一道工序');

  const workerId = num(b.worker_id) || actor.id;
  const results = [];

  tx(() => {
    for (const it of items) {
      const step = get('SELECT * FROM order_steps WHERE id=? AND order_id=?', [it.order_step_id, order_id]);
      if (!step) throw new Error('工序不存在（#' + it.order_step_id + '）');
      // 班组权限：工序已指派班组时，仅该班组的员工可报工；未指派则全员可报工。
      // 管理员/班组长可越权报工（管理兜底），普通员工严格按班组限制。
      if (step.assignee_team && actor.role !== 'admin' && actor.role !== 'leader') {
        const wid = num(b.worker_id) || actor.id;
        const wteam = actor.team || (get('SELECT team FROM users WHERE id=?', [wid]) || {}).team;
        if (wteam !== step.assignee_team) {
          throw new Error('工序「' + step.seq + '」限「' + step.assignee_team + '」班组报工（您为「' + (wteam || '未分组') + '」）');
        }
      }
      // 员工可申报开关：关闭时仅管理员/班组长可报此工序
      if (step.allow_report === 0 && actor.role !== 'admin' && actor.role !== 'leader') {
        throw new Error('工序「' + step.seq + '」需由管理员/班组长报工，员工不可申报');
      }
      const good = Math.max(0, Math.floor(num(it.qty_good)));
      const bad = Math.max(0, Math.floor(num(it.qty_bad)));
      if (good + bad <= 0) throw new Error('工序「' + step.seq + '」合格数与不良数不能同时为 0');
      insert(`INSERT INTO reports(order_id,order_step_id,worker_id,work_center_id,qty_good,qty_bad,bad_reason,work_min,report_date,remark,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [order_id, step.id, workerId, it.work_center_id || step.work_center_id,
          good, bad, bad ? (it.bad_reason || '其他') : '', num(it.work_min),
          it.report_date || today(), it.remark || '', now()]);

      const done = step.qty_good + good;
      const finished = done >= step.qty_plan;
      run('UPDATE order_steps SET qty_good=qty_good+?, qty_bad=qty_bad+?, work_min=work_min+?, status=?, start_time=IFNULL(start_time,?), finish_time=?, assignee_id=IFNULL(assignee_id,?) WHERE id=?',
        [good, bad, num(it.work_min), finished ? 'done' : 'running', now(), finished ? now() : null, workerId, step.id]);

      if (order.status === 'created' || order.status === 'released') {
        run("UPDATE orders SET status='running', start_time=IFNULL(start_time,?) WHERE id=?", [now(), order_id]);
      }
      if (finished) {
        run(`UPDATE order_steps SET status='running' WHERE id=(SELECT MIN(id) FROM order_steps WHERE order_id=? AND status='pending')`, [order_id]);
      }
      results.push({ order_step_id: step.id, seq: step.seq, finished });
    }

    // 全部工序完成 → 工单完工
    const left = get("SELECT COUNT(*) c FROM order_steps WHERE order_id=? AND status<>'done'", [order_id]);
    if (left.c === 0) run("UPDATE orders SET status='done', finish_time=? WHERE id=?", [now(), order_id]);
  });

  const totalGood = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_good))), 0);
  const totalBad = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_bad))), 0);
  writeLog(actor, '生产报工', order.code + (items.length > 1 ? ' 多工序×' + items.length : '') + ' 合格 ' + totalGood + ' / 不良 ' + totalBad);
  return { count: items.length, steps: results, finished: results.some((r) => r.finished) };
}

route('POST', '/api/reports', [], (req, res, _m, b, u) => {
  try { ok(res, doReport(b, u)); }
  catch (e) { fail(res, e.message, 400); }
});

/* 扫码免登录报工：令牌必须匹配工单（机台码）或员工（员工码） */
route('POST', '/api/public/reports', [], (req, res, _m, b) => {
  try {
    const order_id = num(b.order_id);
    const worker_id = num(b.worker_id);
    const validOrder = checkQrToken(b.token, 'order', order_id);
    const validWorker = worker_id && checkQrToken(b.token, 'worker', worker_id);
    if (!validOrder && !validWorker) return fail(res, '二维码已失效或无权限', 403);
    const w = get('SELECT id,name,role,team FROM users WHERE id=?', [worker_id]);
    if (!w) return fail(res, '报工人不存在', 400);
    ok(res, doReport({ ...b, order_id, worker_id }, w));
  } catch (e) { fail(res, e.message, 400); }
});

route('DELETE', '/api/reports/(\\d+)', ['admin', 'leader'], (req, res, m, _b, u) => {
  const r = get('SELECT * FROM reports WHERE id=?', [m[1]]);
  if (!r) return fail(res, '记录不存在', 404);
  tx(() => {
    run('UPDATE order_steps SET qty_good=qty_good-?, qty_bad=qty_bad-?, work_min=work_min-? WHERE id=?',
      [r.qty_good, r.qty_bad, r.work_min, r.order_step_id]);
    run("UPDATE order_steps SET status=CASE WHEN qty_good+qty_bad=0 THEN 'pending' WHEN qty_good>=qty_plan THEN 'done' ELSE 'running' END, finish_time=CASE WHEN qty_good>=qty_plan THEN finish_time ELSE NULL END WHERE id=?", [r.order_step_id]);
    run('DELETE FROM reports WHERE id=?', [m[1]]);
    const o = get('SELECT code FROM orders WHERE id=?', [r.order_id]);
    writeLog(u, '撤销报工', (o ? o.code : '') + ' 合格 ' + r.qty_good);
  });
  ok(res, true);
});

/* ------------------------------ 全流程合格产量 ------------------------------
   口径：一件产品必须「所有工序都合格」才算合格。
   所以工单完工量 = 该工单各工序累计合格数的**最小值**（瓶颈工序），
   某区间产量 = 期末完工量 - 期初完工量。
   历史累计用「当前工序合格数 - 该日之后的报工合计」回推：
   即使有人手工改过工序合格数（没有对应报工记录），也不会凭空算成当日产量。 */
function flowIndex() {
  const steps = all('SELECT s.id sid, s.order_id oid, s.qty_good cur FROM order_steps s');
  const reps = {};
  for (const r of all('SELECT order_step_id sid, report_date d, SUM(qty_good) g FROM reports GROUP BY order_step_id, report_date')) {
    (reps[r.sid] = reps[r.sid] || {})[r.d] = r.g;
  }
  return { steps, reps };
}

// 截至 upTo 日，每个工单的完工量
function finishedByOrder(idx, upTo) {
  const m = {};
  for (const s of idx.steps) {
    let after = 0;
    const by = idx.reps[s.sid];
    if (by) for (const d of Object.keys(by)) if (d > upTo) after += by[d];
    const v = Math.max(0, (s.cur || 0) - after);
    m[s.oid] = Math.min(m[s.oid] === undefined ? Infinity : m[s.oid], v);
  }
  return m;
}

// 某区间的全流程合格产量；cum 为期末累计完工量
function flowDelta(idx, upTo, prevTo) {
  const now = finishedByOrder(idx, upTo), prev = finishedByOrder(idx, prevTo);
  let good = 0, cum = 0;
  for (const k of Object.keys(now)) {
    const p = prev[k] === undefined ? now[k] : prev[k];   // 该工单在区间前不存在 → 按 0 增量计
    good += Math.max(0, now[k] - p);
    cum += now[k];
  }
  return { good, cum };
}

const shiftDay = (d, n) => get('SELECT date(?, ?) d', [d, n + ' day']).d;

/* ------------------------------ 统计 ------------------------------ */
route('GET', '/api/stats/overview', [], (req, res) => {
  const t = today();
  const day = get(`SELECT COALESCE(SUM(qty_good),0) good, COALESCE(SUM(qty_bad),0) bad,
      COALESCE(SUM(work_min),0) minu, COUNT(DISTINCT worker_id) people
    FROM reports WHERE report_date=?`, [t]);

  const ord = get(`SELECT
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) paused,
      SUM(CASE WHEN status IN ('created','released') THEN 1 ELSE 0 END) waiting,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN plan_end < ? AND status NOT IN ('done','closed') THEN 1 ELSE 0 END) overdue
    FROM orders`, [t]);
  const wc = get(`SELECT SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN status='fault' THEN 1 ELSE 0 END) fault,
      SUM(CASE WHEN status='maintain' THEN 1 ELSE 0 END) maintain, COUNT(*) total FROM work_centers`);
  const monthStart = t.slice(0, 8) + '01';
  const month = get(`SELECT COALESCE(SUM(qty_good),0) good FROM reports WHERE report_date >= ?`,
    [monthStart]);
  // 全流程口径：今日新增完工、本月新增完工
  const idx = flowIndex();
  const fg = flowDelta(idx, t, shiftDay(t, -1));
  const fgm = flowDelta(idx, t, shiftDay(monthStart, -1));
  ok(res, {
    // good = 全流程合格（新增完工）；stepGood = 工序级作业合格量（各工序累加，未去重）
    today: {
      good: fg.good, stepGood: day.good, cumulative: fg.cum,
      bad: day.bad, hours: +(day.minu / 60).toFixed(1), people: day.people,
    },
    yield: day.good + day.bad > 0 ? +((day.good / (day.good + day.bad)) * 100).toFixed(1) : 100,
    orders: { running: ord.running || 0, paused: ord.paused || 0, waiting: ord.waiting || 0, done: ord.done || 0, overdue: ord.overdue || 0 },
    workCenters: { running: wc.running || 0, fault: wc.fault || 0, maintain: wc.maintain || 0, total: wc.total || 0 },
    monthGood: fgm.good, monthStepGood: month.good,
  });
});

route('GET', '/api/stats/trend', [], (req, res, _m, _b, _u, q) => {
  const days = Math.min(90, Math.max(3, num(q.days, 14)));
  const start = get(`SELECT date('now', ?) d`, ['-' + (days - 1) + ' day']).d;
  // 工序级：不良、工时（一人一道工序，按工序口径统计）
  const rows = all(`SELECT report_date d, SUM(qty_bad) bad, SUM(work_min) minu
    FROM reports WHERE report_date >= ? GROUP BY report_date`, [start]);
  const byDay = {};
  for (const r of rows) byDay[r.d] = r;
  // 全流程：每日新增完工数 = 当日完工量 - 前一日完工量
  const idx = flowIndex();
  const maps = [finishedByOrder(idx, shiftDay(start, -1))];
  for (let i = 0; i < days; i++) maps.push(finishedByOrder(idx, shiftDay(start, i)));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = shiftDay(start, i);
    const now = maps[i + 1], prev = maps[i];
    let good = 0;
    for (const k of Object.keys(now)) good += Math.max(0, now[k] - (prev[k] === undefined ? now[k] : prev[k]));
    const b = byDay[d] || {};
    out.push({ d, good, stepGood: 0, bad: b.bad || 0, minu: b.minu || 0 });
  }
  ok(res, out);
});

route('GET', '/api/stats/bad', [], (req, res, _m, _b, _u, q) => {
  const days = Math.min(90, Math.max(3, num(q.days, 14)));
  ok(res, all(`SELECT bad_reason name, SUM(qty_bad) qty FROM reports
    WHERE report_date >= date('now', ?) AND qty_bad>0 AND bad_reason<>''
    GROUP BY bad_reason ORDER BY qty DESC`, ['-' + (days - 1) + ' day']));
});

route('GET', '/api/stats/ranking', [], (req, res, _m, _b, _u, q) => {
  const days = Math.min(90, Math.max(3, num(q.days, 7)));
  ok(res, all(`SELECT u.id, u.name, u.team, SUM(r.qty_good) good, SUM(r.qty_bad) bad, SUM(r.work_min) minu,
      COUNT(*) cnt, COUNT(DISTINCT r.report_date) dys
    FROM reports r JOIN users u ON u.id=r.worker_id
    WHERE r.report_date >= date('now', ?)
    GROUP BY u.id ORDER BY good DESC`, ['-' + (days - 1) + ' day']));
});

route('GET', '/api/stats/orders', [], (req, res) => {
  ok(res, all(`SELECT o.code, o.status, o.plan_end, p.name product_name, o.qty_plan,
      (SELECT COALESCE(MIN(qty_good),0) FROM order_steps s WHERE s.order_id=o.id) qty_done
    FROM orders o JOIN products p ON p.id=o.product_id
    WHERE o.status NOT IN ('closed') ORDER BY o.priority, o.plan_end LIMIT 200`));
});

/* ------------------------------ 扫码报工：二维码 + 免登录接口 ------------------------------ */
// 生成工单报工二维码（管理员/班组长）
route('GET', '/api/qr/order/(\\d+)', ['admin', 'leader'], (req, res, m, _b, u) => {
  const o = get('SELECT o.id,o.code,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  const token = qrToken('order', o.id);
  const url = baseUrl(req) + '/m/index.html?o=' + o.id + '&t=' + token;
  ok(res, { order: { id: o.id, code: o.code, product_name: o.product_name }, token, url, svg: makeQr(url) });
});

// 生成员工报工二维码（管理员/班组长）
route('GET', '/api/qr/worker/(\\d+)', ['admin', 'leader'], (req, res, m, _b, u) => {
  const w = get('SELECT id,name,team FROM users WHERE id=?', [m[1]]);
  if (!w) return fail(res, '员工不存在', 404);
  const token = qrToken('worker', w.id);
  const url = baseUrl(req) + '/m/index.html?w=' + w.id + '&t=' + token;
  ok(res, { worker: w, token, url, svg: makeQr(url) });
});

// 免登录：按工单令牌读取工单与工序（员工码可凭 wid 访问其被指派班组的工单）
route('GET', '/api/public/order/(\\d+)', [], (req, res, m, _b, _u, q) => {
  const orderOk = checkQrToken(q.t, 'order', m[1]);
  const wAssigned = q.wid && checkQrToken(q.t, 'worker', q.wid);
  // 存在未指派班组的工序 → 该工单对全员开放报工；否则仅被指派班组的员工可看
  const wTeam = q.wid ? (get('SELECT team FROM users WHERE id=?', [num(q.wid)]) || {}).team : null;
  const orderOpen = !!get('SELECT 1 FROM order_steps WHERE order_id=? AND assignee_team IS NULL', [m[1]]);
  const workerHere = wTeam && !!get('SELECT 1 FROM order_steps WHERE order_id=? AND assignee_team=?', [m[1], wTeam]);
  if (!orderOk && !wAssigned) return fail(res, '二维码已失效或无权限', 403);
  if (!orderOk && wAssigned && !workerHere && !orderOpen) return fail(res, '您暂无该工单的报工权限', 403);
  const o = get(`SELECT o.id,o.code,o.status,o.qty_plan,
      (SELECT COALESCE(MIN(qty_good),0) FROM order_steps WHERE order_id=o.id) qty_done,
      (SELECT COALESCE(SUM(qty_bad),0) FROM order_steps WHERE order_id=o.id) qty_bad,
      p.name product_name,p.spec
    FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`, [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  const steps = all('SELECT s.id,s.seq,s.qty_plan,s.qty_good,s.qty_bad,s.status,s.assignee_team,s.allow_report,pr.name process_name,pr.code process_code FROM order_steps s JOIN processes pr ON pr.id=s.process_id WHERE s.order_id=? ORDER BY s.seq', [m[1]]);
  const workers = all("SELECT id,name,team FROM users WHERE role IN ('worker','leader') AND active=1 ORDER BY team,name");
  ok(res, { order: o, steps, workers });
});

// 免登录：按员工令牌读取该员工在制工单
route('GET', '/api/public/worker/(\\d+)', [], (req, res, m, _b, _u, q) => {
  if (!checkQrToken(q.t, 'worker', m[1])) return fail(res, '二维码已失效或无权限', 403);
  const w = get('SELECT id,name,team FROM users WHERE id=?', [m[1]]);
  if (!w) return fail(res, '员工不存在', 404);
  const orders = all(`SELECT o.id,o.code,o.status,o.qty_plan,
      (SELECT COALESCE(MIN(qty_good),0) FROM order_steps WHERE order_id=o.id) qty_done,
      (SELECT COALESCE(SUM(qty_bad),0) FROM order_steps WHERE order_id=o.id) qty_bad,
      p.name product_name
     FROM orders o JOIN products p ON p.id=o.product_id
     WHERE o.status IN ('released','running','paused')
       AND (o.id IN (SELECT DISTINCT s.order_id FROM order_steps s WHERE s.assignee_team=?)
            OR o.id IN (SELECT DISTINCT s.order_id FROM order_steps s WHERE s.assignee_team IS NULL))
     ORDER BY o.priority,o.plan_end`, [w.team]);
  ok(res, { worker: w, orders });
});

route('GET', '/api/logs', [], (req, res, _m, _b, _u, q) => {
  const limit = Math.min(500, num(q.limit, 100));
  ok(res, all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', [limit]));
});

/* ------------------------------ 库存台账 / 收发明细（核心） ------------------------------
 * 规则：
 *  1) 单据（来料入库、成品入库…）保存时，在同一事务内写一条收发明细流水并更新库存台账；
 *  2) 单据修改/删除前先冲销原流水、再重算库存，保证账实一致；
 *  3) 出库导致库存为负时直接报错并回滚（库存不足不允许出库）；
 *  4) 检验结论为「不合格(rejected)」的单据不计入库存（退货/待处理）。 */
function resolveMaterialId(b) {
  if (b.material_id) return num(b.material_id) || null;
  const code = String(b.material_code || b.product_code || '').trim();
  if (code) {
    const m = get('SELECT id FROM materials WHERE code=?', [code]);
    if (m) return m.id;
  }
  return null;
}
function invEnsure(materialId, warehouseId, batch, location) {
  const wid = num(warehouseId) || 0;
  const bt = String(batch || '').trim();
  let r = get('SELECT * FROM inventory WHERE material_id=? AND IFNULL(warehouse_id,0)=? AND IFNULL(batch,\'\')=?', [materialId, wid, bt]);
  if (r) return r;
  const id = insert('INSERT INTO inventory(material_id,warehouse_id,batch,location,qty,updated_at) VALUES(?,?,?,?,0,?)',
    [materialId, wid || null, bt || null, location || null, now()]);
  return get('SELECT * FROM inventory WHERE id=?', [id]);
}
function applyStock(o) {
  const materialId = num(o.material_id);
  const qty = num(o.qty);
  if (!materialId || !qty) return null;
  const m = get('SELECT name,unit,warehouse_id FROM materials WHERE id=?', [materialId]);
  if (!m) return null;
  // 单据未指定仓库时，回退到物料档案的默认仓库，避免产生「无仓库」的平行台账行
  const wh = num(o.warehouse_id) || num(m.warehouse_id) || null;
  const row = invEnsure(materialId, wh, o.batch, o.location);
  const before = num(row.qty);
  const after = before + qty;
  if (after < -1e-9) throw new Error('库存不足：' + m.name + '，当前库存 ' + before + '，本次出库 ' + Math.abs(qty));
  run('UPDATE inventory SET qty=?, location=IFNULL(?,location), updated_at=? WHERE id=?', [after, o.location || null, now(), row.id]);
  insert(`INSERT INTO inventory_tx(material_id,warehouse_id,batch,tx_type,qty,before_qty,after_qty,ref_type,ref_id,ref_code,order_id,operator,tx_date,remark,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [materialId, wh, String(o.batch || '').trim() || null, o.tx_type, qty, before, after,
      o.ref_type || null, o.ref_id || null, o.ref_code || null, o.order_id ? num(o.order_id) : null,
      o.operator || null, o.tx_date || today(), o.remark || null, now()]);
  return { before, after };
}
function revertStock(refType, refId, operator) {
  for (const t of all('SELECT * FROM inventory_tx WHERE ref_type=? AND ref_id=?', [refType, refId])) {
    applyStock({
      material_id: t.material_id, warehouse_id: t.warehouse_id, batch: t.batch, qty: -num(t.qty),
      tx_type: t.tx_type, order_id: t.order_id, operator: operator || t.operator, tx_date: today(),
      ref_code: (t.ref_code || '') + '(冲销)', remark: '单据' + (operator ? '修改' : '删除') + '冲销',
    });
  }
  run('DELETE FROM inventory_tx WHERE ref_type=? AND ref_id=?', [refType, refId]);
}

/* ------------------------------ 来料记录 / 成品入库 ------------------------------
 * 对标市面小工单系统的「来料检验(IQC)」与「成品入库」模块。
 * 来料记录：供应商来料登记 + 检验结论；成品入库：完工成品按工单入库（含产品快照）。
 * 单号留空时由服务端自动生成（LM/RK + 日期 + 序号）。
 * 关联了物料档案的单据会自动增减库存并生成收发明细。 */
const INCOMING_FIELDS = ['code', 'incoming_date', 'supplier', 'material_id', 'warehouse_id', 'material_code', 'material_name', 'material_spec', 'qty', 'unit', 'batch', 'order_id', 'inspector', 'result', 'remark'];
const FINISHED_FIELDS = ['code', 'in_date', 'order_id', 'material_id', 'warehouse_id', 'product_code', 'product_name', 'spec', 'qty', 'unit', 'batch', 'location', 'inspector', 'result', 'remark'];

// 来料记录
route('GET', '/api/incoming_materials', [], (req, res) => {
  ok(res, all(`SELECT i.*, o.code order_code, m.code m_code, m.name m_name, w.name warehouse_name
    FROM incoming_materials i LEFT JOIN orders o ON o.id=i.order_id
    LEFT JOIN materials m ON m.id=i.material_id LEFT JOIN warehouses w ON w.id=i.warehouse_id
    ORDER BY i.id DESC`));
});
route('POST', '/api/incoming_materials', ['admin', 'leader'], (req, res, _m, b, u) => {
  const code = (b.code && b.code.trim()) ? b.code.trim() : genCode('LM');
  if (get('SELECT id FROM incoming_materials WHERE code=?', [code])) return fail(res, '该来料单号已存在');
  const mid = resolveMaterialId(b);
  let id;
  tx(() => {
    id = insert(`INSERT INTO incoming_materials(code,incoming_date,supplier,material_id,warehouse_id,material_code,material_name,material_spec,qty,unit,batch,order_id,inspector,result,remark,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, b.incoming_date || today(), b.supplier || null, mid, b.warehouse_id ? num(b.warehouse_id) : null,
        b.material_code || null, b.material_name, b.material_spec || null,
        num(b.qty), b.unit || '件', b.batch || null, b.order_id ? num(b.order_id) : null, b.inspector || null, b.result || 'qualified', b.remark || null, u.id, now()]);
    if (mid && b.result !== 'rejected') {
      applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: num(b.qty), tx_type: 'in_incoming',
        ref_type: 'incoming_materials', ref_id: id, ref_code: code, order_id: b.order_id, operator: u.name, tx_date: b.incoming_date || today(), remark: '来料入库 ' + code });
    }
  });
  writeLog(u, '新增来料记录', code + ' ' + (b.material_name || ''));
  ok(res, { id, code });
});
route('PUT', '/api/incoming_materials/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
  const mid = resolveMaterialId(b);
  tx(() => {
    revertStock('incoming_materials', Number(m[1]), u.name);
    run(`UPDATE incoming_materials SET code=?,incoming_date=?,supplier=?,material_id=?,warehouse_id=?,material_code=?,material_name=?,material_spec=?,qty=?,unit=?,batch=?,order_id=?,inspector=?,result=?,remark=? WHERE id=?`,
      [b.code || '', b.incoming_date || today(), b.supplier || null, mid, b.warehouse_id ? num(b.warehouse_id) : null,
        b.material_code || null, b.material_name, b.material_spec || null,
        num(b.qty), b.unit || '件', b.batch || null, b.order_id ? num(b.order_id) : null, b.inspector || null, b.result || 'qualified', b.remark || null, m[1]]);
    if (mid && b.result !== 'rejected') {
      applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: num(b.qty), tx_type: 'in_incoming',
        ref_type: 'incoming_materials', ref_id: Number(m[1]), ref_code: b.code || '', order_id: b.order_id, operator: u.name, tx_date: b.incoming_date || today(), remark: '来料入库 ' + (b.code || '') });
    }
  });
  writeLog(u, '修改来料记录', '#' + m[1]);
  ok(res, true);
});
route('DELETE', '/api/incoming_materials/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  tx(() => {
    revertStock('incoming_materials', Number(m[1]), u.name);
    run('DELETE FROM incoming_materials WHERE id=?', [m[1]]);
  });
  writeLog(u, '删除来料记录', '#' + m[1]);
  ok(res, true);
});

// 成品入库
route('GET', '/api/finished_goods_in', [], (req, res) => {
  ok(res, all(`SELECT f.*, o.code order_code, m.code m_code, m.name m_name, w.name warehouse_name
    FROM finished_goods_in f LEFT JOIN orders o ON o.id=f.order_id
    LEFT JOIN materials m ON m.id=f.material_id LEFT JOIN warehouses w ON w.id=f.warehouse_id
    ORDER BY f.id DESC`));
});
route('POST', '/api/finished_goods_in', ['admin', 'leader'], (req, res, _m, b, u) => {
  const code = (b.code && b.code.trim()) ? b.code.trim() : genCode('RK');
  if (get('SELECT id FROM finished_goods_in WHERE code=?', [code])) return fail(res, '该入库单号已存在');
  const mid = resolveMaterialId(b);
  let id;
  tx(() => {
    id = insert(`INSERT INTO finished_goods_in(code,in_date,order_id,material_id,warehouse_id,product_code,product_name,spec,qty,unit,batch,location,inspector,result,remark,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, b.in_date || today(), b.order_id ? num(b.order_id) : null, mid, b.warehouse_id ? num(b.warehouse_id) : null,
        b.product_code || null, b.product_name, b.spec || null,
        num(b.qty), b.unit || '件', b.batch || null, b.location || null, b.inspector || null, b.result || 'qualified', b.remark || null, u.id, now()]);
    if (mid && b.result !== 'rejected') {
      applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, location: b.location, qty: num(b.qty), tx_type: 'in_finish',
        ref_type: 'finished_goods_in', ref_id: id, ref_code: code, order_id: b.order_id, operator: u.name, tx_date: b.in_date || today(), remark: '成品入库 ' + code });
    }
  });
  writeLog(u, '新增成品入库', code + ' ' + (b.product_name || ''));
  ok(res, { id, code });
});
route('PUT', '/api/finished_goods_in/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
  const mid = resolveMaterialId(b);
  tx(() => {
    revertStock('finished_goods_in', Number(m[1]), u.name);
    run(`UPDATE finished_goods_in SET code=?,in_date=?,order_id=?,material_id=?,warehouse_id=?,product_code=?,product_name=?,spec=?,qty=?,unit=?,batch=?,location=?,inspector=?,result=?,remark=? WHERE id=?`,
      [b.code || '', b.in_date || today(), b.order_id ? num(b.order_id) : null, mid, b.warehouse_id ? num(b.warehouse_id) : null,
        b.product_code || null, b.product_name, b.spec || null,
        num(b.qty), b.unit || '件', b.batch || null, b.location || null, b.inspector || null, b.result || 'qualified', b.remark || null, m[1]]);
    if (mid && b.result !== 'rejected') {
      applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, location: b.location, qty: num(b.qty), tx_type: 'in_finish',
        ref_type: 'finished_goods_in', ref_id: Number(m[1]), ref_code: b.code || '', order_id: b.order_id, operator: u.name, tx_date: b.in_date || today(), remark: '成品入库 ' + (b.code || '') });
    }
  });
  writeLog(u, '修改成品入库', '#' + m[1]);
  ok(res, true);
});
route('DELETE', '/api/finished_goods_in/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  tx(() => {
    revertStock('finished_goods_in', Number(m[1]), u.name);
    run('DELETE FROM finished_goods_in WHERE id=?', [m[1]]);
  });
  writeLog(u, '删除成品入库', '#' + m[1]);
  ok(res, true);
});

/* ------------------------------ 物料档案 ------------------------------ */
route('GET', '/api/materials', [], (req, res) => {
  ok(res, all(`SELECT m.*, w.name warehouse_name FROM materials m LEFT JOIN warehouses w ON w.id=m.warehouse_id ORDER BY m.code`));
});
route('POST', '/api/materials', ['admin', 'leader'], (req, res, _m, b, u) => {
  const code = String(b.code || '').trim();
  if (!code) return fail(res, '物料编码不能为空');
  if (!b.name || !String(b.name).trim()) return fail(res, '物料名称不能为空');
  if (get('SELECT id FROM materials WHERE code=?', [code])) return fail(res, '该物料编码已存在');
  const id = insert(`INSERT INTO materials(code,name,spec,material,category,unit,warehouse_id,location,safe_min,safe_max,active,remark,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [code, String(b.name).trim(), b.spec || null, b.material || null, b.category || '原料', b.unit || '件',
      b.warehouse_id ? num(b.warehouse_id) : null, b.location || null, num(b.safe_min), b.safe_max === '' || b.safe_max == null ? null : num(b.safe_max),
      b.active === 0 || b.active === false ? 0 : 1, b.remark || null, now()]);
  writeLog(u, '新增物料', code + ' ' + b.name);
  ok(res, { id });
});
route('PUT', '/api/materials/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
  const code = String(b.code || '').trim();
  if (!code) return fail(res, '物料编码不能为空');
  const dup = get('SELECT id FROM materials WHERE code=? AND id<>?', [code, m[1]]);
  if (dup) return fail(res, '该物料编码已存在');
  run(`UPDATE materials SET code=?,name=?,spec=?,material=?,category=?,unit=?,warehouse_id=?,location=?,safe_min=?,safe_max=?,active=?,remark=? WHERE id=?`,
    [code, String(b.name || '').trim() || code, b.spec || null, b.material || null, b.category || '原料', b.unit || '件',
      b.warehouse_id ? num(b.warehouse_id) : null, b.location || null, num(b.safe_min), b.safe_max === '' || b.safe_max == null ? null : num(b.safe_max),
      b.active === 0 || b.active === false ? 0 : 1, b.remark || null, m[1]]);
  writeLog(u, '修改物料', code);
  ok(res, true);
});
route('DELETE', '/api/materials/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  if (get('SELECT id FROM inventory_tx WHERE material_id=? LIMIT 1', [m[1]])) return fail(res, '该物料已有库存流水，不能删除（可停用）');
  run('DELETE FROM materials WHERE id=?', [m[1]]);
  writeLog(u, '删除物料', '#' + m[1]);
  ok(res, true);
});

// 一键从产品档案导入成品类物料（已有相同编码的跳过）
route('POST', '/api/materials/import_products', ['admin', 'leader'], (req, res, _m, _b, u) => {
  let n = 0;
  for (const p of all('SELECT code,name,spec,unit FROM products')) {
    if (!p.code) continue;
    if (get('SELECT id FROM materials WHERE code=?', [p.code])) continue;
    insert(`INSERT INTO materials(code,name,spec,material,category,unit,warehouse_id,location,safe_min,safe_max,active,remark,created_at)
      VALUES(?,?,?,NULL,'成品',?,NULL,NULL,0,NULL,1,'从产品档案导入',?)`,
      [p.code, p.name, p.spec || null, p.unit || '件', now()]);
    n++;
  }
  writeLog(u, '从产品导入物料', '新增 ' + n + ' 条');
  ok(res, { imported: n });
});

/* ------------------------------ 仓库 ------------------------------ */
route('GET', '/api/warehouses', [], (req, res) => {
  ok(res, all('SELECT * FROM warehouses ORDER BY code'));
});
route('POST', '/api/warehouses', ['admin', 'leader'], (req, res, _m, b, u) => {
  const code = String(b.code || '').trim();
  if (!code) return fail(res, '仓库编号不能为空');
  if (get('SELECT id FROM warehouses WHERE code=?', [code])) return fail(res, '该仓库编号已存在');
  const id = insert('INSERT INTO warehouses(code,name,remark,created_at) VALUES(?,?,?,?)',
    [code, String(b.name || '').trim() || code, b.remark || null, now()]);
  writeLog(u, '新增仓库', code);
  ok(res, { id });
});
route('PUT', '/api/warehouses/(\\d+)', ['admin', 'leader'], (req, res, m, b, u) => {
  const code = String(b.code || '').trim();
  if (get('SELECT id FROM warehouses WHERE code=? AND id<>?', [code, m[1]])) return fail(res, '该仓库编号已存在');
  run('UPDATE warehouses SET code=?,name=?,remark=? WHERE id=?', [code, String(b.name || '').trim() || code, b.remark || null, m[1]]);
  writeLog(u, '修改仓库', code);
  ok(res, true);
});
route('DELETE', '/api/warehouses/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  if (get('SELECT id FROM inventory WHERE warehouse_id=? LIMIT 1', [m[1]])) return fail(res, '该仓库已有库存记录，不能删除');
  run('DELETE FROM warehouses WHERE id=?', [m[1]]);
  writeLog(u, '删除仓库', '#' + m[1]);
  ok(res, true);
});

/* ------------------------------ 库存台账 / 收发明细查询 ------------------------------
 * 台账数量只读，由收发明细流水汇总而来；前端据此做安全库存预警（低于下限=缺料，高于上限=积压）。 */
route('GET', '/api/inventory', [], (req, res) => {
  ok(res, all(`SELECT i.id,i.material_id,i.warehouse_id,i.batch,i.location,i.qty,i.updated_at,
      m.code material_code, m.name material_name, m.spec, m.unit, m.category, m.safe_min, m.safe_max,
      w.name warehouse_name
    FROM inventory i JOIN materials m ON m.id=i.material_id LEFT JOIN warehouses w ON w.id=i.warehouse_id
    ORDER BY m.code, i.batch`));
});
route('GET', '/api/inventory_tx', [], (req, res, _m, _b, _u, q) => {
  const limit = Math.min(1000, num(q.limit, 500));
  const where = [];
  const ps = [];
  if (q.material_id) { where.push('t.material_id=?'); ps.push(num(q.material_id)); }
  if (q.tx_type) { where.push('t.tx_type=?'); ps.push(q.tx_type); }
  if (q.order_id) { where.push('t.order_id=?'); ps.push(num(q.order_id)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  ok(res, all(`SELECT t.*, m.code material_code, m.name material_name, m.unit, w.name warehouse_name, o.code order_code
    FROM inventory_tx t JOIN materials m ON m.id=t.material_id
    LEFT JOIN warehouses w ON w.id=t.warehouse_id LEFT JOIN orders o ON o.id=t.order_id
    ${w} ORDER BY t.id DESC LIMIT ?`, [...ps, limit]));
});

/* ------------------------------ 请求分发 ------------------------------ */
const server = http.createServer(async (req, res) => {
  let url;
  try {
    // 合并多余的斜杠，避免 "//" 之类畸形路径导致解析失败并让进程退出
    req.url = req.url.replace(/^\/+/, '/');
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    try {
      const method = req.method;
      let body = {};
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') body = await readBody(req);
      const query = Object.fromEntries(url.searchParams.entries());
      const match = routes.find((r) => r[0] === method && r[1].test(pathname));
      if (!match) return fail(res, '接口不存在：' + method + ' ' + pathname, 404);
      const [, pattern, roles, fn] = match;
      const m = pathname.match(pattern);
      if (roles.length) {
        const u = currentUser(req);
        if (!u) return fail(res, '未登录或登录已过期', 401);
        if (!roles.includes(u.role)) return fail(res, '当前角色无权执行该操作', 403);
        return fn(req, res, m, body, u, query);
      }
      return fn(req, res, m, body, currentUser(req), query);
    } catch (e) {
      return fail(res, e.message || '服务器内部错误', 500);
    }
  }

  // 移动端扫码报工页（免登录 H5）
  if (pathname === '/m' || pathname === '/m/') {
    const mfile = path.join(PUBLIC_DIR, 'm', 'index.html');
    if (fs.existsSync(mfile)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(mfile).pipe(res);
    }
  }

  // 静态文件
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

// 兜底：任何未预料到的异常都只记录日志，不让服务进程退出
process.on('uncaughtException', (e) => console.error('[未捕获异常]', e.message));
process.on('unhandledRejection', (e) => console.error('[未处理 Promise 拒绝]', e && e.message));

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  生产管理系统已启动');
  console.log('  ------------------------------------------');
  console.log('  本机访问:  http://localhost:' + PORT);
  console.log('  演示账号:  admin / 123456   (管理员)');
  console.log('            leader1 / 123456 (班组长)');
  console.log('            worker1 / 123456 (操作工)');
  console.log('  数据文件:  ' + path.join(__dirname, 'data', 'mes.db'));
  console.log('  ------------------------------------------');
  console.log('');
});

module.exports = server;
