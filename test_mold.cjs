/* 模具管理冒烟测试：台账建档/查重、上机/下机/送修/完修/保养/报废状态机、
 * 保养周期与设计寿命预警、报工经机台联动累计生产数、权限矩阵 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5342);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-mold-'));

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
    const lw = await api('POST', '/api/login', { username: 'worker1', password: '123456' });
    const wTok = lw.data && lw.data.token;
    chk('操作工登录', !!wTok, JSON.stringify(lw));

    // ---------- 1. 台账建档与查重 ----------
    const mk = await H('POST', '/api/molds', { code: 'MJ-T1', name: '面壳注塑模', category: '注塑模', cavities: 2, product_name: '电池面壳', location: '模具架 A-01', design_life: 1000, maintain_every: 500 });
    chk('建档成功且默认在库', mk.ok && mk.data.status === 'idle' && mk.data.status_label === '在库', JSON.stringify(mk));
    const moldId = mk.data.id;
    const dup = await H('POST', '/api/molds', { code: 'MJ-T1', name: '重复编码' });
    chk('编码查重拦截', dup.ok === false, JSON.stringify(dup));
    const bad = await H('POST', '/api/molds', { code: '', name: '' });
    chk('编码/名称必填', bad.ok === false, JSON.stringify(bad));

    // ---------- 2. 上机 → 报工联动累计 → 下机 ----------
    const wcs = (await H('GET', '/api/work_centers')).data;
    const wc = wcs[0] || (await H('POST', '/api/work_centers', { code: 'WC-T1', name: '注塑机 1#' })).data;
    const wcId = wc.id;
    const noWc = await api('POST', '/api/molds/' + moldId + '/issue', {}, wTok);
    chk('操作工上机被拒 403', noWc.ok === false, JSON.stringify(noWc));
    const iss = await H('POST', '/api/molds/' + moldId + '/issue', { work_center_id: wcId, note: '上机试模' });
    chk('上机后在机并绑机台', iss.ok && iss.data.status === 'producing' && iss.data.work_center_name, JSON.stringify(iss));
    const reIssue = await H('POST', '/api/molds/' + moldId + '/issue', { work_center_id: wcId });
    chk('在机重复上机被拒', reIssue.ok === false, JSON.stringify(reIssue));

    // 建在产工单并报工（经该机台）→ 模具累计生产数
    const meta = (await H('GET', '/api/meta')).data;
    const route0 = meta.routes[0];
    const od = await H('POST', '/api/orders', { product_id: route0.product_id, route_id: route0.id, qty_plan: 500 });
    chk('测试工单创建', od.ok, JSON.stringify(od));
    const odSteps = (await H('GET', '/api/orders/' + od.data.id)).data.steps;
    const rep1 = await H('POST', '/api/reports', { order_id: od.data.id, order_step_id: odSteps[0].id, qty_good: 120, qty_bad: 10, work_min: 60, work_center_id: wcId });
    chk('经机台报工成功', rep1.ok, JSON.stringify(rep1));
    let moldNow = (await H('GET', '/api/molds/' + moldId)).data;
    chk('模具自动累计生产数 130 件', moldNow.total_shots === 130, 'total_shots=' + moldNow.total_shots);
    chk('保养进度 26%（130/500）', moldNow.maintain_pct === 26 && !moldNow.need_maintain, JSON.stringify(moldNow));

    // ---------- 3. 保养周期预警与保养动作 ----------
    await H('POST', '/api/reports', { order_id: od.data.id, order_step_id: odSteps[0].id, qty_good: 500, qty_bad: 0, work_min: 60, work_center_id: wcId });
    moldNow = (await H('GET', '/api/molds/' + moldId)).data;
    chk('达到保养周期标红（130+500 ≥ 500）', moldNow.total_shots === 630 && moldNow.need_maintain === true, JSON.stringify({ shots: moldNow.total_shots, nm: moldNow.need_maintain }));
    chk('寿命进度 63%（630/1000）', moldNow.life_pct === 63 && moldNow.life_warn === false, JSON.stringify({ pct: moldNow.life_pct }));
    const mtn = await H('POST', '/api/molds/' + moldId + '/maintain', { note: '清洁防锈', cost: 80 });
    chk('保养后周期基准重置', mtn.ok && mtn.data.need_maintain === false && mtn.data.maintain_pct === 0, JSON.stringify(mtn.data && { nm: mtn.data.need_maintain, mp: mtn.data.maintain_pct }));
    const mDetail = await H('GET', '/api/molds/' + moldId);
    chk('履历含保养记录（费用 80）', mDetail.data.events.some((e) => e.type === 'maintain' && Number(e.cost) === 80), JSON.stringify(mDetail.data.events.map((e) => e.type)));

    // ---------- 4. 送修/完修状态机 ----------
    const rep = await H('POST', '/api/molds/' + moldId + '/repair', { note: '滑块卡滞', cost: 300 });
    chk('在机可直接送修（清机台）', rep.ok && rep.data.status === 'repairing' && !rep.data.work_center_id, JSON.stringify(rep.data && rep.data.status));
    const issueInRepair = await H('POST', '/api/molds/' + moldId + '/issue', { work_center_id: wcId });
    chk('维修中上机被拒', issueInRepair.ok === false, JSON.stringify(issueInRepair));
    const workerRepair = await api('POST', '/api/molds/' + moldId + '/repair', { note: '现场报修' }, wTok);
    chk('维修中重复送修被拒', workerRepair.ok === false, JSON.stringify(workerRepair));
    const rdone = await H('POST', '/api/molds/' + moldId + '/repair_done', { note: '更换滑块' });
    chk('完修后回库', rdone.ok && rdone.data.status === 'idle', JSON.stringify(rdone.data && rdone.data.status));

    // ---------- 5. 寿命预警与报废 ----------
    const mk2 = await H('POST', '/api/molds', { code: 'MJ-T2', name: '寿命测试模', design_life: 100, maintain_every: 0 });
    const m2 = mk2.data.id;
    // 直接种到 100 件（用保养基准重置侧写不行，直接走 SQL 无接口；用连续报工太慢 → 用 issue+报工一次 100）
    const iss2 = await H('POST', '/api/molds/' + m2 + '/issue', { work_center_id: wcId });
    const rep2 = await H('POST', '/api/reports', { order_id: od.data.id, order_step_id: odSteps[0].id, qty_good: 100, qty_bad: 0, work_min: 30, work_center_id: wcId });
    chk('追加报工成功（联动前置）', rep2.ok, JSON.stringify(rep2));
    // 注意：上面报工可能累计到了 MJ-T1？此时 WC 上在机的是 MJ-T2（MJ-T1 已送修下机），验证联动对象
    let m2d = (await H('GET', '/api/molds/' + m2)).data;
    chk('新模具联动累计 100 件且寿命到（标红）', m2d.total_shots === 100 && m2d.life_warn === true && m2d.life_pct === 100, JSON.stringify({ shots: m2d.total_shots, warn: m2d.life_warn }));
    const scrap = await H('POST', '/api/molds/' + m2 + '/scrap', { note: '达到寿命' });
    chk('报废为终态', scrap.ok && scrap.data.status === 'scrapped', JSON.stringify(scrap.data && scrap.data.status));
    const reIssue2 = await H('POST', '/api/molds/' + m2 + '/issue', { work_center_id: wcId });
    chk('报废后上机被拒', reIssue2.ok === false, JSON.stringify(reIssue2));
    const summary = (await H('GET', '/api/molds')).data.summary;
    chk('汇总：寿命预警/在机数自洽', summary.life_warn === 0 && summary.total === 1 && summary.repairing === 0, JSON.stringify(summary));

    // ---------- 6. 权限：操作工不可建档/上机/保养 ----------
    const wCreate = await api('POST', '/api/molds', { code: 'MJ-W1', name: 'x' }, wTok);
    chk('操作工建档被拒 403', wCreate.ok === false, JSON.stringify(wCreate));
    const wMaint = await api('POST', '/api/molds/' + moldId + '/maintain', {}, wTok);
    chk('操作工保养被拒 403', wMaint.ok === false, JSON.stringify(wMaint));

    // ---------- 7. 清理 ----------
    await H('DELETE', '/api/molds/' + m2).catch(() => {});
    await H('DELETE', '/api/molds/' + moldId).catch(() => {});

  } finally {
    srv.kill();
  }
  console.log(`\n===== test_mold: ${pass} passed, ${fail} failed =====`);
  if (fail) process.exitCode = 1;
})();
