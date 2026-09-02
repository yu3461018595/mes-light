// MES-Light 数据迁移（兜底方案）：从 Railway 备份 JSON 导入到本地 SQLite
// 优先做法其实是直接把旧服务器的 mes.db 拷到 ./data/mes.db（见 runbook），本脚本仅作兜底。
//
// 用法（在仓库根目录执行）：
//   node deploy/migrate_db.cjs /path/to/mes_live_backup_YYYYMMDD.json
//
// 说明：
//  - 复用 lib/db.js（同源 schema），按 PRAGMA 取真实列名，只插存在的列，避免 JOIN 派生字段报错。
//  - 备份 JSON 不含密码，导入后统一把全部用户密码重置为 123456，请上线后立即修改。
//  - 备份可能不含 route_steps 等表，属正常，导入后请在页面核对路由/工序是否完整。

const path = require('path');
const { db, all, run, hashPassword } = require('./lib/db.js');

const file = process.argv[2];
if (!file) {
  console.error('用法: node deploy/migrate_db.cjs backup.json');
  process.exit(1);
}
const data = require(path.resolve(file));

// 备份键名 -> 表名（与 lib/db.js 中 CREATE TABLE 一致）
const map = {
  users: 'users',
  customers: 'customers',
  processes: 'processes',
  work_centers: 'work_centers',
  products: 'products',
  routes: 'routes',
  route_steps: 'route_steps',
  orders: 'orders',
  order_steps: 'order_steps',
  reports: 'reports',
  logs: 'logs'
};

function colsOf(table) {
  return all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

let total = 0;
for (const [key, table] of Object.entries(map)) {
  const rows = data[key] || [];
  if (!rows.length) continue;
  const cols = colsOf(table);
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  run('BEGIN');
  for (const row of rows) {
    const vals = cols.map((c) => (c in row ? row[c] : null));
    stmt.run(...vals);
    total++;
  }
  run('COMMIT');
  console.log(`  ${table}: ${rows.length} 行`);
}

run('UPDATE users SET password=?', [hashPassword('123456')]);
console.log(`导入完成，共 ${total} 行。所有用户密码已重置为 123456，请尽快修改默认密码。`);
