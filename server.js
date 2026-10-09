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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

seed();

/* 列类型缓存：把空串按数值列转成 0，避免 NOT NULL 约束失败（新增/编辑时用户留空数字） */
const colTypes = {};
const colDflt = {};
for (const t of ['products', 'processes', 'work_centers', 'customers', 'bad_reasons', 'routes', 'users', 'orders', 'order_steps', 'reports', 'logs', 'sessions', 'incoming_materials', 'finished_goods_in', 'materials', 'warehouses', 'inventory', 'inventory_tx', 'order_bad_reasons', 'equipments', 'equipment_checks']) {
  try {
    colTypes[t] = {};
    for (const row of all(`PRAGMA table_info(${t})`)) colTypes[t][row.name] = (row.type || '').toUpperCase();
  } catch (e) { colTypes[t] = {}; }
  try {
    colDflt[t] = {};
    for (const row of all(`PRAGMA table_info(${t})`)) colDflt[t][row.name] = row.dflt_value;
  } catch (e) { colDflt[t] = {}; }
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
route('POST', '/api/login', ['*'], (req, res, _m, body) => {
  const u = get('SELECT * FROM users WHERE username=? AND active=1', [String(body.username || '').trim()]);
  if (!u || u.password !== hashPassword(String(body.password || ''))) return fail(res, '账号或密码错误', 401);
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions(token,user_id,created_at,expire_at) VALUES(?,?,?,?)', [
    token, u.id, now(), new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 19).replace('T', ' '),
  ]);
  writeLog(u, '用户登录', u.name + ' 登录系统');
  ok(res, { token, user: { id: u.id, username: u.username, name: u.name, role: u.role, team: u.team } });
});

route('POST', '/api/logout', ['*'], (req, res, _m, _b, u) => {
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

/* ---- 账号：改密码 / 重置密码（APP 员工自助）---- */
// 本人修改密码：需校验原密码；改成功后吊销本人**其他**会话（当前设备保持登录）
route('POST', '/api/password', [], (req, res, _m, b, u) => {
  if (!u) return fail(res, '未登录', 401);
  const oldPwd = String(b.old_password || '');
  const newPwd = String(b.new_password || '');
  if (!oldPwd || !newPwd) return fail(res, '原密码与新密码不能为空');
  if (newPwd.length < 6) return fail(res, '新密码至少 6 位');
  if (newPwd === oldPwd) return fail(res, '新密码不能与原密码相同');
  const row = get('SELECT * FROM users WHERE id=?', [u.id]);
  if (!row || row.password !== hashPassword(oldPwd)) return fail(res, '原密码不正确', 400);
  run('UPDATE users SET password=? WHERE id=?', [hashPassword(newPwd), u.id]);
  const auth = req.headers.authorization || '';
  const cur = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', [u.id, cur]);
  writeLog(u, '修改密码', u.name + ' 修改了自己的登录密码');
  ok(res, true);
});

// 管理员重置他人密码（无需原密码，用于员工忘记密码）
route('POST', '/api/users/(\\d+)/reset_password', ['admin'], (req, res, m, b, u) => {
  const target = get('SELECT * FROM users WHERE id=?', [m[1]]);
  if (!target) return fail(res, '用户不存在', 404);
  const newPwd = String(b.new_password || '');
  if (newPwd.length < 6) return fail(res, '新密码至少 6 位');
  run('UPDATE users SET password=? WHERE id=?', [hashPassword(newPwd), target.id]);
  run('DELETE FROM sessions WHERE user_id=?', [target.id]);
  writeLog(u, '重置密码', u.name + ' 重置了「' + target.name + '」的登录密码');
  ok(res, true);
});

// 修改自己的显示名（APP「我的」页可改昵称）
route('POST', '/api/profile', [], (req, res, _m, b, u) => {
  if (!u) return fail(res, '未登录', 401);
  const name = String(b.name || '').trim();
  if (!name) return fail(res, '姓名不能为空');
  run('UPDATE users SET name=? WHERE id=?', [name, u.id]);
  writeLog(u, '修改资料', '姓名改为 ' + name);
  ok(res, get('SELECT id,username,name,role,team,work_center_id FROM users WHERE id=?', [u.id]));
});

/* ------------------------------ 元数据 ------------------------------ */
route('GET', '/api/meta', ['*'], (req, res) => {
  ok(res, {
    products: all('SELECT * FROM products ORDER BY code'),
    processes: all('SELECT * FROM processes ORDER BY code'),
    workCenters: all('SELECT * FROM work_centers ORDER BY code'),
    customers: all('SELECT id,code,name FROM customers ORDER BY code'),
    // 供应商快照：历史来料单出现过的供应商（免建档案，下拉建议用）+ 客户档案名称合并去重
    suppliers: [...new Set([
      ...all("SELECT DISTINCT supplier FROM incoming_materials WHERE supplier IS NOT NULL AND supplier<>'' ORDER BY supplier").map((r) => r.supplier),
      ...all('SELECT name FROM customers ORDER BY name').map((r) => r.name),
    ])],
    badReasons: all('SELECT * FROM bad_reasons ORDER BY id'),
    workers: all("SELECT id,name,team,work_center_id FROM users WHERE role='worker' AND active=1 ORDER BY name"),
    inspectors: all("SELECT id,name,team,username FROM users WHERE role='inspector' AND active=1 ORDER BY name"),
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
  route('POST', '/api/' + table, ['admin', 'technician'], (req, res, _m, b, u) => {
    if (opts.unique) {
      const ex = get(`SELECT id FROM ${table} WHERE ${opts.unique}=?`, [b[opts.unique]]);
      if (ex) return fail(res, '该编码已存在');
    }
    const cv = (f) => {
      const raw = b[f];
      if (raw === undefined) {
        // 未提交字段：优先取列 DEFAULT（如 equipments.status 'idle'），避免 NOT NULL 报错
        const dv = colDflt[table] && colDflt[table][f];
        if (dv != null) {
          const s = String(dv);
          if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1);
          if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
          if (/^CURRENT/i.test(s)) return now();
          return s;
        }
        return f === 'created_at' ? now() : null;
      }
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
  route('PUT', '/api/' + table + '/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
    // 只更新请求中出现的字段（未提交的字段保持原值），避免部分提交把其余列清空
    const sets = (opts.editFields || opts.fields.filter((f) => f !== 'created_at')).filter((f) => b[f] !== undefined);
    if (!sets.length) return ok(res, true);
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
  fields: ['code', 'name', 'std_time', 'std_price', 'remark', 'inspect_type'],
  editFields: ['code', 'name', 'std_time', 'std_price', 'remark', 'inspect_type'],
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
crud('equipments', '设备', {
  fields: ['code', 'name', 'model', 'location', 'status', 'check_cycle', 'remark', 'created_at'],
  editFields: ['code', 'name', 'model', 'location', 'status', 'check_cycle', 'remark'],
  unique: 'code', order: 'code',
});

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
route('POST', '/api/routes', ['admin', 'technician'], (req, res, _m, b, u) => {
  const rid = insert('INSERT INTO routes(code,name,product_id,created_at) VALUES(?,?,?,?)', [b.code, b.name, b.product_id, now()]);
  (b.steps || []).forEach((s) => {
    // 检验点：优先用路线步骤显式指定，缺省则继承工序档案的 inspect_type
    const proc = s.process_id ? get('SELECT inspect_type FROM processes WHERE id=?', [num(s.process_id)]) : null;
    const insType = s.inspect_type !== undefined ? String(s.inspect_type || '') : String((proc && proc.inspect_type) || '');
    run('INSERT INTO route_steps(route_id,seq,process_id,work_center_id,std_time,std_price,need_report,inspect_type) VALUES(?,?,?,?,?,?,?,?)',
      [rid, s.seq, s.process_id, s.work_center_id || null, num(s.std_time), num(s.std_price), 1, insType]);
  });
  writeLog(u, '新增工艺路线', b.code + ' ' + b.name);
  ok(res, { id: rid });
});
route('PUT', '/api/routes/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  run('UPDATE routes SET code=?,name=?,product_id=? WHERE id=?', [b.code, b.name, b.product_id, m[1]]);
  run('DELETE FROM route_steps WHERE route_id=?', [m[1]]);
  (b.steps || []).forEach((s) => {
    const proc = s.process_id ? get('SELECT inspect_type FROM processes WHERE id=?', [num(s.process_id)]) : null;
    const insType = s.inspect_type !== undefined ? String(s.inspect_type || '') : String((proc && proc.inspect_type) || '');
    run('INSERT INTO route_steps(route_id,seq,process_id,work_center_id,std_time,std_price,need_report,inspect_type) VALUES(?,?,?,?,?,?,?,?)',
      [m[1], s.seq, s.process_id, s.work_center_id || null, num(s.std_time), num(s.std_price), 1, insType]);
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
    (SELECT COALESCE(qty_good,0) FROM order_steps s WHERE s.order_id=o.id ORDER BY s.seq DESC LIMIT 1) qty_done,
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
  o.steps = all(`SELECT s.*, pr.code process_code, pr.name process_name,
      COALESCE(NULLIF(s.std_price,0), pr.std_price, 0) std_price, pr.std_price proc_std_price, w.name wc_name, s.assignee_team,
      (SELECT COUNT(*) FROM order_steps x WHERE x.order_id=s.order_id AND x.seq<s.seq)+1 AS seq_no
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
  o.reports = all(`SELECT rp.*, u.name worker_name, pr.name process_name,
      COALESCE(rp.unit_price, NULLIF(s.std_price,0), pr.std_price, 0) unit_price,
      CASE WHEN rp.wage_type='time' THEN ROUND(COALESCE(rp.work_hours,0) * COALESCE(rp.unit_price, 0), 2)
           ELSE ROUND(rp.qty_good * COALESCE(rp.unit_price, NULLIF(s.std_price,0), pr.std_price, 0), 2) END amount
    FROM reports rp LEFT JOIN users u ON u.id=rp.worker_id LEFT JOIN order_steps s ON s.id=rp.order_step_id
    LEFT JOIN processes pr ON pr.id=s.process_id
    WHERE rp.order_id=? ORDER BY rp.id DESC LIMIT 100`, [m[1]]);
  // 附带不良明细，便于前端展示多种不良
  const rids = o.reports.map((r) => r.id);
  if (rids.length) {
    const rbr = all(`SELECT * FROM report_bad_reasons WHERE report_id IN (${rids.join(',')})`);
    for (const r of o.reports) {
      r.bad_reasons = rbr.filter((x) => x.report_id === r.id)
        .map((x) => ({ bad_reason: x.bad_reason, bad_reason_id: x.bad_reason_id, bad_reason_detail: x.bad_reason_detail, qty: x.qty }));
    }
  }
  const sel = all('SELECT bad_reason_id FROM order_bad_reasons WHERE order_id=?', [m[1]]).map((r) => r.bad_reason_id);
  const allR = all('SELECT id,name FROM bad_reasons ORDER BY id');
  o.badReasons = (sel.length ? allR.filter((r) => sel.includes(r.id)) : allR).map((r) => ({ id: r.id, name: r.name }));
  ok(res, o);
});

route('GET', '/api/orders/(\\d+)/bad-reasons', [], (req, res, m) => {
  const oid = num(m[1]);
  const reasons = all('SELECT id,name FROM bad_reasons ORDER BY id');
  const sel = all('SELECT bad_reason_id FROM order_bad_reasons WHERE order_id=?', [oid]).map((r) => r.bad_reason_id);
  const configured = sel.length > 0;
  const selected = configured ? reasons.filter((r) => sel.includes(r.id)) : reasons;
  ok(res, { configured, reasons, selected });
});

route('PUT', '/api/orders/(\\d+)/bad-reasons', ['admin', 'technician'], (req, res, m, b, u) => {
  const oid = num(m[1]);
  if (!get('SELECT id FROM orders WHERE id=?', [oid])) return fail(res, '工单不存在', 404);
  const ids = Array.isArray(b.ids) ? b.ids.map((x) => num(x)).filter((x) => x > 0) : [];
  const valid = new Set(all('SELECT id FROM bad_reasons').map((r) => r.id));
  const clean = [...new Set(ids)].filter((x) => valid.has(x));
  tx(() => {
    run('DELETE FROM order_bad_reasons WHERE order_id=?', [oid]);
    for (const id of clean) insert('INSERT INTO order_bad_reasons(order_id,bad_reason_id) VALUES(?,?)', [oid, id]);
  });
  writeLog(u || null, '配置不良原因', '工单#' + oid + ' 可用不良原因 ' + clean.length + ' 项');
  ok(res, { count: clean.length });
});

/* 工单智能建议（减少建单人工操作）：按产品带出默认工艺路线 / 历史常用客户 / 最近负责人与优先级 /
 * 历史平均工期推算计划完工日；无历史则回退产品默认路线。 */
route('GET', '/api/orders/suggest', [], (req, res, _m, _b, _u, q) => {
  const pid = num(q.product_id);
  if (!pid) return ok(res, { route_id: null, customer_id: null, owner_user_id: null, priority: 2, duration_days: 0, plan_end: '', from_history: false });
  const last = get(`SELECT o.route_id, o.customer_id, o.owner_user_id, o.priority, o.qty_plan, o.code, o.plan_start, o.plan_end, o.created_at
    FROM orders o WHERE o.product_id=? AND o.route_id IS NOT NULL ORDER BY o.id DESC LIMIT 1`, [pid]);
  const routes = all('SELECT id FROM routes WHERE product_id=? ORDER BY id', [pid]);
  const routeId = (last && last.route_id) || (routes[0] || {}).id || null;
  // 历史平均工期：优先实际开工→完工，其次计划天数
  const dur = get(`SELECT AVG(MAX(1, julianday(COALESCE(finish_time, plan_end)) - julianday(COALESCE(start_time, plan_start)))) d
    FROM orders WHERE product_id=? AND route_id IS NOT NULL AND created_at >= date('now','-180 day')`, [pid]);
  const durationDays = Math.max(1, Math.round(num(dur && dur.d) || (last ? Math.max(1, daysBetween(last.plan_start, last.plan_end)) : 1)));
  const planEnd = new Date(Date.now() + durationDays * 86400000).toISOString().slice(0, 10);
  ok(res, {
    route_id: routeId,
    customer_id: last ? last.customer_id : null,
    owner_user_id: last ? last.owner_user_id : null,
    priority: last ? num(last.priority, 2) : 2,
    qty_hint: last ? num(last.qty_plan) : null,
    duration_days: durationDays,
    plan_end: planEnd,
    from_history: !!last,
    last_code: last ? last.code : '',
  });
});
function daysBetween(a, b) {
  if (!a || !b) return 1;
  const d = Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  return Number.isFinite(d) && d > 0 ? d : 1;
}

/* 工单级计件工价批量设置（免去逐个改工序档案）：prices=[{order_step_id, std_price}]，0=跟随工序档案 */
route('PUT', '/api/orders/(\\d+)/step_prices', ['admin', 'technician'], (req, res, m, b, u) => {
  const o = get('SELECT id,code,wage_type FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  if (o.wage_type === 'time') return fail(res, '计时核算工单不计件工价，无需设置');
  const list = Array.isArray(b.prices) ? b.prices : [];
  if (!list.length) return fail(res, '未提交任何工序价格');
  let n = 0;
  tx(() => {
    for (const p of list) {
      const sid = num(p.order_step_id);
      const step = get('SELECT id FROM order_steps WHERE id=? AND order_id=?', [sid, o.id]);
      if (!step) continue;
      run('UPDATE order_steps SET std_price=? WHERE id=?', [Math.max(0, num(p.std_price)), sid]);
      n++;
    }
    writeLog(u, '批量设置工价', o.code + ' 共 ' + n + ' 道工序');
  });
  ok(res, { updated: n });
});

/* 工单批量操作（对标黑湖「批量开工/撤回/结案/取消/删除」）：逐单校验，返回成功清单与失败明细 */
route('POST', '/api/orders/batch', ['admin', 'technician'], (req, res, _m, b, u) => {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => num(x)).filter((x) => x > 0).slice(0, 200);
  const action = String(b.action || '');
  const LABEL = { release: '批量下发', pause: '批量暂停', resume: '批量恢复', done: '批量完工', close: '批量关闭', cancel: '批量取消', del: '批量删除' };
  if (!ids.length) return fail(res, '请先勾选要操作的工单');
  if (!LABEL[action]) return fail(res, '不支持的批量操作：' + action);
  const to = { release: 'released', pause: 'paused', resume: 'running', done: 'done', close: 'closed', cancel: 'cancelled' }[action];
  const okList = [], failed = [];
  const st = now();
  for (const id of ids) {
    const o = get('SELECT * FROM orders WHERE id=?', [id]);
    if (!o) { failed.push({ id, code: '#' + id, msg: '工单不存在' }); continue; }
    try {
      if (action === 'del') {
        if (o.status === 'closed') { failed.push({ id, code: o.code, msg: '已关闭工单不可删除' }); continue; }
        if (get('SELECT 1 FROM reports WHERE order_id=? LIMIT 1', [id])) { failed.push({ id, code: o.code, msg: '已有报工记录，不可删除' }); continue; }
        run('DELETE FROM orders WHERE id=?', [id]);
        writeLog(u, '批量删除工单', o.code);
        okList.push(o.code);
        continue;
      }
      if (action === 'release' && !get('SELECT 1 FROM order_steps WHERE order_id=? LIMIT 1', [id])) { failed.push({ id, code: o.code, msg: '无工序，无法下发' }); continue; }
      if (action === 'resume' && o.status !== 'paused') { failed.push({ id, code: o.code, msg: '仅暂停中的工单可恢复' }); continue; }
      if (action === 'pause' && ['closed', 'cancelled', 'done'].includes(o.status)) { failed.push({ id, code: o.code, msg: '已完成/关闭工单不可暂停' }); continue; }
      if (action === 'close' && o.status === 'created') { failed.push({ id, code: o.code, msg: '未下发工单请先取消而非关闭' }); continue; }
      if (to === 'running') run('UPDATE orders SET status=?, start_time=IFNULL(start_time,?) WHERE id=?', [to, st, id]);
      else if (to === 'done') run('UPDATE orders SET status=?, finish_time=? WHERE id=?', [to, st, id]);
      else if (to === 'closed') run('UPDATE orders SET status=?, finish_time=IFNULL(finish_time,?), close_reason=? WHERE id=?', [to, st, b.close_reason || '批量关闭', id]);
      else run('UPDATE orders SET status=? WHERE id=?', [to, id]);
      if (to === 'running') run(`UPDATE order_steps SET status='running' WHERE id=(SELECT MIN(id) FROM order_steps WHERE order_id=? AND status='pending')`, [id]);
      if (to === 'released') { try { notifyAssign(o, id); } catch (e) { /* 通知失败不影响下发 */ } }
      writeLog(u, LABEL[action], o.code);
      okList.push(o.code);
    } catch (e) { failed.push({ id, code: o.code, msg: e.message || '操作失败' }); }
  }
  ok(res, { action, ok_count: okList.length, ok_list: okList, failed });
});

route('POST', '/api/orders', ['admin', 'technician'], (req, res, _m, b, u) => {
  const qty = Math.max(1, Math.floor(num(b.qty_plan, 1)));
  const code = b.code && b.code.trim() ? b.code.trim()
    : 'WO' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 9000) + 1000);
  if (get('SELECT id FROM orders WHERE code=?', [code])) return fail(res, '工单号已存在');
  // 责任人（accountable）：创建时可直接指定；校验存在且启用
  // 注意：必须在 tx() 之外校验 —— fail() 不抛异常，写在事务回调内 return 只会退出回调，
  // 导致拒绝时仍继续写「创建工单」日志并重复写响应
  let ownerName = null;
  if (b.owner_user_id) {
    const ow = get('SELECT id,name,active,role FROM users WHERE id=?', [num(b.owner_user_id)]);
    if (!ow || !ow.active) return fail(res, '所选责任人不存在或未启用', 400);
    if (ow.role === 'worker') return fail(res, '责任人不能选操作工，请选技术员/质检员/管理员', 400);
    ownerName = ow.name;
  }
  // 工资核算方式：piece 计件（默认）/ time 计时（按实动工时×时薪）
  const wageType = String(b.wage_type) === 'time' ? 'time' : 'piece';
  const hourRate = wageType === 'time' ? Math.max(0, num(b.hourly_rate)) : null;
  if (wageType === 'time' && !(hourRate > 0)) return fail(res, '计时核算工单需填写时薪（元/小时）', 400);
  const id = tx(() => {
    const oid = insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,plan_start,plan_end,status,remark,created_by,owner_user_id,owner_name,wage_type,hourly_rate,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, b.product_id, b.route_id, b.customer_id || null, qty, num(b.priority, 2),
        b.plan_start || today(), b.plan_end || today(), 'created', b.remark || '', u.id,
        b.owner_user_id ? num(b.owner_user_id) : null, ownerName, wageType, hourRate, now()]);
    all('SELECT * FROM route_steps WHERE route_id=? ORDER BY seq', [b.route_id]).forEach((s) => {
      insert('INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,status,inspect_type) VALUES(?,?,?,?,?,?,?)',
        [oid, s.seq, s.process_id, s.work_center_id, qty, 'pending', String(s.inspect_type || '')]);
    });
    return oid;
  });
  writeLog(u, '创建工单', code + ' 数量 ' + qty + (wageType === 'time' ? '（计时核算 ¥' + hourRate + '/小时）' : ''));
  ok(res, { id, code });
});

route('PATCH', '/api/orders/(\\d+)/status', ['admin', 'technician'], (req, res, m, b, u) => {
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
  // 下发时通知已指派班组的成员（派工待办）
  if (to === 'released') {
    try { notifyAssign(o, m[1]); } catch (e) { /* 通知失败不影响下发 */ }
  }
  ok(res, true);
});

/* 指派工单负责人（accountable 责任人）：检验反馈异常首推此人处理；可清空 */
route('PUT', '/api/orders/(\\d+)/owner', ['admin', 'technician'], (req, res, m, b, u) => {
  const oid = num(m[1]);
  const o = get('SELECT * FROM orders WHERE id=?', [oid]);
  if (!o) return fail(res, '工单不存在', 404);
  const uid = b.owner_user_id ? num(b.owner_user_id) : null;
  let uname = null;
  if (uid) {
    const u = get('SELECT id,name,active,role FROM users WHERE id=?', [uid]);
    if (!u || !u.active) return fail(res, '所选用户不存在或未启用', 400);
    if (u.role === 'worker') return fail(res, '责任人不能选操作工，请选技术员/质检员/管理员', 400);
    uname = u.name;
  }
  run('UPDATE orders SET owner_user_id=?, owner_name=? WHERE id=?', [uid, uname, oid]);
  writeLog(u, '指派工单负责人', o.code + (uname ? ' → ' + uname : ' → 取消负责人'));
  ok(res, { owner_user_id: uid, owner_name: uname });
});

route('PATCH', '/api/orders/(\\d+)/steps/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const allowReport = (b.allow_report === 0 || b.allow_report === '0' || b.allow_report === false) ? 0 : 1;
  run('UPDATE order_steps SET assignee_team=?, work_center_id=?, allow_report=? WHERE id=? AND order_id=?',
    [b.assignee_team || null, b.work_center_id || null, allowReport, m[2], m[1]]);
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  writeLog(u, '工序派工', (o ? o.code : m[1]) + ' 工序#' + m[2] + (b.assignee_team ? ' → ' + b.assignee_team : '') + (allowReport ? '' : '（员工不可申报）'));
  // 单独指派某工序班组时，也通知该班组（工单已在制/已下发才有意义）
  if (b.assignee_team && o && ['released', 'running', 'paused'].includes(o.status)) {
    try {
      const step = get('SELECT * FROM order_steps WHERE id=? AND order_id=?', [m[2], m[1]]);
      notifyAssign(o, o.id, step ? [step] : null);
    } catch (e) { /* 忽略 */ }
  }
  ok(res, true);
});

/* 工单工序增减：待下发 / 已下发 / 生产中 / 已暂停 均允许调整（生产中插工序常见：补返工、加检验）；
   已完成 / 已关闭 禁止，避免影响已结算数据。已报工的工序不允许删除（会丢报工记录）。 */
const STEP_EDIT_STATUS = { created: 1, released: 1, running: 1, paused: 1 };
const ORDER_STATUS_LABEL = { created: '待下发', released: '已下发', running: '生产中', paused: '已暂停', done: '已完成', closed: '已关闭' };

// 增加工序
route('POST', '/api/orders/(\\d+)/steps', ['admin', 'technician'], (req, res, m, b, u) => {
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  if (!STEP_EDIT_STATUS[o.status]) return fail(res, '工单处于「' + (ORDER_STATUS_LABEL[o.status] || o.status) + '」状态，不能调整工序');
  const pid = num(b.process_id);
  const proc = pid ? get('SELECT id,name,inspect_type FROM processes WHERE id=?', [pid]) : null;
  if (!proc) return fail(res, '请选择要增加的工序');
  const qty = num(b.qty_plan) > 0 ? num(b.qty_plan) : num(o.qty_plan);
  const steps = all('SELECT id,seq FROM order_steps WHERE order_id=? ORDER BY seq', [m[1]]);
  const atPos = num(b.at_pos);                       // 插入位置（第几道，1 起）；留空=追加到最后
  const insType = b.inspect_type !== undefined ? String(b.inspect_type || '') : (proc.inspect_type || '');
  let seq = 0;
  tx(() => {
    if (atPos > 0 && atPos <= steps.length) {
      seq = num(steps[atPos - 1].seq);               // 插入该位之前：其后工序整体后移 10
      run('UPDATE order_steps SET seq=seq+10 WHERE order_id=? AND seq>=?', [m[1], seq]);
    } else {
      seq = (steps.length ? Math.max.apply(null, steps.map((s) => num(s.seq))) : 0) + 10;
    }
    insert(`INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,assignee_team,allow_report,status,inspect_type) VALUES(?,?,?,?,?,?,?,?,?)`,
      [num(m[1]), seq, pid, b.work_center_id ? num(b.work_center_id) : null, qty, b.assignee_team || null,
        (b.allow_report === 0 || b.allow_report === '0' || b.allow_report === false) ? 0 : 1, 'pending', insType]);
  });
  writeLog(u, '工单增加工序', o.code + ' 增加「' + proc.name + '」×' + qty + (atPos > 0 ? '（第' + atPos + '道）' : '（末尾）') + (insType ? ' [检验点]' : ''));
  ok(res, { seq });
});

// 删除工序
route('DELETE', '/api/orders/(\\d+)/steps/(\\d+)', ['admin', 'technician'], (req, res, m, _b, u) => {
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  if (!STEP_EDIT_STATUS[o.status]) return fail(res, '工单处于「' + (ORDER_STATUS_LABEL[o.status] || o.status) + '」状态，不能调整工序');
  const st = get('SELECT s.*, p.name pname FROM order_steps s LEFT JOIN processes p ON p.id=s.process_id WHERE s.id=? AND s.order_id=?', [m[2], m[1]]);
  if (!st) return fail(res, '工序不存在', 404);
  const rc = get('SELECT COUNT(*) c FROM reports WHERE order_step_id=?', [m[2]]).c;
  if (rc) return fail(res, '该工序已有 ' + rc + ' 条报工记录，不能删除（请先在报工流水中撤销）');
  if (num(st.qty_good) || num(st.qty_bad)) return fail(res, '该工序已有报工数量，不能删除（请先在报工流水中撤销）');
  if (num(get('SELECT COUNT(*) c FROM order_steps WHERE order_id=?', [m[1]]).c) <= 1) return fail(res, '至少要保留一道工序');
  run('DELETE FROM order_steps WHERE id=?', [m[2]]);
  writeLog(u, '工单删除工序', o.code + ' 删除「' + (st.pname || '#' + m[2]) + '」');
  ok(res, true);
});

// 设置/取消工序检验点：inspect_type 传 '' 取消检验。
// 取消检验放宽限制：即使工序已有报工、正处于「待检/不合格」也可取消——
// 取消时视同普通工序放行：按当前合格数判定完工并流转后续工序，暂停工单自动恢复，等待中的检验自动出队。
route('PUT', '/api/orders/(\\d+)/steps/(\\d+)/inspect', ['admin', 'technician'], (req, res, m, b, u) => {
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  const st = get('SELECT s.*, p.name pname FROM order_steps s LEFT JOIN processes p ON p.id=s.process_id WHERE s.id=? AND s.order_id=?', [m[2], m[1]]);
  if (!st) return fail(res, '工序不存在', 404);
  const t = String(b.inspect_type || '').trim();
  if (t && !INSPECT_LABEL[t]) return fail(res, '无效的检验类型（可选：iqc 首检 / ipqc 过程检 / fqc 终检）');

  // 取消检验：任何状态下都允许（含已完成/已关闭工单），仅清空检验标记；
  // 待检/不合格时一并按当前合格数放行流转，暂停的工单自动恢复。设置新检验点仍要求工单处于可编辑状态且无报工。
  if (!t) {
    const was = String(st.inspect_status || '');
    tx(() => {
      if (was === 'waiting' || was === 'failed') {
        const fin = num(st.qty_good) >= num(st.qty_plan);
        run("UPDATE order_steps SET inspect_type='', inspect_status=NULL, status=?, finish_time=? WHERE id=?",
          [fin ? 'done' : 'running', fin ? now() : null, st.id]);
        if (fin) run("UPDATE order_steps SET status='running' WHERE id=(SELECT MIN(id) FROM order_steps WHERE order_id=? AND status='pending')", [o.id]);
        const left = get("SELECT COUNT(*) c FROM order_steps WHERE order_id=? AND status<>'done'", [o.id]).c;
        if (left === 0) run("UPDATE orders SET status='done', finish_time=? WHERE id=?", [now(), o.id]);
        else if (o.status === 'paused') run("UPDATE orders SET status='running' WHERE id=?", [o.id]);
      } else {
        run("UPDATE order_steps SET inspect_type='' WHERE id=?", [st.id]);
      }
    });
    writeLog(u, '取消工序检验', o.code + '「' + (st.pname || '#' + m[2]) + '」原状态 ' + (was || '未检') + '，已按普通工序放行流转');
    return ok(res, { inspect_type: '', released: was === 'waiting' || was === 'failed' });
  }

  // 设置检验点：要求工单处于可编辑状态且无报工、未进入检验流程（保证检验数据一致）
  if (!STEP_EDIT_STATUS[o.status]) return fail(res, '工单处于「' + (ORDER_STATUS_LABEL[o.status] || o.status) + '」状态，不能设置检验点');
  const rc = get('SELECT COUNT(*) c FROM reports WHERE order_step_id=?', [m[2]]).c;
  if (rc) return fail(res, '该工序已有 ' + rc + ' 条报工记录，不能设置检验点');
  if (st.inspect_status) return fail(res, '该工序已在检验流程中，不能设置检验点');
  run('UPDATE order_steps SET inspect_type=? WHERE id=?', [t, m[2]]);
  writeLog(u, '工单设置检验点', o.code + '「' + (st.pname || '#' + m[2]) + '」→ ' + INSPECT_LABEL[t]);
  ok(res, { inspect_type: t });
});

// 调整工序顺序：传入完整有序的工序 id 列表，按 10 递增重排 seq（上移/下移/拖拽统一走此接口）
route('PUT', '/api/orders/(\\d+)/steps/order', ['admin', 'technician'], (req, res, m, b, u) => {
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  if (!STEP_EDIT_STATUS[o.status]) return fail(res, '工单处于「' + (ORDER_STATUS_LABEL[o.status] || o.status) + '」状态，不能调整工序');
  const ids = Array.isArray(b.order) ? b.order.map((x) => num(x)).filter((x) => x > 0) : [];
  if (!ids.length) return fail(res, '缺少工序顺序');
  const steps = all('SELECT id,seq FROM order_steps WHERE order_id=? ORDER BY seq', [m[1]]);
  const have = new Set(steps.map((s) => s.id));
  if (ids.length !== steps.length) return fail(res, '工序顺序必须包含该工单的全部 ' + steps.length + ' 道工序');
  if (!ids.every((id) => have.has(id))) return fail(res, '工序顺序中包含不属于该工单的工序');
  tx(() => {
    ids.forEach((id, i) => run('UPDATE order_steps SET seq=? WHERE id=? AND order_id=?', [(i + 1) * 10, id, m[1]]));
  });
  writeLog(u, '工单工序排序', o.code + ' 调整为 ' + ids.length + ' 道工序的新顺序');
  ok(res, true);
});

route('PUT', '/api/orders/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const before = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!before) return fail(res, '工单不存在', 404);
  if (before.status !== 'created') return fail(res, '只有「待下发」状态的工单可以修改');
  // 责任人：编辑表单提交时一并更新（body 未携带 owner_user_id 字段则不动）
  let ownerSet = '';
  const ownerParams = [];
  if (Object.prototype.hasOwnProperty.call(b, 'owner_user_id')) {
    let ownerName = null;
    if (b.owner_user_id) {
      const ow = get('SELECT id,name,active,role FROM users WHERE id=?', [num(b.owner_user_id)]);
      if (!ow || !ow.active) return fail(res, '所选责任人不存在或未启用', 400);
      if (ow.role === 'worker') return fail(res, '责任人不能选操作工，请选技术员/质检员/管理员', 400);
      ownerName = ow.name;
      ownerParams.push(num(b.owner_user_id), ownerName);
    } else {
      ownerParams.push(null, null);
    }
    ownerSet = ',owner_user_id=?,owner_name=?';
  }
  // 核算方式：body 携带 wage_type 才更新；计时必须有时薪
  let wageSet = '';
  const wageParams = [];
  if (Object.prototype.hasOwnProperty.call(b, 'wage_type')) {
    const wt = String(b.wage_type) === 'time' ? 'time' : 'piece';
    const hr = wt === 'time' ? Math.max(0, num(b.hourly_rate)) : null;
    if (wt === 'time' && !(hr > 0)) return fail(res, '计时核算工单需填写时薪（元/小时）', 400);
    wageSet = ',wage_type=?,hourly_rate=?';
    wageParams.push(wt, hr);
  }
  tx(() => {
    run(`UPDATE orders SET product_id=?,route_id=?,customer_id=?,qty_plan=?,priority=?,plan_start=?,plan_end=?,remark=?${ownerSet}${wageSet} WHERE id=?`,
      [b.product_id, b.route_id, b.customer_id || null, num(b.qty_plan), num(b.priority, 2), b.plan_start, b.plan_end, b.remark || '',
        ...ownerParams, ...wageParams, m[1]]);
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
route('GET', '/api/scan/(.+)', ['*'], (req, res, m) => {
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
  const rows = all(sql, p);
  if (query.format === 'csv') {
    return sendCSV(res, '报工记录.csv', ['日期', '工单号', '工序', '工人', '合格数', '不良数', '不良原因', '工时(分)', '备注'],
      rows.map((r) => [r.report_date, r.order_code, r.process_name, r.worker_name, r.qty_good, r.qty_bad, r.bad_reason, r.work_min, r.remark]));
  }
  ok(res, rows);
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
        bad_reason: s.bad_reason, bad_reason_id: num(s.bad_reason_id) || 0, bad_reason_detail: s.bad_reason_detail, work_center_id: s.work_center_id,
        work_min: s.work_min, bad_reasons: Array.isArray(s.bad_reasons) ? s.bad_reasons : null,
        report_date: s.report_date || b.report_date, remark: s.remark || '',
      }))
    : [{
        order_step_id: num(b.order_step_id),
        qty_good: b.qty_good, qty_bad: b.qty_bad,
        bad_reason: b.bad_reason, bad_reason_id: num(b.bad_reason_id) || 0, bad_reason_detail: b.bad_reason_detail, work_center_id: b.work_center_id,
        work_min: b.work_min, bad_reasons: Array.isArray(b.bad_reasons) ? b.bad_reasons : null,
        report_date: b.report_date, remark: b.remark || '',
      }];
  if (!items.length) throw new Error('请至少选择一道工序');

  const workerId = num(b.worker_id) || actor.id;
  const results = [];
  // 末道工序（seq 最大）合格数自动计入成品仓
  const product = get('SELECT * FROM products WHERE id=?', [order.product_id]);
  const lastStepId = (get('SELECT id FROM order_steps WHERE order_id=? ORDER BY seq DESC LIMIT 1', [order_id]) || {}).id || null;

  tx(() => {
    for (const it of items) {
      const step = get('SELECT * FROM order_steps WHERE id=? AND order_id=?', [it.order_step_id, order_id]);
      if (!step) throw new Error('工序不存在（#' + it.order_step_id + '）');
      // 班组权限：工序已指派班组时，仅该班组的员工可报工；未指派则全员可报工。
      // 管理员/技术员可越权报工（管理兜底），普通员工严格按班组限制。
      if (step.assignee_team && actor.role !== 'admin' && actor.role !== 'technician') {
        const wid = num(b.worker_id) || actor.id;
        const wteam = actor.team || (get('SELECT team FROM users WHERE id=?', [wid]) || {}).team;
        if (wteam !== step.assignee_team) {
          throw new Error('工序「' + step.seq + '」限「' + step.assignee_team + '」班组报工（您为「' + (wteam || '未分组') + '」）');
        }
      }
      // 员工可申报开关：关闭时仅管理员/技术员可报此工序
      if (step.allow_report === 0 && actor.role !== 'admin' && actor.role !== 'technician') {
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
            const br = get('SELECT name FROM bad_reasons WHERE id=?', [brId]);
            if (!br) throw new Error('不良原因不存在（#' + brId + '）');
            const allowed = all('SELECT bad_reason_id FROM order_bad_reasons WHERE order_id=?', [order_id]);
            if (allowed.length && !allowed.some((a) => a.bad_reason_id === brId)) {
              throw new Error('不良原因「' + br.name + '」不在该工单可选范围内');
            }
            // 选「其他」并填写具体说明 → 以说明作为具体原因；bad_reason_id 置空便于统计按具体原因聚合
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
        // 旧版单原因兜底
        bad = Math.max(0, Math.floor(num(it.qty_bad)));
        const detail = String(it.bad_reason_detail || '').trim();
        let brId = num(it.bad_reason_id) || 0;
        let brName = '';
        if (brId) {
          const br = get('SELECT name FROM bad_reasons WHERE id=?', [brId]);
          if (!br) throw new Error('不良原因不存在（#' + brId + '）');
          const allowed = all('SELECT bad_reason_id FROM order_bad_reasons WHERE order_id=?', [order_id]);
          if (allowed.length && !allowed.some((a) => a.bad_reason_id === brId)) {
            throw new Error('不良原因「' + br.name + '」不在该工单可选范围内');
          }
          if (br.name === '其他' && detail) { brName = detail; brId = 0; } else { brName = br.name; }
        } else if (it.bad_reason) {
          brName = String(it.bad_reason);
        } else if (bad) {
          brName = '其他';
        }
        if (bad > 0) badEntries.push({ bad_reason_id: brId || null, bad_reason: brName, bad_reason_detail: detail, qty: bad });
      }
      it._bad = bad;
      if (good + bad <= 0) throw new Error('工序「' + step.seq + '」合格数与不良数不能同时为 0');
      // 工资核算：工单级 wage_type —— piece 计件（合格数×计件单价）/ time 计时（实动工时×时薪）。
      // 报工行快照 wage_type、work_hours（小时）与单价（unit_price：计件存单件价、计时存时薪），后续调价不影响历史工资
      const isTime = String(order.wage_type) === 'time';
      const workHours = Math.max(0, num(it.work_min)) / 60;
      if (isTime && workHours <= 0) throw new Error('计时核算工单报工需填写实动工时（小时）');
      // 单价优先级：工单级工序工价（std_price>0）> 工序档案单价
      const stepPrice = num(step.std_price) || 0;
      const procPrice = num(get('SELECT std_price FROM processes WHERE id=?', [step.process_id]).std_price) || 0;
      const snapRate = isTime ? (num(order.hourly_rate) || 0) : (stepPrice || procPrice);
      const rid = insert(`INSERT INTO reports(order_id,order_step_id,worker_id,work_center_id,qty_good,qty_bad,bad_reason,bad_reason_id,work_min,report_date,remark,created_at,unit_price,wage_type,work_hours)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [order_id, step.id, workerId, it.work_center_id || step.work_center_id,
          good, bad, badEntries[0] ? badEntries[0].bad_reason : '', badEntries[0] ? badEntries[0].bad_reason_id : null, num(it.work_min),
          it.report_date || today(), it.remark || '', now(), snapRate, isTime ? 'time' : 'piece', workHours > 0 ? workHours : null]);
      // 写入不良明细
      for (const e of badEntries) {
        insert('INSERT INTO report_bad_reasons(report_id,bad_reason_id,bad_reason,bad_reason_detail,qty) VALUES(?,?,?,?,?)',
          [rid, e.bad_reason_id, e.bad_reason, e.bad_reason_detail, e.qty]);
      }

      const done = step.qty_good + good;
      const finished = done >= step.qty_plan;
      // 检验点（inspect_type 非空）：报工后不直接完工，先落「待检」，检验合格才放行完工
      const needInspect = !!String(step.inspect_type || '').trim();
      if (needInspect) {
        run("UPDATE order_steps SET qty_good=qty_good+?, qty_bad=qty_bad+?, work_min=work_min+?, inspect_status='waiting', start_time=IFNULL(start_time,?), assignee_id=IFNULL(assignee_id,?) WHERE id=?",
          [good, bad, num(it.work_min), now(), workerId, step.id]);
      } else {
        run('UPDATE order_steps SET qty_good=qty_good+?, qty_bad=qty_bad+?, work_min=work_min+?, status=?, start_time=IFNULL(start_time,?), finish_time=?, assignee_id=IFNULL(assignee_id,?) WHERE id=?',
          [good, bad, num(it.work_min), finished ? 'done' : 'running', now(), finished ? now() : null, workerId, step.id]);
      }

      if (order.status === 'created' || order.status === 'released') {
        run("UPDATE orders SET status='running', start_time=IFNULL(start_time,?) WHERE id=?", [now(), order_id]);
      }
      // 模具联动：该机台「在机」模具自动累计生产数（合格+不良，件）→ 保养周期/寿命预警口径
      const moldWc = it.work_center_id || step.work_center_id;
      if (moldWc) {
        const usingMold = get("SELECT id FROM molds WHERE work_center_id=? AND status='producing' LIMIT 1", [moldWc]);
        if (usingMold) run('UPDATE molds SET total_shots=total_shots+? WHERE id=?', [good + bad, usingMold.id]);
      }
      if (finished && !needInspect) {
        run(`UPDATE order_steps SET status='running' WHERE id=(SELECT MIN(id) FROM order_steps WHERE order_id=? AND status='pending')`, [order_id]);
      }
      // 末道工序报工合格数 → 自动成品入库（检验点须待检验合格后才入库，此处只做非检验点）
      let autoIn = null;
      if (step.id === lastStepId && good > 0 && !needInspect) {
        autoIn = autoFinishIn(order, product, good, actor, step.id, rid);
      }
      const repWage = isTime ? Math.round(workHours * snapRate * 100) / 100 : Math.round(good * snapRate * 100) / 100;
      results.push({ report_id: rid, order_step_id: step.id, seq: step.seq, finished, needInspect, autoFinishIn: autoIn, wage: repWage });
    }

    // 全部工序完成 → 工单完工（检验点未放行的工序状态仍为 running，天然阻止误判完工）
    const left = get("SELECT COUNT(*) c FROM order_steps WHERE order_id=? AND status<>'done'", [order_id]);
    if (left.c === 0) run("UPDATE orders SET status='done', finish_time=? WHERE id=?", [now(), order_id]);
  });

  const totalGood = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_good))), 0);
  const totalBad = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it._bad) || 0)), 0);
  const totalWage = Math.round(results.reduce((a, r) => a + (r.wage || 0), 0) * 100) / 100;
  writeLog(actor, '生产报工', order.code + (items.length > 1 ? ' 多工序×' + items.length : '') + ' 合格 ' + totalGood + ' / 不良 ' + totalBad);
  // 通知对应负责人：① 报工环节出现不良 → 质量异常待跟进；② 报工后工序需检验 → 质检员待检
  try { notifyAfterReport(order, actor, items, results, product); } catch (e) { /* 通知失败不阻塞报工 */ }
  return { count: items.length, steps: results, finished: results.some((r) => r.finished), total_wage: totalWage };
}

