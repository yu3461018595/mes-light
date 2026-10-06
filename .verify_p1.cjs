/* P1 线上验证：设备台账/点检联动异常单/设备二维码/工序SOP 全链路（结束后清理测试数据） */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'http://114.117.233.47:8080';
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' → ' + extra : '')); }
};
async function req(method, url, body, token) {
  const r = await fetch(BASE + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}
async function raw(url, token) {
  const r = await fetch(BASE + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}
async function login(username, password) {
  const r = await req('POST', '/api/login', { username, password });
  const tok = r.j && r.j.data && r.j.data.token;
  if (!tok) throw new Error('登录失败 ' + username + ': ' + JSON.stringify(r.j));
  return tok;
}
(async () => {
  const adminTok = await login('管理员', '123456');
  const workerTok = adminTok; // 线上库无种子工人账号，用管理员代走操作工路径（角色门禁已由本地 test_equip 覆盖）
  const inspTok = await login('罗小敏', '123456');
  const H = (m, u, b) => req(m, u, b, adminTok);
  console.log('BASE=' + BASE);

  // 1. 设备 CRUD
  const seed = await H('GET', '/api/equipments');
  chk('设备接口可用', seed.status === 200 && seed.j.ok && Array.isArray(seed.j.data), JSON.stringify(seed.j).slice(0, 100));
  const add = await H('POST', '/api/equipments', { code: 'EQ-VERIFY', name: '验证测试机', check_cycle: 1 });
  chk('新增测试设备', add.j.ok && add.j.data.id, JSON.stringify(add.j));
  const eqId = add.j.data.id;

  // 2. 操作工正常点检
  const okC = await req('POST', '/api/equipments/' + eqId + '/check', { result: 'ok', note: '线上验证·正常' }, workerTok);
  chk('操作工正常点检成功', okC.j.ok && !okC.j.data.issue, JSON.stringify(okC.j));

  // 3. 操作工异常点检（不申报）→ 待定级 + 不推送
  const ab1 = await req('POST', '/api/equipments/' + eqId + '/check', { result: 'abnormal', note: '线上验证·主轴异响', report: 1 }, workerTok);
  chk('异常点检生成待定级异常单', ab1.j.ok && ab1.j.data.issue && ab1.j.data.issue.level === 'pending', JSON.stringify(ab1.j));
  const d1 = await H('GET', '/api/quality_issues/' + ab1.j.data.issue.id);
  chk('异常单工序含设备名', String(d1.j.data.process_name || '').includes('验证测试机'), d1.j.data.process_name);
  chk('非检验员上报：不推送（timeline 空）', (d1.j.data.timeline || []).length === 0, JSON.stringify(d1.j.data.timeline));

  // 4. 操作工申报重大 → 通知检验员
  const ab2 = await req('POST', '/api/equipments/' + eqId + '/check', { result: 'abnormal', note: '线上验证·漏油', report: 1, level: 'major' }, workerTok);
  const d2 = await H('GET', '/api/quality_issues/' + ab2.j.data.issue.id);
  chk('申报重大：通知检验员（有 created）', (d2.j.data.timeline || []).some((n) => n.kind === 'created'), JSON.stringify(d2.j.data.timeline || []).slice(0, 200));

  // 5. 质检员异常点检定级致命 → 管理层
  const ab3 = await req('POST', '/api/equipments/' + eqId + '/check', { result: 'abnormal', note: '线上验证·皮带断裂', report: 1, level: 'critical' }, inspTok);
  chk('质检员点检定级致命生效', ab3.j.ok && ab3.j.data.issue.level === 'critical', JSON.stringify(ab3.j));

  // 6. 点检历史
  const hist = await H('GET', '/api/equipments/' + eqId + '/checks');
  chk('点检历史 4 条且 3 条关联异常单', hist.j.data.length === 4 && hist.j.data.filter((c) => c.issue_code).length === 3, JSON.stringify(hist.j.data.length));

  // 7. 设备二维码（admin 可、worker 不可）
  const qr = await H('GET', '/api/qr/equipment/' + eqId);
  chk('设备二维码生成（svg+url）', qr.j.ok && qr.j.data.svg && qr.j.data.url.includes('#/equip/'), qr.j.data && qr.j.data.url);
  const wQr = await req('GET', '/api/qr/equipment/' + eqId, null, workerTok);
  chk('操作工取设备码被拒', wQr.j.ok === false, JSON.stringify(wQr.j));

  // 8. 工序 SOP 上传/下载/更换/删除
  const procs = await H('GET', '/api/processes');
  const proc = procs.j.data[0];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up1 = await H('POST', '/api/processes/' + proc.id + '/sop', { name: '线上验证SOP.png', data: png.toString('base64') });
  chk('SOP 上传成功', up1.j.ok && up1.j.data.sop_name === '线上验证SOP.png', JSON.stringify(up1.j));
  const pAfter = (await H('GET', '/api/processes')).j.data.find((p) => p.id === proc.id);
  const dl = await raw('/uploads/' + encodeURIComponent(pAfter.sop_file));
  chk('SOP 下载一致(' + dl.buf.length + 'B)', dl.status === 200 && dl.buf.equals(png), 'status ' + dl.status);
  const up2 = await H('POST', '/api/processes/' + proc.id + '/sop', { name: '线上验证SOPv2.png', data: png.toString('base64') });
  chk('更换 SOP 成功', up2.j.ok && up2.j.data.sop_name === '线上验证SOPv2.png', JSON.stringify(up2.j));
  const dlOld = await raw('/uploads/' + encodeURIComponent(pAfter.sop_file));
  chk('旧 SOP 已清理', dlOld.status === 404, 'status ' + dlOld.status);
  const wUp = await req('POST', '/api/processes/' + proc.id + '/sop', { name: 'a.png', data: png.toString('base64') }, workerTok);
  chk('操作工上传 SOP 被拒', wUp.j.ok === false, JSON.stringify(wUp.j));
  const delSop = await H('DELETE', '/api/processes/' + proc.id + '/sop');
  chk('删除 SOP 成功', delSop.j.ok, JSON.stringify(delSop.j));

  // 9. 页面可达
  for (const [p, name] of [['/manual.html', '说明书'], ['/m/app/', '手机端'], ['/board.html', '大屏']]) {
    const r = await raw(p);
    chk('页面·' + name + ' 200', r.status === 200, 'status ' + r.status);
  }

  // 10. 清理：作废 3 张测试异常单 + 删除测试设备
  for (const it of [ab1, ab2, ab3]) {
    const c = await req('POST', '/api/quality_issues/' + it.j.data.issue.id + '/cancel', { reason: '线上验证清理' }, adminTok);
    chk('测试异常单 ' + it.j.data.issue.code + ' 已作废', c.j.ok, JSON.stringify(c.j));
  }
  const delEq = await H('DELETE', '/api/equipments/' + eqId);
  chk('测试设备已删除', delEq.j.ok, JSON.stringify(delEq.j));

  console.log(`\n===== P1 live verify: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('验证异常：', e); process.exit(1); });
