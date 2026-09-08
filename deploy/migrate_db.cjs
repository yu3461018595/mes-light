#!/usr/bin/env node
// MES-Light 数据迁移：把备份 JSON 导入到 SQLite 库
//
// 用法（在仓库根目录执行）：
//   node deploy/migrate_db.cjs /path/to/backup.json            // 增量导入
//   node deploy/migrate_db.cjs /path/to/backup.json --clean    // 先清空业务表再导入（推荐，结果与旧库一致）
//
// 关键顺序：**必须在应用首次启动前执行**。
//   server.js 启动时会调用 seed()，若 users 表为空会灌入 12 张演示工单等演示数据。
//   先导入真实数据（users 非空）→ seed() 自动跳过演示数据。
//
// 已知坑（本次修复）：
//   1) 线上导出的 JSON 不含 password 字段（安全考虑），直接插入会因 users.password NOT NULL 失败。
//      若用 INSERT OR IGNORE，失败行会被**静默丢弃**，导致 users 表为空，
//      随后 orders.created_by 找不到父记录，报成 FOREIGN KEY constraint failed —— 表象与真因相隔好几张表。
//      现改为：NOT NULL 且无默认值的列自动补兜底值（password 补 123456 的哈希）。
//   2) 不再使用 INSERT OR IGNORE，改为 INSERT OR REPLACE（幂等，可重复执行）+ 逐行捕获，
//      任何失败都会打印明细并在结束时汇总告警。
//   3) 导入结束执行 PRAGMA foreign_key_check 做完整性校验。

const path = require('path');
const { db, all, run, hashPassword } = require('../lib/db.js');

const file = process.argv[2];
const clean = process.argv.includes('--clean');
if (!file) {
  console.error('用法: node deploy/migrate_db.cjs backup.json [--clean]');
  process.exit(1);
}
const data = require(path.resolve(file));

const DEFAULT_PASSWORD = '123456';
const PWD_HASH = hashPassword(DEFAULT_PASSWORD);

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

function info(table) {
  return all(`PRAGMA table_info(${table})`);
}
function count(table) {
  return all(`SELECT COUNT(*) c FROM ${table}`)[0].c;
}
function defaultByType(type) {
  const t = String(type || '').toUpperCase();
  if (/INT/.test(t)) return 0;
  if (/REAL|FLOA|DOUB|NUM/.test(t)) return 0;
  return '';
}

/* 构造一行的列与值：
   - password 缺失 → 补默认密码哈希
   - 其它 NOT NULL 缺失 → 有 DEFAULT 则省略该列（交给 SQLite），无 DEFAULT 则按类型补 0/'' */
function buildRow(cols, row) {
  const useCols = [];
  const vals = [];
  for (const col of cols) {
    let v = Object.prototype.hasOwnProperty.call(row, col.name) ? row[col.name] : null;
    if (v === undefined || v === null || v === '') {
      if (col.name === 'password') {
        v = PWD_HASH;                       // 导出数据不含密码，统一重置
      } else if (col.notnull) {
        if (col.dflt_value !== null) continue; // 省略 → 用表定义的 DEFAULT
        v = defaultByType(col.type);
      } else {
        v = null;
      }
    }
    useCols.push(col.name);
    vals.push(v);
  }
  return [useCols, vals];
}

const stmtCache = new Map();
/* 生成 upsert 语句。
   注意：不能用 INSERT OR REPLACE —— 它的语义是「先 DELETE 再 INSERT」，
   删除父行会触发外键的 ON DELETE CASCADE 级联删掉子表数据（如 products 被删会连带删 routes），
   而没配 CASCADE 的外键（如 orders→products）则直接报 FOREIGN KEY constraint failed。
   改用 ON CONFLICT(id) DO UPDATE：只更新不删行，幂等且安全。*/