// 报工后的负责人通知（操作工 → 技术员/质检员）
function notifyAfterReport(order, actor, items, results, product) {
  const workers = [actor];
  // ① 有不良 → 不良率达到提醒阈值（检验设置「一般不合格率下限」minor_ratio，默认 5%）才提醒；
  //    收件人收敛为「责任人 + 质检员」：责任人=工单负责人→班组技术员→创建人→管理员兜底（单人），不再全员轰炸管理员
  const totalBad = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it._bad) || 0)), 0);
  const totalGood = items.reduce((a, it) => a + Math.max(0, Math.floor(num(it.qty_good))), 0);
  if (totalBad > 0) {
    const threshold = Math.min(50, Math.max(0, num(getSetting('minor_ratio', 5)))) / 100;
    const ratio = (totalGood + totalBad) > 0 ? totalBad / (totalGood + totalBad) : 1;
    if (ratio >= threshold) {
      const firstStep = items.length ? get('SELECT * FROM order_steps WHERE id=?', [items[0].order_step_id]) : null;
      // 责任人不含操作工：负责人是操作工时视为未指定，走定责链（技术员→创建人→管理员）
      const ownerRaw = order.owner_user_id ? get('SELECT id,name,active,role FROM users WHERE id=? AND active=1', [order.owner_user_id]) : null;
      const owner = ownerRaw && ownerRaw.role !== 'worker' ? ownerRaw : null;
      const resp = owner || resolveIssueAssignee(firstStep, order);
      const inspectors = usersByRole('inspector').filter((x) => x.id !== actor.id && x.id !== resp.id);
      const pct = Math.round(ratio * 1000) / 10;
      pushMessage({
        source: 'quality', toUsers: [resp, ...inspectors], kind: 'created', ref_type: 'order', ref_id: order.id, link: '#/quality',
        title: `报工不良提醒：${order.code} 不良 ${totalBad} 件（${pct}%）`,
        body: `${actor.name} 报工登记合格 ${totalGood} 件、不良 ${totalBad} 件（${product ? product.name : '-'}），不良率 ${pct}% 已达提醒阈值。请核实是否开异常单并跟进处置。`,
      });
    }
  }
  // ② 报工后落入待检 → 通知质检员
  const waiting = results.filter((r) => r.needInspect);
  if (waiting.length) {
    const inspectors = usersByRole('inspector');
    // 排除报工人自己（质检员也可能自己报工）
    const tos = inspectors.filter((x) => x.id !== actor.id);
    if (tos.length) {
      const names = waiting.map((r) => {
        const s = get('SELECT p.name process_name, s.order_id, s.seq FROM order_steps s LEFT JOIN processes p ON p.id=s.process_id WHERE s.id=?', [r.order_step_id]);
        const no = s ? stepSeqNo(s.order_id, s.seq) : r.seq;
        return s && s.process_name ? s.process_name + '（第' + no + '道）' : '第' + no + '道';
      });
      pushMessage({
        source: 'quality', toUsers: tos, kind: 'created', ref_type: 'order', ref_id: order.id, link: '#/inspect',
        title: `待检任务：${order.code} 有 ${waiting.length} 道工序待检验`,
        body: `${actor.name} 已报工提交：${names.join('、')}。请到「质检台」判定。`,
      });
    }
  }
}

route('POST', '/api/reports', [], (req, res, _m, b, u) => {
  try { ok(res, doReport(b, u)); }
  catch (e) { fail(res, e.message, 400); }
});

