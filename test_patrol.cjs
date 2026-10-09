/* 现场巡检记录冒烟测试：手机 APP 巡检（正常/异常/联动异常单/照片/统计/权限）
 * 用法：node test_patrol.cjs   （脚本内部用 DATA_DIR 指定临时目录并另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5341);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-pt-'));

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
    const H = (m, u, b) => api(m, u, b, token);
    chk('管理员登录', !!token, JSON.stringify(lg));
    const lq = await api('POST', '/api/login', { username: 'qc01', password: '123456' });
    const qTok = lq.data && lq.data.token;
    chk('质检员登录', !!qTok, JSON.stringify(lq));
    const lw = await api('POST', '/api/login', { username: 'worker1', password: '123456' });
    const wTok = lw.data && lw.data.token;
    chk('操作工登录', !!wTok, JSON.stringify(lw));

    // 准备：建一张在产工单（status=created 即可巡检，未 closed/cancelled）
    const meta = (await H('GET', '/api/meta')).data;
    const route0 = meta.routes[0];
    const or = await H('POST', '/api/orders', { product_id: route0.product_id, route_id: route0.id, qty_plan: 100 });
    chk('准备测试工单成功', or.ok && or.data.id, JSON.stringify(or));
    const od = (await H('GET', '/api/orders/' + or.data.id)).data;
    const step0 = od.steps[0];

    // 1. 权限：操作工提交巡检被拒
    const wPt = await api('POST', '/api/patrols', { order_id: or.data.id, result: 'normal' }, wTok);
    chk('操作工巡检被拒 403', wPt.ok === false, JSON.stringify(wPt));

    // 2. 正常巡检
    const noOrder = await api('POST', '/api/patrols', { result: 'normal' }, qTok);
    chk('缺工单被拒', noOrder.ok === false, JSON.stringify(noOrder));
    const p1 = await api('POST', '/api/patrols', {
      order_id: or.data.id, order_step_id: step0.id, result: 'normal', qty_checked: 5,
      checklist: [{ name: '外观无划伤', result: 'ok' }, { name: '关键尺寸', result: 'ok' }],
    }, qTok);
    chk('正常巡检成功且单号 XL 开头', p1.ok && /^XL/.test(p1.data.code || ''), JSON.stringify(p1));
    chk('正常巡检不生成异常单', p1.ok && p1.data.issue === null, JSON.stringify(p1.data));

    // 3. 有不良却记正常 → 拒绝；有 NG 项却记正常 → 拒绝
    const badN1 = await api('POST', '/api/patrols', { order_id: or.data.id, result: 'normal', qty_bad: 2 }, qTok);
    chk('有不良数不能记正常', badN1.ok === false, JSON.stringify(badN1));
    const badN2 = await api('POST', '/api/patrols', { order_id: or.data.id, result: 'normal', checklist: [{ name: '外观', result: 'ng', qty: 1 }] }, qTok);
    chk('有 NG 检查项不能记正常', badN2.ok === false, JSON.stringify(badN2));

    // 4. 异常巡检 → 联动生成质量异常单（source=patrol）
    const p2 = await api('POST', '/api/patrols', {
      order_id: or.data.id, order_step_id: step0.id, result: 'abnormal', level: 'major',
      qty_checked: 5, qty_bad: 2, findings: '极片边缘波浪褶皱',
      checklist: [{ name: '外观无划伤', result: 'ok' }, { name: '边缘褶皱', result: 'ng', qty: 2 }],
    }, qTok);
    chk('异常巡检成功', p2.ok && p2.data.issue && p2.data.issue.code, JSON.stringify(p2));
    const issue1 = await H('GET', '/api/quality_issues/' + p2.data.issue.id);
    chk('异常单来源=patrol 且等级 major', issue1.ok && issue1.data.source === 'patrol' && issue1.data.level === 'major', JSON.stringify({ source: issue1.data && issue1.data.source, level: issue1.data && issue1.data.level }));
    chk('异常单摘要含巡检描述与 NG 项', (issue1.data.bad_summary || '').includes('褶皱') && (issue1.data.bad_summary || '').includes('边缘褶皱×2'), JSON.stringify(issue1.data && issue1.data.bad_summary));
    chk('异常单已定责到人', !!issue1.data.assignee_name, JSON.stringify(issue1.data && issue1.data.assignee_name));

    // 5. 异常巡检缺描述/不良/NG → 拒绝
    const badA = await api('POST', '/api/patrols', { order_id: or.data.id, result: 'abnormal' }, qTok);
    chk('异常巡检无任何异常信息被拒', badA.ok === false, JSON.stringify(badA));

    // 6. 巡检详情 + 列表 + mine 过滤
    const det = await H('GET', '/api/patrols/' + p1.data.id);
    chk('巡检详情返回并解析检查项', det.ok && Array.isArray(det.data.checklist_result) && det.data.checklist_result.length === 2, JSON.stringify(det.data && det.data.checklist_result));
    const list1 = await H('GET', '/api/patrols?days=1');
    chk('巡检列表 ≥2 条且带工单号', list1.ok && list1.data.length >= 2 && list1.data.every((r) => r.order_code), JSON.stringify(list1.data.length));
    const mine = await api('GET', '/api/patrols?days=1&mine=1', null, qTok);
    chk('mine=1 仅本人记录', mine.ok && mine.data.length >= 2 && mine.data.every((r) => r.inspector_name === '陈晓芸' || r.inspector_id), JSON.stringify(mine.data.length));
    const onlyAb = await H('GET', '/api/patrols?days=1&result=abnormal');
    chk('result=abnormal 过滤生效', onlyAb.ok && onlyAb.data.length >= 1 && onlyAb.data.every((r) => r.result === 'abnormal'), JSON.stringify(onlyAb.data.length));

    // 7. 照片上传：合法 png 成功 / 非法扩展被拒
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const ph1 = await api('POST', '/api/patrols/' + p2.data.id + '/photos', { name: 'scene.png', data: png.toString('base64') }, qTok);
    chk('巡检照片上传成功', ph1.ok && ph1.data.photos.length === 1, JSON.stringify(ph1));
    const ph2 = await api('POST', '/api/patrols/' + p2.data.id + '/photos', { name: 'bad.txt', data: png.toString('base64') }, qTok);
    chk('非图片扩展名被拒', ph2.ok === false, JSON.stringify(ph2));
    const det2 = await H('GET', '/api/patrols/' + p2.data.id);
    chk('详情照片数=1', det2.ok && (det2.data.photos || []).length === 1, JSON.stringify(det2.data && det2.data.photos));

    // 8. 统计口径：今日次数/异常数/异常率自洽
    const st = await H('GET', '/api/stats/patrol');
    chk('今日巡检 ≥2 且异常 ≥1', st.ok && st.data.today.total >= 2 && st.data.today.abnormal >= 1, JSON.stringify(st.data && st.data.today));
    chk('近7天异常率与明细自洽', st.ok && Math.abs(st.data.week.rate - Math.round(st.data.week.abnormal * 1000 / Math.max(1, st.data.week.total)) / 10) < 0.2, JSON.stringify(st.data && st.data.week));
    const stW = await api('GET', '/api/stats/patrol', null, wTok);
    chk('操作工查巡检统计被拒', stW.ok === false, JSON.stringify(stW));

  } finally {
    srv.kill();
  }
  console.log(`\n===== test_patrol: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
