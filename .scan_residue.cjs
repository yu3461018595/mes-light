const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/app/data/mes.db', { readOnly: true });
const flat = (a) => (Array.isArray(a) ? a.flat(Infinity) : [a]);
const q = (s, ...p) => db.prepare(s).all(...flat(p));
const show = (label, rows) => { console.log('\n== ' + label + ' =='); rows.forEach(r => console.log(JSON.stringify(r))); if (!rows.length) console.log('(无)'); };

show('设备：含 TEST/测试', q("SELECT id,code,name FROM equipments WHERE code LIKE '%TEST%' OR name LIKE '%测试%'"));
show('点检：备注含 测试/验证', q("SELECT id,equipment_id,note,checked_name,created_at FROM equipment_checks WHERE note LIKE '%测试%' OR note LIKE '%验证%'"));
show('销售订单：备注含 测试/自检/验证', q("SELECT id,code,remark FROM sales_orders WHERE remark LIKE '%测试%' OR remark LIKE '%自检%' OR remark LIKE '%验证%'"));
show('用户：可疑测试号', q("SELECT id,username,name,role,active,created_at FROM users WHERE username LIKE 'ra%' OR username LIKE 'wkown%' OR name LIKE '%测试%' OR username LIKE '%test%'"));
show('日志：含 测试/自检/线上验证/live（近40条）', q("SELECT id,user_name,action,substr(detail,1,70) d,created_at FROM logs WHERE detail LIKE '%测试%' OR detail LIKE '%自检%' OR detail LIKE '%线上验证%' OR detail LIKE '%live%' OR detail LIKE '%验证工单%' OR action LIKE '%测试%' ORDER BY id DESC LIMIT 40"));
show('工单#25 关联数据（工序/报工/通知）', q("SELECT 'step' t, COUNT(*) c FROM order_steps WHERE order_id=25 UNION ALL SELECT 'report', COUNT(*) FROM reports WHERE order_id=25 UNION ALL SELECT 'notif', COUNT(*) FROM issue_notifications WHERE ref_id=25 AND ref_type='order'"));
show('sessions 过期数量', q("SELECT COUNT(*) c FROM sessions"));