/* 扫码免登录报工：令牌必须匹配工单（机台码）或员工（员工码） */
route('POST', '/api/public/reports', ['*'], (req, res, _m, b) => {
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

route('DELETE', '/api/reports/(\\d+)', ['admin', 'technician'], (req, res, m, _b, u) => {
  const r = get('SELECT * FROM reports WHERE id=?', [m[1]]);
  if (!r) return fail(res, '记录不存在', 404);
  tx(() => {
    // 末道工序自动入库联动回滚：按 report_id 定位自动生成的成品入库单并冲销库存，再删除单据
    const fins = all('SELECT id, qty FROM finished_goods_in WHERE report_id=?', [m[1]]);
    let rolled = 0;
    for (const f of fins) {
      revertStock('finished_goods_in', f.id, u.name);
      run('DELETE FROM finished_goods_in WHERE id=?', [f.id]);
      rolled += Number(f.qty) || 0;
    }
    run('UPDATE order_steps SET qty_good=qty_good-?, qty_bad=qty_bad-?, work_min=work_min-? WHERE id=?',
      [r.qty_good, r.qty_bad, r.work_min, r.order_step_id]);
    run("UPDATE order_steps SET status=CASE WHEN qty_good+qty_bad=0 THEN 'pending' WHEN qty_good>=qty_plan THEN 'done' ELSE 'running' END, finish_time=CASE WHEN qty_good>=qty_plan THEN finish_time ELSE NULL END WHERE id=?", [r.order_step_id]);
    run('DELETE FROM report_bad_reasons WHERE report_id=?', [m[1]]);
    run('DELETE FROM reports WHERE id=?', [m[1]]);
    const o = get('SELECT code FROM orders WHERE id=?', [r.order_id]);
    const detail = (o ? o.code : '') + ' 合格 ' + r.qty_good + (rolled ? '，联动回滚成品入库 ' + rolled + ' 件' : '');
    writeLog(u, '撤销报工', detail);
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
  const since = '-' + (days - 1) + ' day';
  // 新模型：按 report_bad_reasons 明细聚合；旧模型：无明细行的 reports 仍按原 bad_reason 聚合
  ok(res, all(`SELECT name, SUM(qty) qty FROM (
      SELECT COALESCE(br.name, rb.bad_reason) name, rb.qty qty
      FROM report_bad_reasons rb JOIN reports r ON r.id=rb.report_id
      LEFT JOIN bad_reasons br ON br.id=rb.bad_reason_id
      WHERE r.report_date >= date('now', ?) AND rb.qty>0 AND COALESCE(br.name, rb.bad_reason)<>''
      UNION ALL
      SELECT COALESCE(br.name, r.bad_reason) name, r.qty_bad qty
      FROM reports r LEFT JOIN bad_reasons br ON br.id=r.bad_reason_id
      WHERE r.report_date >= date('now', ?) AND r.qty_bad>0
        AND r.id NOT IN (SELECT report_id FROM report_bad_reasons WHERE report_id IS NOT NULL)
        AND COALESCE(br.name, r.bad_reason)<>''
    ) GROUP BY name ORDER BY qty DESC`, [since, since]));
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
      (SELECT COALESCE(qty_good,0) FROM order_steps s WHERE s.order_id=o.id ORDER BY s.seq DESC LIMIT 1) qty_done
    FROM orders o JOIN products p ON p.id=o.product_id
    WHERE o.status NOT IN ('closed') ORDER BY o.priority, o.plan_end LIMIT 200`));
});

/* ------------------------------ 设备稼动分析（轻量 OEE：产出视角） ------------------------------
 * 口径：稼动率 = 近 N 天该设备上报实动工时 ÷（N 天 × shift_hours 班制基准，默认 8h 可配置），上限 100%；
 * 产出 = 报工合格数，质量 = 合格率。数据全部来自报工流水，无需额外录入。 */
route('GET', '/api/stats/equip_util', [], (req, res, _m, _b, _u, q) => {
  const days = Math.min(90, Math.max(3, num(q.days, 7)));
  const shiftH = Math.min(24, Math.max(1, num(getSetting('shift_hours', 8))));
  const CAP = days * shiftH * 60; // 分钟
  const rows = all(`SELECT w.id, w.code, w.name, w.workshop, w.status,
      COUNT(r.id) cnt, COALESCE(SUM(r.qty_good),0) good, COALESCE(SUM(r.qty_bad),0) bad,
      COALESCE(SUM(r.work_min),0) minu,
      MIN(100, ROUND(COALESCE(SUM(r.work_min),0) * 100.0 / ${CAP}, 1)) util_pct,
      ROUND(SUM(r.qty_good) * 100.0 / MAX(1, SUM(r.qty_good) + SUM(r.qty_bad)), 1) rate_pct
    FROM work_centers w LEFT JOIN reports r
      ON r.work_center_id = w.id AND r.report_date >= date('now', ?)
    GROUP BY w.id ORDER BY minu DESC, w.code`, ['-' + (days - 1) + ' day']);
  const used = rows.filter((r) => r.cnt > 0);
  ok(res, {
    days,
    shift_hours: shiftH,
    summary: {
      total_machines: rows.length,
      used_machines: used.length,
      total_hours: Math.round(used.reduce((s, r) => s + r.minu, 0) / 60 * 10) / 10,
      avg_util: used.length ? Math.round(used.reduce((s, r) => s + r.util_pct, 0) / used.length * 10) / 10 : 0,
      good: used.reduce((s, r) => s + r.good, 0),
      bad: used.reduce((s, r) => s + r.bad, 0),
    },
    rows,
  });
});

/* 设备稼动设置：班制基准工时（元数据 settings.shift_hours） */
route('GET', '/api/equip/settings', [], (req, res) => {
  ok(res, { shift_hours: Math.min(24, Math.max(1, num(getSetting('shift_hours', 8)))) });
});
route('POST', '/api/equip/settings', ['admin'], (req, res, _m, b, u) => {
  const v = Math.min(24, Math.max(1, num(b.shift_hours, 8)));
  const ex = get('SELECT key FROM settings WHERE key=?', ['shift_hours']);
  if (ex) run('UPDATE settings SET value=? WHERE key=?', [String(v), 'shift_hours']);
  else insert('INSERT INTO settings(key,value) VALUES(?,?)', ['shift_hours', String(v)]);
  writeLog(u, '修改设备稼动设置', '班制基准 ' + v + ' 小时/天');
  ok(res, { shift_hours: v });
});


/* ------------------------------ 工单 ⇄ 仓储 闭环对账报表（分产品） ------------------------------
 * 把「工单完工（末道工序合格）→ 自动成品入库 → 库存」串成一张按产品的对账表：
 *   计划  = 该产品的工单 qty_plan 合计
 *   完工  = 该产品各工单末道工序合格数合计（与完成率口径一致，瓶颈口径已废弃）
 *   入库  = 关联工单的成品入库单（finished_goods_in.order_id 非空）数量合计，按产品编码归集
 *   库存  = 对应成品物料（materials.code = products.code）当前库存台账合计
 *   待入库 = 完工 - 入库（正常情况下为 0；若出现 >0 说明有末道报工未入库，<0 说明有手工/异常入库）
 * 同时返回每个产品的工单明细，便于下钻核对。 */
route('GET', '/api/stats/production-stock', [], (req, res) => {
  const products = all(`SELECT id,code,name,spec,unit FROM products ORDER BY code`);
  const orders = all(`SELECT o.id,o.code,o.product_id,o.status,o.qty_plan,
      (SELECT COALESCE(qty_good,0) FROM order_steps s WHERE s.order_id=o.id ORDER BY s.seq DESC LIMIT 1) qty_done
    FROM orders o`);
  // 成品入库：仅统计关联工单的单据，按产品编码 / 工单分别归集
  const finByProduct = {};
  const finByOrder = {};
  all(`SELECT product_code, order_id, SUM(qty) qty FROM finished_goods_in WHERE order_id IS NOT NULL GROUP BY product_code, order_id`).forEach((r) => {
    if (r.product_code) finByProduct[r.product_code] = (finByProduct[r.product_code] || 0) + Number(r.qty);
    if (r.order_id) finByOrder[r.order_id] = (finByOrder[r.order_id] || 0) + Number(r.qty);
  });
  const matByCode = {};
  all(`SELECT id,code,safe_min,safe_max FROM materials`).forEach((m) => { if (!matByCode[m.code]) matByCode[m.code] = m; });
  const stockByMat = {};
  all(`SELECT material_id, SUM(qty) qty FROM inventory GROUP BY material_id`).forEach((r) => {
    stockByMat[r.material_id] = (stockByMat[r.material_id] || 0) + Number(r.qty);
  });

  // 以产品为主行；成品入库里出现但无产品档案的孤儿编码也补一行
  const rowsMap = {};
  products.forEach((p) => {
    rowsMap[p.code] = {
      product_code: p.code, product_name: p.name, spec: p.spec || '', unit: p.unit || '件',
      plan: 0, done: 0, inQty: finByProduct[p.code] || 0, stock: 0, safe_min: null, safe_max: null, orders: [],
    };
  });
  Object.keys(finByProduct).forEach((code) => {
    if (!rowsMap[code]) rowsMap[code] = {
      product_code: code, product_name: code, spec: '', unit: '件',
      plan: 0, done: 0, inQty: finByProduct[code], stock: 0, safe_min: null, safe_max: null, orders: [],
    };
  });

  orders.forEach((o) => {
    const p = products.find((x) => x.id === o.product_id);
    const row = p && rowsMap[p.code] ? rowsMap[p.code] : null;
    if (!row) return;
    const done = Number(o.qty_done || 0);
    const inQ = finByOrder[o.id] || 0;
    row.plan += Number(o.qty_plan || 0);
    row.done += done;
    row.orders.push({
      code: o.code, status: o.status, plan: Number(o.qty_plan || 0),
      done, inQty: inQ, diff: done - inQ,
    });
  });

  const rows = Object.values(rowsMap).map((r) => {
    const mat = matByCode[r.product_code];
    if (mat) {
      r.safe_min = mat.safe_min;
      r.safe_max = mat.safe_max;
      r.stock = stockByMat[mat.id] || 0;
    }
    r.diff = Number(r.done) - Number(r.inQty);
    r.orders.sort((a, b) => (a.code < b.code ? -1 : 1));
    return r;
  }).sort((a, b) => (a.product_code < b.product_code ? -1 : 1));

  const summary = {
    product_count: rows.length,
    plan: rows.reduce((s, r) => s + Number(r.plan), 0),
    done: rows.reduce((s, r) => s + Number(r.done), 0),
    inQty: rows.reduce((s, r) => s + Number(r.inQty), 0),
    stock: rows.reduce((s, r) => s + Number(r.stock), 0),
    diff: rows.reduce((s, r) => s + Number(r.diff), 0),
  };
  ok(res, { summary, rows });
});

/* ------------------------------ 升级：CSV 导出助手 ------------------------------ */
/* 用法：列表接口收到 ?format=csv 时改为下载 CSV（带 BOM，Excel 直接打开不乱码） */
function sendCSV(res, filename, header, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = [header.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(','))).join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"',
  });
  res.end('\ufeff' + body);
}

/* ------------------------------ 升级：批次/工单双向追溯 ------------------------------ */
/* 输入批次号或工单号，返回完整追溯链：
 *   批次 → 来料(供应商) / 领料去向工单 / 报工 / 检验 / 成品入库 / 出库(客户)
 *   工单 → 用料批次 / 报工明细 / 检验记录 / 成品入库批次 / 出库 */
route('GET', '/api/trace/([^/]+)', [], (req, res, m) => {
  const code = decodeURIComponent(m[1]).trim();
  if (!code) return fail(res, '请输入批次号或工单号');
  const result = { code, type: 'none', suppliers: [], customers: [], orders: [] };

  const order = get('SELECT o.id,o.code,o.status,o.qty_plan,o.plan_start,o.plan_end,p.name product_name,p.spec FROM orders o JOIN products p ON p.id=o.product_id WHERE o.code=?', [code]);
  if (order) {
    result.type = 'order';
    result.order = order;
    result.materials = all(`SELECT mi.material_code, mi.material_name, mi.material_spec, mi.qty, mi.unit, mi.issue_date, t.batch, w.name warehouse_name
      FROM material_issues mi LEFT JOIN inventory_tx t ON t.ref_type='material_issues' AND t.ref_id=mi.id
      LEFT JOIN warehouses w ON w.id=mi.warehouse_id
      WHERE mi.order_id=? AND mi.type='pick' ORDER BY mi.id`, [order.id]);
    result.reports = all(`SELECT rp.report_date, rp.qty_good, rp.qty_bad, u.name worker_name, pr.name process_name
      FROM reports rp LEFT JOIN users u ON u.id=rp.worker_id
      LEFT JOIN order_steps s ON s.id=rp.order_step_id LEFT JOIN processes pr ON pr.id=s.process_id
      WHERE rp.order_id=? ORDER BY rp.id`, [order.id]);
    result.inspections = all(`SELECT code, process_name, conclusion, qty_check, qty_pass, qty_fail, inspector, created_at
      FROM inspections WHERE order_id=? ORDER BY id`, [order.id]);
    result.finished = all(`SELECT code, in_date, batch, qty, unit FROM finished_goods_in WHERE order_id=? ORDER BY id`, [order.id]);
    result.shipments = all(`SELECT code, ship_date, qty, unit, batch, customer FROM stock_shipments WHERE order_id=? ORDER BY id`, [order.id]);
    result.customers = [...new Set(result.shipments.map((s) => s.customer).filter(Boolean))];
  } else {
    const txs = all(`SELECT t.id, t.tx_type, t.qty, t.batch, t.tx_date, t.ref_code, m.code material_code, m.name material_name, m.unit, w.name warehouse_name, o.code order_code
      FROM inventory_tx t JOIN materials m ON m.id=t.material_id
      LEFT JOIN warehouses w ON w.id=t.warehouse_id LEFT JOIN orders o ON o.id=t.order_id
      WHERE t.batch=? ORDER BY t.id`, [code]);
    if (txs.length) {
      result.type = 'batch';
      result.txs = txs;
      const orderIds = [...new Set(txs.map((t) => t.order_id).filter(Boolean))];
      result.orders = orderIds.map((id) => get(`SELECT o.id,o.code,o.status,o.qty_plan,p.name product_name
        FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`, [id])).filter(Boolean);
      result.orders.forEach((o) => {
        o.reports = all(`SELECT rp.report_date, rp.qty_good, rp.qty_bad, u.name worker_name, pr.name process_name
          FROM reports rp LEFT JOIN users u ON u.id=rp.worker_id
          LEFT JOIN order_steps s ON s.id=rp.order_step_id LEFT JOIN processes pr ON pr.id=s.process_id
          WHERE rp.order_id=? ORDER BY rp.id`, [o.id]);
        o.inspections = all(`SELECT code, conclusion, qty_pass, qty_fail, created_at FROM inspections WHERE order_id=? ORDER BY id`, [o.id]);
      });
      result.suppliers = all(`SELECT DISTINCT im.supplier FROM incoming_materials im
        JOIN inventory_tx t ON t.ref_type='incoming_materials' AND t.ref_id=im.id
        WHERE t.batch=? AND im.supplier IS NOT NULL`, [code]).map((r) => r.supplier);
      result.finished = all(`SELECT code, in_date, qty, unit FROM finished_goods_in WHERE batch=? ORDER BY id`, [code]);
      result.shipments = all(`SELECT code, ship_date, qty, unit, customer FROM stock_shipments WHERE batch=? ORDER BY id`, [code]);
      result.customers = [...new Set(result.shipments.map((s) => s.customer).filter(Boolean))];
    }
  }
  if (result.type === 'none') return fail(res, '未找到匹配的批次或工单：' + code, 404);
  ok(res, result);
});

/* ------------------------------ 升级：计件工资统计 ------------------------------ */
/* 口径：工资 = 报工合格数 × 工序计件单价(processes.std_price)；支持 ?days=N 与 ?format=csv */
/* 工资核算（计件+计时）：计件工单 = 报工合格数 × 单价快照；计时工单 = 实动工时 × 时薪快照（均报工时落库，调价不影响历史）
 * 支持 days（近N天）与 month（YYYY-MM 按月核算，二选一）；
 * 隐私：操作工/质检员仅能查本人工资，管理员/技术员可查全员（可传 worker_id 过滤 + detail=1 展开逐单明细）。 */
const WAGE_EXPR = `CASE WHEN r.wage_type='time' THEN COALESCE(r.work_hours,0) * COALESCE(r.unit_price, o.hourly_rate, 0)
    ELSE r.qty_good * COALESCE(r.unit_price, pr.std_price, 0) END`;
route('GET', '/api/stats/piece_wage', [], (req, res, _m, _b, u, q) => {
  const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : null;
  const days = Math.min(180, Math.max(1, num(q.days, 30)));
  const canAll = u && ['admin', 'technician'].includes(u.role);
  const selfId = canAll ? (num(q.worker_id) || null) : (u ? u.id : null);
  const COND = month ? `strftime('%Y-%m', r.report_date)=?` : `r.report_date >= date('now', ?)`;
  const ARGS = month ? [month] : ['-' + (days - 1) + ' day'];
  const SELF = selfId ? ' AND r.worker_id=?' : '';
  const FULL_ARGS = ARGS.concat(selfId ? [selfId] : []);
  const rows = all(`SELECT u.id, u.name, u.team,
      SUM(r.qty_good) good, SUM(r.qty_bad) bad, SUM(r.work_min) minu, COUNT(*) cnt,
      ROUND(SUM(${WAGE_EXPR}), 2) wage
    FROM reports r JOIN users u ON u.id=r.worker_id
    LEFT JOIN orders o ON o.id=r.order_id
    LEFT JOIN order_steps s ON s.id=r.order_step_id
    LEFT JOIN processes pr ON pr.id=s.process_id
    WHERE ${COND}${SELF}
    GROUP BY u.id ORDER BY wage DESC, good DESC`, FULL_ARGS);
  if (q.format === 'csv') {
    return sendCSV(res, `工资核算_${month || days + '天'}.csv`, ['姓名', '班组', '合格数', '不良数', '工时(分)', '报工次数', '工资(元)'],
      rows.map((r) => [r.name, r.team || '', r.good, r.bad, r.minu, r.cnt, r.wage]));
  }
  /* 单人逐单明细（核算对账用） */
  let detail = null;
  if (selfId && q.detail) {
    detail = all(`SELECT r.report_date, r.qty_good, r.qty_bad, r.wage_type,
        COALESCE(r.work_hours, 0) work_hours,
        COALESCE(r.unit_price, pr.std_price, 0) unit_price,
        ROUND(${WAGE_EXPR}, 2) amount,
        o.code order_code, pr.name process_name
      FROM reports r JOIN orders o ON o.id=r.order_id
      LEFT JOIN order_steps s ON s.id=r.order_step_id
      LEFT JOIN processes pr ON pr.id=s.process_id
      WHERE r.worker_id=? AND ${COND} ORDER BY r.report_date DESC, r.id DESC`, [selfId].concat(ARGS));
  }
  /* 管理层汇总：工资总额与计件/计时构成、总工时、参与人数（口径与明细一致，操作工仅见本人） */
  const WJOIN = `FROM reports r JOIN users u ON u.id=r.worker_id
    LEFT JOIN orders o ON o.id=r.order_id
    LEFT JOIN order_steps s ON s.id=r.order_step_id
    LEFT JOIN processes pr ON pr.id=s.process_id`;
  const HOURS_EXPR = `COALESCE(r.work_hours, r.work_min/60.0, 0)`;
  const summary = get(`SELECT
      ROUND(SUM(${WAGE_EXPR}), 2) total_wage,
      ROUND(SUM(CASE WHEN r.wage_type='time' THEN ${WAGE_EXPR} ELSE 0 END), 2) time_wage,
      ROUND(SUM(CASE WHEN r.wage_type<>'time' THEN ${WAGE_EXPR} ELSE 0 END), 2) piece_wage,
      ROUND(SUM(${HOURS_EXPR}), 1) total_hours,
      SUM(r.qty_good) total_good, SUM(r.qty_bad) total_bad,
      COUNT(DISTINCT r.worker_id) headcount, COUNT(*) cnt
    ${WJOIN} WHERE ${COND}${SELF}`, FULL_ARGS) || {};
  /* 班组汇总：管理层按班组看人工成本分布 */
  const teams = all(`SELECT IFNULL(NULLIF(u.team,''),'未分组') team, COUNT(DISTINCT r.worker_id) headcount,
      SUM(r.qty_good) good, ROUND(SUM(${HOURS_EXPR}), 1) hours, COUNT(*) cnt,
      ROUND(SUM(${WAGE_EXPR}), 2) wage
    ${WJOIN} WHERE ${COND}${SELF}
    GROUP BY team ORDER BY wage DESC`, FULL_ARGS);
  /* 近6月工资趋势（不受所选周期影响，便于管理层看走势；仍按 worker 权限过滤） */
  const trend = all(`SELECT strftime('%Y-%m', r.report_date) ym,
      ROUND(SUM(${WAGE_EXPR}), 2) wage,
      ROUND(SUM(CASE WHEN r.wage_type='time' THEN ${WAGE_EXPR} ELSE 0 END), 2) time_wage,
      ROUND(SUM(${HOURS_EXPR}), 1) hours
    ${WJOIN} WHERE r.report_date >= date('now','-5 month','start of month')${SELF}
    GROUP BY ym ORDER BY ym`, selfId ? [selfId] : []);
  ok(res, { month, days, rows, detail, summary, teams, trend, self_only: !canAll });
});

/* ------------------------------ 升级：车间看板大屏（公开只读） ------------------------------ */
route('GET', '/api/public/board', ['*'], (req, res) => {
  const today = get(`SELECT COALESCE(SUM(qty_good),0) good, COALESCE(SUM(qty_bad),0) bad,
      COUNT(DISTINCT worker_id) workers, COUNT(*) cnt FROM reports WHERE report_date=date('now')`);
  const wip = all(`SELECT o.code, o.status, o.qty_plan, o.plan_end, p.name product_name,
      (SELECT COALESCE(qty_good,0) FROM order_steps WHERE order_id=o.id ORDER BY seq DESC LIMIT 1) qty_done
    FROM orders o JOIN products p ON p.id=o.product_id
    WHERE o.status IN ('released','running','paused') ORDER BY o.priority, o.plan_end LIMIT 10`);
  const openIssues = get(`SELECT COUNT(*) n FROM quality_issues WHERE status NOT IN ('closed','cancelled')`).n;
  const trend = all(`SELECT report_date d, SUM(qty_good) good, SUM(qty_bad) bad FROM reports
    WHERE report_date >= date('now','-6 day') GROUP BY report_date ORDER BY d`);
  const teams = all(`SELECT u.team, SUM(r.qty_good) good, SUM(r.qty_bad) bad FROM reports r JOIN users u ON u.id=r.worker_id
    WHERE r.report_date >= date('now','-29 day') AND u.team IS NOT NULL AND u.team != ''
    GROUP BY u.team ORDER BY good DESC LIMIT 8`);
  const latest = all(`SELECT r.report_date, r.qty_good, r.qty_bad, u.name worker_name, o.code order_code, pr.name process_name
    FROM reports r JOIN users u ON u.id=r.worker_id LEFT JOIN orders o ON o.id=r.order_id
    LEFT JOIN order_steps s ON s.id=r.order_step_id LEFT JOIN processes pr ON pr.id=s.process_id
    ORDER BY r.id DESC LIMIT 12`);
  const month = get(`SELECT COALESCE(SUM(qty_good),0) good, COALESCE(SUM(qty_bad),0) bad FROM reports WHERE report_date >= date('now','-29 day')`);
  ok(res, { today, wip, open_issues: openIssues, trend, teams, latest, month });
});

/* ------------------------------ 扫码报工：二维码 + 免登录接口 ------------------------------ */
/* ---- APP 登录态复用（与扫码免登录同口径，但身份来自会话）---- */
// 我的在制工单（按本人班组可见性过滤）
function appMyOrders(u) {
  return all(`SELECT o.id,o.code,o.status,o.qty_plan,
      (SELECT COALESCE(qty_good,0) FROM order_steps WHERE order_id=o.id ORDER BY seq DESC LIMIT 1) qty_done,
      (SELECT COALESCE(SUM(qty_bad),0) FROM order_steps WHERE order_id=o.id) qty_bad,
      p.name product_name, p.spec
     FROM orders o JOIN products p ON p.id=o.product_id
     WHERE o.status IN ('released','running','paused')
       AND (o.id IN (SELECT DISTINCT s.order_id FROM order_steps s WHERE s.assignee_team=?)
            OR o.id IN (SELECT DISTINCT s.order_id FROM order_steps s WHERE s.assignee_team IS NULL))
     ORDER BY o.priority,o.plan_end`, [u.team]);
}
route('GET', '/api/app/my_orders', [], (req, res, _m, _b, u) => {
  if (!u) return fail(res, '未登录', 401);
  ok(res, { worker: { id: u.id, name: u.name, team: u.team, role: u.role }, orders: appMyOrders(u) });
});
// 工单详情 + 可报工序（登录态；班组不匹配的工序标记为不可报）
route('GET', '/api/app/order/(\\d+)', [], (req, res, m, _b, u) => {
  if (!u) return fail(res, '未登录', 401);
  const o = get(`SELECT o.id,o.code,o.status,o.qty_plan,o.owner_name,o.wage_type,o.hourly_rate,
      (SELECT COALESCE(qty_good,0) FROM order_steps WHERE order_id=o.id ORDER BY seq DESC LIMIT 1) qty_done,
      (SELECT COALESCE(SUM(qty_bad),0) FROM order_steps WHERE order_id=o.id) qty_bad,
      p.name product_name,p.spec
    FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`, [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  const canManage = ['admin', 'technician'].includes(u.role);
  const steps = all(`SELECT s.id,s.seq,s.qty_plan,s.qty_good,s.qty_bad,s.status,s.assignee_team,s.allow_report,
      s.inspect_type,s.inspect_status,pr.name process_name,pr.code process_code,pr.std_price,
      (SELECT COUNT(*) FROM order_steps x WHERE x.order_id=s.order_id AND x.seq<s.seq)+1 AS seq_no
    FROM order_steps s JOIN processes pr ON pr.id=s.process_id WHERE s.order_id=? ORDER BY s.seq`, [m[1]]);
  for (const s of steps) {
    // 班组不符 → 不可报（管理员/技术员兜底可越权，与 doReport 一致）
    if (s.assignee_team && s.assignee_team !== u.team && !canManage) s.allow_report = 0;
  }
  const allR = all('SELECT id,name FROM bad_reasons ORDER BY id');
  const sel = all('SELECT bad_reason_id FROM order_bad_reasons WHERE order_id=?', [m[1]]).map((r) => r.bad_reason_id);
  const badReasons = (sel.length ? allR.filter((r) => sel.includes(r.id)) : allR).map((r) => ({ id: r.id, name: r.name }));
  ok(res, { order: o, steps, workers: [{ id: u.id, name: u.name, team: u.team }], badReasons });
});
// APP 提交报工（登录态代填 worker_id=本人；doReport 内部自带事务）
route('POST', '/api/app/reports', [], (req, res, _m, b, u) => {
  if (!u) return fail(res, '未登录', 401);
  try { ok(res, doReport(Object.assign({}, b, { worker_id: u.id }), u)); }
  catch (e) { fail(res, e.message, 400); }
});
// APP 提交检验判定（登录态质检员/管理员；doInspection 内部无事务，由外层包裹）
route('POST', '/api/app/inspections', ['admin', 'technician', 'inspector'], (req, res, _m, b, u) => {
  let r;
  tx(() => { r = doInspection(b, u); });
  ok(res, r);
});

/* ---- 扫码免登录（微信扫码入口）---- */
// 生成工单报工二维码（管理员/技术员）
route('GET', '/api/qr/order/(\\d+)', ['admin', 'technician'], (req, res, m, _b, u) => {
  const o = get('SELECT o.id,o.code,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  const token = qrToken('order', o.id);
  const url = baseUrl(req) + '/m/index.html?o=' + o.id + '&t=' + token;
  ok(res, { order: { id: o.id, code: o.code, product_name: o.product_name }, token, url, svg: makeQr(url) });
});

// 生成员工报工二维码（管理员/技术员）
route('GET', '/api/qr/worker/(\\d+)', ['admin', 'technician'], (req, res, m, _b, u) => {
  const w = get('SELECT id,name,team FROM users WHERE id=?', [m[1]]);
  if (!w) return fail(res, '员工不存在', 404);
  const token = qrToken('worker', w.id);
  const url = baseUrl(req) + '/m/index.html?w=' + w.id + '&t=' + token;
  ok(res, { worker: w, token, url, svg: makeQr(url) });
});

// 生成设备点检二维码（管理员/技术员）：扫码打开移动端点检页
route('GET', '/api/qr/equipment/(\\d+)', ['admin', 'technician'], (req, res, m, _b, u) => {
  const eq = get('SELECT id,code,name FROM equipments WHERE id=?', [m[1]]);
  if (!eq) return fail(res, '设备不存在', 404);
  const url = baseUrl(req) + '/m/app/index.html#/equip/' + eq.id;
  ok(res, { equipment: eq, url, svg: makeQr(url) });
});

// ------------------------------ 设备点检（P1） ------------------------------
// 点检记录：全员可打点（质检员点检可直接定级）；异常可勾选一键生成质量异常单（走统一上报口径）
route('POST', '/api/equipments/(\\d+)/check', ['admin', 'technician', 'worker', 'inspector'], (req, res, m, b, u) => {
  const eq = get('SELECT * FROM equipments WHERE id=?', [m[1]]);
  if (!eq) return fail(res, '设备不存在', 404);
  const result = b.result === 'abnormal' ? 'abnormal' : 'ok';
  let issue = null;
  let photos = [];
  tx(() => {
    const cid = insert('INSERT INTO equipment_checks(equipment_id,result,note,issue_id,checked_by,checked_name,created_at) VALUES(?,?,?,NULL,?,?,?)',
      [eq.id, result, b.note || null, u.id, u.name, now()]);
    // 点检拍照留证（防走过场）：JSON base64，最多 3 张
    try {
      const list = (Array.isArray(b.photos) ? b.photos : []).slice(0, 3);
      for (const ph of list) storeScanPhoto(ph, 'eqcheck', cid, photos);
      if (photos.length) run('UPDATE equipment_checks SET photos=? WHERE id=?', [JSON.stringify(photos), cid]);
    } catch (e) { /* 照片异常不阻断点检 */ }
    run('UPDATE equipments SET last_check_at=? WHERE id=?', [now(), eq.id]);
    if (result === 'abnormal' && b.fault) run("UPDATE equipments SET status='fault' WHERE id=?", [eq.id]);
    if (result === 'abnormal' && b.report) {
      // 检验员点检可直接定级；其他角色正式等级「待定级」，申报重大时通知全体检验员及时定级
      const lv = u.role === 'inspector' && ['minor', 'major', 'critical'].includes(b.level) ? b.level : 'pending';
      issue = createQualityIssue({
        level: lv, source: 'report', process_name: '设备点检 · ' + eq.name, qty_affected: 0,
        bad_summary: `设备点检异常：${eq.code} ${eq.name}${eq.location ? '（' + eq.location + '）' : ''}${b.note ? '：' + b.note : ''}`,
        created_by: u.id,
      });
      run('UPDATE equipment_checks SET issue_id=? WHERE id=?', [issue.id, cid]);
      if (u.role !== 'inspector' && ['major', 'critical'].includes(b.level)) {
        for (const ip of all("SELECT id,name FROM users WHERE role='inspector' AND active=1")) {
          notifyIssue(issue, ip, 'created', `操作工上报重大异常，请及时定级：${issue.code}`,
            `设备点检异常：${eq.code} ${eq.name}${eq.location ? '（' + eq.location + '）' : ''}（申报等级：${ISSUE_LEVEL_LABEL[b.level] || b.level}）${b.note ? '：' + b.note : ''}`, false);
        }
      }
    }
    writeLog(u, '设备点检', eq.code + ' ' + (result === 'ok' ? '正常' : '异常'));
  });
  ok(res, { issue });
});

// 点检历史（需登录）
route('GET', '/api/equipments/(\\d+)/checks', [], (req, res, m) => {
  ok(res, all('SELECT c.*, q.code issue_code, q.level issue_level FROM equipment_checks c LEFT JOIN quality_issues q ON q.id=c.issue_id WHERE c.equipment_id=? ORDER BY c.id DESC LIMIT 100', [m[1]]));
});

/* ------------------------------ 模具管理（设备模块分支） ------------------------------
 * 参考市面模具管理工具（Moldbase/EasyMold/MES 模具模块）核心能力轻量化：
 * 台账（编码/类型/腔数/适用产品/库位）· 上机/下机流转 · 维修 · 按生产件数周期保养 ·
 * 设计寿命预警 · 报工经机台自动累计生产数 · 全程履历。 */
const MOLD_STATUS = { idle: '在库', producing: '在机', repairing: '维修中', scrapped: '已报废' };
const MOLD_EVENT = { create: '建档', issue: '上机', return: '下机', repair: '送修', repair_done: '完修', maintain: '保养', scrap: '报废', edit: '编辑' };
function moldOut(r) {
  const maintainAt = r.maintain_every > 0 ? r.last_maintain_at + r.maintain_every : null;
  const lifePct = r.design_life > 0 ? Math.min(100, Math.round(r.total_shots * 100 / r.design_life)) : null;
  const lifeLeft = r.design_life > 0 ? Math.max(0, r.design_life - r.total_shots) : null;
  return Object.assign({}, r, {
    status_label: MOLD_STATUS[r.status] || r.status,
    work_center_name: r.work_center_id ? (get('SELECT name FROM work_centers WHERE id=?', [r.work_center_id]) || {}).name || null : null,
    maintain_at: maintainAt,
    need_maintain: !!needMaintain(r),
    life_pct: lifePct,
    life_left: lifeLeft,
    life_warn: r.design_life > 0 && r.total_shots >= r.design_life,
    maintain_pct: maintainAt ? Math.min(100, Math.round((r.total_shots - r.last_maintain_at) * 100 / r.maintain_every)) : null,
  });
}
function needMaintain(r) { return r.maintain_every > 0 && r.total_shots >= r.last_maintain_at + r.maintain_every; }
function moldEvent(moldId, type, u, opt) {
  opt = opt || {};
  insert('INSERT INTO mold_events(mold_id,type,work_center_id,order_id,note,cost,operator_id,operator_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [moldId, type, opt.work_center_id || null, opt.order_id || null, opt.note || null, num(opt.cost) || 0, u.id, u.name, now()]);
}

// 模具列表（含保养/寿命预警标记与汇总）
route('GET', '/api/molds', [], (req, res) => {
  const rows = all('SELECT * FROM molds ORDER BY id DESC').map(moldOut);
  ok(res, {
    summary: {
      total: rows.filter((r) => r.status !== 'scrapped').length,
      producing: rows.filter((r) => r.status === 'producing').length,
      repairing: rows.filter((r) => r.status === 'repairing').length,
      need_maintain: rows.filter((r) => r.status !== 'scrapped' && r.need_maintain).length,
      life_warn: rows.filter((r) => r.status !== 'scrapped' && r.life_warn).length,
    },
    rows,
  });
});

// 模具详情（含履历）
route('GET', '/api/molds/(\\d+)', [], (req, res, m) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  ok(res, Object.assign(moldOut(r), {
    events: all(`SELECT e.*, w.name work_center_name FROM mold_events e LEFT JOIN work_centers w ON w.id=e.work_center_id WHERE e.mold_id=? ORDER BY e.id DESC LIMIT 200`, [m[1]]),
  }));
});

// 新建/编辑模具（admin/technician）
function moldPayload(b) {
  return {
    code: String(b.code || '').trim(),
    name: String(b.name || '').trim(),
    category: b.category || null,
    cavities: Math.max(1, num(b.cavities, 1)),
    product_name: b.product_name || null,
    location: b.location || null,
    design_life: Math.max(0, num(b.design_life, 0)),
    maintain_every: Math.max(0, num(b.maintain_every, 0)),
    remark: b.remark || null,
  };
}
route('POST', '/api/molds', ['admin', 'technician'], (req, res, _m, b, u) => {
  const p = moldPayload(b);
  if (!p.code || !p.name) return fail(res, '请填写模具编码与名称');
  if (get('SELECT id FROM molds WHERE code=?', [p.code])) return fail(res, '模具编码已存在：' + p.code);
  const id = tx(() => {
    const mid = insert('INSERT INTO molds(code,name,category,cavities,product_name,location,status,design_life,total_shots,maintain_every,last_maintain_at,remark,created_at) VALUES(?,?,?,?,?,?,\'idle\',?,?,?,0,?,?)',
      [p.code, p.name, p.category, p.cavities, p.product_name, p.location, p.design_life, 0, p.maintain_every, p.remark, now()]);
    moldEvent(mid, 'create', u, { note: '建档：' + p.code + ' ' + p.name });
    return mid;
  });
  writeLog(u, '新建模具', p.code + ' ' + p.name);
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [id])));
});
route('PUT', '/api/molds/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  const p = moldPayload(b);
  if (!p.code || !p.name) return fail(res, '请填写模具编码与名称');
  if (get('SELECT id FROM molds WHERE code=? AND id<>?', [p.code, r.id])) return fail(res, '模具编码已存在：' + p.code);
  tx(() => {
    run(`UPDATE molds SET code=?,name=?,category=?,cavities=?,product_name=?,location=?,design_life=?,maintain_every=?,remark=? WHERE id=?`,
      [p.code, p.name, p.category, p.cavities, p.product_name, p.location, p.design_life, p.maintain_every, p.remark, r.id]);
    moldEvent(r.id, 'edit', u, { note: '修改档案' });
  });
  writeLog(u, '编辑模具', p.code);
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [r.id])));
});

// 删除（仅 admin；已有履历也一并删，通常建议走「报废」留痕）
route('DELETE', '/api/molds/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const r = get('SELECT code,name FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  run('DELETE FROM molds WHERE id=?', [m[1]]);
  writeLog(u, '删除模具', r.code + ' ' + r.name);
  ok(res, true);
});

// 上机（在库 → 在机，绑机台，可带工单）
route('POST', '/api/molds/(\\d+)/issue', ['admin', 'technician'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  if (r.status === 'scrapped') return fail(res, '模具已报废，不可上机');
  if (r.status === 'producing') return fail(res, '模具当前在机（' + MOLD_STATUS[r.status] + '），请先下机');
  if (r.status === 'repairing') return fail(res, '模具维修中，完修后方可上机');
  const wc = get('SELECT id,name FROM work_centers WHERE id=?', [num(b.work_center_id)]);
  if (!wc) return fail(res, '请选择要上机的机台/工位');
  const orderId = num(b.order_id) || null;
  if (orderId && !get('SELECT id FROM orders WHERE id=?', [orderId])) return fail(res, '关联工单不存在');
  tx(() => {
    run("UPDATE molds SET status='producing', work_center_id=? WHERE id=?", [wc.id, r.id]);
    moldEvent(r.id, 'issue', u, { work_center_id: wc.id, order_id: orderId, note: b.note || ('上机：' + wc.name) });
  });
  writeLog(u, '模具上机', r.code + ' → ' + wc.name);
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [r.id])));
});

// 下机归还（在机 → 在库）
route('POST', '/api/molds/(\\d+)/return', ['admin', 'technician'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  if (r.status !== 'producing') return fail(res, '仅「在机」模具可下机');
  tx(() => {
    run("UPDATE molds SET status='idle', work_center_id=NULL WHERE id=?", [r.id]);
    moldEvent(r.id, 'return', u, { work_center_id: r.work_center_id, note: b.note || '下机归还' });
  });
  writeLog(u, '模具下机', r.code);
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [r.id])));
});

// 送修（非报废 → 维修中；现场工人也可报修）与完修（维修中 → 在库）
route('POST', '/api/molds/(\\d+)/repair', ['admin', 'technician', 'worker', 'inspector'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  if (r.status === 'scrapped') return fail(res, '模具已报废');
  if (r.status === 'repairing') return fail(res, '模具已在维修中');
  tx(() => {
    run("UPDATE molds SET status='repairing', work_center_id=NULL WHERE id=?", [r.id]);
    moldEvent(r.id, 'repair', u, { work_center_id: r.work_center_id, note: b.note || '送修', cost: b.cost });
  });
  writeLog(u, '模具送修', r.code + (b.note ? '：' + b.note : ''));
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [r.id])));
});
route('POST', '/api/molds/(\\d+)/repair_done', ['admin', 'technician'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  if (r.status !== 'repairing') return fail(res, '仅「维修中」模具可完修');
  tx(() => {
    run("UPDATE molds SET status='idle' WHERE id=?", [r.id]);
    moldEvent(r.id, 'repair_done', u, { note: b.note || '维修完成', cost: b.cost });
  });
  writeLog(u, '模具完修', r.code);
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [r.id])));
});

// 保养（非报废均可，重置保养周期基准；支持在机保养）
route('POST', '/api/molds/(\\d+)/maintain', ['admin', 'technician'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  if (r.status === 'scrapped') return fail(res, '模具已报废');
  tx(() => {
    run('UPDATE molds SET last_maintain_at=total_shots, last_maintain_time=? WHERE id=?', [now(), r.id]);
    moldEvent(r.id, 'maintain', u, { work_center_id: r.work_center_id, note: b.note || '例行保养', cost: b.cost });
  });
  writeLog(u, '模具保养', r.code);
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [r.id])));
});

// 报废（终态，清机台）
route('POST', '/api/molds/(\\d+)/scrap', ['admin', 'technician'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM molds WHERE id=?', [m[1]]);
  if (!r) return fail(res, '模具不存在', 404);
  if (r.status === 'scrapped') return fail(res, '模具已报废');
  tx(() => {
    run("UPDATE molds SET status='scrapped', work_center_id=NULL WHERE id=?", [r.id]);
    moldEvent(r.id, 'scrap', u, { note: b.note || '报废' });
  });
  writeLog(u, '模具报废', r.code);
  ok(res, moldOut(get('SELECT * FROM molds WHERE id=?', [r.id])));
});


// ------------------------------ 工序 SOP / 图纸附件（P1） ------------------------------
const SOP_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt'];
function uploadDir() {
  return path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
}
// 上传/更换工序 SOP（管理员/技术员）：JSON base64，≤12MB，扩展名白名单
route('POST', '/api/processes/(\\d+)/sop', ['admin', 'technician'], (req, res, m, b, u) => {
  const p = get('SELECT id,code,name FROM processes WHERE id=?', [m[1]]);
  if (!p) return fail(res, '工序不存在', 404);
  if (!b.name) return fail(res, '请选择要上传的文件');
  const buf = Buffer.from(String(b.data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) return fail(res, '文件内容为空');
  if (buf.length > 12 * 1024 * 1024) return fail(res, '文件不能超过 12MB');
  const safe = String(b.name).replace(/[\\/:*?"<>|]/g, '_').slice(-120);
  if (!SOP_EXT.includes(path.extname(safe).toLowerCase())) return fail(res, '仅支持 ' + SOP_EXT.join(' ') + ' 格式');
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });
  // 同一工序只保留最新一份：先清旧文件
  const old = get('SELECT sop_file FROM processes WHERE id=?', [p.id]);
  if (old && old.sop_file) { try { fs.unlinkSync(path.join(dir, old.sop_file)); } catch (e) { /* 忽略 */ } }
  const fname = 'sop_' + p.id + '_' + Date.now() + '_' + safe;
  fs.writeFileSync(path.join(dir, fname), buf);
  run('UPDATE processes SET sop_file=?, sop_name=? WHERE id=?', [fname, safe, p.id]);
  writeLog(u, '上传工序SOP', p.code + ' ' + safe);
  ok(res, { sop_file: fname, sop_name: safe });
});
// 删除工序 SOP（管理员/技术员）
route('DELETE', '/api/processes/(\\d+)/sop', ['admin', 'technician'], (req, res, m, _b, u) => {
  const p = get('SELECT id,code,sop_file FROM processes WHERE id=?', [m[1]]);
  if (!p || !p.sop_file) return fail(res, '该工序未上传 SOP/图纸', 404);
  try { fs.unlinkSync(path.join(uploadDir(), p.sop_file)); } catch (e) { /* 文件可能已被手动清理 */ }
  run('UPDATE processes SET sop_file=NULL, sop_name=NULL WHERE id=?', [p.id]);
  writeLog(u, '删除工序SOP', p.code);
  ok(res, { ok: true });
});

// 免登录：按工单令牌读取工单与工序（员工码可凭 wid 访问其被指派班组的工单）
route('GET', '/api/public/order/(\\d+)', ['*'], (req, res, m, _b, _u, q) => {
  const orderOk = checkQrToken(q.t, 'order', m[1]);
  const wAssigned = q.wid && checkQrToken(q.t, 'worker', q.wid);
  // 存在未指派班组的工序 → 该工单对全员开放报工；否则仅被指派班组的员工可看
  const wTeam = q.wid ? (get('SELECT team FROM users WHERE id=?', [num(q.wid)]) || {}).team : null;
  const orderOpen = !!get('SELECT 1 FROM order_steps WHERE order_id=? AND assignee_team IS NULL', [m[1]]);
  const workerHere = wTeam && !!get('SELECT 1 FROM order_steps WHERE order_id=? AND assignee_team=?', [m[1], wTeam]);
  if (!orderOk && !wAssigned) return fail(res, '二维码已失效或无权限', 403);
  if (!orderOk && wAssigned && !workerHere && !orderOpen) return fail(res, '您暂无该工单的报工权限', 403);
  const o = get(`SELECT o.id,o.code,o.status,o.qty_plan,
      (SELECT COALESCE(qty_good,0) FROM order_steps WHERE order_id=o.id ORDER BY seq DESC LIMIT 1) qty_done,
      (SELECT COALESCE(SUM(qty_bad),0) FROM order_steps WHERE order_id=o.id) qty_bad,
      p.name product_name,p.spec
    FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`, [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  const steps = all('SELECT s.id,s.seq,s.qty_plan,s.qty_good,s.qty_bad,s.status,s.assignee_team,s.allow_report,s.inspect_type,s.inspect_status,pr.name process_name,pr.code process_code,(SELECT COUNT(*) FROM order_steps x WHERE x.order_id=s.order_id AND x.seq<s.seq)+1 AS seq_no FROM order_steps s JOIN processes pr ON pr.id=s.process_id WHERE s.order_id=? ORDER BY s.seq', [m[1]]);
  const workers = all("SELECT id,name,team FROM users WHERE role IN ('worker','technician') AND active=1 ORDER BY team,name");
  const sel = all('SELECT bad_reason_id FROM order_bad_reasons WHERE order_id=?', [m[1]]).map((r) => r.bad_reason_id);
  const allR = all('SELECT id,name FROM bad_reasons ORDER BY id');
  const badReasons = (sel.length ? allR.filter((r) => sel.includes(r.id)) : allR).map((r) => ({ id: r.id, name: r.name }));
  ok(res, { order: o, steps, workers, badReasons });
});

// 免登录：按员工令牌读取该员工在制工单
route('GET', '/api/public/worker/(\\d+)', ['*'], (req, res, m, _b, _u, q) => {
  if (!checkQrToken(q.t, 'worker', m[1])) return fail(res, '二维码已失效或无权限', 403);
  const w = get('SELECT id,name,team FROM users WHERE id=?', [m[1]]);
  if (!w) return fail(res, '员工不存在', 404);
  const orders = all(`SELECT o.id,o.code,o.status,o.qty_plan,
      (SELECT COALESCE(qty_good,0) FROM order_steps WHERE order_id=o.id ORDER BY seq DESC LIMIT 1) qty_done,
      (SELECT COALESCE(SUM(qty_bad),0) FROM order_steps WHERE order_id=o.id) qty_bad,
      p.name product_name
     FROM orders o JOIN products p ON p.id=o.product_id
     WHERE o.status IN ('released','running','paused')
       AND (o.id IN (SELECT DISTINCT s.order_id FROM order_steps s WHERE s.assignee_team=?)
            OR o.id IN (SELECT DISTINCT s.order_id FROM order_steps s WHERE s.assignee_team IS NULL))
     ORDER BY o.priority,o.plan_end`, [w.team]);
  ok(res, { worker: w, orders });
});

// 生成质检员待检队列二维码（管理员/技术员）——质检员扫码进入待检队列直接判定
route('GET', '/api/qr/inspector/(\\d+)', ['admin', 'technician'], (req, res, m, _b, u) => {
  const w = get("SELECT id,name,team FROM users WHERE id=? AND role='inspector'", [m[1]]);
  if (!w) return fail(res, '质检员不存在', 404);
  const token = qrToken('worker', w.id);
  const url = baseUrl(req) + '/m/index.html?q=' + w.id + '&t=' + token;
  ok(res, { worker: w, token, url, svg: makeQr(url) });
});

// 免登录：质检员待检队列（扫码即判）
route('GET', '/api/public/inspector/(\\d+)', ['*'], (req, res, m, _b, _u, q) => {
  if (!checkQrToken(q.t, 'worker', m[1])) return fail(res, '二维码已失效或无权限', 403);
  const w = get("SELECT id,name,team,role FROM users WHERE id=?", [m[1]]);
  if (!w) return fail(res, '用户不存在', 404);
  const steps = all(`SELECT s.id order_step_id, s.order_id, s.seq, s.inspect_type, s.qty_plan, s.qty_good, s.qty_bad, s.assignee_team,
      p.name process_name, p.code process_code, o.code order_code, o.status order_status, od.name product_name,
      (SELECT pr.name FROM users pr WHERE pr.id=s.assignee_id) last_worker,
      (SELECT COUNT(*) FROM order_steps x WHERE x.order_id=s.order_id AND x.seq<s.seq)+1 AS seq_no
    FROM order_steps s JOIN orders o ON o.id=s.order_id
    LEFT JOIN processes p ON p.id=s.process_id LEFT JOIN products od ON od.id=o.product_id
    WHERE s.inspect_status='waiting' AND o.status NOT IN ('closed') ORDER BY s.id DESC LIMIT 200`);
  const badReasons = all('SELECT id,name FROM bad_reasons ORDER BY id');
  ok(res, { worker: w, steps, badReasons });
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
// 单据仅传了 material_id 时，从物料档案回带编码/名称/规格/单位/默认仓库，避免 NOT NULL 字段落空
function fillFromMaterial(b, mid) {
  if (!mid) return;
  const m = get('SELECT code,name,spec,unit,warehouse_id FROM materials WHERE id=?', [mid]);
  if (!m) return;
  if (!String(b.material_code || '').trim()) b.material_code = m.code;
  if (!String(b.material_name || '').trim()) b.material_name = m.name;
  if (!String(b.product_code || '').trim()) b.product_code = m.code;
  if (!String(b.product_name || '').trim()) b.product_name = m.name;
  if (!String(b.material_spec || '').trim()) b.material_spec = m.spec || null;
  if (!String(b.spec || '').trim()) b.spec = m.spec || null;
  if (!String(b.unit || '').trim()) b.unit = m.unit || '件';
  if (!b.warehouse_id && m.warehouse_id) b.warehouse_id = m.warehouse_id;
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
  // 出库未指定批次：自动按批次分扣（先扣无批次行，再按入库时间先进先出），支持跨批次合计出库
  if (qty < 0 && !String(o.batch || '').trim() && !o._autoBatch) {
    const lines = all("SELECT * FROM inventory WHERE material_id=? AND IFNULL(warehouse_id,0)=? AND qty>1e-9 ORDER BY (CASE WHEN IFNULL(batch,'')='' THEN 0 ELSE 1 END), updated_at ASC, id ASC",
      [materialId, num(wh)]);
    const total = lines.reduce((s, r) => s + num(r.qty), 0);
    if (total < -qty - 1e-9) throw new Error('库存不足：' + m.name + '，当前库存 ' + (Math.round(total * 1e6) / 1e6) + '，本次出库 ' + Math.abs(qty));
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

/* ------------------------------ 报工自动成品入库（末道工序） ------------------------------
 * 工单最后一道工序（seq 最大）报工合格数，自动计入成品仓，生成 finished_goods_in 单据 + 收发明细。
 * 物料按产品编码映射：已有成品物料直接复用，否则按产品档案自动建档（成品类，默认进成品仓）。
 * 与手动成品入库规则一致：合格数入库，不良数不计；仓库缺省回退成品仓。 */
function ensureFgWarehouse() {
  let w = get("SELECT id FROM warehouses WHERE code='FG'");
  if (w) return w.id;
  w = get("SELECT id FROM warehouses WHERE name LIKE '%成品%' LIMIT 1");
  if (w) return w.id;
  return insert("INSERT INTO warehouses(code,name,remark,created_at) VALUES('FG','成品仓','报工自动入库默认仓库',?)", [now()]);
}
function ensureFgMaterial(product) {
  if (!product || !product.code) return null;
  const m = get('SELECT id FROM materials WHERE code=?', [product.code]);
  if (m) return m.id;
  const wid = ensureFgWarehouse();
  return insert(`INSERT INTO materials(code,name,spec,material,category,unit,warehouse_id,location,safe_min,safe_max,active,remark,created_at)
    VALUES(?,?,?,NULL,'成品',?,?,NULL,0,NULL,1,?,?)`,
    [product.code, product.name, product.spec || null, product.unit || '件', wid, '报工自动入库生成', now()]);
}
// 末道工序合格数自动成品入库；返回生成的单据摘要（供 doReport 回传前端提示）
function autoFinishIn(order, product, good, actor, stepId, reportId, remarkTag) {
  const mid = ensureFgMaterial(product);
  if (!mid) return null;
  const wh = ensureFgWarehouse();
  const code = genCode('RK');
  const remark = '报工自动入库（末道工序）' + (remarkTag || '');
  const id = insert(`INSERT INTO finished_goods_in(code,in_date,order_id,report_id,material_id,warehouse_id,product_code,product_name,spec,qty,unit,batch,location,inspector,result,remark,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [code, today(), order.id, reportId || null, mid, wh, product.code || null, product.name, product.spec || null,
      good, product.unit || '件', null, null, null, 'qualified', remark, actor.id, now()]);
  applyStock({ material_id: mid, warehouse_id: wh, batch: null, location: null, qty: good, tx_type: 'in_finish',
    ref_type: 'finished_goods_in', ref_id: id, ref_code: code, order_id: order.id, operator: actor.name, tx_date: today(), remark: '成品入库 ' + code });
  return { id, code, qty: good, material_id: mid, warehouse_id: wh };
}

/* ==================== 检验与质量异常（一期：初版检验模式） ====================
 * 设计：检验点是「工序属性」（processes/route_steps/order_steps 的 inspect_type），
 * 报工后该工序落 inspect_status='waiting'（待检），由质检员判定：
 *   pass 合格 → 放行完工（末道触发成品自动入库）
 *   concession 让步接收 → 放行完工，入库单备注「特采」
 *   fail 不合格 → 工序置 inspect_status='failed'，自动生成质量异常单并推送责任管理人员
 * 异常单按「工序指派班组 → 该班组 technician」定责，超时未处理自动抄送/升级。
 * 严重异常（critical）暂停工单后续工序流转并禁止成品入库，需管理员确认后放行。
 */
const INSPECT_LABEL = { iqc: '首检', ipqc: '过程检', fqc: '终检' };
const ISSUE_LEVEL_LABEL = { pending: '待定级', minor: '轻微', major: '严重', critical: '致命' };
const DISPOSITION_LABEL = { rework: '返工', repair: '返修', concession: '让步接收', scrap: '报废' };

// 通知配置（可在 settings 表覆盖）：站内待办必发，webhook 留空则跳过外部推送
function getSetting(key, def) {
  try {
    const r = get('SELECT value FROM settings WHERE key=?', [key]);
    return r && r.value !== null && r.value !== undefined ? r.value : def;
  } catch (e) { return def; }
}

// 定责：优先该工序指派班组 → 班组 technician；再退工单创建人；最后 admin
// 工序在其工单内的显示道次（seq 按 10 递增存储，展示时换算为 1 开始的顺序号）
function stepSeqNo(orderId, seq) {
  return num(get('SELECT COUNT(*) c FROM order_steps WHERE order_id=? AND seq<?', [orderId, seq]).c) + 1;
}

function resolveIssueAssignee(step, order) {
  const team = step && step.assignee_team;
  if (team) {
    const l = get("SELECT id,name FROM users WHERE role='technician' AND team=? AND active=1 ORDER BY id LIMIT 1", [team]);
    if (l) return l;
  }
  if (order && order.created_by) {
    const c = get('SELECT id,name FROM users WHERE id=? AND active=1', [order.created_by]);
    if (c && c.role !== 'worker') return c;
  }
  const a = get("SELECT id,name FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
  return a || { id: null, name: '未指派' };
}

// 投递站内待办 + 记录通知痕迹（外部 webhook 见 pushExternal）
/* ---- 通用消息中心（APP 通知）----
 * 场景 source：quality 质量异常 | stock 库存预警 | assign 派工待办 | system 系统公告
 * 全部消息落在 issue_notifications（channel='inbox'），issue_id 可空，用 ref_type/ref_id/link 记录跳转目标。
 */
const MSG_SOURCE_LABEL = { quality: '质量异常', stock: '库存预警', assign: '派工待办', system: '系统消息' };
// 消息小类（kind）→ 中文动词，APP 消息列表按此显示
const MSG_KIND_LABEL = {
  created: '新消息', remind: '催办', escalate: '升级', handled: '已处理', closed: '已闭环', cancelled: '已作废',
};

// 统一投递：给一个或多个用户发站内消息（自动去重收件人）
function pushMessage(opt) {
  const ts = now();
  const src = opt.source || 'system';
  const users = (Array.isArray(opt.toUsers) ? opt.toUsers : [opt.toUsers]).filter((u) => u && u.id);
  const seen = new Set();
  for (const u of users) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    insert(`INSERT INTO issue_notifications(issue_id,to_user_id,to_name,channel,kind,title,body,source,ref_type,ref_id,link,read_at,sent_at,ok)
      VALUES(?,?,?,'inbox',?,?,?,?,?,?,?,NULL,?,1)`,
      [opt.issue_id || null, u.id, u.name || '', opt.kind || 'created', opt.title || '', opt.body || '',
        src, opt.ref_type || null, opt.ref_id || null, opt.link || null, ts]);
  }
  return seen.size;
}

// 给指定角色的全部在职用户发消息
function usersByRole(...roles) {
  const ph = roles.map(() => '?').join(',');
  return all(`SELECT id,name,role,team FROM users WHERE role IN (${ph}) AND active=1`, roles);
}

function notifyIssue(issue, toUser, kind, title, body, external) {
  const ts = now();
  insert('INSERT INTO issue_notifications(issue_id,to_user_id,to_name,channel,kind,title,body,source,ref_type,ref_id,link,read_at,sent_at,ok) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,1)',
    [issue.id, toUser && toUser.id ? toUser.id : null, toUser ? toUser.name : '', 'inbox', kind, title, body,
      'quality', 'issue', issue.id, '#/quality/issue/' + issue.id, ts]);
  // 抄送超级管理员（升级时）
  if (kind === 'escalate') {
    const admins = all("SELECT id,name FROM users WHERE role='admin' AND active=1");
    for (const a of admins) {
      if (toUser && a.id === toUser.id) continue;
      insert('INSERT INTO issue_notifications(issue_id,to_user_id,to_name,channel,kind,title,body,source,ref_type,ref_id,link,read_at,sent_at,ok) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,1)',
        [issue.id, a.id, a.name, 'inbox', kind, title, body, 'quality', 'issue', issue.id, '#/quality/issue/' + issue.id, ts]);
    }
  }
  // 上报口径：external !== false 才推外部管理层群；一般异常仅站内，超时升级时再推
  if (external !== false) pushExternal(issue, kind, title, body);
}

// 外部推送（企业微信/钉钉群机器人）。webhook 未配置时静默跳过，不影响主流程。
function pushExternal(issue, kind, title, body) {
  const url = getSetting('webhook_url', '');
  if (!url || !/^https:\/\//.test(url)) return;
  const text = `【质量异常·${ISSUE_LEVEL_LABEL[issue.level] || issue.level}】${title}\n${body || ''}\n单号：${issue.code}　状态：${issue.status}`;
  try {
    // 同时兼容企业微信({msgtype:text}) 与 钉钉({msgtype:markdown}) 的报文
    const payload = /dingtalk/i.test(url)
      ? { msgtype: 'markdown', markdown: { title: title, text: text } }
      : { msgtype: 'text', text: { content: text } };
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .catch(() => { /* 推送失败不阻塞业务 */ });
  } catch (e) { /* 忽略 */ }
}

/* ---- 派工待办通知：工单下发 / 工序指派班组 → 通知该班组成员 ---- */
function notifyAssign(order, orderId, onlySteps) {
  const steps = onlySteps && onlySteps.length
    ? onlySteps.filter((s) => s.assignee_team)
    : all("SELECT * FROM order_steps WHERE order_id=? AND IFNULL(assignee_team,'')<>'' ORDER BY seq", [orderId]);
  if (!steps.length) return 0;
  // 按班组聚合，一个班组只发一条汇总消息
  const byTeam = {};
  for (const s of steps) {
    const t = s.assignee_team;
    if (!byTeam[t]) byTeam[t] = [];
    byTeam[t].push(s);
  }
  let sent = 0;
  for (const team of Object.keys(byTeam)) {
    const members = all("SELECT id,name FROM users WHERE team=? AND active=1 AND role<>'admin'", [team]);
    if (!members.length) continue;
    const names = byTeam[team].map((s) => s.process_name || ('工序' + stepSeqNo(s.order_id, s.seq)));
    const plan = byTeam[team][0].qty_plan;
    sent += pushMessage({
      source: 'assign',
      toUsers: members,
      kind: 'created',
      title: `新任务：${order.code} 待报工`,
      body: `产品 ${order.product_name || '-'}　计划 ${plan} 件\n工序：${names.join('、')}\n请到「报工」扫码或选择工单开始生产。`,
      ref_type: 'order', ref_id: Number(orderId), link: '#/orders',
    });
  }
  return sent;
}

/* ---- 库存预警：低于安全下限 → 通知仓管/管理员；同一物料同一天只提醒一次 ---- */
function scanStockAlerts(actor) {
  const stocks = all(`SELECT m.id, m.code, m.name, m.unit, m.safe_min, m.safe_max,
      IFNULL(SUM(i.qty),0) qty
    FROM materials m LEFT JOIN inventory i ON i.material_id=m.id
    WHERE m.active=1 AND IFNULL(m.safe_min,0) > 0
    GROUP BY m.id`);
  const todayStr = today();
  const receivers = usersByRole('admin');
  const keepers = all("SELECT id,name FROM users WHERE active=1 AND (role='technician' OR IFNULL(team,'') LIKE '%仓%')");
  const targets = receivers.concat(keepers);
  let fired = 0;
  for (const s of stocks) {
    const short = Number(s.qty) < Number(s.safe_min);
    if (!short) continue;
    // 去重：同日已提醒过则跳过
    const dup = get('SELECT 1 FROM stock_alerts WHERE material_id=? AND alert_date=?', [s.id, todayStr]);
    if (dup) continue;
    run('INSERT INTO stock_alerts(material_id,alert_date,level,qty,safe_min,created_at) VALUES(?,?,?,?,?,?)',
      [s.id, todayStr, 'short', s.qty, s.safe_min, now()]);
    fired += pushMessage({
      source: 'stock',
      toUsers: targets,
      kind: 'created',
      title: `库存预警：${s.name} 低于安全库存`,
      body: `物料 ${s.code} ${s.name}\n当前库存 ${s.qty} ${s.unit}　安全下限 ${s.safe_min} ${s.unit}\n缺口 ${Math.max(0, Number(s.safe_min) - Number(s.qty))} ${s.unit}，请及时补货。`,
      ref_type: 'material', ref_id: s.id, link: '#/warehouse',
    });
    }
  return fired;
}

// 定时扫描库存预警（每 10 分钟）
function scanStockAlertsTick() {
  try { scanStockAlerts(null); } catch (e) { /* 忽略 */ }
}

// 生成质量异常单（不合格 / 报工上报共用）
function createQualityIssue(opt) {  const ts = now();
  const code = genCode('QA');
  const step = opt.order_step_id ? get('SELECT * FROM order_steps WHERE id=?', [opt.order_step_id]) : null;
  const order = opt.order_id ? get('SELECT * FROM orders WHERE id=?', [opt.order_id]) : null;
  // 工单负责人优先：若工单指定了负责人，则该工单的检验反馈异常首推负责人处理；否则沿用原定责链路
  // 工单负责人优先（不含操作工：历史脏数据兜底走定责链）；否则沿用原定责链路
  const ownerRaw2 = (order && order.owner_user_id) ? get('SELECT id,name,active,role FROM users WHERE id=? AND active=1', [order.owner_user_id]) : null;
  const orderOwner = ownerRaw2 && ownerRaw2.role !== 'worker' ? ownerRaw2 : null;
  const assignee = orderOwner || resolveIssueAssignee(step, order);
  const id = insert(`INSERT INTO quality_issues(code,level,source,order_id,order_step_id,inspection_id,product_id,product_name,order_code,process_name,
      qty_affected,bad_summary,status,assignee_user_id,assignee_name,claimed_at,due_at,escalated,cause,action,disposition,verifier,closed_at,created_by,created_at,supplier)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,NULL,?,0,NULL,NULL,NULL,NULL,NULL,?,?,?)`,
    [code, opt.level || 'major', opt.source || 'inspect', opt.order_id || null, opt.order_step_id || null, opt.inspection_id || null,
      opt.product_id || null, opt.product_name || null, order ? order.code : null, opt.process_name || null,
      num(opt.qty_affected), opt.bad_summary || null,
      assignee.id, assignee.name,
      ts.slice(0, 19), // due_at 由扫描器按等级计算；此处占位
      opt.created_by || null, ts, opt.supplier || null]);
  const issue = get('SELECT * FROM quality_issues WHERE id=?', [id]);
  const title = `${order ? order.code : '工单'} · ${opt.process_name || '工序'} 出现${ISSUE_LEVEL_LABEL[issue.level]}质量异常`;
  const body = `不良${issue.qty_affected}件：${issue.bad_summary || '未填写原因'}（${DISPOSITION_LABEL[issue.disposition] || '待处理'}）`;
  const creator = opt.created_by ? get('SELECT id,role FROM users WHERE id=?', [opt.created_by]) : null;
  const creatorIsInspector = !!(creator && creator.role === 'inspector');
  // 上报口径（2026-10-06 修订）：
  // 1) 致命级（任何来源）：通知责任处理人 + 厂部管理层（webhook 群 + 管理员站内升级）。
  // 2) 检验员上报 / 检验判定 / 来料判定开单（非致命）：仅通知责任处理人（不推管理层）。
  // 3) 操作工/代报上报（source=report，非检验员）：正式等级仍为「待定级」，只留存数据记录与统计，
  //    不通知责任人与管理层；其中申报为重大（严重/致命）的，由上报接口另行通知检验员及时定级。
  const isCritical = issue.level === 'critical';
  if (isCritical) {
    notifyIssue(issue, assignee, 'created', title, body, true);
    const admins = all("SELECT id,name FROM users WHERE role='admin' AND active=1").filter((a) => !assignee || a.id !== assignee.id);
    pushMessage({
      source: 'quality', toUsers: admins, kind: 'escalate', issue_id: issue.id,
      ref_type: 'issue', ref_id: issue.id, link: '#/quality/issue/' + issue.id,
      title: `重大质量异常：${issue.code}`, body: `${title}　${body}`,
    });
  } else if (creatorIsInspector || (opt.source || 'inspect') !== 'report') {
    notifyIssue(issue, assignee, 'created', title, body, false);
  }
  // 非检验员上报（source=report，非致命申报）：只留存，不发任何通知
  return issue;
}

// 检验判定 → 写检验记录；仅重大异常（critical）自动开异常单并逐级上报管理层，一般不合格待返工重检
function doInspection(b, actor) {
  const stepId = num(b.order_step_id);
  const step = get('SELECT s.*, p.name process_name FROM order_steps s LEFT JOIN processes p ON p.id=s.process_id WHERE s.id=?', [stepId]);
  if (!step) throw new Error('工序不存在');
  const order = get('SELECT * FROM orders WHERE id=?', [step.order_id]);
  if (!order) throw new Error('工单不存在');
  if (String(step.inspect_status || '') !== 'waiting') throw new Error('该工序当前不在待检状态，无需检验');

  // 检验方式：full 全检（默认）/ sample 抽检（受检数=样本数，合格样本数=样本数-不合格数）
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
  if (!['pass', 'fail', 'concession'].includes(conclusion)) {
    conclusion = qtyFail > 0 ? 'fail' : 'pass';
  }
  if (conclusion === 'pass' && qtyFail > 0) throw new Error('判定合格时不合格数必须为 0');
  if (conclusion !== 'pass' && qtyFail <= 0) throw new Error('判定不合格/让步接收时须填写不合格数');

  // 检验项目检查表（可选，来自绑定工序的模板）：逐项 OK/NG/未检，NG 项并入不良明细
  const clResults = [];
  for (const c of (Array.isArray(b.checklist) ? b.checklist : [])) {
    const nm = String(c.name || '').trim();
    if (!nm) continue;
    clResults.push({ name: nm, standard: String(c.standard || '').trim(),
      result: ['ok', 'ng', 'skip'].includes(c.result) ? c.result : 'skip',
      qty: Math.max(0, Math.floor(num(c.qty))), remark: String(c.remark || '').trim() });
  }
  const ngItems = clResults.filter((c) => c.result === 'ng');
  if (conclusion === 'pass' && ngItems.some((c) => c.qty > 0)) {
    throw new Error('存在 NG 检验项（' + ngItems.filter((c) => c.qty > 0).map((c) => c.name).join('、') + '），不能判定合格');
  }

  const insCode = genCode('QC');
  const qtyCheck = mode === 'sample' ? sampleQty : qtyPass + qtyFail;
  const inspId = insert(`INSERT INTO inspections(code,order_id,order_step_id,report_id,process_name,inspector_id,inspector,qty_check,qty_pass,qty_fail,conclusion,remark,inspect_mode,sample_qty,checklist_result,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [insCode, order.id, step.id, num(b.report_id) || null, step.process_name || null, actor.id, actor.name,
      qtyCheck, qtyPass, qtyFail, conclusion, b.remark || '', mode, sampleQty,
      clResults.length ? JSON.stringify(clResults) : null, now()]);

  // 不良明细（可多种）
  const defects = Array.isArray(b.defects) ? b.defects : [];
  const summary = [];
  for (const d of defects) {
    const q = Math.max(0, Math.floor(num(d.qty)));
    if (q <= 0) continue;
    let brId = num(d.bad_reason_id) || 0;
    let name = '';
    const detail = String(d.bad_reason_detail || '').trim();
    if (brId) {
      const br = get('SELECT name FROM bad_reasons WHERE id=?', [brId]);
      if (!br) throw new Error('不良原因不存在（#' + brId + '）');
      if (br.name === '其他' && detail) { name = detail; brId = 0; } else { name = br.name; }
    } else { name = String(d.bad_reason || detail || '其他'); }
    insert('INSERT INTO inspection_defects(inspection_id,bad_reason_id,bad_reason,bad_reason_detail,qty) VALUES(?,?,?,?,?)',
      [inspId, brId || null, name, detail, q]);
    summary.push(name + '×' + q);
  }
  if (conclusion !== 'pass' && !summary.length) summary.push((b.bad_summary || '未分类不良') + '×' + qtyFail);

  // 检查表 NG 项并入不良明细（不良原因=项目名，数量按各项 NG 数）
  for (const c of ngItems) {
    if (c.qty <= 0) continue;
    insert('INSERT INTO inspection_defects(inspection_id,bad_reason_id,bad_reason,bad_reason_detail,qty) VALUES(?,?,?,?,?)',
      [inspId, null, c.name, c.remark || '', c.qty]);
    summary.push(c.name + '×' + c.qty);
  }

  // 定级：终检不合格或不合格占比高 → critical；占比低 → minor（阈值可在「检验设置」配置，默认 20% / 5%）
  const ratio = (qtyPass + qtyFail) > 0 ? qtyFail / (qtyPass + qtyFail) : 0;
  const isFinal = String(step.inspect_type) === 'fqc';
  const criticalRatio = Math.min(100, Math.max(1, num(getSetting('critical_ratio', 20)))) / 100;
  const minorRatio = Math.min(50, Math.max(0, num(getSetting('minor_ratio', 5)))) / 100;
  let level = 'major';
  if (conclusion === 'fail' && (isFinal || ratio >= criticalRatio)) level = 'critical';
  else if (ratio > 0 && ratio <= minorRatio) level = 'minor';

  const result = { inspection_id: inspId, code: insCode, conclusion, qty_pass: qtyPass, qty_fail: qtyFail, issue: null, autoFinishIn: null };
  const product = get('SELECT * FROM products WHERE id=?', [order.product_id]);
  const lastStepId = (get('SELECT id FROM order_steps WHERE order_id=? ORDER BY seq DESC LIMIT 1', [order.id]) || {}).id;
  const finished = (step.qty_good + qtyPass) >= step.qty_plan;

  if (conclusion === 'pass' || conclusion === 'concession') {
    // 合格/让步接收 → 放行完工
    run("UPDATE order_steps SET inspect_status='passed', status=?, finish_time=? WHERE id=?",
      [finished ? 'done' : 'running', finished ? now() : null, step.id]);
    if (finished) {
      run("UPDATE order_steps SET status='running' WHERE id=(SELECT MIN(id) FROM order_steps WHERE order_id=? AND status='pending')", [order.id]);
    }
    // 末道检验放行 → 成品自动入库（末道合格数取本次放行的合格数）
    if (step.id === lastStepId && qtyPass > 0) {
      const tag = conclusion === 'concession' ? '（特采放行）' : '';
      result.autoFinishIn = autoFinishIn(order, product, qtyPass, actor, step.id, null, tag);
    }
    const left = get("SELECT COUNT(*) c FROM order_steps WHERE order_id=? AND status<>'done'", [order.id]);
    if (left.c === 0) run("UPDATE orders SET status='done', finish_time=? WHERE id=?", [now(), order.id]);
  } else {
    // 不合格 → 工序置 failed 待返工（重新报工自动回到待检）；
    // 仅重大异常（critical：终检不合格或不良率≥20%）自动开异常单并暂停工单、立即上报管理层
    run("UPDATE order_steps SET inspect_status='failed' WHERE id=?", [step.id]);
    if (level === 'critical') {
      result.issue = createQualityIssue({
        level, source: 'inspect', order_id: order.id, order_step_id: step.id, inspection_id: inspId,
        product_id: order.product_id, product_name: product ? product.name : null,
        process_name: step.process_name || ('工序' + stepSeqNo(step.order_id, step.seq)),
        qty_affected: qtyFail, bad_summary: summary.join('；'), created_by: actor.id,
      });
      run("UPDATE orders SET status='paused' WHERE id=? AND status IN ('running','released')", [order.id]);
    }
  }
  writeLog(actor, '检验判定', `${order.code} ${step.process_name || ''} ${insCode} ${conclusion} 合格${qtyPass}/不合格${qtyFail}`);
  // 通知报工人/该班组：检验结果（放行→可继续流转；不合格→已开异常单/工单可能暂停）
  try {
    const pass = conclusion === 'pass' || conclusion === 'concession';
    const teamMembers = step.assignee_team
      ? all('SELECT id,name FROM users WHERE team=? AND active=1 AND role<>? ', [step.assignee_team, 'admin'])
      : [];
    const reporter = step.assignee_id ? get('SELECT id,name FROM users WHERE id=? AND active=1', [step.assignee_id]) : null;
    const tos = teamMembers.concat(reporter ? [reporter] : []).filter((x) => x.id !== actor.id);
    if (tos.length) {
      const head = `${INSPECT_LABEL[step.inspect_type] || '检验'}${pass ? '合格放行' : '不合格'}：${order.code}`;
      const tail = pass
        ? `合格 ${qtyPass} 件${conclusion === 'concession' ? '（让步接收）' : ''}${result.autoFinishIn ? '，已自动成品入库 ' + result.autoFinishIn.qty + ' 件' : ''}。`
        : (result.issue
          ? `不合格 ${qtyFail} 件，已生成重大质量异常单 ${result.issue.code}，工单已暂停待处理。`
          : `不合格 ${qtyFail} 件，请安排返工返修后重新报工送检。`);
      pushMessage({
        source: 'quality', toUsers: tos, kind: pass ? 'closed' : 'created',
        issue_id: result.issue ? result.issue.id : null, ref_type: 'order', ref_id: order.id,
        link: result.issue ? '#/quality/issue/' + result.issue.id : '#/inspect',
        title: head, body: `${actor.name} 判定：合格 ${qtyPass} / 不合格 ${qtyFail}。${tail}`,
      });
    }
  } catch (e) { /* 通知失败不阻塞检验 */ }
  return result;
}

/* ---- 检验接口 ---- */
// 为待检行附加绑定的检验项目模板（按工序档案绑定，一条工序至多一个模板）
function attachChecklist(rows) {
  if (!rows || !rows.length) return;
  const cls = all('SELECT id,name,process_id,items FROM quality_checklists');
  if (!cls.length) return;
  for (const r of rows) {
    const t = cls.find((c) => c.process_id && c.process_id === r.process_id);
    if (t) {
      try { r.checklist = JSON.parse(t.items || '[]'); r.checklist_id = t.id; r.checklist_name = t.name; } catch (e) { /* 忽略 */ }
    }
  }
}
// 待检队列（质检台）
route('GET', '/api/inspections/pending', ['admin', 'technician', 'inspector'], (req, res) => {
  const rows = all(`SELECT s.id order_step_id, s.order_id, s.seq, s.process_id, s.inspect_type, s.qty_plan, s.qty_good, s.qty_bad, s.assignee_team,
      p.name process_name, o.code order_code, o.status order_status, od.name product_name, s.start_time,
      (SELECT pr.name FROM users pr WHERE pr.id=s.assignee_id) last_worker,
      (SELECT COUNT(*) FROM order_steps x WHERE x.order_id=s.order_id AND x.seq<s.seq)+1 AS seq_no
    FROM order_steps s JOIN orders o ON o.id=s.order_id
    LEFT JOIN processes p ON p.id=s.process_id LEFT JOIN products od ON od.id=o.product_id
    WHERE s.inspect_status='waiting' AND o.status NOT IN ('closed')
    ORDER BY s.id DESC LIMIT 200`);
  attachChecklist(rows);
  ok(res, rows);
});
// 检验记录列表
route('GET', '/api/inspections', [], (req, res, _m, _b, u, query) => {
  const w = []; const p = [];
  if (query.order_id) { w.push('i.order_id=?'); p.push(query.order_id); }
  if (query.mine === '1' && u) { w.push('i.inspector_id=?'); p.push(u.id); }
  if (query.today === '1') { w.push('date(i.created_at)=date(?)'); p.push(today()); }
  ok(res, all(`SELECT i.*, o.code order_code,
      (SELECT inspect_type FROM order_steps s WHERE s.id=i.order_step_id) inspect_type,
      (SELECT GROUP_CONCAT(bad_reason || '×' || qty, '；') FROM inspection_defects WHERE inspection_id=i.id) defect_summary
    FROM inspections i LEFT JOIN orders o ON o.id=i.order_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY i.id DESC LIMIT 200`, p));
});
// 检验单明细（含不良项）
route('GET', '/api/inspections/(\\d+)', [], (req, res, m) => {
  const i = get('SELECT * FROM inspections WHERE id=?', [m[1]]);
  if (!i) return fail(res, '检验记录不存在', 404);
  i.defects = all('SELECT * FROM inspection_defects WHERE inspection_id=? ORDER BY id', [m[1]]);
  ok(res, i);
});
// 提交检验判定
route('POST', '/api/inspections', ['admin', 'technician', 'inspector'], (req, res, _m, b, u) => {
  let r;
  tx(() => { r = doInspection(b, u); });
  ok(res, r);
});
// 质检台队列（APP 质检员扫码登录后进入）——与公开扫码入口同口径，但走登录态
route('GET', '/api/inspections/queue', ['admin', 'technician', 'inspector'], (req, res, _m, _b, u) => {
  const rows = all(`SELECT s.id order_step_id, s.order_id, s.seq, s.process_id, s.inspect_type, s.qty_plan, s.qty_good, s.qty_bad,
      s.assignee_team, p.name process_name, p.sop_file, p.sop_name, o.code order_code, od.name product_name,
      (SELECT pr.name FROM users pr WHERE pr.id=s.assignee_id) last_worker,
      (SELECT COUNT(*) FROM order_steps x WHERE x.order_id=s.order_id AND x.seq<s.seq)+1 AS seq_no
    FROM order_steps s JOIN orders o ON o.id=s.order_id
    LEFT JOIN processes p ON p.id=s.process_id LEFT JOIN products od ON od.id=o.product_id
    WHERE s.inspect_status='waiting' AND o.status<>'closed'
    ORDER BY s.id DESC LIMIT 200`);
  attachChecklist(rows);
  ok(res, { worker: { id: u.id, name: u.name, team: u.team, role: u.role }, steps: rows, badReasons: all('SELECT id,name FROM bad_reasons ORDER BY id') });
});

/* ---- 质量异常单接口 ---- */
route('GET', '/api/quality_issues', [], (req, res, _m, _b, u, query) => {
  const w = []; const p = [];
  if (query.status) { w.push('status=?'); p.push(query.status); }
  if (query.mine === '1' && u) { w.push('assignee_user_id=?'); p.push(u.id); }
  if (query.open === '1') { w.push("status IN ('open','processing','verifying')"); }
  ok(res, all(`SELECT * FROM quality_issues ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY
    CASE level WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, id DESC LIMIT 200`, p));
});
route('GET', '/api/quality_issues/(\\d+)', [], (req, res, m) => {
  const it = get('SELECT * FROM quality_issues WHERE id=?', [m[1]]);
  if (!it) return fail(res, '异常单不存在', 404);
  it.inspection = it.inspection_id ? get('SELECT * FROM inspections WHERE id=?', [it.inspection_id]) : null;
  if (it.inspection) it.inspection.defects = all('SELECT * FROM inspection_defects WHERE inspection_id=?', [it.inspection.id]);
  it.timeline = all('SELECT * FROM issue_notifications WHERE issue_id=? ORDER BY id', [m[1]])
    .map((t) => Object.assign({}, t, { kind_label: ({ created: '开单通知', remind: '催办', escalate: '升级', graded: '定级', claim: '认领', handled: '处理中', closed: '闭环回执' })[t.kind] || t.kind }));
  if (it.order_step_id) {
    it.step = get(`SELECT s.id, s.seq, s.status, s.inspect_status, s.qty_plan, s.qty_good, s.qty_bad, s.assignee_team,
        p.name process_name FROM order_steps s LEFT JOIN processes p ON p.id=s.process_id WHERE s.id=?`, [it.order_step_id]);
  } else it.step = null;
  it.order = it.order_id ? get(`SELECT o.id, o.code, o.status, o.qty_plan,
      (SELECT COALESCE(qty_good,0) FROM order_steps WHERE order_id=o.id ORDER BY seq DESC LIMIT 1) qty_done
    FROM orders o WHERE o.id=?`, [it.order_id]) : null;
  // 处置方式字典（APP 处理弹窗渲染用）
  it.dispositions = DISPOSITION_LABEL;
  ok(res, it);
});
// 认领
route('POST', '/api/quality_issues/(\\d+)/claim', ['admin', 'technician', 'inspector'], (req, res, m, _b, u) => {
  const it = get('SELECT * FROM quality_issues WHERE id=?', [m[1]]);
  if (!it) return fail(res, '异常单不存在', 404);
  if (it.status !== 'open') return fail(res, '该异常单已被认领或已关闭');
  tx(() => {
    run("UPDATE quality_issues SET status='processing', assignee_user_id=?, assignee_name=?, claimed_at=? WHERE id=?", [u.id, u.name, now(), it.id]);
    writeLog(u, '认领质量异常', it.code);
  });
  ok(res, true);
});
// 提交处理（原因/措施/处置方式）→ 待验证
route('POST', '/api/quality_issues/(\\d+)/handle', ['admin', 'technician', 'inspector'], (req, res, m, b, u) => {
  const it = get('SELECT * FROM quality_issues WHERE id=?', [m[1]]);
  if (!it) return fail(res, '异常单不存在', 404);
  if (['closed', 'cancelled'].includes(it.status)) return fail(res, '该异常单已关闭');
  tx(() => {
    // 报废/损失登记：处置=报废未填数量时默认取影响数量；金额选填
    const lossQty = (b.loss_qty !== undefined && b.loss_qty !== '' && b.loss_qty !== null)
      ? num(b.loss_qty)
      : (b.disposition === 'scrap' && it.loss_qty == null ? it.qty_affected : (it.loss_qty != null ? it.loss_qty : null));
    const lossAmt = (b.loss_amount !== undefined && b.loss_amount !== '' && b.loss_amount !== null)
      ? num(b.loss_amount)
      : (it.loss_amount != null ? it.loss_amount : null);
    run("UPDATE quality_issues SET status='verifying', cause=?, action=?, disposition=?, loss_qty=?, loss_amount=?, claimed_at=IFNULL(claimed_at,?) WHERE id=?",
      [b.cause || null, b.action || null, b.disposition || null, lossQty, lossAmt, now(), it.id]);
    // 抄送原上报人：他关心自己报的异常处理到哪一步了
    const reporter = it.created_by ? get('SELECT id,name FROM users WHERE id=? AND active=1', [it.created_by]) : null;
    const owners = it.assignee_user_id ? [{ id: it.assignee_user_id, name: it.assignee_name }] : [];
    pushMessage({
      source: 'quality', toUsers: owners.concat(reporter ? [reporter] : []), kind: 'handled',
      issue_id: it.id, ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id,
      title: `质量异常处理中：${it.code}`,
      body: `${u.name} 已提交处理：处置 ${DISPOSITION_LABEL[b.disposition] || '未填'}${b.action ? '，措施：' + b.action : ''}。待验证关闭。`,
    });
    writeLog(u, '处理质量异常', it.code + ' ' + (DISPOSITION_LABEL[b.disposition] || ''));
  });
  ok(res, true);
});
// 验证关闭 → 闭环；若是 critical 且选择让步/返工完成，恢复工单流转
route('POST', '/api/quality_issues/(\\d+)/close', ['admin', 'technician'], (req, res, m, b, u) => {
  const it = get('SELECT * FROM quality_issues WHERE id=?', [m[1]]);
  if (!it) return fail(res, '异常单不存在', 404);
  if (it.status === 'closed') return fail(res, '该异常单已关闭');
  tx(() => {
    run("UPDATE quality_issues SET status='closed', verifier=?, closed_at=? WHERE id=?", [u.name, now(), it.id]);
    // 工序放行：合格→done；让步接收→放行但标记
    if (it.order_step_id) {
      const step = get('SELECT * FROM order_steps WHERE id=?', [it.order_step_id]);
      if (step && String(step.inspect_status) === 'failed') {
        const pass = b.release !== false; // 默认放行
        if (pass) {
          const fin = step.qty_good >= step.qty_plan;
          run("UPDATE order_steps SET inspect_status='passed', status=?, finish_time=? WHERE id=?",
            [fin ? 'done' : 'running', fin ? now() : null, step.id]);
        }
      }
    }
    // 恢复工单（critical 时曾被暂停）
    if (it.order_id) {
      const o = get('SELECT * FROM orders WHERE id=?', [it.order_id]);
      if (o && o.status === 'paused') {
        const left = get("SELECT COUNT(*) c FROM order_steps WHERE order_id=? AND status<>'done'", [o.id]);
        run("UPDATE orders SET status=? WHERE id=?", [left.c === 0 ? 'done' : 'running', o.id]);
      }
    }
    const closer = { id: it.assignee_user_id, name: it.assignee_name };
    notifyIssue(it, closer, 'closed', `质量异常已闭环：${it.code}`, `验证人 ${u.name}，处置：${DISPOSITION_LABEL[it.disposition] || '未填'}`);
    // 上报人也收到闭环消息
    const reporter = it.created_by ? get('SELECT id,name FROM users WHERE id=? AND active=1', [it.created_by]) : null;
    if (reporter && reporter.id !== (closer && closer.id)) {
      pushMessage({
        source: 'quality', toUsers: [reporter], kind: 'closed', issue_id: it.id,
        ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id,
        title: `质量异常已闭环：${it.code}`,
        body: `验证人 ${u.name}；处置 ${DISPOSITION_LABEL[it.disposition] || '未填'}。工单已恢复流转。`,
      });
    }
    writeLog(u, '关闭质量异常', it.code);
  });
  ok(res, true);
});
// 作废（误报）
route('POST', '/api/quality_issues/(\\d+)/cancel', ['admin'], (req, res, m, b, u) => {
  const it = get('SELECT * FROM quality_issues WHERE id=?', [m[1]]);
  if (!it) return fail(res, '异常单不存在', 404);
  tx(() => {
    run("UPDATE quality_issues SET status='cancelled', cause=?, closed_at=? WHERE id=?", [b.reason || '作废', now(), it.id]);
    writeLog(u, '作废质量异常', it.code);
  });
  ok(res, true);
});
// 报工环节自主上报异常（操作工/质检员均可）
route('POST', '/api/quality_issues', ['admin', 'technician', 'inspector'], (req, res, _m, b, u) => {  let it;
  tx(() => {
    // 上报口径（2026-10-06）：非检验员上报正式等级一律「待定级」（检验员判定），只留存记录；
    // 检验员上报可直接定级（缺省 major）
    const lv = (b.source || 'report') === 'report'
      ? (u.role === 'inspector' && ['minor', 'major', 'critical'].includes(b.level) ? b.level : 'pending')
      : (b.level || 'major');
    it = createQualityIssue({
      level: lv, source: b.source || 'report',
      order_id: num(b.order_id) || null, order_step_id: num(b.order_step_id) || null,
      product_name: b.product_name || null, process_name: b.process_name || null,
      qty_affected: num(b.qty_affected), bad_summary: b.bad_summary || b.title || '', created_by: u.id,
    });
    // 操作工/代报申报重大（严重/致命）：通知全体检验员及时定级（不通知责任人与管理层）
    if ((b.source || 'report') === 'report' && u.role !== 'inspector' && ['major', 'critical'].includes(b.level)) {
      const inspUsers = all("SELECT id,name FROM users WHERE role='inspector' AND active=1");
      for (const ip of inspUsers) {
        notifyIssue(it, ip, 'created', `操作工上报重大异常，请及时定级：${it.code}`,
          `${it.process_name || ''} 不良${it.qty_affected}件：${it.bad_summary || ''}（申报等级：${ISSUE_LEVEL_LABEL[b.level]}）`, false);
      }
    }
    // 检验员主动上报（2026-10-07）：严重程度由检验员直接判定；无论等级均知会厂部管理层
    // （致命级已由 createQualityIssue 升级管理层站内+webhook，此处补推非致命级的站内通知）
    if ((b.source || 'report') === 'report' && u.role === 'inspector' && lv !== 'critical') {
      const admins = all("SELECT id,name FROM users WHERE role='admin' AND active=1").filter((a) => a.id !== it.assignee_user_id);
      pushMessage({
        source: 'quality', toUsers: admins, kind: 'created', issue_id: it.id,
        ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id,
        title: `检验员上报质量异常（${ISSUE_LEVEL_LABEL[lv] || lv}）：${it.code}`,
        body: `${it.order_code || '工单'} · ${it.process_name || '工序'} 不良${it.qty_affected}件：${it.bad_summary || '未填原因'}`,
      });
    }
    writeLog(u, '上报质量异常', it.code + ' ' + (b.bad_summary || ''));
  });
  ok(res, it);
});
// 检验员定级：工人/现场报工上报的异常，严重等级交由检验员判定；
// 判定为致命(critical)级时才上报厂部管理层（webhook 群 + 管理员站内升级），轻微/严重仅通知责任处理人
route('PUT', '/api/quality_issues/(\\d+)/level', ['inspector', 'admin'], (req, res, m, b, u) => {
  const it = get('SELECT * FROM quality_issues WHERE id=?', [m[1]]);
  if (!it) return fail(res, '异常单不存在', 404);
  const lv = b.level;
  if (!['minor', 'major', 'critical'].includes(lv)) return fail(res, '等级必须是 minor/major/critical');
  if (it.level === lv) return ok(res, it);
  const prevLabel = ISSUE_LEVEL_LABEL[it.level] || it.level || '待定级';
  tx(() => {
    run('UPDATE quality_issues SET level=? WHERE id=?', [lv, it.id]);
    const assignee = { id: it.assignee_user_id, name: it.assignee_name };
    if (lv === 'critical') {
      // 致命级：上报厂部管理层
      notifyIssue(it, assignee, 'graded', `${it.code} 经 ${u.name} 判定为致命级`, `原等级 ${prevLabel}，现判定致命（${ISSUE_LEVEL_LABEL.critical}），请厂部关注并督促处理`, true);
      const admins = all("SELECT id,name FROM users WHERE role='admin' AND active=1").filter((a) => !assignee || a.id !== assignee.id);
      pushMessage({
        source: 'quality', toUsers: admins, kind: 'escalate', issue_id: it.id,
        ref_type: 'issue', ref_id: it.id, link: '#/quality/issue/' + it.id,
        title: `重大质量异常（检验员判定）：${it.code}`,
        body: `${it.order_code || ''} · ${it.process_name || ''} 不良${it.qty_affected}件，${u.name} 判定为致命级。`,
      });
    } else {
      notifyIssue(it, assignee, 'graded', `${it.code} 等级更新为${ISSUE_LEVEL_LABEL[lv]}`, `由 ${u.name} 判定（原 ${prevLabel}）`, false);
    }
    writeLog(u, '质量异常定级', it.code + ' → ' + lv);
  });
  ok(res, get('SELECT * FROM quality_issues WHERE id=?', [it.id]));
});

/* ---- 检验项目模板（Checklist）---- */
const clParse = (raw) => { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const clNorm = (raw) => (Array.isArray(raw) ? raw : [])
  .map((it) => ({ name: String(it.name || '').trim(), standard: String(it.standard || '').trim() }))
  .filter((it) => it.name);
route('GET', '/api/checklists', [], (req, res) => {
  ok(res, all('SELECT c.*, p.name process_name FROM quality_checklists c LEFT JOIN processes p ON p.id=c.process_id ORDER BY c.id DESC')
    .map((c) => Object.assign(c, { items: clParse(c.items) })));
});
route('POST', '/api/checklists', ['admin', 'technician'], (req, res, _m, b, u) => {
  const name = String(b.name || '').trim();
  if (!name) return fail(res, '请填写模板名称');
  const items = clNorm(b.items);
  if (!items.length) return fail(res, '至少填写一个检验项目（如：外观无划伤 / 关键尺寸）');
  const id = insert('INSERT INTO quality_checklists(name,process_id,items,created_at) VALUES(?,?,?,?)',
    [name, num(b.process_id) || null, JSON.stringify(items), now()]);
  writeLog(u, '新建检验项目模板', name + '（' + items.length + ' 项）');
  ok(res, { id });
});
route('PUT', '/api/checklists/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const it = get('SELECT * FROM quality_checklists WHERE id=?', [m[1]]);
  if (!it) return fail(res, '模板不存在', 404);
  const name = String(b.name || '').trim();
  if (!name) return fail(res, '请填写模板名称');
  const items = clNorm(b.items);
  if (!items.length) return fail(res, '至少填写一个检验项目');
  run('UPDATE quality_checklists SET name=?, process_id=?, items=? WHERE id=?',
    [name, num(b.process_id) || null, JSON.stringify(items), m[1]]);
  writeLog(u, '修改检验项目模板', name + '（' + items.length + ' 项）');
  ok(res, true);
});
route('DELETE', '/api/checklists/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const it = get('SELECT name FROM quality_checklists WHERE id=?', [m[1]]);
  if (!it) return fail(res, '模板不存在', 404);
  run('DELETE FROM quality_checklists WHERE id=?', [m[1]]);
  writeLog(u, '删除检验项目模板', it.name);
  ok(res, true);
});

/* ------------------------------ 现场巡检记录（检验员手机 APP · 主动巡查留痕） ------------------------------
 * 与「报工后待检判定」互补：巡检不占用待检队列、不打乱检验流；
 * 巡检异常可一键生成质量异常单（source=patrol，复用定责与通知链路）。 */
const PATROL_PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
function patrolOut(r) {
  let cl = null, photos = [];
  try { cl = r.checklist_result ? JSON.parse(r.checklist_result) : null; } catch (e) { /* 忽略 */ }
  try { photos = r.photos ? JSON.parse(r.photos) : []; } catch (e) { /* 忽略 */ }
  return Object.assign({}, r, { checklist_result: cl, photos });
}
route('GET', '/api/patrols', ['admin', 'technician', 'inspector'], (req, res, _m, _b, u, q) => {
  const days = Math.min(180, Math.max(1, num(q.days, 7)));
  const w = ["date(p.created_at) >= date('now', ?)"];
  const a = ['-' + (days - 1) + ' day'];
  if (q.mine === '1') { w.push('p.inspector_id=?'); a.push(u.id); }
  if (['normal', 'abnormal'].includes(q.result)) { w.push('p.result=?'); a.push(q.result); }
  const rows = all(`SELECT p.*, o.code order_code, pr.name product_name, s.seq step_seq, os.name step_name
    FROM patrol_records p LEFT JOIN orders o ON o.id=p.order_id LEFT JOIN products pr ON pr.id=o.product_id
    LEFT JOIN order_steps s ON s.id=p.order_step_id LEFT JOIN processes os ON os.id=s.process_id
    WHERE ${w.join(' AND ')} ORDER BY p.id DESC LIMIT 200`, a);
  ok(res, rows.map(patrolOut));
});
route('POST', '/api/patrols', ['admin', 'technician', 'inspector'], (req, res, _m, b, u) => {
  const result = String(b.result || '') === 'abnormal' ? 'abnormal' : 'normal';
  const order = b.order_id ? get('SELECT o.*, p.name product_name, p.id pid FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?', [num(b.order_id)]) : null;
  if (!order) return fail(res, '请选择要巡查的在产工单');
  if (['closed', 'cancelled'].includes(order.status)) return fail(res, '该工单已完工/作废，无需巡检');
  let step = null;
  if (b.order_step_id) {
    step = get('SELECT s.*, pr.name process_name FROM order_steps s LEFT JOIN processes pr ON pr.id=s.process_id WHERE s.id=?', [num(b.order_step_id)]);
    if (!step || step.order_id !== order.id) return fail(res, '工序与工单不匹配');
  }
  const qtyChecked = Math.max(0, Math.floor(num(b.qty_checked)));
  const qtyBad = Math.max(0, Math.floor(num(b.qty_bad)));
  // 检查项（可选，来自工序绑定模板或手动）：NG 项不允许判正常
  const clResults = [];
  for (const c of (Array.isArray(b.checklist) ? b.checklist : [])) {
    const nm = String(c.name || '').trim();
    if (!nm) continue;
    clResults.push({ name: nm, standard: String(c.standard || '').trim(),
      result: ['ok', 'ng', 'skip'].includes(c.result) ? c.result : 'skip',
      qty: Math.max(0, Math.floor(num(c.qty))), remark: String(c.remark || '').trim() });
  }
  const ngItems = clResults.filter((c) => c.result === 'ng');
  const findings = String(b.findings || '').trim();
  if (result === 'normal' && (qtyBad > 0 || ngItems.length)) return fail(res, '存在不良或 NG 检查项，不能记为正常');
  if (result === 'abnormal' && !findings && !ngItems.length && !qtyBad) return fail(res, '异常巡检请填写异常描述或勾选 NG 检查项');
  let issue = null;
  if (result === 'abnormal' && b.create_issue !== false) {
    const level = ['minor', 'major', 'critical'].includes(b.level) ? b.level : 'major';
    const summary = ngItems.map((c) => c.name + (c.qty ? '×' + c.qty : '')).concat(findings ? [findings] : []).join('；');
    issue = createQualityIssue({
      level, source: 'patrol', order_id: order.id, order_step_id: step ? step.id : null,
      product_id: order.pid, product_name: order.product_name, process_name: step ? step.process_name : null,
      qty_affected: qtyBad || qtyChecked || 0, bad_summary: summary || '现场巡检发现异常', created_by: u.id,
    });
  }
  const id = insert(`INSERT INTO patrol_records(code,inspector_id,inspector_name,order_id,order_step_id,checklist_id,checklist_result,result,qty_checked,qty_bad,findings,issue_id,photos,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [genCode('XL'), u.id, u.name, order.id, step ? step.id : null, num(b.checklist_id) || null,
      clResults.length ? JSON.stringify(clResults) : null, result, qtyChecked, qtyBad,
      findings || (ngItems.length ? '检查项 NG：' + ngItems.map((c) => c.name).join('、') : ''),
      issue ? issue.id : null, '[]', now()]);
  writeLog(u, '现场巡检', (order.code || '') + ' ' + (result === 'normal' ? '正常' : '异常' + (issue ? '（开单 ' + issue.code + '）' : '')));
  ok(res, { id, code: get('SELECT code FROM patrol_records WHERE id=?', [id]).code, issue: issue ? { id: issue.id, code: issue.code, assignee_name: issue.assignee_name } : null });
});
route('GET', '/api/patrols/(\\d+)', ['admin', 'technician', 'inspector'], (req, res, m) => {
  const r = get(`SELECT p.*, o.code order_code, pr.name product_name, s.seq step_seq, os.name step_name
    FROM patrol_records p LEFT JOIN orders o ON o.id=p.order_id LEFT JOIN products pr ON pr.id=o.product_id
    LEFT JOIN order_steps s ON s.id=p.order_step_id LEFT JOIN processes os ON os.id=s.process_id WHERE p.id=?`, [m[1]]);
  if (!r) return fail(res, '巡检记录不存在', 404);
  ok(res, patrolOut(r));
});
// 巡检照片上传（JSON base64，≤8MB/张，最多 6 张，白名单 jpg/png/webp）
route('POST', '/api/patrols/(\\d+)/photos', ['admin', 'technician', 'inspector'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM patrol_records WHERE id=?', [m[1]]);
  if (!r) return fail(res, '巡检记录不存在', 404);
  if (r.inspector_id !== u.id && u.role !== 'admin') return fail(res, '仅巡检人或管理员可补充照片', 403);
  let photos = [];
  try { photos = JSON.parse(r.photos || '[]'); } catch (e) { /* 忽略 */ }
  if (photos.length >= 6) return fail(res, '每条巡检最多 6 张照片');
  if (!b.name) return fail(res, '请选择要上传的照片');
  const buf = Buffer.from(String(b.data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) return fail(res, '照片内容为空');
  if (buf.length > 8 * 1024 * 1024) return fail(res, '单张照片不能超过 8MB');
  const safe = String(b.name).replace(/[\\/:*?"<>|]/g, '_').slice(-120);
  if (!PATROL_PHOTO_EXT.includes(path.extname(safe).toLowerCase())) return fail(res, '仅支持拍照/相册的 ' + PATROL_PHOTO_EXT.join(' ') + ' 格式');
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });
  const fname = 'patrol_' + r.id + '_' + Date.now() + '_' + safe;
  fs.writeFileSync(path.join(dir, fname), buf);
  photos.push({ file: fname, name: safe, at: now() });
  run('UPDATE patrol_records SET photos=? WHERE id=?', [JSON.stringify(photos), r.id]);
  writeLog(u, '上传巡检照片', '巡检#' + r.id + ' ' + safe);
  ok(res, { photos });
});

/* APP 拍照留证通用落盘：校验 base64/大小/扩展名 → data/uploads/ → 返回 {photos, fname}（写库由调用方做） */
function storeScanPhoto(b, prefix, id, photos) {
  if (!b || !b.name) throw Object.assign(new Error('请选择要上传的照片'), { status: 400 });
  const buf = Buffer.from(String(b.data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) throw Object.assign(new Error('照片内容为空'), { status: 400 });
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('单张照片不能超过 8MB'), { status: 400 });
  const safe = String(b.name).replace(/[\\/:*?"<>|]/g, '_').slice(-120);
  if (!PATROL_PHOTO_EXT.includes(path.extname(safe).toLowerCase())) throw Object.assign(new Error('仅支持拍照/相册的 ' + PATROL_PHOTO_EXT.join(' ') + ' 格式'), { status: 400 });
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });
  const fname = prefix + '_' + id + '_' + Date.now() + '_' + safe;
  fs.writeFileSync(path.join(dir, fname), buf);
  photos.push({ file: fname, name: safe, at: now() });
  return photos;
}

// 报工拍照留证：报工人本人或管理员/技术员可补传（≤6 张）
route('POST', '/api/reports/(\\d+)/photos', [], (req, res, m, b, u) => {
  const r = get('SELECT * FROM reports WHERE id=?', [m[1]]);
  if (!r) return fail(res, '报工记录不存在', 404);
  if (r.worker_id !== u.id && !['admin', 'technician'].includes(u.role)) return fail(res, '仅报工人本人或管理员可补充照片', 403);
  let photos = [];
  try { photos = JSON.parse(r.photos || '[]'); } catch (e) { /* 忽略 */ }
  if (photos.length >= 6) return fail(res, '每条报工最多 6 张照片');
  try {
    storeScanPhoto(b, 'report', r.id, photos);
  } catch (e) { return fail(res, e.message, e.status || 400); }
  run('UPDATE reports SET photos=? WHERE id=?', [JSON.stringify(photos), r.id]);
  writeLog(u, '上传报工照片', '报工#' + r.id);
  ok(res, { photos });
});

// 质量异常单照片上传（异常上报/巡检联动后补拍，≤6 张）
route('POST', '/api/quality_issues/(\\d+)/photos', ['admin', 'technician', 'inspector'], (req, res, m, b, u) => {
  const r = get('SELECT * FROM quality_issues WHERE id=?', [m[1]]);
  if (!r) return fail(res, '异常单不存在', 404);
  let photos = [];
  try { photos = JSON.parse(r.photos || '[]'); } catch (e) { /* 忽略 */ }
  if (photos.length >= 6) return fail(res, '每张异常单最多 6 张照片');
  try {
    storeScanPhoto(b, 'issue', r.id, photos);
  } catch (e) { return fail(res, e.message, e.status || 400); }
  run('UPDATE quality_issues SET photos=? WHERE id=?', [JSON.stringify(photos), r.id]);
  writeLog(u, '上传异常单照片', '异常单#' + r.id + ' ' + (r.code || ''));
  ok(res, { photos });
});
/* 巡检统计：今日/近7天次数与异常检出，按人员、按日趋势 */
route('GET', '/api/stats/patrol', ['admin', 'technician', 'inspector'], (req, res) => {
  const todayStr = today();
  const totalToday = get("SELECT COUNT(*) c FROM patrol_records WHERE date(created_at)=?", [todayStr]).c;
  const abToday = get("SELECT COUNT(*) c FROM patrol_records WHERE date(created_at)=? AND result='abnormal'", [todayStr]).c;
  const week = get(`SELECT COUNT(*) c, SUM(result='abnormal') ab FROM patrol_records WHERE date(created_at) >= date('now','-6 day')`);
  const byUser = all(`SELECT u.id, u.name, COUNT(*) total, SUM(p.result='abnormal') abnormal
    FROM patrol_records p JOIN users u ON u.id=p.inspector_id
    WHERE date(p.created_at) >= date('now','-6 day') GROUP BY u.id ORDER BY total DESC`);
  const trend = all(`SELECT date(created_at) d, COUNT(*) total, SUM(result='abnormal') abnormal
    FROM patrol_records WHERE date(created_at) >= date('now','-6 day') GROUP BY date(created_at) ORDER BY d`);
  ok(res, {
    today: { total: totalToday, abnormal: abToday },
    week: { total: week.c, abnormal: week.ab || 0, rate: week.c ? Math.round((week.ab || 0) * 1000 / week.c) / 10 : 0, inspectors: byUser.length },
    by_user: byUser, trend,
  });
});

/* ---- 消息中心（APP 通知）---- */
route('GET', '/api/notifications', [], (req, res, _m, _b, u, query) => {
  if (!u) return ok(res, []);
  const w = ["n.to_user_id=?", "n.channel='inbox'"];
  const p = [u.id];
  if (query && query.source) { w.push('n.source=?'); p.push(String(query.source)); }
  if (query && query.unread === '1') w.push('n.read_at IS NULL');
  const limit = Math.min(200, Math.max(1, num((query && query.limit) || 100, 100)));
  const rows = all(`SELECT n.*, q.code issue_code, q.level, q.status issue_status, q.assignee_name, q.process_name, q.bad_summary
    FROM issue_notifications n
    LEFT JOIN quality_issues q ON q.id=n.issue_id
    WHERE ${w.join(' AND ')} ORDER BY n.id DESC LIMIT ${limit}`, p);
  for (const r of rows) {
    r.source_label = MSG_SOURCE_LABEL[r.source || 'system'] || '消息';
    r.kind_label = MSG_KIND_LABEL[r.kind] || r.kind || '';
  }
  ok(res, rows);
});
route('GET', '/api/notifications/unread_count', [], (req, res, _m, _b, u) => {
  if (!u) return ok(res, { count: 0, by_source: {} });
  const c = get("SELECT COUNT(*) c FROM issue_notifications WHERE to_user_id=? AND channel='inbox' AND read_at IS NULL", [u.id]);
  const bySource = {};
  for (const r of all("SELECT source, COUNT(*) c FROM issue_notifications WHERE to_user_id=? AND channel='inbox' AND read_at IS NULL GROUP BY source", [u.id])) {
    bySource[r.source || 'system'] = r.c;
  }
  ok(res, { count: c ? c.c : 0, by_source: bySource });
});
route('POST', '/api/notifications/read', [], (req, res, _m, b, u) => {
  if (!u) return ok(res, true);
  if (b.id) run('UPDATE issue_notifications SET read_at=? WHERE id=? AND to_user_id=?', [now(), num(b.id), u.id]);
  else if (b.source) run("UPDATE issue_notifications SET read_at=? WHERE to_user_id=? AND channel='inbox' AND read_at IS NULL AND source=?", [now(), u.id, String(b.source)]);
  else run("UPDATE issue_notifications SET read_at=? WHERE to_user_id=? AND channel='inbox' AND read_at IS NULL", [now(), u.id]);
  ok(res, true);
});
// 消息场景字典（前端渲染筛选用）
route('GET', '/api/message_sources', [], (req, res) => {
  ok(res, Object.keys(MSG_SOURCE_LABEL).map((k) => ({ key: k, label: MSG_SOURCE_LABEL[k] })));
});
// 手动触发库存预警扫描（admin/technician，APP 下拉刷新或管理员手动催）
route('POST', '/api/stock_alerts/scan', ['admin', 'technician'], (req, res, _m, _b, u) => {
  const n = scanStockAlerts(u);
  ok(res, { sent: n });
});
// 库存预警总览（哪些物料缺料 / 积压）
route('GET', '/api/stock_alerts', ['admin', 'technician'], (req, res) => {
  const rows = all(`SELECT m.id, m.code, m.name, m.unit, m.safe_min, m.safe_max, IFNULL(SUM(i.qty),0) qty
    FROM materials m LEFT JOIN inventory i ON i.material_id=m.id
    WHERE m.active=1 GROUP BY m.id ORDER BY m.code`);
  const out = rows.map((r) => {
    let lv = 'ok';
    if (Number(r.safe_min) > 0 && Number(r.qty) < Number(r.safe_min)) lv = 'short';
    else if (r.safe_max != null && Number(r.safe_max) > 0 && Number(r.qty) > Number(r.safe_max)) lv = 'over';
    return { ...r, level: lv };
  }).filter((r) => r.level !== 'ok');
  ok(res, out);
});
// 通知设置（webhook 地址）
route('GET', '/api/quality/settings', ['admin', 'technician'], (req, res) => {
  ok(res, {
    webhook_url: getSetting('webhook_url', ''),
    escalate_minutes: num(getSetting('escalate_minutes', 240)),
    remind_minutes: num(getSetting('remind_minutes', 30)),
    critical_ratio: num(getSetting('critical_ratio', 20)),
    minor_ratio: num(getSetting('minor_ratio', 5)),
    inspect_timeout_minutes: num(getSetting('inspect_timeout_minutes', 120)),
  });
});
route('POST', '/api/quality/settings', ['admin'], (req, res, _m, b, u) => {
  const setKV = (k, v) => {
    const ex = get('SELECT key FROM settings WHERE key=?', [k]);
    if (ex) run('UPDATE settings SET value=? WHERE key=?', [String(v), k]);
    else insert('INSERT INTO settings(key,value) VALUES(?,?)', [k, String(v)]);
  };
  if (b.webhook_url !== undefined) setKV('webhook_url', b.webhook_url || '');
  if (b.escalate_minutes !== undefined) setKV('escalate_minutes', num(b.escalate_minutes, 240));
  if (b.remind_minutes !== undefined) setKV('remind_minutes', num(b.remind_minutes, 30));
  if (b.critical_ratio !== undefined) setKV('critical_ratio', Math.min(100, Math.max(1, num(b.critical_ratio, 20))));
  if (b.minor_ratio !== undefined) setKV('minor_ratio', Math.min(50, Math.max(0, num(b.minor_ratio, 5))));
  if (b.inspect_timeout_minutes !== undefined) setKV('inspect_timeout_minutes', Math.min(10080, Math.max(0, num(b.inspect_timeout_minutes, 120))));
  writeLog(u, '修改质量设置', JSON.stringify(b));
  ok(res, true);
});

/* ---- 质量统计 ---- */
route('GET', '/api/stats/quality', [], (req, res) => {
  const openByLevel = all(`SELECT level, COUNT(*) c FROM quality_issues WHERE status IN ('open','processing','verifying') GROUP BY level`);
  const totalOpen = get("SELECT COUNT(*) c FROM quality_issues WHERE status IN ('open','processing','verifying')").c;
  const totalClosed = get("SELECT COUNT(*) c FROM quality_issues WHERE status='closed'").c;
  // 不良帕累托（检验明细聚合）
  const pareto = all(`SELECT bad_reason name, SUM(qty) qty, COUNT(*) times FROM inspection_defects
    WHERE IFNULL(bad_reason,'')<>'' GROUP BY bad_reason ORDER BY qty DESC LIMIT 10`);
  // 检验不良率（按工序）
  const byProcess = all(`SELECT process_name, SUM(qty_check) chk, SUM(qty_fail) fail
    FROM inspections GROUP BY process_name ORDER BY fail DESC LIMIT 10`);
  // 超期未闭环
  const overdue = all(`SELECT * FROM quality_issues WHERE status IN ('open','processing','verifying')
    AND IFNULL(due_at,'')<>'' AND due_at < ? ORDER BY due_at LIMIT 20`, [now()]);
  // 平均响应时长（创建→认领，单位分钟）
  const resp = get(`SELECT AVG((julianday(claimed_at)-julianday(created_at))*24*60) m FROM quality_issues WHERE claimed_at IS NOT NULL`);
  // 报废与损失（处置=报废的数量 + 登记的损失金额）
  const loss = get(`SELECT COALESCE(SUM(loss_qty),0) q, COALESCE(SUM(loss_amount),0) a FROM quality_issues WHERE status<>'cancelled'`);
  ok(res, {
    total_open: totalOpen, total_closed: totalClosed,
    open_by_level: openByLevel, pareto, by_process: byProcess,
    overdue: overdue, avg_claim_minutes: resp && resp.m ? Math.round(resp.m) : null,
    scrap_qty: loss.q, loss_amount: loss.a,
  });
});

// 供应商来料质量：来料合格率（合格÷已检，待检不计入分母）
route('GET', '/api/stats/supplier_quality', [], (req, res, _m, _b, _u, q) => {
  const w = []; const p = [];
  if (q.start) { w.push('i.incoming_date>=?'); p.push(q.start); }
  if (q.end) { w.push('i.incoming_date<=?'); p.push(q.end); }
  const rows = all(`SELECT i.supplier name,
      SUM(i.qty) total,
      SUM(CASE WHEN i.result='qualified' THEN i.qty ELSE 0 END) qualified,
      SUM(CASE WHEN i.result='rejected' THEN i.qty ELSE 0 END) rejected,
      SUM(CASE WHEN i.result='pending' THEN i.qty ELSE 0 END) pending
    FROM incoming_materials i ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
    GROUP BY i.supplier ORDER BY total DESC LIMIT 50`, p);
  ok(res, rows.map((r) => {
    const judged = (Number(r.qualified) || 0) + (Number(r.rejected) || 0);
    return Object.assign(r, { pass_rate: judged > 0 ? (Number(r.qualified) || 0) / judged : null });
  }));
});

// 直通率 FPY（一次合格率）：每张工单取终检(fqc)首次判定，一次判定即合格（无返工/让步）计为一次合格
route('GET', '/api/stats/fpy', [], (req, res, _m, _b, _u, q) => {
  const rows = all(`WITH first_insp AS (
      SELECT i.order_id, MIN(i.id) fid
      FROM inspections i JOIN order_steps s ON s.id=i.order_step_id
      WHERE IFNULL(s.inspect_type,'')='fqc'
      GROUP BY i.order_id)
    SELECT fi.order_id, i.conclusion, substr(i.created_at,1,7) ym, o.product_id, p.name product_name
    FROM first_insp fi
    JOIN inspections i ON i.id=fi.fid
    JOIN orders o ON o.id=fi.order_id LEFT JOIN products p ON p.id=o.product_id`);
  if (!rows.length) return ok(res, { total: 0, first_pass: 0, fpy: null, by_product: [], by_month: [] });
  const byProduct = {}; const byMonth = {};
  let firstPass = 0;
  for (const r of rows) {
    const pass = r.conclusion === 'pass' ? 1 : 0;
    firstPass += pass;
    const pk = r.product_name || '未命名产品';
    byProduct[pk] = byProduct[pk] || { name: pk, total: 0, pass: 0 };
    byProduct[pk].total++; byProduct[pk].pass += pass;
    byMonth[r.ym] = byMonth[r.ym] || { name: r.ym, total: 0, pass: 0 };
    byMonth[r.ym].total++; byMonth[r.ym].pass += pass;
  }
  const rate = (o) => Object.assign(o, { fpy: o.total > 0 ? o.pass / o.total : null });
  ok(res, {
    total: rows.length, first_pass: firstPass, fpy: firstPass / rows.length,
    by_product: Object.values(byProduct).map(rate).sort((a, b) => a.fpy - b.fpy).slice(0, 10),
    by_month: Object.values(byMonth).map(rate).sort((a, b) => a.name.localeCompare(b.name)).slice(-12),
  });
});

// 质量趋势（按月）：检验合格率、异常开单数、平均闭环时长（小时）
route('GET', '/api/stats/quality_trend', [], (req, res) => {
  const insp = all(`SELECT substr(created_at,1,7) ym, COUNT(*) n, SUM(qty_check) chk, SUM(qty_pass) pass
    FROM inspections GROUP BY ym ORDER BY ym DESC LIMIT 12`);
  const issues = all(`SELECT substr(created_at,1,7) ym, COUNT(*) n,
      AVG(CASE WHEN closed_at IS NOT NULL THEN (julianday(closed_at)-julianday(created_at))*24 END) avg_close_h
    FROM quality_issues WHERE status<>'cancelled' GROUP BY ym ORDER BY ym DESC LIMIT 12`);
  const map = {};
  for (const r of insp) map[r.ym] = Object.assign({ name: r.ym, chk: r.chk || 0, pass_rate: r.chk > 0 ? (r.pass || 0) / r.chk : null, insp_n: r.n, issue_n: 0, avg_close_h: null }, map[r.ym] || {});
  for (const r of issues) {
    map[r.ym] = Object.assign({ name: r.ym, chk: 0, pass_rate: null, insp_n: 0, issue_n: r.n, avg_close_h: r.avg_close_h != null ? Math.round(r.avg_close_h * 10) / 10 : null }, map[r.ym] || {});
  }
  ok(res, Object.values(map).sort((a, b) => a.name.localeCompare(b.name)));
});

// 超时扫描：未认领 → 抄送；长时间未处理 → 升级。每分钟执行。
function scanOverdueIssues() {
  try {
    const remindMin = num(getSetting('remind_minutes', 30), 30);
    const escMin = num(getSetting('escalate_minutes', 240), 240);
    const list = all("SELECT * FROM quality_issues WHERE status IN ('open','processing')");
    for (const it of list) {
      const creator = it.created_by ? get('SELECT role FROM users WHERE id=?', [it.created_by]) : null;
      const creatorIsInspector = !!(creator && creator.role === 'inspector');
      const born = new Date(String(it.created_at).replace(' ', 'T'));
      const mins = (Date.now() - born.getTime()) / 60000;
      // 上报口径（2026-10-06）：操作工/代报（非检验员）创建的异常只留存记录与统计，不催办、不升级；
      // 仅检验员创建的异常在超时未处理时提醒/升级管理层
      if (it.status === 'open' && mins >= remindMin && creatorIsInspector) {
        const already = get("SELECT id FROM issue_notifications WHERE issue_id=? AND kind='remind'", [it.id]);
        if (!already) {
          const supervisor = get("SELECT id,name FROM users WHERE role='technician' AND team=(SELECT team FROM users WHERE id=?) AND active=1 LIMIT 1", [it.assignee_user_id])
            || get("SELECT id,name FROM users WHERE role='admin' AND active=1 LIMIT 1");
          notifyIssue(it, supervisor, 'remind', `质量异常待认领超 ${remindMin} 分钟：${it.code}`, `${it.process_name || ''} 不良${it.qty_affected}件，请尽快认领处理`);
        }
      }
      if (!it.escalated && mins >= escMin) {
        if (creatorIsInspector) {
          const admin = get("SELECT id,name FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
          notifyIssue(it, admin, 'escalate', `质量异常超 ${Math.round(escMin / 60)} 小时未处理：${it.code}`, `${it.process_name || ''} 不良${it.qty_affected}件，责任人 ${it.assignee_name || '未指派'}`);
        }
        run('UPDATE quality_issues SET escalated=1 WHERE id=?', [it.id]);
      }
    }
  } catch (e) { /* 扫描失败不影响服务 */ }
}

/* 待检超时提醒（对标「批次必须在 N 小时内完成检验，超时自动推送」）：
 * 报工后工序落 inspect_status='waiting'，超过 settings.inspect_timeout_minutes 未判定 → 通知全体质检员（每天每工序只提醒一次）。 */
function scanInspectOverdue() {
  try {
    const lim = num(getSetting('inspect_timeout_minutes', 120), 120);
    if (lim <= 0) return;
    const inspectors = all("SELECT id,name FROM users WHERE role='inspector' AND active=1");
    if (!inspectors.length) return;
    const rows = all(`SELECT s.id sid, s.seq, s.inspect_type, o.code order_code, pr.name process_name
      FROM order_steps s JOIN orders o ON o.id=s.order_id JOIN processes pr ON pr.id=s.process_id
      WHERE s.inspect_status='waiting' AND o.status NOT IN ('closed','cancelled')`);
    for (const r of rows) {
      const last = get('SELECT MAX(created_at) t FROM reports WHERE order_step_id=?', [r.sid]);
      if (!last || !last.t) continue;
      const mins = (Date.now() - new Date(String(last.t).replace(' ', 'T')).getTime()) / 60000;
      if (mins < lim) continue;
      const dup = get("SELECT id FROM issue_notifications WHERE source='inspect_overdue' AND ref_id=? AND sent_at >= datetime('now','-1 day')", [r.sid]);
      if (dup) continue;
      pushMessage({
        source: 'inspect_overdue', toUsers: inspectors, kind: 'remind', ref_type: 'inspect_step', ref_id: r.sid,
        link: '#/inspect',
        title: `待检工序已等待 ${Math.round(mins)} 分钟未检验`,
        body: `${r.order_code} · 第 ${r.seq} 道 ${r.process_name}${r.inspect_type ? '（' + r.inspect_type.toUpperCase() + '）' : ''}，请尽快判定以免阻塞流转`,
      });
    }
  } catch (e) { /* 扫描失败不影响服务 */ }
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
route('POST', '/api/incoming_materials', ['admin', 'technician'], (req, res, _m, b, u) => {
  const code = (b.code && b.code.trim()) ? b.code.trim() : genCode('LM');
  if (get('SELECT id FROM incoming_materials WHERE code=?', [code])) return fail(res, '该来料单号已存在');
  const mid = resolveMaterialId(b);
  fillFromMaterial(b, mid);
  // 检验结论：pending 待检（默认，暂不计库存，由质检员判定后入库）/ qualified 合格（直接入库）/ rejected 不合格
  const iqcResult = ['pending', 'qualified', 'rejected'].includes(b.result) ? b.result : 'pending';
  let id;
  tx(() => {
    id = insert(`INSERT INTO incoming_materials(code,incoming_date,supplier,material_id,warehouse_id,material_code,material_name,material_spec,qty,unit,batch,order_id,inspector,result,remark,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, b.incoming_date || today(), b.supplier || null, mid, b.warehouse_id ? num(b.warehouse_id) : null,
        b.material_code || null, b.material_name, b.material_spec || null,
        num(b.qty), b.unit || '件', b.batch || null, b.order_id ? num(b.order_id) : null, b.inspector || null, iqcResult, b.remark || null, u.id, now()]);
    if (mid && iqcResult === 'qualified') {
      applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: num(b.qty), tx_type: 'in_incoming',
        ref_type: 'incoming_materials', ref_id: id, ref_code: code, order_id: b.order_id, operator: u.name, tx_date: b.incoming_date || today(), remark: '来料入库 ' + code });
    }
  });
  writeLog(u, '新增来料记录', code + ' ' + (b.material_name || '') + (iqcResult === 'pending' ? '（待检）' : ''));
  ok(res, { id, code });
});
route('PUT', '/api/incoming_materials/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const old = get('SELECT * FROM incoming_materials WHERE id=?', [m[1]]);
  if (!old) return fail(res, '来料记录不存在', 404);
  const mid = resolveMaterialId(b);
  fillFromMaterial(b, mid);
  const iqcResult = ['pending', 'qualified', 'rejected'].includes(b.result)
    ? b.result
    : (['pending', 'qualified', 'rejected'].includes(old.result) ? old.result : 'pending');
  tx(() => {
    revertStock('incoming_materials', Number(m[1]), u.name);
    run(`UPDATE incoming_materials SET code=?,incoming_date=?,supplier=?,material_id=?,warehouse_id=?,material_code=?,material_name=?,material_spec=?,qty=?,unit=?,batch=?,order_id=?,inspector=?,result=?,remark=? WHERE id=?`,
      [b.code || '', b.incoming_date || today(), b.supplier || null, mid, b.warehouse_id ? num(b.warehouse_id) : null,
        b.material_code || null, b.material_name, b.material_spec || null,
        num(b.qty), b.unit || '件', b.batch || null, b.order_id ? num(b.order_id) : null, b.inspector || null, iqcResult, b.remark || null, m[1]]);
    if (mid && iqcResult === 'qualified') {
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

// 来料检验判定（IQC）：待检单 → 合格/让步自动入库；不合格不入库并自动开异常单（source=iqc，按供应商留痕）
route('POST', '/api/incoming_inspections', ['admin', 'technician', 'inspector'], (req, res, _m, b, u) => {
  const rec = get('SELECT * FROM incoming_materials WHERE id=?', [num(b.id)]);
  if (!rec) return fail(res, '来料单不存在', 404);
  if (rec.result !== 'pending') return fail(res, '该来料单已完成检验，无需重复判定');
  let conclusion = String(b.conclusion || 'pass').trim();
  if (!['pass', 'fail', 'concession'].includes(conclusion)) conclusion = 'pass';
  const total = Math.max(0, num(rec.qty));
  const qtyFail = Math.max(0, Math.floor(num(b.qty_fail)));
  const qtyPass = Math.max(0, total - qtyFail);
  if (conclusion === 'pass' && qtyFail > 0) return fail(res, '判定合格时不合格数必须为 0');
  if (conclusion !== 'pass' && qtyFail <= 0) return fail(res, '判定不合格/让步接收时须填写不合格数');
  const criticalRatio = Math.min(100, Math.max(1, num(getSetting('critical_ratio', 20)))) / 100;
  const ratio = total > 0 ? qtyFail / total : 0;
  const level = conclusion === 'fail' && ratio >= criticalRatio ? 'critical' : 'major';
  let issue = null;
  tx(() => {
    run('UPDATE incoming_materials SET result=?, inspector=?, remark=? WHERE id=?',
      [conclusion === 'fail' ? 'rejected' : 'qualified', u.name,
        ((b.remark || '').trim() + (conclusion === 'concession' ? '（让步接收）' : '')).trim() || rec.remark, rec.id]);
    if (conclusion !== 'fail' && rec.material_id) {
      applyStock({ material_id: rec.material_id, warehouse_id: rec.warehouse_id, batch: rec.batch, qty: total, tx_type: 'in_incoming',
        ref_type: 'incoming_materials', ref_id: rec.id, ref_code: rec.code, order_id: rec.order_id, operator: u.name,
        tx_date: rec.incoming_date || today(), remark: 'IQC 合格入库 ' + rec.code });
    }
    if (conclusion === 'fail') {
      issue = createQualityIssue({
        level, source: 'iqc', order_id: rec.order_id || null,
        process_name: '来料检验·' + (rec.material_name || '') + '（' + (rec.supplier || '未知供应商') + '）',
        qty_affected: qtyFail, bad_summary: (b.bad_summary || '来料检验不合格').trim(),
        supplier: rec.supplier || null, created_by: u.id,
      });
    }
  });
  writeLog(u, '来料检验判定', rec.code + ' ' + (conclusion === 'fail' ? '不合格' : conclusion === 'concession' ? '让步接收' : '合格') + ' 合格' + qtyPass + '/不合格' + qtyFail);
  ok(res, { id: rec.id, result: conclusion === 'fail' ? 'rejected' : 'qualified', qty_pass: qtyPass, qty_fail: qtyFail, issue });
});

// 成品入库
route('GET', '/api/finished_goods_in', [], (req, res) => {
  ok(res, all(`SELECT f.*, o.code order_code, m.code m_code, m.name m_name, w.name warehouse_name
    FROM finished_goods_in f LEFT JOIN orders o ON o.id=f.order_id
    LEFT JOIN materials m ON m.id=f.material_id LEFT JOIN warehouses w ON w.id=f.warehouse_id
    ORDER BY f.id DESC`));
});
route('POST', '/api/finished_goods_in', ['admin', 'technician'], (req, res, _m, b, u) => {
  const code = (b.code && b.code.trim()) ? b.code.trim() : genCode('RK');
  if (get('SELECT id FROM finished_goods_in WHERE code=?', [code])) return fail(res, '该入库单号已存在');
  const mid = resolveMaterialId(b);
  fillFromMaterial(b, mid);
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
route('PUT', '/api/finished_goods_in/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const mid = resolveMaterialId(b);
  fillFromMaterial(b, mid);
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

/* ------------------------------ 领料 / 退料（关联工单） ------------------------------ */
const ISSUE_TYPE_LABEL = { pick: '领料', return: '退料' };

route('GET', '/api/material_issues', [], (req, res, _m, _b, _u, q) => {
  const where = []; const ps = [];
  if (q.order_id) { where.push('i.order_id=?'); ps.push(num(q.order_id)); }
  if (q.type) { where.push('i.type=?'); ps.push(q.type); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  ok(res, all(`SELECT i.*, o.code order_code, m.code m_code, m.name m_name, w.name warehouse_name
    FROM material_issues i LEFT JOIN orders o ON o.id=i.order_id
    LEFT JOIN materials m ON m.id=i.material_id LEFT JOIN warehouses w ON w.id=i.warehouse_id
    ${w} ORDER BY i.id DESC`, ps));
});

route('POST', '/api/material_issues', ['admin', 'technician', 'worker'], (req, res, _m, b, u) => {
  let type = b.type === 'return' ? 'return' : 'pick';
  // 工人手机端领料：只能领料（不能退料/改单/删单），且只能为「本班组在制或未指派」的工单领料
  if (u.role === 'worker') {
    if (b.type === 'return') return fail(res, '工人账号只能领料，退料请联系技术员在电脑端办理');
    type = 'pick';
    if (!b.order_id) return fail(res, '请选择要领料的工单');
    const o = get('SELECT id,status FROM orders WHERE id=?', [num(b.order_id)]);
    if (!o) return fail(res, '工单不存在', 404);
    if (['closed', 'cancelled'].includes(o.status)) return fail(res, '该工单已结束，不能领料');
    const allowed = get(`SELECT id FROM order_steps WHERE order_id=? AND (assignee_team IS NULL OR assignee_team='' OR assignee_team=?) LIMIT 1`,
      [num(b.order_id), u.team || '']);
    if (!allowed) return fail(res, '该工单未指派给你的班组，无权领料');
  }
  const qty = num(b.qty);
  if (!(qty > 0)) return fail(res, '数量必须大于 0');
  if (type === 'pick' && !b.order_id) return fail(res, '领料必须关联工单（退料可选）');
  const mid = resolveMaterialId(b);
  if (!mid) return fail(res, '请选择物料');
  fillFromMaterial(b, mid);
  const code = (b.code && b.code.trim()) ? b.code.trim() : genCode(type === 'pick' ? 'LL' : 'TL');
  if (get('SELECT id FROM material_issues WHERE code=?', [code])) return fail(res, '该单号已存在');
  const date = b.issue_date || today();
  let id;
  tx(() => {
    id = insert(`INSERT INTO material_issues(code,type,issue_date,order_id,material_id,material_code,material_name,material_spec,qty,unit,warehouse_id,batch,reason,operator,remark,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, type, date, b.order_id ? num(b.order_id) : null, mid, b.material_code || null, b.material_name,
        b.material_spec || null, qty, b.unit || '件', b.warehouse_id ? num(b.warehouse_id) : null,
        b.batch || null, b.reason || null, b.operator || u.name, b.remark || null, u.id, now()]);
    applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch,
      qty: type === 'pick' ? -qty : qty, tx_type: type === 'pick' ? 'out_pick' : 'in_return',
      ref_type: 'material_issues', ref_id: id, ref_code: code, order_id: b.order_id,
      operator: u.name, tx_date: date, remark: ISSUE_TYPE_LABEL[type] + ' ' + code });
  });
  writeLog(u, ISSUE_TYPE_LABEL[type], code + ' ' + (b.material_name || '') + ' ×' + qty + (b.order_id ? '（工单）' : ''));
  ok(res, { id, code });
});

route('PUT', '/api/material_issues/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const row = get('SELECT * FROM material_issues WHERE id=?', [m[1]]);
  if (!row) return fail(res, '单据不存在', 404);
  const type = b.type === 'return' ? 'return' : (b.type === 'pick' ? 'pick' : row.type);
  const qty = num(b.qty) > 0 ? num(b.qty) : num(row.qty);
  if (type === 'pick' && !b.order_id && !row.order_id) return fail(res, '领料必须关联工单');
  const mid = resolveMaterialId(b) || row.material_id;
  fillFromMaterial(b, mid);
  tx(() => {
    revertStock('material_issues', Number(m[1]), u.name);
    run(`UPDATE material_issues SET type=?,issue_date=?,order_id=?,material_id=?,material_code=?,material_name=?,material_spec=?,qty=?,unit=?,warehouse_id=?,batch=?,reason=?,operator=?,remark=? WHERE id=?`,
      [type, b.issue_date || row.issue_date, b.order_id ? num(b.order_id) : (type === 'pick' ? row.order_id : (b.order_id === null ? null : row.order_id)),
        mid, b.material_code || null, b.material_name, b.material_spec || null, qty, b.unit || '件',
        b.warehouse_id ? num(b.warehouse_id) : null, b.batch || null, b.reason || null,
        b.operator || row.operator, b.remark || null, m[1]]);
    applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch,
      qty: type === 'pick' ? -qty : qty, tx_type: type === 'pick' ? 'out_pick' : 'in_return',
      ref_type: 'material_issues', ref_id: Number(m[1]), ref_code: row.code, order_id: row.order_id,
      operator: u.name, tx_date: b.issue_date || row.issue_date, remark: ISSUE_TYPE_LABEL[type] + '(改) ' + row.code });
  });
  writeLog(u, '修改' + ISSUE_TYPE_LABEL[type] + '单', row.code);
  ok(res, true);
});

route('DELETE', '/api/material_issues/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const row = get('SELECT * FROM material_issues WHERE id=?', [m[1]]);
  if (!row) return fail(res, '单据不存在', 404);
  tx(() => {
    revertStock('material_issues', Number(m[1]), u.name);
    run('DELETE FROM material_issues WHERE id=?', [m[1]]);
  });
  writeLog(u, '删除' + ISSUE_TYPE_LABEL[row.type] + '单', row.code);
  ok(res, true);
});

/* ------------------------------ 成品出库（发货 / 销售出库） ------------------------------ */
route('GET', '/api/stock_shipments', [], (req, res, _m, _b, _u, q) => {
  const where = []; const ps = [];
  if (q.order_id) { where.push('s.order_id=?'); ps.push(num(q.order_id)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  ok(res, all(`SELECT s.*, o.code order_code, m.code m_code, m.name m_name, w.name warehouse_name
    FROM stock_shipments s LEFT JOIN orders o ON o.id=s.order_id
    LEFT JOIN materials m ON m.id=s.material_id LEFT JOIN warehouses w ON w.id=s.warehouse_id
    ${w} ORDER BY s.id DESC`, ps));
});

route('POST', '/api/stock_shipments', ['admin', 'technician'], (req, res, _m, b, u) => {
  const qty = num(b.qty);
  if (!(qty > 0)) return fail(res, '数量必须大于 0');
  const mid = resolveMaterialId(b);
  if (!mid) return fail(res, '请选择物料');
  fillFromMaterial(b, mid);
  const code = (b.code && b.code.trim()) ? b.code.trim() : genCode('CK');
  if (get('SELECT id FROM stock_shipments WHERE code=?', [code])) return fail(res, '该出库单号已存在');
  const date = b.ship_date || today();
  let id;
  tx(() => {
    id = insert(`INSERT INTO stock_shipments(code,ship_date,customer,order_id,sale_ref,material_id,material_code,material_name,material_spec,qty,unit,warehouse_id,batch,operator,remark,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, date, b.customer || null, b.order_id ? num(b.order_id) : null, b.sale_ref || null,
        mid, b.material_code || null, b.material_name, b.material_spec || null, qty, b.unit || '件',
        b.warehouse_id ? num(b.warehouse_id) : null, b.batch || null, b.operator || u.name,
        b.remark || null, u.id, now()]);
    applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: -qty, tx_type: 'out_ship',
      ref_type: 'stock_shipments', ref_id: id, ref_code: code, order_id: b.order_id,
      operator: u.name, tx_date: date, remark: '成品出库 ' + code });
  });
  writeLog(u, '成品出库', code + ' ' + (b.material_name || '') + ' ×' + qty + (b.customer ? ' → ' + b.customer : ''));
  if (b.sale_ref) syncSalesShipped(b.sale_ref);
  ok(res, { id, code });
});

route('PUT', '/api/stock_shipments/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const row = get('SELECT * FROM stock_shipments WHERE id=?', [m[1]]);
  if (!row) return fail(res, '单据不存在', 404);
  const qty = num(b.qty) > 0 ? num(b.qty) : num(row.qty);
  const mid = resolveMaterialId(b) || row.material_id;
  fillFromMaterial(b, mid);
  tx(() => {
    revertStock('stock_shipments', Number(m[1]), u.name);
    run(`UPDATE stock_shipments SET ship_date=?,customer=?,order_id=?,sale_ref=?,material_id=?,material_code=?,material_name=?,material_spec=?,qty=?,unit=?,warehouse_id=?,batch=?,operator=?,remark=? WHERE id=?`,
      [b.ship_date || row.ship_date, b.customer !== undefined ? (b.customer || null) : row.customer,
        b.order_id !== undefined ? (b.order_id ? num(b.order_id) : null) : row.order_id,
        b.sale_ref !== undefined ? (b.sale_ref || null) : row.sale_ref,
        mid, b.material_code || null, b.material_name, b.material_spec || null, qty, b.unit || '件',
        b.warehouse_id ? num(b.warehouse_id) : null, b.batch || null, b.operator || row.operator,
        b.remark || null, m[1]]);
    applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: -qty, tx_type: 'out_ship',
      ref_type: 'stock_shipments', ref_id: Number(m[1]), ref_code: row.code, order_id: row.order_id,
      operator: u.name, tx_date: b.ship_date || row.ship_date, remark: '成品出库(改) ' + row.code });
  });
  writeLog(u, '修改成品出库', row.code);
  syncSalesShipped(b.sale_ref !== undefined ? b.sale_ref : row.sale_ref);
  if (b.sale_ref !== undefined && row.sale_ref && b.sale_ref !== row.sale_ref) syncSalesShipped(row.sale_ref);
  ok(res, true);
});

route('DELETE', '/api/stock_shipments/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const row = get('SELECT * FROM stock_shipments WHERE id=?', [m[1]]);
  if (!row) return fail(res, '单据不存在', 404);
  tx(() => {
    revertStock('stock_shipments', Number(m[1]), u.name);
    run('DELETE FROM stock_shipments WHERE id=?', [m[1]]);
  });
  writeLog(u, '删除成品出库', row.code);
  if (row.sale_ref) syncSalesShipped(row.sale_ref);
  ok(res, true);
});

/* ------------------------------ P2：销售订单（接单 → 转工单 → 出货核销） ------------------------------
 * sales_orders 出货核销：按成品出库单 sale_ref（销售单号）聚合回写 shipped_qty 与状态，
 * 新增/修改/删除出库单后自动重算，改错单也不会留脏数据。 */
function syncSalesShipped(saleRef) {
  const code = String(saleRef || '').trim();
  if (!code) return;
  const so = get('SELECT * FROM sales_orders WHERE code=?', [code]);
  if (!so) return;
  const shipped = num(get('SELECT IFNULL(SUM(qty),0) s FROM stock_shipments WHERE sale_ref=?', [code]).s);
  let status = so.status;
  if (status !== 'cancelled') {
    status = shipped <= 0 ? 'open' : (shipped + 1e-9 >= num(so.qty) ? 'done' : 'partial');
  }
  run('UPDATE sales_orders SET shipped_qty=?, status=? WHERE id=?', [shipped, status, so.id]);
}

const SALES_STATUS_LABEL = { open: '未交货', partial: '部分交货', done: '已交货', cancelled: '已取消' };

route('GET', '/api/sales_orders', [], (req, res, _m, _b, _u, q) => {
  const w = []; const p = [];
  if (q.status) { w.push('s.status=?'); p.push(q.status); }
  if (q.keyword) {
    w.push('(s.code LIKE ? OR s.customer_name LIKE ? OR s.product_name LIKE ?)');
    const k = '%' + q.keyword + '%';
    p.push(k, k, k);
  }
  ok(res, all(`SELECT s.*, p.code product_code,
      (SELECT COUNT(*) FROM orders o WHERE o.id=s.produced_order_id) has_order
    FROM sales_orders s LEFT JOIN products p ON p.id=s.product_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
    ORDER BY CASE s.status WHEN 'open' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,
      CASE WHEN s.status IN ('open','partial') THEN s.delivery_date ELSE '' END, s.id DESC`, p));
});

route('POST', '/api/sales_orders', ['admin', 'technician'], (req, res, _m, b, u) => {
  const qty = num(b.qty);
  if (!(qty > 0)) return fail(res, '请填写有效的销售数量');
  const pid = num(b.product_id);
  if (!pid) return fail(res, '请选择产品');
  const prod = get('SELECT * FROM products WHERE id=?', [pid]);
  if (!prod) return fail(res, '产品不存在', 404);
  let cid = num(b.customer_id) || null;
  let cname = String(b.customer_name || '').trim();
  if (cid) {
    const c = get('SELECT name FROM customers WHERE id=?', [cid]);
    if (!c) return fail(res, '客户不存在', 404);
    cname = c.name;
  }
  const code = b.code && b.code.trim() ? b.code.trim() : genCode('SO');
  if (get('SELECT id FROM sales_orders WHERE code=?', [code])) return fail(res, '销售单号已存在');
  const id = insert(`INSERT INTO sales_orders(code,customer_id,customer_name,product_id,product_name,spec,unit,qty,price,order_date,delivery_date,status,remark,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [code, cid, cname || null, pid, prod.name, prod.spec || null, prod.unit || '件', qty, num(b.price, num(prod.price, 0)),
      b.order_date || today(), b.delivery_date || null, 'open', b.remark || null, u.id, now()]);
  writeLog(u, '创建销售订单', `${code} ${prod.name} ×${qty}${cname ? ' → ' + cname : ''}`);
  ok(res, { id, code });
});

route('PUT', '/api/sales_orders/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
  const row = get('SELECT * FROM sales_orders WHERE id=?', [m[1]]);
  if (!row) return fail(res, '销售订单不存在', 404);
  if (row.status === 'cancelled') return fail(res, '已取消的订单不能编辑');
  let cid = row.customer_id;
  let cname = row.customer_name;
  if (b.customer_id !== undefined) {
    cid = num(b.customer_id) || null;
    if (cid) {
      const c = get('SELECT name FROM customers WHERE id=?', [cid]);
      if (!c) return fail(res, '客户不存在', 404);
      cname = c.name;
    } else cname = null;
  }
  const qty = b.qty !== undefined ? num(b.qty) : num(row.qty);
  if (!(qty > 0)) return fail(res, '请填写有效的销售数量');
  run(`UPDATE sales_orders SET customer_id=?, customer_name=?, qty=?, price=?, order_date=?, delivery_date=?, remark=? WHERE id=?`,
    [cid, cname, qty, b.price !== undefined ? num(b.price, 0) : num(row.price),
      b.order_date || row.order_date, b.delivery_date !== undefined ? (b.delivery_date || null) : row.delivery_date,
      b.remark !== undefined ? (b.remark || null) : row.remark, m[1]]);
  syncSalesShipped(row.code); // 数量可能变化，重算交货状态
  writeLog(u, '修改销售订单', row.code + ' ' + JSON.stringify(b));
  ok(res, true);
});

route('DELETE', '/api/sales_orders/(\\d+)', ['admin'], (req, res, m, _b, u) => {
  const row = get('SELECT * FROM sales_orders WHERE id=?', [m[1]]);
  if (!row) return fail(res, '销售订单不存在', 404);
  if (num(row.shipped_qty) > 0) return fail(res, '该订单已有出货记录，不能删除（可改为「已取消」）');
  run('DELETE FROM sales_orders WHERE id=?', [m[1]]);
  writeLog(u, '删除销售订单', row.code);
  ok(res, true);
});

// 批量转工单：一次把多张销售订单转成生产工单，逐单返回成功/失败明细
// （与单张 convert 同一套规则：数量取销售数量、客户/交期带入、已转过则幂等返回）
route('POST', '/api/sales_orders/convert_batch', ['admin', 'technician'], (req, res, _m, b, u) => {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => num(x)).filter((x) => x > 0).slice(0, 100);
  if (!ids.length) return fail(res, '请先勾选要转工单的销售订单');
  const done = [], failed = [];
  for (const id of ids) {
    const s = get('SELECT * FROM sales_orders WHERE id=?', [id]);
    if (!s) { failed.push({ id, code: '#' + id, msg: '订单不存在' }); continue; }
    if (s.status === 'cancelled') { failed.push({ id, code: s.code, msg: '已取消的订单不能转工单' }); continue; }
    if (s.produced_order_id) {
      const ex = get('SELECT id, code FROM orders WHERE id=?', [s.produced_order_id]);
      if (ex) { done.push({ id, code: s.code, order_code: ex.code, existed: true }); continue; }
    }
    if (!s.product_id) { failed.push({ id, code: s.code, msg: '未关联产品档案，无法转工单' }); continue; }
    const route0 = get('SELECT id FROM routes WHERE product_id=? ORDER BY id LIMIT 1', [s.product_id]);
    if (!route0) { failed.push({ id, code: s.code, msg: '该产品还没有工艺路线' }); continue; }
    try {
      const qty = Math.max(1, Math.floor(num(s.qty, 1)));
      const code = 'WO' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 9000) + 1000);
      const oid = tx(() => {
        const oid2 = insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,plan_start,plan_end,status,remark,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [code, s.product_id, route0.id, s.customer_id, qty, num(b.priority, 2),
            b.plan_start || today(), b.plan_end || s.delivery_date || today(), 'created',
            '销售订单 ' + s.code + (s.customer_name ? '（' + s.customer_name + '）' : ''), u.id, now()]);
        all('SELECT * FROM route_steps WHERE route_id=? ORDER BY seq', [route0.id]).forEach((st) => {
          insert('INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,status,inspect_type) VALUES(?,?,?,?,?,?,?)',
            [oid2, st.seq, st.process_id, st.work_center_id, qty, 'pending', String(st.inspect_type || '')]);
        });
        run('UPDATE sales_orders SET produced_order_id=? WHERE id=?', [oid2, s.id]);
        return oid2;
      });
      writeLog(u, '批量转工单', s.code + ' → ' + code);
      done.push({ id, code: s.code, order_code: code, order_id: oid, existed: false });
    } catch (e) { failed.push({ id, code: s.code, msg: e.message || '转换失败' }); }
  }
  writeLog(u, '批量转工单汇总', `成功 ${done.length} 单，失败 ${failed.length} 单`);
  ok(res, { ok_count: done.length, done, failed });
});

/* CSV 批量导入建单（对标黑湖「Excel 批量导入」）：逐行匹配产品/路线/客户后建单，返回成功与失败明细
 * 列（表头可省略，按顺序）：产品编码 产品名称 数量 工艺路线编码 客户 优先级 计划开工 计划完工 备注 */
route('POST', '/api/orders/import', ['admin', 'technician'], (req, res, _m, b, u) => {
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 300) : [];
  if (!rows.length) return fail(res, '没有可导入的数据行');
  const created = [], failed = [];
  rows.forEach((r, i) => {
    const line = i + 1;
    try {
      const pCode = String(r.product_code || '').trim();
      const pName = String(r.product_name || '').trim();
      const prod = (pCode ? get('SELECT * FROM products WHERE code=?', [pCode]) : null)
        || (pName ? get('SELECT * FROM products WHERE name=? ORDER BY id LIMIT 1', [pName]) : null);
      if (!prod) { failed.push({ line, msg: (pCode || pName || '?') + '：产品档案不存在' }); return; }
      const rCode = String(r.route_code || '').trim();
      const route0 = (rCode ? get('SELECT * FROM routes WHERE code=? AND product_id=?', [rCode, prod.id]) : null)
        || get('SELECT id FROM routes WHERE product_id=? ORDER BY id LIMIT 1', [prod.id]);
      if (!route0) { failed.push({ line, msg: prod.name + '：没有工艺路线，请先在基础数据建立' }); return; }
      const qty = Math.floor(num(r.qty, 0));
      if (!(qty > 0)) { failed.push({ line, msg: prod.name + '：数量必须大于 0' }); return; }
      const cName = String(r.customer || '').trim();
      const cust = cName ? get('SELECT id FROM customers WHERE name=? ORDER BY id LIMIT 1', [cName]) : null;
      if (cName && !cust) { failed.push({ line, msg: cName + '：客户档案不存在（可先在基础数据建立，或留空该列）' }); return; }
      const code = 'WO' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 9000) + 1000);
      const oid = tx(() => {
        const oid2 = insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,plan_start,plan_end,status,remark,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [code, prod.id, route0.id, cust ? cust.id : null, qty, Math.min(3, Math.max(1, num(r.priority, 2))),
            String(r.plan_start || '').trim() || today(), String(r.plan_end || '').trim() || today(), 'created',
            String(r.remark || '').trim() + (String(r.remark || '').trim() ? ' · ' : '') + '批量导入', u.id, now()]);
        all('SELECT * FROM route_steps WHERE route_id=? ORDER BY seq', [route0.id]).forEach((st) => {
          insert('INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,status,inspect_type) VALUES(?,?,?,?,?,?,?)',
            [oid2, st.seq, st.process_id, st.work_center_id, qty, 'pending', String(st.inspect_type || '')]);
        });
        return oid2;
      });
      created.push({ line, code, order_id: oid, product: prod.name, qty });
    } catch (e) { failed.push({ line, msg: e.message || '导入失败' }); }
  });
  if (created.length) writeLog(u, '批量导入工单', `成功 ${created.length} 单，失败 ${failed.length} 单`);
  ok(res, { ok_count: created.length, created, failed });
});

