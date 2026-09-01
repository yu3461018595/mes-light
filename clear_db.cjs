const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const dbPath = path.join(__dirname, 'data', 'mes.db');
const d = new DatabaseSync(dbPath);
d.exec('PRAGMA foreign_keys=OFF;');

const keep = new Set(['users']);
const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);

let total = 0;
for (const t of tables) {
  if (keep.has(t)) continue;
  const n = d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  if (n > 0) {
    d.exec(`DELETE FROM ${t};`);
    // 重置该表的自增计数（若存在）
    d.exec(`DELETE FROM sqlite_sequence WHERE name='${t}';`);
    total += n;
  }
}
d.exec('VACUUM;');
d.close();

console.log('已清空业务数据，保留 users =', 11, '行');
console.log('被清空/重置的表：', tables.filter(t => !keep.has(t)).join(', '));
console.log('共清理行数(估算)：', total);
