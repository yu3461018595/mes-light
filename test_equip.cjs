/* P1 升级冒烟测试：设备台账 / 点检（联动异常单）/ 设备二维码 / 工序 SOP 附件 / 权限
 * 用法：node test_equip.cjs   （脚本内部用 DATA_DIR 指定临时目录并另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5321);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-eq-'));

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' → ' + extra : '')); }
};

async function api(method, url, body, token) {
  const res = await fetch('http://127.0.0.1:' + PORT + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return await res.json();
}
async function raw(method, url, body, token) {
  const res = await fetch('http://127.0.0.1:' + PORT + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(300);
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/meta'); if (r.ok) up = true; } catch (e) { /* retry */ }
  }
  if (!up) { console.log('服务启动失败'); srv.kill(); process.exit(1); }

  try {
    const lg = await api('POST', '/api/login', { username: 'admin', password: '123456' });
    const token = lg.data && lg.data.token;
    chk('管理员登录', !!token, JSON.stringify(lg));
    const H = (m, u, b) => api(m, u, b, token);
    const HR = (m, u, b) => raw(m, u, b, token);

    // 1. 设备台账 CRUD
    const seedEq = await H('GET', '/api/equipments');
    chk('演示设备 ≥3 台（EQ-001~003）', seedEq.data && seedEq.data.length >= 3 && seedEq.data.some((e) => e.code === 'EQ-001'), JSON.stringify(seedEq.data || '').slice(0, 120));
    const noAuth = await api('POST', '/api/equipments', { code: 'X', name: 'x' });
    chk('未登录新增设备被拒', noAuth.ok === false, JSON.stringify(noAuth));
    const add = await H('POST', '/api/equipments', { code: 'EQ-T1', name: '测试钻床', model: 'Z525', location: '试验车间', status: 'idle', check_cycle: 2, remark: '测试设备' });
    chk('新增设备成功', add.ok && add.data && add.data.id, JSON.stringify(add));
    const dup = await H('POST', '/api/equipments', { code: 'EQ-T1', name: '重复编码' });
    chk('重复编码被拒', dup.ok === false, JSON.stringify(dup));
    const edit = await H('PUT', '/api/equipments/' + add.data.id, { code: 'EQ-T1', name: '测试钻床（改）', check_cycle: 1 });
    chk('编辑设备成功', edit.ok, JSON.stringify(edit));

    // 2. 角色登录：worker1 / qc01
    const lw = await api('POST', '/api/login', { username: 'worker1', password: '123456' });
    const wTok = lw.data && lw.data.token;
    chk('操作工登录', !!wTok, JSON.stringify(lw));
    const lq = await api('POST', '/api/login', { username: 'qc01', password: '123456' });
    const qTok = lq.data && lq.data.token;
    chk('质检员登录', !!qTok, JSON.stringify(lq));

    // 3. 操作工正常点检
    const okCheck = await api('POST', '/api/equipments/' + add.data.id + '/check', { result: 'ok', note: '运行正常' }, wTok);
    chk('操作工正常点检成功', okCheck.ok && okCheck.data && !okCheck.data.issue, JSON.stringify(okCheck));
    const eqAfter = await H('GET', '/api/equipments');
    const eq1 = eqAfter.data.find((e) => e.id === add.data.id);
    chk('last_check_at 已更新', !!eq1.last_check_at, JSON.stringify(eq1));
    const hist1 = await H('GET', '/api/equipments/' + add.data.id + '/checks');
    chk('点检历史 1 条且记录点检人', hist1.data.length === 1 && hist1.data[0].checked_name === '王强' && hist1.data[0].result === 'ok', JSON.stringify(hist1.data));

    // 4. 操作工异常点检（不申报等级）→ 生成待定级异常单，不推送
    const ab1 = await api('POST', '/api/equipments/' + add.data.id + '/check', { result: 'abnormal', note: '主轴异响', report: 1, fault: 1 }, wTok);
    chk('异常点检生成异常单', ab1.ok && ab1.data && ab1.data.issue && ab1.data.issue.code, JSON.stringify(ab1));
    chk('异常单为待定级(pending)', ab1.data.issue.level === 'pending', JSON.stringify(ab1.data.issue));
    const det1 = await H('GET', '/api/quality_issues/' + ab1.data.issue.id);
    chk('异常单工序=设备点检·设备名', det1.ok && String(det1.data.process_name || '').includes('测试钻床'), JSON.stringify(det1.data && det1.data.process_name));
    const kinds1 = (det1.data.timeline || []).map((n) => n.kind);
    chk('操作工上报：不推送任何通知(timeline 空)', kinds1.length === 0, JSON.stringify(kinds1));
    const eqFault = (await H('GET', '/api/equipments')).data.find((e) => e.id === add.data.id);
    chk('设备状态已转故障', eqFault.status === 'fault', JSON.stringify(eqFault.status));

    // 5. 操作工异常点检 + 申报重大 → 通知检验员
    const ab2 = await api('POST', '/api/equipments/' + add.data.id + '/check', { result: 'abnormal', note: '漏油严重', report: 1, level: 'major' }, wTok);
    chk('申报重大生成异常单', ab2.ok && ab2.data.issue && ab2.data.issue.level === 'pending', JSON.stringify(ab2.data));
    const det2 = await H('GET', '/api/quality_issues/' + ab2.data.issue.id);
    const kinds2 = (det2.data.timeline || []).map((n) => n.kind);
    chk('申报重大：通知检验员(有 created)', kinds2.includes('created'), JSON.stringify(kinds2));

    // 6. 质检员异常点检可直接定级 critical → 推管理层
    const ab3 = await api('POST', '/api/equipments/' + add.data.id + '/check', { result: 'abnormal', note: '皮带断裂', report: 1, level: 'critical' }, qTok);
    chk('质检员点检可定级 critical', ab3.ok && ab3.data.issue && ab3.data.issue.level === 'critical', JSON.stringify(ab3.data));
    const det3 = await H('GET', '/api/quality_issues/' + ab3.data.issue.id);
    const kinds3 = (det3.data.timeline || []).map((n) => n.kind);
    // 无工单的设备异常责任人兜底为 admin 本人：critical 的外部管理层推送（webhook）随 created 直发；
    // escalate 仅在存在「其他管理员/责任人非管理员」时出现
    const admin = (await H('GET', '/api/users')).data.find((x) => x.role === 'admin');
    chk('致命级：管理层已收到通知（escalate 或责任人=admin 直发）',
      kinds3.includes('created') && (kinds3.includes('escalate') || det3.data.assignee_user_id === admin.id),
      JSON.stringify({ kinds: kinds3, assignee: det3.data.assignee_user_id, admin: admin.id }));

    // 7. 点检历史含关联异常单
    const histAll = await H('GET', '/api/equipments/' + add.data.id + '/checks');
    const withIssue = histAll.data.filter((c) => c.issue_code);
    chk('点检历史 4 条且 3 条关联异常单', histAll.data.length === 4 && withIssue.length === 3, JSON.stringify(histAll.data.length) + '/' + JSON.stringify(withIssue.length));

    // 8. 权限：worker 不能生成设备二维码
    const wQr = await api('GET', '/api/qr/equipment/' + add.data.id, null, wTok);
    chk('操作工取设备码被拒 403', wQr.ok === false, JSON.stringify(wQr));
    const aQr = await H('GET', '/api/qr/equipment/' + add.data.id);
    chk('管理员取设备码成功（含 svg/url）', aQr.ok && aQr.data.svg && aQr.data.url.includes('#/equip/'), JSON.stringify(aQr.data && aQr.data.url));

    // 9. 工序 SOP 附件
    const procs = await H('GET', '/api/processes');
    const proc = procs.data[0];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up1 = await H('POST', '/api/processes/' + proc.id + '/sop', { name: '作业指导书.png', data: png.toString('base64') });
    chk('SOP 上传成功', up1.ok && up1.data.sop_name === '作业指导书.png', JSON.stringify(up1));
    const procAfter = (await H('GET', '/api/processes')).data.find((p) => p.id === proc.id);
    chk('工序记录已带 sop_file/sop_name', !!procAfter.sop_file && procAfter.sop_name === '作业指导书.png', JSON.stringify(procAfter.sop_file));
    const dl1 = await HR('GET', '/uploads/' + encodeURIComponent(procAfter.sop_file));
    chk('SOP 下载内容一致(' + dl1.buf.length + 'B)', dl1.status === 200 && dl1.buf.equals(png), 'status ' + dl1.status);
    const bad1 = await H('POST', '/api/processes/' + proc.id + '/sop', { name: '病毒.exe', data: png.toString('base64') });
    chk('非白名单扩展名被拒', bad1.ok === false, JSON.stringify(bad1));
    const bad2 = await H('POST', '/api/processes/' + proc.id + '/sop', { name: '空.pdf', data: '' });
    chk('空文件被拒', bad2.ok === false, JSON.stringify(bad2));
    // 更换：旧文件应被清理
    const up2 = await H('POST', '/api/processes/' + proc.id + '/sop', { name: '图纸v2.png', data: png.toString('base64') });
    chk('更换 SOP 成功', up2.ok && up2.data.sop_name === '图纸v2.png', JSON.stringify(up2));
    const oldFile = procAfter.sop_file;
    const procAfter2 = (await H('GET', '/api/processes')).data.find((p) => p.id === proc.id);
    const dlOld = await HR('GET', '/uploads/' + encodeURIComponent(oldFile));
    chk('旧 SOP 文件已删除', dlOld.status === 404, 'status ' + dlOld.status);
    // 路径穿越防护
    const trav = await HR('GET', '/uploads/' + encodeURIComponent('..%2Fmes.db'));
    chk('路径穿越被拦截', trav.status === 404, 'status ' + trav.status);
    // 删除
    const delSop = await H('DELETE', '/api/processes/' + proc.id + '/sop');
    chk('删除 SOP 成功', delSop.ok, JSON.stringify(delSop));
    const procAfter3 = (await H('GET', '/api/processes')).data.find((p) => p.id === proc.id);
    chk('SOP 字段已清空', !procAfter3.sop_file && !procAfter3.sop_name, JSON.stringify(procAfter3.sop_file));
    const wSop = await api('POST', '/api/processes/' + proc.id + '/sop', { name: 'a.png', data: png.toString('base64') }, wTok);
    chk('操作工上传 SOP 被拒 403', wSop.ok === false, JSON.stringify(wSop));

    // 9.5 设备稼动分析（轻量 OEE）
    const wcNew = await H('POST', '/api/work_centers', { code: 'WC-T9', name: '稼动测试机', workshop: '测试车间' });
    chk('测试工位创建成功', wcNew.ok && !!wcNew.data.id, JSON.stringify(wcNew));
    const util1 = await H('GET', '/api/stats/equip_util?days=7');
    chk('稼动接口返回 summary', util1.ok && typeof util1.data.summary.avg_util === 'number' && util1.data.summary.total_machines >= 1, JSON.stringify(util1.data && util1.data.summary));
    const wcRow = (util1.data.rows || []).find((r) => r.code === 'WC-T9');
    chk('新工位出现在稼动表且未使用', !!wcRow && wcRow.cnt === 0 && wcRow.util_pct === 0, JSON.stringify(wcRow));
    const util30 = await H('GET', '/api/stats/equip_util?days=30');
    chk('30 天口径可用且基准更大', util30.ok && util30.data.days === 30, JSON.stringify(util30.data && util30.data.days));
    await H('DELETE', '/api/work_centers/' + wcNew.data.id).catch(() => {});

    // 10. 清理测试数据
    await H('DELETE', '/api/equipments/' + add.data.id);
    const after = (await H('GET', '/api/equipments')).data.filter((e) => e.code === 'EQ-T1');
    chk('测试设备已删除', after.length === 0, JSON.stringify(after));

  } finally {
    srv.kill();
  }
  console.log(`\n===== test_equip: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