// 一键转生产工单：数量默认取销售数量（可改），客户/交期带入；重复点击幂等返回已生成的工单
route('POST', '/api/sales_orders/(\\d+)/convert', ['admin', 'technician'], (req, res, m, b, u) => {
  const s = get('SELECT * FROM sales_orders WHERE id=?', [m[1]]);
  if (!s) return fail(res, '销售订单不存在', 404);
  if (s.status === 'cancelled') return fail(res, '已取消的订单不能转工单');
  if (s.produced_order_id) {
    const ex = get('SELECT id, code FROM orders WHERE id=?', [s.produced_order_id]);
    if (ex) return ok(res, { order_id: ex.id, code: ex.code, existed: true });
  }
  if (!s.product_id) return fail(res, '该订单未关联产品档案，无法转工单');
  const route0 = get('SELECT * FROM routes WHERE product_id=? ORDER BY id LIMIT 1', [s.product_id]);
  if (!route0) return fail(res, '该产品还没有工艺路线，请先在基础数据中建立');
  const qty = Math.max(1, Math.floor(num(b.qty, num(s.qty, 1))));
  const code = 'WO' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 9000) + 1000);
  const oid = tx(() => {
    const oid2 = insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,plan_start,plan_end,status,remark,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, s.product_id, route0.id, s.customer_id, qty, num(b.priority, 2),
        b.plan_start || today(), b.plan_end || s.delivery_date || today(), 'created',
        '销售订单 ' + s.code + (s.customer_name ? '（' + s.customer_name + '）' : ''), u.id, now()]);
    all('SELECT * FROM route_steps WHERE route_id=? ORDER BY seq', [route0.id]).forEach((st) => {
      insert('INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,status,inspect_type) VALUES(?,?,?,?,?,?,?)',
        [oid2, st.seq, st.process_id, st.work_center_id, qty, 'pending', String(st.inspect_type || '')]);
    });
    run('UPDATE sales_orders SET produced_order_id=? WHERE id=?', [oid2, s.id]);
    return oid2;
  });
  writeLog(u, '销售订单转工单', s.code + ' → ' + code + ' 数量 ' + qty);
  ok(res, { order_id: oid, code });
});

