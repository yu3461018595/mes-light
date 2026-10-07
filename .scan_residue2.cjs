const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/app/data/mes.db', { readOnly: true });
const flat = (a) => (Array.isArray(a) ? a.flat(Infinity) : [a]);
const q = (s, ...p) => db.prepare(s).all(...flat(p));
console.log('== 工序 SOP 字段 ==');
q("SELECT id,code,name,sop_file,sop_name FROM processes WHERE sop_file IS NOT NULL AND sop_file<>''").forEach(r => console.log(JSON.stringify(r)));
console.log('\n== logs 中 SOP 相关（含删除） ==');
q("SELECT id,user_name,action,detail,created_at FROM logs WHERE action LIKE '%SOP%' ORDER BY id").forEach(r => console.log(JSON.stringify(r)));
console.log('\n== sessions 结构 ==');
q("SELECT name FROM pragma_table_info('sessions')").forEach(r => console.log(JSON.stringify(r)));
console.log('\n== 过期 sessions ==');
const g = (s, ...p) => db.prepare(s).get(...flat(p));
try { console.log(JSON.stringify(g("SELECT COUNT(*) c FROM sessions WHERE expires_at < ?", [new Date().toISOString().slice(0,19).replace('T',' ')]))); } catch(e) { console.log('expires_at? ' + e.message); }
