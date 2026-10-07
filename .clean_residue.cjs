// 清理预览：列出将要删除的所有日志（DRY_RUN=1 只打印不删）
const { DatabaseSync } = require('node:sqlite');
const DRY_RUN = process.env.DRY_RUN === '1';
const db = new DatabaseSync('/app/data/mes.db', DRY_RUN ? { readOnly: true } : {});
const flat = (a) => (Array.isArray(a) ? a.flat(Infinity) : [a]);
const q = (s, ...p) => db.prepare(s).all(...flat(p));
const run = (s, ...p) => db.prepare(s).run(...flat(p));

const LOG_WHERE = `detail LIKE '%测试%' OR detail LIKE '%自检%' OR detail LIKE '%线上验证%' OR detail LIKE '%live%'
  OR detail LIKE '%LIVE验证%' OR detail LIKE '%EQ-VERIFY%' OR detail LIKE '%WO2610063456%'
  OR detail LIKE '%冒烟%' OR detail LIKE '%verify%'
  OR detail LIKE '%WO2610062078%' OR detail LIKE '%WO2610062689%' OR detail LIKE '%WO2610067351%'
  OR detail LIKE '%WO2610062395%' OR detail LIKE '%WO2610076953%' OR detail LIKE '%WO2610075163%'
  OR detail LIKE '%WO2610078160%'`;

console.log('== 将删除的日志（共 ' + q('SELECT COUNT(*) c FROM logs WHERE ' + LOG_WHERE)[0].c + ' 条） ==');
q('SELECT id,user_name,action,detail,created_at FROM logs WHERE ' + LOG_WHERE + ' ORDER BY id').forEach(r => console.log(JSON.stringify(r)));

// 兜底核对：这些日志里有没有疑似真实业务（action 不是测试类、detail 看不出测试痕迹的不删）
if (!DRY_RUN) {
  run('DELETE FROM order_steps WHERE order_id=25');
  run('DELETE FROM orders WHERE id=25');
  run('DELETE FROM logs WHERE ' + LOG_WHERE);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let sess = 0;
  try { sess = run('DELETE FROM sessions WHERE expire_at < ?', [now]).changes; } catch (e) { console.log('sessions 跳过: ' + e.message); }
  try { run('VACUUM'); } catch (e) {}
  console.log('\n== 清理完成 ==');
  console.log('order25_left=' + (q('SELECT COUNT(*) c FROM orders WHERE id=25')[0] || {}).c
    + ' logs_left_test=' + (q('SELECT COUNT(*) c FROM logs WHERE ' + LOG_WHERE)[0] || {}).c
    + ' sessions_deleted=' + sess);
}