// 状态流转：取消 / 手工完工（已出货核销的自动置 done，一般不需要手工）
route('PATCH', '/api/sales_orders/(\\d+)/status', ['admin', 'technician'], (req, res, m, b, u) => {
  const row = get('SELECT * FROM sales_orders WHERE id=?', [m[1]]);
  if (!row) return fail(res, '销售订单不存在', 404);
  const to = b.status;
  if (!SALES_STATUS_LABEL[to]) return fail(res, '无效的状态');
  if (to === 'cancelled' && num(row.shipped_qty) > 0) return fail(res, '该订单已有出货记录，不能取消');
  run('UPDATE sales_orders SET status=? WHERE id=?', [to, m[1]]);
  writeLog(u, '销售订单状态', row.code + ' → ' + SALES_STATUS_LABEL[to] + (b.reason ? '（' + b.reason + '）' : ''));
  ok(res, true);
});

/* ------------------------------ P2：齐套分析 + 简单排产 ------------------------------
 * 齐套：按产品单耗 BOM（product_boms）× 计划数量 ×(1+损耗率) 对比库存台账合计；
 * 未维护 BOM 的产品返回 has_bom=false（不阻塞排产，仅提示）。 */
function kitForOrder(o) {
  const rows = all(`SELECT b.material_id, m.code mcode, m.name mname, m.unit munit, b.qty_per_unit, b.loss_rate
    FROM product_boms b JOIN materials m ON m.id=b.material_id WHERE b.product_id=?`, [o.product_id]);
  if (!rows.length) return { has_bom: false, kit_pct: null, shortage: 0, lines: [] };
  const lines = rows.map((r) => {
    const need = Math.round(num(o.qty_plan) * num(r.qty_per_unit) * (1 + num(r.loss_rate) / 100) * 1e4) / 1e4;
    const stock = num(get('SELECT IFNULL(SUM(qty),0) s FROM inventory WHERE material_id=?', [r.material_id]).s);
    const gap = Math.round(Math.max(0, need - stock) * 1e4) / 1e4;
    return { material_id: r.material_id, code: r.mcode, name: r.mname, unit: r.munit,
      qty_per_unit: num(r.qty_per_unit), loss_rate: num(r.loss_rate), need, stock, gap, ok: gap <= 0 };
  });
  const pct = Math.min(...lines.map((l) => (l.need > 0 ? Math.min(1, l.stock / l.need) : 1)));
  return { has_bom: true, kit_pct: Math.floor(pct * 100), shortage: lines.filter((l) => !l.ok).length, lines };
}

