const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/app/data/mes.db', { readOnly: true });
const flat = (a) => (Array.isArray(a) ? a.flat(Infinity) : [a]);
const q = (s, ...p) => db.prepare(s).all(...flat(p));
console.log('== logs id>=515 全部 ==');
q("SELECT id,user_name,action,substr(detail,1,80) d,created_at FROM logs WHERE id>=515 ORDER BY id").forEach(r => console.log(JSON.stringify(r)));
console.log('\n== orders id>=24 全部（区分真实/测试） ==');
q("SELECT id,code,remark,created_at FROM orders WHERE id>=24 ORDER BY id").forEach(r => console.log(JSON.stringify(r)));
