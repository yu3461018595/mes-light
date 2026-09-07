#!/usr/bin/env node
// MES-Light 数据迁移：把备份 JSON 导入到 SQLite 库
//
// 用法（在仓库根目录执行）：
//   node deploy/migrate_db.cjs /path/to/backup.json            // 增量导入（INSERT OR IGNORE）
//   node deploy/migrate_db.cjs /path/to/backup.json --clean    // 先清空业务表再导入（推荐，结果与旧库一致）
//
// 关键顺序：**必须在应用首次启动前执行**。
//   server.js 启动时会调用 seed()，若 users 表为空会灌入 12 张演示工单等演示数据。
//   先导入真实数据（users 非空）→ seed() 自动跳过演示数据。
//   若已经先启动过容器、混入了演示数据，加 --clean 重跑一次即可清干净。
//
// 备份 JSON 由 export_live.py 生成，键对应下方 map 的表名。

const path = require('path');
const { db, all, run, hashPassword } = require('../lib/db.js');

const file = process.argv[2];
const clean = process.argv.includes('--clean');
if (!file) {
  console.error('用法: node deploy/migrate_db.cjs backup.json [--clean]');
  process.exit(1);
}
const data = require(path.resolve(file));

// 备份键名 -> 表名（与 lib/db.js 的 CREATE TABLE 一致）
const map = {
  users: 'users',
  customers: 'customers',
  processes: 'processes',
  work_centers: 'work_centers',
  products: 'products',
  bad_reasons: 'bad_reasons',
  routes: 'routes',
  route_steps: 'route_steps',
  orders: 'orders',
  order_steps: 'order_steps',
  reports: 'reports',
  logs: 'logs',
};

function colsOf(table) {
  return all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

if (clean) {
  console.log('清空既有数据（--clean）…');
  // 按外键依赖顺序删除
  const order = ['reports', 'order_steps', 'orders', 'route_steps', 'routes',
    'logs', 'sessions', 'bad_reasons', 'products', 'processes', 'work_centers', 'customers', 'users'];
  run('BEGIN');
  for (const t of order) {
    try { run(`DELETE FROM ${t}`); } catch (e) { /* 表不存在则跳过 */ }
  }
  run('COMMIT');
}

let total = 0;
run('BEGIN');
for (const [key, table] of Object.entries(map)) {
  const rows = data[key] || [];
  if (!rows.length) continue;
  const cols = colsOf(table);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  let n = 0;
  for (const row of rows) {
    stmt.run(...cols.map((c) => (c in row ? row[c] : null)));
    n++;
  }
  console.log(`  ${table}: ${n} 行`);
  total += n;
}
run('COMMIT');

run('UPDATE users SET password=?', [hashPassword('123456')]);
console.log(`导入完成，共 ${total} 行。`);
console.log('注意：所有用户密码已统一重置为 123456，请登录后立即修改。');