route('GET', '/api/orders/(\\d+)/kit', [], (req, res, m) => {
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  const k = kitForOrder(o);
  ok(res, { order_id: o.id, code: o.code, product_id: o.product_id, qty_plan: o.qty_plan, ...k });
});

// 排产看板：全部未完工工单 + 齐套 + 进度/瓶颈/速率/完工预测/逾期分级（竞品对标增强版）
// 口径：进度 qty_done = MIN(各工序 qty_good)（瓶颈）；速率取瓶颈工序近7天报工合格数日均值；逾期按计划完工日分级。
route('GET', '/api/stats/kit', [], (req, res, _m, _b, _u, q) => {
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(today + 'T00:00:00Z').getTime();
  const dayMs = 86400000;
  const d7ago = new Date(todayMs - 7 * dayMs).toISOString().slice(0, 10);
  const list = all(`SELECT o.id, o.code, o.product_id, p.name product_name, p.code product_code,
      o.qty_plan, o.priority, o.plan_start, o.plan_end, o.status, c.name customer_name
    FROM orders o JOIN products p ON p.id=o.product_id LEFT JOIN customers c ON c.id=o.customer_id
    WHERE o.status NOT IN ('done','closed')
    ORDER BY o.priority, o.plan_end, o.id`).filter((o) => {
    if (q.status && o.status !== q.status) return false;
    return true;
  });
  const result = list.map((o) => {
    const k = kitForOrder(o);
    /* ---- 进度与瓶颈（MIN 口径） ---- */
    const steps = all(`SELECT s.id, s.seq, s.qty_plan, s.qty_good, s.status, pr.name pname
      FROM order_steps s JOIN processes pr ON pr.id=s.process_id WHERE s.order_id=? ORDER BY s.seq`, [o.id]);
    const goods = steps.map((s) => num(s.qty_good));
    const qtyDone = goods.length ? Math.min(...goods) : 0;
    const progressPct = num(o.qty_plan) > 0 ? Math.min(100, Math.round(qtyDone / num(o.qty_plan) * 100)) : 0;
    /* 瓶颈工序：未完成工序中完成率最低者（并列取靠后工序——流水线堵点） */
    let bottleneck = null;
    const unfinished = steps.filter((s) => s.status !== 'done');
    if (unfinished.length) {
      const ranked = unfinished.map((s) => ({
        s, pct: num(s.qty_plan) > 0 ? num(s.qty_good) / num(s.qty_plan) : 1,
      })).sort((a, b) => (a.pct - b.pct) || (b.s.seq - a.s.seq));
      bottleneck = { step_id: ranked[0].s.id, seq: ranked[0].s.seq, name: ranked[0].s.pname, pct: Math.floor(ranked[0].pct * 100) };
    }
    /* ---- 速率与完工预测：瓶颈工序近7天报工合格数日均值 ---- */
    let dailyRate = 0;
    if (bottleneck) {
      const r = get(`SELECT IFNULL(SUM(qty_good),0) s FROM reports WHERE order_id=? AND order_step_id=? AND report_date>=?`,
        [o.id, bottleneck.step_id, d7ago]).s;
      dailyRate = Math.round((num(r) / 7) * 100) / 100;
    } else if (steps.length) {
      const r = get(`SELECT IFNULL(SUM(qty_good),0) s FROM reports WHERE order_id=? AND report_date>=?`, [o.id, d7ago]).s;
      dailyRate = Math.round((num(r) / 7) * 100) / 100;
    }
    const remaining = Math.max(0, num(o.qty_plan) - qtyDone);
    let forecastEnd = null; let delayDays = null;
    if (remaining <= 0) { forecastEnd = today; }
    else if (dailyRate > 0) {
      forecastEnd = new Date(todayMs + Math.ceil(remaining / dailyRate) * dayMs).toISOString().slice(0, 10);
    }
    if (forecastEnd && o.plan_end) delayDays = Math.round((new Date(forecastEnd + 'T00:00:00Z') - new Date(o.plan_end + 'T00:00:00Z')) / dayMs);
    /* ---- 逾期分级：none / due_soon(≤2天) / overdue_1_3 / overdue_3p ---- */
    let dueClass = 'none';
    if (o.plan_end) {
      const diff = Math.round((todayMs - new Date(o.plan_end + 'T00:00:00Z').getTime()) / dayMs); // >0 已过期
      if (diff > 0) dueClass = diff >= 3 ? 'overdue_3p' : 'overdue_1_3';
      else if (diff >= -2) dueClass = 'due_soon';
    }
    return { ...o, has_bom: k.has_bom, kit_pct: k.kit_pct, shortage: k.shortage,
      shortages: k.lines.filter((l) => !l.ok).slice(0, 5).map((l) => l.name + ' 缺 ' + l.gap),
      qty_done: qtyDone, progress_pct: progressPct, steps_total: steps.length,
      steps_done: steps.filter((s) => s.status === 'done').length,
      bottleneck, daily_rate: dailyRate, forecast_end: forecastEnd, delay_days: delayDays, due_class: dueClass };
  });
  ok(res, {
    orders: result,
    today,
    summary: {
      total: result.length,
      full_kit: result.filter((r) => r.has_bom && r.kit_pct >= 100).length,
      shortage: result.filter((r) => r.has_bom && r.kit_pct < 100).length,
      no_bom: result.filter((r) => !r.has_bom).length,
      due_today: result.filter((r) => r.plan_end === today).length,
      due_soon: result.filter((r) => r.due_class === 'due_soon').length,
      overdue: result.filter((r) => r.due_class.startsWith('overdue')).length,
      delayed_forecast: result.filter((r) => r.delay_days !== null && r.delay_days > 0).length,
      running: result.filter((r) => r.status === 'running').length,
      paused: result.filter((r) => r.status === 'paused').length,
      plan_qty: result.reduce((a, r) => a + num(r.qty_plan), 0),
      done_qty: result.reduce((a, r) => a + r.qty_done, 0),
    },
  });
});