function stmtFor(table, useCols, pkName) {
  const key = table + '|' + useCols.join(',');
  let s = stmtCache.get(key);
  if (s) return s;
  const placeholders = useCols.map(() => '?').join(',');
  const updates = useCols.filter((c) => c !== pkName);
  let sql;
  if (pkName && updates.length) {
    sql = `INSERT INTO ${table} (${useCols.join(',')}) VALUES (${placeholders}) ` +
      `ON CONFLICT(${pkName}) DO UPDATE SET ${updates.map((c) => `${c}=excluded.${c}`).join(',')}`;
  } else {
    sql = `INSERT OR IGNORE INTO ${table} (${useCols.join(',')}) VALUES (${placeholders})`;
  }
  s = db.prepare(sql);
  stmtCache.set(key, s);
  return s;
}

if (clean) {
  console.log('清空既有数据（--clean）…');
  const order = ['reports', 'order_steps', 'orders', 'route_steps', 'routes',
    'logs', 'sessions', 'bad_reasons', 'products', 'processes', 'work_centers', 'customers', 'users'];
  run('BEGIN');
  for (const t of order) {
    try { run(`DELETE FROM ${t}`); } catch (e) { /* 表不存在则跳过 */ }
  }
  run('COMMIT');
}

console.log('开始导入…');
run('BEGIN');

let totalBackup = 0;
let totalOk = 0;
let totalFail = 0;
const summary = [];

for (const [key, table] of Object.entries(map)) {
  const rows = data[key] || [];
  if (!rows.length) { summary.push([table, 0, 0, 0]); continue; }
  let cols;
  try {
    cols = info(table);
  } catch (e) {
    console.error(`  跳过 ${table}：${e.message}`);
    continue;
  }
  const pk = (cols.find((c) => c.pk) || {}).name || 'id';
  let ok = 0;
  const fails = [];
  for (const row of rows) {
    const [useCols, vals] = buildRow(cols, row);
    try {
      stmtFor(table, useCols, pk).run(...vals);
      ok++;
    } catch (e) {
      fails.push({ vals, useCols, err: e.message });
    }
  }
  totalBackup += rows.length;
  totalOk += ok;
  totalFail += fails.length;

  if (fails.length) {
    console.error(`  ✗ ${table}: 失败 ${fails.length}/${rows.length} 行`);
    for (const f of fails.slice(0, 3)) {
      const obj = {};
      f.useCols.forEach((c, i) => { obj[c] = f.vals[i]; });
      console.error(`      ${f.err}`);
      console.error(`      ${JSON.stringify(obj)}`);
    }
  }
  summary.push([table, rows.length, ok, count(table)]);
}

run('COMMIT');

console.log('\n=== 导入结果核对 ===');
console.log('  表名'.padEnd(16) + '备份行数'.padEnd(10) + '成功插入'.padEnd(10) + '库内总数');
let mismatch = 0;
for (const [t, backup, ok, now] of summary) {
  const flag = (backup === now) ? '  ' : ' *';
  if (backup !== now) mismatch++;
  console.log(`${flag} ${String(t).padEnd(14)}${String(backup).padEnd(10)}${String(ok).padEnd(12)}${now}`);
}

// 统一重置密码（导出数据不含真实密码）
let usersCnt = 0;
try { usersCnt = count('users'); } catch (e) { /* ignore */ }
if (usersCnt > 0) {
  run('UPDATE users SET password=?', [PWD_HASH]);
  console.log(`\n所有 ${usersCnt} 个用户的密码已统一重置为 ${DEFAULT_PASSWORD}，请登录后立即修改。`);
} else {
  console.error('\n严重：users 表为空！后续 seed() 会灌入演示数据，请检查备份文件是否包含 users。');
}

// 外键完整性校验
const fk = all('PRAGMA foreign_key_check');
if (fk.length) {
  console.error(`\n外键校验失败：${fk.length} 条记录存在孤儿引用`);
  console.error(JSON.stringify(fk.slice(0, 5)));
} else {
  console.log('外键完整性校验：通过');
}

console.log(`\n合计：备份 ${totalBackup} 行，成功 ${totalOk} 行，失败 ${totalFail} 行。`);

if (totalFail > 0 || mismatch > 0 || fk.length > 0) {
  console.error('导入未完全成功，请检查上方明细。');
  process.exitCode = 1;
} else {
  console.log('导入完成，数据与备份完全一致。');
}
