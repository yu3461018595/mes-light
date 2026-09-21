/**
 * 生成静态版种子数据：把 SQLite 演示库导出为 public/data/seed.json
 * 供浏览器端数据层 Store 初始化使用（无需后端即可运行整套系统）。
 *
 * 用法： node build_static.js [DATA_DIR 可选]
 *   不传 DATA_DIR 时使用项目内的 .seed-tmp（每次重建前自动清空），
 *   保证导出的永远是「干净的全量演示数据」，不会误读被改脏的 ./data/mes.db。
 *   若确需导出某个已有库：node build_static.js ./data
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 必须在 require('./lib/db') 之前确定 DATA_DIR —— lib/db.js 在模块加载时即读取该环境变量建库
const argDir = process.argv[2];
const fresh = !argDir; // 未显式指定目录 => 走一次性干净库
const dataDir = argDir
  ? path.resolve(argDir)
  : path.join(__dirname, '.seed-tmp');

if (fresh && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;

const D = require('./lib/db');

// 空库时写入整套演示数据（与 server.js 启动行为一致）
D.seed();

const TABLES = [
  'users', 'customers', 'processes', 'work_centers', 'products',
  'routes', 'route_steps', 'bad_reasons', 'orders', 'order_steps',
  'reports', 'report_bad_reasons', 'order_bad_reasons', 'logs',
  'warehouses', 'materials', 'inventory', 'inventory_tx',
  'incoming_materials', 'finished_goods_in',
  // 检验与质量异常（一期）
  'inspections', 'inspection_defects', 'quality_issues', 'issue_notifications', 'settings',
];

const out = {};
for (const t of TABLES) {
  out[t] = D.all(`SELECT * FROM ${t}`);
}

// 完整性校验：演示数据的核心实体必须齐全，否则说明读到了空库/脏库，拒绝覆盖 seed.json
const MIN = { users: 10, processes: 5, products: 5, routes: 5, orders: 5, route_steps: 10 };
const bad = Object.keys(MIN).filter((t) => out[t].length < MIN[t]);
if (bad.length) {
  console.error('导出中止：数据不完整，拒绝覆盖 public/data/seed.json');
  for (const t of bad) console.error(`  ${t}: ${out[t].length} 条（至少需要 ${MIN[t]} 条）`);
  console.error(`  数据来源目录：${dataDir}`);
  process.exit(1);
}

const dir = path.join(__dirname, 'public', 'data');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'seed.json');
fs.writeFileSync(file, JSON.stringify(out, null, 0));

console.log('已生成 public/data/seed.json  (来源: ' + dataDir + ')');
for (const t of TABLES) console.log('  ' + t.padEnd(14) + out[t].length + ' 条');
console.log('文件大小:', (fs.statSync(file).size / 1024).toFixed(1) + ' KB');

// Windows 下 sqlite 文件句柄可能尚未释放，清理失败不影响导出结果，忽略即可
if (fresh) {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 下次运行会先清空 */ }
}