// 排产调整：计划开工/完工 + 优先级（工单列表与排产看板共用）
route('PUT', '/api/orders/(\\d+)/schedule', ['admin', 'technician'], (req, res, m, b, u) => {
  const o = get('SELECT * FROM orders WHERE id=?', [m[1]]);
  if (!o) return fail(res, '工单不存在', 404);
  if (['done', 'closed'].includes(o.status)) return fail(res, '已完工/已关闭的工单不能再排产');
  const prio = b.priority !== undefined ? num(b.priority, o.priority) : o.priority;
  if (![1, 2, 3].includes(prio)) return fail(res, '优先级无效（1 高 / 2 中 / 3 低）');
  const ps = b.plan_start !== undefined ? (b.plan_start || null) : o.plan_start;
  const pe = b.plan_end !== undefined ? (b.plan_end || null) : o.plan_end;
  if (ps && pe && ps > pe) return fail(res, '计划开工不能晚于计划完工');
  run('UPDATE orders SET plan_start=?, plan_end=?, priority=? WHERE id=?', [ps, pe, prio, m[1]]);
  writeLog(u, '工单排产调整', `${o.code} 计划 ${ps || '—'} ~ ${pe || '—'} 优先级 ${prio}`);
  ok(res, true);
});

/* ------------------------------ 盘点调整（实盘数 → 差异流水） ------------------------------ */
route('POST', '/api/inventory/adjust', ['admin', 'technician'], (req, res, _m, b, u) => {
  const mid = num(b.material_id);
  if (!mid) return fail(res, '请选择物料');
  const m = get('SELECT * FROM materials WHERE id=?', [mid]);
  if (!m) return fail(res, '物料不存在', 404);
  if (b.physical_qty === undefined || b.physical_qty === null || b.physical_qty === '' || num(b.physical_qty) < 0) return fail(res, '请填写有效的实盘数量');
  const physical = num(b.physical_qty);
  // 仓库口径与 applyStock 一致：未指定时回退物料默认仓库
  const whAdj = num(b.warehouse_id) || num(m.warehouse_id) || null;
  const inv = get('SELECT * FROM inventory WHERE material_id=? AND IFNULL(warehouse_id,0)=? AND IFNULL(batch,\'\')=?',
    [mid, num(whAdj), String(b.batch || '').trim()]);
  const book = inv ? num(inv.qty) : 0;
  const diff = Math.round((physical - book) * 1e6) / 1e6;
  if (Math.abs(diff) < 1e-9) return fail(res, '实盘数与账面数一致（' + book + '），无需调整');
  const code = genCode('PD');
  applyStock({ material_id: mid, warehouse_id: b.warehouse_id, batch: b.batch, qty: diff, tx_type: 'adjust',
    ref_type: 'adjust', ref_id: null, ref_code: code, order_id: null,
    operator: u.name, tx_date: b.adjust_date || today(),
    remark: '盘点调整 ' + code + '：账面 ' + book + ' → 实盘 ' + physical + (b.remark ? '，' + b.remark : '') });
  writeLog(u, '盘点调整', (m.name || '') + ' 账面 ' + book + ' → 实盘 ' + physical + '（差异 ' + diff + '）');
  ok(res, { code, book, physical, diff });
});

