/* 升级功能冒烟测试：批次/工单双向追溯 / 计件工资统计 / 车间看板大屏 / CSV 导出
 * 用法：node test_upgrade.cjs   （内部用临时 DATA_DIR 另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5301);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-up-'));

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
async function raw(method, url, token) {
  const res = await fetch('http://127.0.0.1:' + PORT + url, {
    method,
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') || '' };
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

    // ===== 1. 计件工资 =====
    const procs = await H('GET', '/api/processes');
    chk('工序演示数据存在', procs.ok && procs.data.length >= 3, JSON.stringify(procs.data && procs.data.length));
    const pr1 = procs.data[0];
    const setP = await H('PUT', '/api/processes/' + pr1.id, { code: pr1.code, name: pr1.name, std_time: pr1.std_time, std_price: 2.5, inspect_type: pr1.inspect_type });
    chk('工序计件单价可设置(2.5元)', setP.ok, JSON.stringify(setP));

    const prods = await H('GET', '/api/products');
    const rts = await H('GET', '/api/routes');
    const ord = await H('POST', '/api/orders', { product_id: prods.data[0].id, route_id: rts.data[0].id, qty_plan: 10 });
    chk('创建测试工单', ord.ok, JSON.stringify(ord));
    const det = await H('GET', '/api/orders/' + ord.data.id);
    const step1 = (det.data.steps || []).find((s) => s.seq === 1) || (det.data.steps || [])[0];
    chk('工单含首道工序', !!step1 && !!step1.id, JSON.stringify(det.data.steps));
    const rep = await H('POST', '/api/reports', { order_id: ord.data.id, order_step_id: step1.id, qty_good: 10, qty_bad: 0 });
    chk('报工 10 件合格', rep.ok, JSON.stringify(rep));
    const inspWait = det.data.steps.some((s) => s.inspect_type); // 若首道是检验点需判定
    if (inspWait) {
      const ins = await H('POST', '/api/inspections', { order_step_id: step1.id, qty_pass: 10, qty_fail: 0, conclusion: 'pass' });
      chk('首道检验点判定合格（若为检验点）', ins.ok, JSON.stringify(ins));
    }

    const adminName = (lg.data.user && lg.data.user.name) || '张建国';
    const wage = await H('GET', '/api/stats/piece_wage?days=30');
    const wRow = (wage.data.rows || []).find((r) => r.name === adminName);
    chk('计件工资统计存在记录', !!wRow, JSON.stringify(wage.data.rows));
    chk('计件工资金额 = 10 × 2.5 = 25', wRow && Math.abs(Number(wRow.wage) - 25) < 0.01, JSON.stringify(wRow));
    chk('计件工资按工资降序', (wage.data.rows || []).every((r, i, a) => i === 0 || Number(a[i - 1].wage) >= Number(r.wage)), JSON.stringify(wage.data.rows));

    const wageCsv = await raw('GET', '/api/stats/piece_wage?days=30&format=csv', token);
    chk('工资核算 CSV 导出', wageCsv.status === 200 && wageCsv.ct.indexOf('text/csv') >= 0 && wageCsv.text.indexOf('工资(元)') >= 0, wageCsv.text.slice(0, 120));

    const repCsv = await raw('GET', '/api/reports?format=csv', token);
    chk('报工记录 CSV 导出', repCsv.status === 200 && repCsv.text.indexOf('工单号') >= 0 && repCsv.text.indexOf('合格数') >= 0, repCsv.text.slice(0, 120));
    const txCsv = await raw('GET', '/api/inventory_tx?format=csv', token);
    chk('收发明细 CSV 导出', txCsv.status === 200 && txCsv.text.indexOf('物料编码') >= 0 && txCsv.text.indexOf('变动前') >= 0, txCsv.text.slice(0, 120));

    // ===== 2. 批次/工单双向追溯 =====
    const trOrder = await H('GET', '/api/trace/' + encodeURIComponent(ord.data.code));
    chk('按工单追溯成功', trOrder.ok && trOrder.data.type === 'order', JSON.stringify(trOrder).slice(0, 200));
    chk('工单追溯含报工明细(10件)', (trOrder.data.reports || []).length >= 1 && Number(trOrder.data.reports[0].qty_good) === 10, JSON.stringify(trOrder.data.reports));

    // 来料批次 → 追溯
    const mats = await H('GET', '/api/materials');
    const whs = await H('GET', '/api/warehouses');
    const inc = await H('POST', '/api/incoming_materials', {
      incoming_date: new Date().toISOString().slice(0, 10), supplier: '追溯测试供应商',
      material_id: mats.data[0].id, qty: 100, batch: 'TR-BATCH-01', warehouse_id: whs.data[0].id,
      inspector: '质检员', result: 'qualified',
    });
    chk('创建来料单(批次TR-BATCH-01)', inc.ok, JSON.stringify(inc));
    const trBatch = await H('GET', '/api/trace/' + encodeURIComponent('TR-BATCH-01'));
    chk('按批次追溯成功', trBatch.ok && trBatch.data.type === 'batch', JSON.stringify(trBatch).slice(0, 200));
    chk('批次追溯含供应商', (trBatch.data.suppliers || []).includes('追溯测试供应商'), JSON.stringify(trBatch.data.suppliers));
    chk('批次追溯含流水', (trBatch.data.txs || []).length >= 1, JSON.stringify(trBatch.data.txs && trBatch.data.txs.length));
    const trNone = await api('GET', '/api/trace/NO-SUCH-XYZ', null, token);
    chk('不存在编码返回404', !trNone.ok, JSON.stringify(trNone));

    // ===== 3. 车间看板大屏（公开接口） =====
    const board = await raw('GET', '/api/public/board');
    let bj = null;
    try { bj = JSON.parse(board.text); } catch (e) { /* ignore */ }
    chk('看板接口免登录可访问', board.status === 200 && bj && bj.ok, board.text.slice(0, 120));
    chk('看板今日产量含刚报的10件', bj && bj.data && Number(bj.data.today.good) >= 10, JSON.stringify(bj && bj.data && bj.data.today));
    chk('看板含在制工单/趋势/班组/最新报工', bj && bj.data && Array.isArray(bj.data.wip) && Array.isArray(bj.data.trend) && Array.isArray(bj.data.teams) && Array.isArray(bj.data.latest), '');
    const brdHtml = await raw('GET', '/board.html');
    chk('看板页面可访问', brdHtml.status === 200 && brdHtml.text.indexOf('车间生产看板') >= 0, brdHtml.text.slice(0, 80));

  } catch (e) {
    fail++; console.log('  FAIL  测试异常 → ' + (e && e.stack || e));
  } finally {
    srv.kill();
  }
  console.log(`\n===== test_upgrade：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();