/* ------------------------------ 完工入库补齐（工单完工量 → 成品库） ------------------------------
 * 把「工单末道工序完工量」与「该工单自动入库量」的差额补生成成品入库单，使工单完工多少件都能在仓储查到。
 * 用于历史报工（自动入库功能上线前）未生成入库单的补救；可反复执行：
 *   每次先移除该工单旧的补齐单（source='sync'）并冲销库存，再按最新差额重建 —— 幂等且双向一致。
 * 只处理 source='sync' 的补齐单；人工手工建的入库单（source 为空且 report_id 为空）与
 * 末道报工自动单（report_id 非空）均不受影响。 */
route('POST', '/api/warehouse/sync_finished', ['admin', 'technician'], (req, res, _m, _b, u) => {
  try {
    const result = { order_count: 0, created: 0, qty: 0, removed: 0 };
    tx(() => {
      const orders = all(`SELECT o.id, o.code, o.product_id,
          (SELECT COALESCE(qty_good,0) FROM order_steps s WHERE s.order_id=o.id ORDER BY s.seq DESC LIMIT 1) done
        FROM orders o`);
      for (const o of orders) {
        const done = Number(o.done || 0);
        const product = get('SELECT id,code,name,spec,unit FROM products WHERE id=?', [o.product_id]);
        if (!product || !product.code) continue;
        // 该工单自动入库量（末道报工自动生成的单：report_id 非空）
        const autoIn = Number(get('SELECT COALESCE(SUM(qty),0) q FROM finished_goods_in WHERE order_id=? AND report_id IS NOT NULL', [o.id]).q || 0);
        // 先移除旧的补齐单（source='sync'），保证幂等并支持反向调整
        for (const f of all("SELECT id FROM finished_goods_in WHERE order_id=? AND source='sync'", [o.id])) {
          revertStock('finished_goods_in', f.id, u.name);
          run('DELETE FROM finished_goods_in WHERE id=?', [f.id]);
          result.removed++;
        }
        const need = done - autoIn;
        if (need > 0) {
          const mid = ensureFgMaterial(product);
          const wh = ensureFgWarehouse();
          const code = genCode('RK');
          const id = insert(`INSERT INTO finished_goods_in(code,in_date,order_id,material_id,warehouse_id,product_code,product_name,spec,qty,unit,batch,location,inspector,result,remark,source,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [code, today(), o.id, mid, wh, product.code || null, product.name, product.spec || null,
              need, product.unit || '件', null, null, null, 'qualified', '完工入库补齐（历史报工未自动入库）', 'sync', u.id, now()]);
          applyStock({ material_id: mid, warehouse_id: wh, batch: null, location: null, qty: need, tx_type: 'in_finish',
            ref_type: 'finished_goods_in', ref_id: id, ref_code: code, order_id: o.id, operator: u.name, tx_date: today(), remark: '完工入库补齐 ' + code });
          result.created++;
          result.qty += need;
        }
        result.order_count++;
      }
    });
    writeLog(u, '同步完工入库', `补齐 ${result.created} 张 / ${result.qty} 件（重算 ${result.removed} 张补齐单）`);
    ok(res, result);
  } catch (e) { fail(res, e.message, 400); }
});

/* ------------------------------ 物料档案 ------------------------------ */
route('GET', '/api/materials', [], (req, res) => {
  ok(res, all(`SELECT m.*, w.name warehouse_name FROM materials m LEFT JOIN warehouses w ON w.id=m.warehouse_id ORDER BY m.code`));
});
route('POST', '/api/materials', ['admin', 'technician'], (req, res, _m, b, u) => {
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
route('PUT', '/api/materials/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
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
route('POST', '/api/materials/import_products', ['admin', 'technician'], (req, res, _m, _b, u) => {
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
route('POST', '/api/warehouses', ['admin', 'technician'], (req, res, _m, b, u) => {
  const code = String(b.code || '').trim();
  if (!code) return fail(res, '仓库编号不能为空');
  if (get('SELECT id FROM warehouses WHERE code=?', [code])) return fail(res, '该仓库编号已存在');
  const id = insert('INSERT INTO warehouses(code,name,remark,created_at) VALUES(?,?,?,?)',
    [code, String(b.name || '').trim() || code, b.remark || null, now()]);
  writeLog(u, '新增仓库', code);
  ok(res, { id });
});
route('PUT', '/api/warehouses/(\\d+)', ['admin', 'technician'], (req, res, m, b, u) => {
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
  const rows = all(`SELECT t.*, m.code material_code, m.name material_name, m.unit, w.name warehouse_name, o.code order_code
    FROM inventory_tx t JOIN materials m ON m.id=t.material_id
    LEFT JOIN warehouses w ON w.id=t.warehouse_id LEFT JOIN orders o ON o.id=t.order_id
    ${w} ORDER BY t.id DESC LIMIT ?`, [...ps, limit]);
  if (q.format === 'csv') {
    const TXL = { in_incoming: '来料入库', in_finish: '成品入库', out_pick: '领料出库', in_return: '退料入库', out_ship: '成品出库', adjust: '盘点调整' };
    return sendCSV(res, '收发明细.csv', ['日期', '类型', '物料编码', '物料名称', '批次', '数量', '变动前', '变动后', '仓库', '关联工单', '单号', '操作人'],
      rows.map((r) => [r.tx_date, TXL[r.tx_type] || r.tx_type, r.material_code, r.material_name, r.batch, r.qty, r.before_qty, r.after_qty, r.warehouse_name, r.order_code, r.ref_code, r.operator]));
  }
  ok(res, rows);
});

/* ------------------------------ 投入产出比（来料 → 成品入库） ------------------------------
 * 口径：产出比 = 成品入库合格数 ÷ 来料合格数 × 100%（默认只计检验合格，可含待检）。
 * 三层：总览（期间合计）+ 按月趋势（近6个月）+ 按工单明细（利用来料/入库单的 order_id 关联）。
 * 未关联工单的来料单汇总为「公共来料」，不摊入工单口径。 */
route('GET', '/api/stats/yield', [], (req, res, _m, _b, _u, q) => {
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const monthsMap = { month: 1, quarter: 3, year: 12, all: 0 };
  const months = monthsMap[q.period] !== undefined ? monthsMap[q.period] : 1;
  let start = null;
  if (months > 0) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (months - 1));
    start = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
  }
  const incRes = q.include_pending === '1' ? ['qualified', 'pending'] : ['qualified'];
  const resIn = incRes.map(() => '?').join(',');
  // 期间合计（总览 + 工单口径）
  const incWhere = `result IN (${resIn})` + (start ? ' AND incoming_date>=?' : '');
  const incPs = start ? [...incRes, start] : [...incRes];
  const finWhere = `result IN (${resIn})` + (start ? ' AND in_date>=?' : '');
  const finPs = start ? [...incRes, start] : [...incRes];
  const incTotal = r2(get(`SELECT SUM(qty) qty FROM incoming_materials WHERE ${incWhere}`, incPs).qty);
  const finTotal = r2(get(`SELECT SUM(qty) qty FROM finished_goods_in WHERE ${finWhere}`, finPs).qty);
  const incPublic = r2(get(`SELECT SUM(qty) qty FROM incoming_materials WHERE ${incWhere} AND order_id IS NULL`, incPs).qty);
  // 按工单
  const incByOrder = all(`SELECT order_id, SUM(qty) qty FROM incoming_materials WHERE ${incWhere} AND order_id IS NOT NULL GROUP BY order_id`, incPs);
  const finByOrder = all(`SELECT order_id, SUM(qty) qty FROM finished_goods_in WHERE ${finWhere} AND order_id IS NOT NULL GROUP BY order_id`, finPs);
  const ids = [...new Set([...incByOrder.map((r) => r.order_id), ...finByOrder.map((r) => r.order_id)])];
  const oRows = ids.length ? all(`SELECT o.id, o.code, o.qty_plan, p.name product_name,
      (SELECT MIN(s.qty_good) FROM order_steps s WHERE s.order_id=o.id) qty_done
    FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  const incMap = {}; incByOrder.forEach((r) => { incMap[r.order_id] = r2(r.qty); });
  const finMap = {}; finByOrder.forEach((r) => { finMap[r.order_id] = r2(r.qty); });
  const orders = oRows.map((o) => ({
    order_id: o.id, order_code: o.code, product_name: o.product_name,
    qty_plan: num(o.qty_plan), qty_done: num(o.qty_done),
    incoming_qty: incMap[o.id] || 0, finished_qty: finMap[o.id] || 0,
    ratio: incMap[o.id] > 0 ? r2((finMap[o.id] || 0) / incMap[o.id] * 100) : null,
  })).sort((a, b) => b.order_id - a.order_id);
  // 按月趋势（近6个月，独立于期间筛选）
  const d6 = new Date(); d6.setDate(1); d6.setMonth(d6.getMonth() - 5);
  const mStart = d6.getFullYear() + '-' + String(d6.getMonth() + 1).padStart(2, '0') + '-01';
  const incM = all(`SELECT substr(incoming_date,1,7) ym, SUM(qty) qty FROM incoming_materials WHERE result IN (${resIn}) AND incoming_date>=? GROUP BY ym`, [...incRes, mStart]);
  const finM = all(`SELECT substr(in_date,1,7) ym, SUM(qty) qty FROM finished_goods_in WHERE result IN (${resIn}) AND in_date>=? GROUP BY ym`, [...incRes, mStart]);
  const im = {}; incM.forEach((r) => { im[r.ym] = r2(r.qty); });
  const fm = {}; finM.forEach((r) => { fm[r.ym] = r2(r.qty); });
  const monthly = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 5 + i);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const iq = im[ym] || 0, fq = fm[ym] || 0;
    monthly.push({ month: ym, incoming_qty: iq, finished_qty: fq, ratio: iq > 0 ? r2(fq / iq * 100) : null });
  }
  ok(res, {
    period: months === 0 ? 'all' : (q.period || 'month'), start,
    include_pending: q.include_pending === '1',
    summary: {
      incoming_qty: incTotal, finished_qty: finTotal,
      ratio: incTotal > 0 ? r2(finTotal / incTotal * 100) : null,
      orders_count: ids.length, public_incoming: incPublic,
    },
    monthly, orders,
  });
});

/* ------------------------------ 收发存汇总（期初 + 收入 − 发出 = 期末） ------------------------------
 * 口径：期末取自库存台账当前值；期间收入/发出按流水统计（含冲销红字，ERP 惯例）；
 * 期初 = 期末 − 收入 + 发出 倒推，保证恒等式恒成立（冲销不破坏账实一致）。 */
route('GET', '/api/stats/inventory_summary', [], (req, res, _m, _b, _u, q) => {
  const d = new Date();
  const start = q.start || d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
  const end = q.end || today();
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const rows = all(`SELECT m.id material_id, m.code material_code, m.name material_name, m.unit, m.category,
      IFNULL(inv.qty, 0) closing,
      IFNULL(tx.in_qty, 0) in_qty, IFNULL(tx.out_qty, 0) out_qty
    FROM materials m
    LEFT JOIN (SELECT material_id, SUM(qty) qty FROM inventory GROUP BY material_id) inv ON inv.material_id = m.id
    LEFT JOIN (SELECT material_id,
        SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) in_qty,
        SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) out_qty
      FROM inventory_tx WHERE tx_date >= ? AND tx_date <= ? GROUP BY material_id) tx ON tx.material_id = m.id
    ORDER BY m.code`, [start, end])
    .map((r) => {
      const closing = r2(r.closing), inq = r2(r.in_qty), outq = r2(r.out_qty);
      return { material_id: r.material_id, material_code: r.material_code, material_name: r.material_name, unit: r.unit, category: r.category,
        opening: r2(closing - inq + outq), in_qty: inq, out_qty: outq, closing };
    })
    .filter((r) => r.opening || r.in_qty || r.out_qty || r.closing);
  ok(res, { start, end, rows });
});

/* ------------------------------ 产品单耗（简易 BOM） ------------------------------ */
route('GET', '/api/boms', [], (_req, res) => {
  ok(res, all(`SELECT b.*, p.name product_name, p.code product_code, m.name material_name, m.code material_code, m.unit
    FROM product_boms b JOIN products p ON p.id=b.product_id JOIN materials m ON m.id=b.material_id
    ORDER BY p.code, m.code`));
});

// 全量替换某产品的 BOM（items: [{material_id, qty_per_unit, loss_rate}]）
route('PUT', '/api/products/(\\d+)/bom', ['admin', 'technician'], (req, res, m, b, u) => {
  const pid = num(m[1]);
  if (!get('SELECT id FROM products WHERE id=?', [pid])) return fail(res, '产品不存在', 404);
  const items = Array.isArray(b.items) ? b.items : [];
  for (const it of items) {
    if (!num(it.material_id)) return fail(res, 'BOM 项缺少物料');
    if (!(num(it.qty_per_unit) > 0)) return fail(res, '单耗必须大于 0');
    if (num(it.loss_rate) < 0 || num(it.loss_rate) > 100) return fail(res, '损耗率需在 0~100 之间');
  }
  const seen = new Set();
  for (const it of items) {
    if (seen.has(num(it.material_id))) return fail(res, '同一物料不能重复添加');
    seen.add(num(it.material_id));
  }
  tx(() => {
    run('DELETE FROM product_boms WHERE product_id=?', [pid]);
    for (const it of items) {
      insert('INSERT INTO product_boms(product_id,material_id,qty_per_unit,loss_rate,created_at) VALUES(?,?,?,?,?)',
        [pid, num(it.material_id), num(it.qty_per_unit), num(it.loss_rate), now()]);
    }
  });
  writeLog(u, '配置产品单耗', '产品#' + pid + ' 共 ' + items.length + ' 项材料');
  ok(res, true);
});

/* ------------------------------ 材料损耗率分析（口径 B） ------------------------------
 * 应耗 = 成品入库合格数 × 单耗 × (1 + 损耗率%)；实领 = 领料 − 退料；损耗率 = (实领 − 应耗) ÷ 应耗 */
route('GET', '/api/stats/material_loss', [], (req, res, _m, _b, _u, q) => {
  const d = new Date();
  const start = q.start || d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
  const end = q.end || today();
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  // 期间内各工单成品入库合格数
  const fin = all(`SELECT order_id, SUM(qty) qty FROM finished_goods_in
    WHERE result='qualified' AND order_id IS NOT NULL AND in_date>=? AND in_date<=? GROUP BY order_id`, [start, end]);
  // 期间内各工单×物料净领料（领料为正、退料为负）
  const picks = all(`SELECT order_id, material_id, SUM(CASE WHEN type='pick' THEN qty ELSE -qty END) qty
    FROM material_issues WHERE order_id IS NOT NULL AND issue_date>=? AND issue_date<=? GROUP BY order_id, material_id`, [start, end]);
  const bomRows = all(`SELECT b.*, m.name material_name, m.code material_code, m.unit,
      p.name product_name, p.code product_code
    FROM product_boms b JOIN materials m ON m.id=b.material_id JOIN products p ON p.id=b.product_id`);
  const finMap = new Map(fin.map((r) => [num(r.order_id), num(r.qty)]));
  const pickMap = new Map(picks.map((r) => [r.order_id + ':' + r.material_id, num(r.qty)]));
  const orderIds = new Set([...finMap.keys()]);
  const rows = [];
  const ordersInfo = new Map(all('SELECT id, code, qty_plan, product_id FROM orders').map((o) => [o.id, o]));
  for (const oid of orderIds) {
    const finQty = finMap.get(oid);
    if (!(finQty > 0)) continue;
    const o = ordersInfo.get(oid) || {};
    for (const b of bomRows) {
      if (num(b.product_id) !== num(o.product_id)) continue;
      const should = r2(finQty * num(b.qty_per_unit) * (1 + num(b.loss_rate) / 100));
      const actual = r2(pickMap.get(oid + ':' + b.material_id) || 0);
      const loss = should > 0 ? Math.round(((actual - should) / should) * 1000) / 10 : null;
      rows.push({
        order_id: oid, order_code: o.code, product_name: b.product_name, qty_plan: num(o.qty_plan),
        material_id: b.material_id, material_code: b.material_code, material_name: b.material_name, unit: b.unit,
        qty_per_unit: num(b.qty_per_unit), loss_rate_std: num(b.loss_rate),
        finished_qty: r2(finQty), should_use: should, actual_pick: actual,
        loss_rate: loss === null ? null : loss,        // 正=超耗，负=节约
      });
    }
  }
  rows.sort((a, b2) => (a.order_code < b2.order_code ? -1 : 1));
  ok(res, { start, end, rows, hint: rows.length ? null : '未配置产品单耗或期间内无成品入库' });
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
      // 角色语义（2026-10-06 安全加固）：['*']=完全公开；空数组=需登录（任意角色）；非空=需登录且角色匹配
      if (roles[0] === '*') return fn(req, res, m, body, currentUser(req), query);
      if (roles.length) {
        const u = currentUser(req);
        if (!u) return fail(res, '未登录或登录已过期', 401);
        if (!roles.includes(u.role)) return fail(res, '当前角色无权执行该操作', 403);
        return fn(req, res, m, body, u, query);
      }
      const u0 = currentUser(req);
      if (!u0) return fail(res, '未登录或登录已过期', 401);
      return fn(req, res, m, body, u0, query);
    } catch (e) {
      return fail(res, e.message || '服务器内部错误', 500);
    }
  }

  // 移动端入口：/m/ 直接进 APP 工作台（登录态），扫码报工走 /m/index.html
  if (pathname === '/m' || pathname === '/m/') {
    const appFile = path.join(PUBLIC_DIR, 'm', 'app', 'index.html');
    if (fs.existsSync(appFile)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(appFile).pipe(res);
    }
    const mfile = path.join(PUBLIC_DIR, 'm', 'index.html');
    if (fs.existsSync(mfile)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(mfile).pipe(res);
    }
  }
  // /app 与 /m/app 都作为 APP 工作台别名（便于宣传口径「打开 /app」）
  if (pathname === '/app' || pathname === '/app/' || pathname === '/m/app' || pathname === '/m/app/') {
    const appFile = path.join(PUBLIC_DIR, 'm', 'app', 'index.html');
    if (fs.existsSync(appFile)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(appFile).pipe(res);
    }
  }

  // SOP/图纸等上传文件（落盘在 data/uploads/，与数据库同卷保证持久化）
  if (pathname.startsWith('/uploads/')) {
    const upDir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
    const f = path.join(upDir, path.basename(decodeURIComponent(pathname.slice('/uploads/'.length))));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' });
    return fs.createReadStream(f).pipe(res);
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

// 质量异常超时扫描（未认领抄送 / 超时升级），每分钟一次
// unref()：不作为进程存活的理由——被测试/脚本 require 时可正常退出
setInterval(scanOverdueIssues, 60 * 1000).unref();
setTimeout(scanOverdueIssues, 5 * 1000).unref();
// 待检超时提醒：每 5 分钟扫一次，启动 10 秒后首扫
setInterval(scanInspectOverdue, 5 * 60 * 1000).unref();
setTimeout(scanInspectOverdue, 10 * 1000).unref();
// 库存预警：启动 15 秒后首扫，之后每 10 分钟一次
setInterval(scanStockAlertsTick, 10 * 60 * 1000).unref();
setTimeout(scanStockAlertsTick, 15 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  生产管理系统已启动');
  console.log('  ------------------------------------------');
  console.log('  本机访问:  http://localhost:' + PORT);
  console.log('  演示账号:  admin / 123456   (管理员)');
  console.log('            tech1 / 123456 (技术员)');
  console.log('            worker1 / 123456 (操作工)');
  console.log('  数据文件:  ' + path.join(__dirname, 'data', 'mes.db'));
  console.log('  ------------------------------------------');
  console.log('');
});

module.exports = server;
