/* P2 升级冒烟测试：销售订单（接单→转工单→出货核销）/ 齐套分析 / 简单排产 / 权限
 * 用法：node test_p2.cjs   （脚本内部用 DATA_DIR 指定临时目录并另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5333);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-p2-'));

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
    chk('管理员登录', !!token, JSON.stringify(lg));
    const H = (m, u, b) => api(m, u, b, token);
    const lw = await api('POST', '/api/login', { username: 'worker1', password: '123456' });
    const wTok = lw.data && lw.data.token;
    chk('操作工登录', !!wTok, JSON.stringify(lw));

    const meta = (await H('GET', '/api/meta')).data;
    const route0 = meta.routes[0];
    chk('种子数据含产品+工艺路线', !!route0, JSON.stringify(meta.routes || '').slice(0, 100));
    const pid = route0.product_id;
    const cust = meta.customers[0];

    // ---------- 1. 销售订单 CRUD ----------
    const bad1 = await H('POST', '/api/sales_orders', { product_id: pid, qty: 0 });
    chk('数量≤0 被拒', bad1.ok === false, JSON.stringify(bad1));
    const bad2 = await H('POST', '/api/sales_orders', { qty: 10 });
    chk('缺产品被拒', bad2.ok === false, JSON.stringify(bad2));
    const so1 = await H('POST', '/api/sales_orders', { product_id: pid, customer_id: cust ? cust.id : null, qty: 100, price: 50, delivery_date: '2026-12-31', remark: 'P2测试' });
    chk('创建销售订单成功(SO号)', so1.ok && /^SO/.test(so1.data.code), JSON.stringify(so1));
    const dup = await H('POST', '/api/sales_orders', { product_id: pid, qty: 1, code: so1.data.code });
    chk('销售单号重复被拒', dup.ok === false, JSON.stringify(dup));
    const wSo = await api('POST', '/api/sales_orders', { product_id: pid, qty: 1 }, wTok);
    chk('操作工创建销售订单被拒 403', wSo.ok === false, JSON.stringify(wSo));
    const list1 = await H('GET', '/api/sales_orders');
    chk('列表含新订单且快照产品/客户', list1.data.some((r) => r.id === so1.data.id && r.product_name && (!cust || r.customer_name === cust.name)), JSON.stringify(list1.data && list1.data[0]));
    const kw = await H('GET', '/api/sales_orders?keyword=' + encodeURIComponent(so1.data.code));
    chk('按单号搜索命中', kw.data.length === 1, JSON.stringify(kw.data.length));
    const edit = await H('PUT', '/api/sales_orders/' + so1.data.id, { qty: 200, price: 55 });
    chk('编辑订单数量 100→200', edit.ok, JSON.stringify(edit));
    const soAfter = (await H('GET', '/api/sales_orders')).data.find((r) => r.id === so1.data.id);
    chk('数量已更新且状态 open', soAfter.qty === 200 && soAfter.status === 'open', JSON.stringify(soAfter));

    // ---------- 2. 一键转生产工单 ----------
    const noRoute = await H('POST', '/api/sales_orders', { product_id: pid, qty: 5, code: 'SONR001' });
    const conv = await H('POST', '/api/sales_orders/' + so1.data.id + '/convert', {});
    chk('转工单成功', conv.ok && conv.data.code && conv.data.order_id, JSON.stringify(conv));
    const o1 = (await H('GET', '/api/orders/' + conv.data.order_id)).data;
    chk('工单数量/客户/备注带出', o1.qty_plan === 200 && o1.customer_name === (cust ? cust.name : null) && String(o1.remark).includes(so1.data.code), JSON.stringify({ qty: o1.qty_plan, cust: o1.customer_name, rm: o1.remark }));
    const conv2 = await H('POST', '/api/sales_orders/' + so1.data.id + '/convert', {});
    chk('重复转工单幂等（同工单）', conv2.ok && conv2.data.existed === true && conv2.data.order_id === conv.data.order_id, JSON.stringify(conv2));

    // ---------- 3. 排产调整 ----------
    const sch = await H('PUT', '/api/orders/' + conv.data.order_id + '/schedule', { plan_start: '2026-10-01', plan_end: '2026-10-20', priority: 1 });
    chk('排产调整成功', sch.ok, JSON.stringify(sch));
    const o2 = (await H('GET', '/api/orders/' + conv.data.order_id)).data;
    chk('计划时间/优先级已保存', o2.plan_start === '2026-10-01' && o2.plan_end === '2026-10-20' && o2.priority === 1, JSON.stringify({ ps: o2.plan_start, pe: o2.plan_end, pr: o2.priority }));
    const badPrio = await H('PUT', '/api/orders/' + conv.data.order_id + '/schedule', { priority: 9 });
    chk('非法优先级被拒', badPrio.ok === false, JSON.stringify(badPrio));
    const badDate = await H('PUT', '/api/orders/' + conv.data.order_id + '/schedule', { plan_start: '2026-10-21', plan_end: '2026-10-20' });
    chk('开工晚于完工被拒', badDate.ok === false, JSON.stringify(badDate));
    const wSch = await api('PUT', '/api/orders/' + conv.data.order_id + '/schedule', { priority: 3 }, wTok);
    chk('操作工排产被拒 403', wSch.ok === false, JSON.stringify(wSch));

    // ---------- 4. 齐套分析 ----------
    const kit0 = await H('GET', '/api/orders/' + conv.data.order_id + '/kit');
    chk('未维护BOM：has_bom=false', kit0.ok && kit0.data.has_bom === false && kit0.data.kit_pct === null, JSON.stringify(kit0.data));
    const mat = await H('POST', '/api/materials', { code: 'MAT-P2-A', name: 'P2测试原料A', unit: '件', category: '原料' });
    chk('创建原料成功', mat.ok && mat.data.id, JSON.stringify(mat));
    const mid = mat.data.id;
    const adj1 = await H('POST', '/api/inventory/adjust', { material_id: mid, physical_qty: 300 });
    chk('盘点入库 300', adj1.ok, JSON.stringify(adj1));
    const bom = await H('PUT', '/api/products/' + pid + '/bom', { items: [{ material_id: mid, qty_per_unit: 2, loss_rate: 10 }] });
    chk('维护 BOM（单耗2/损耗10%）', bom.ok, JSON.stringify(bom));
    // 需求 = 200 × 2 × 1.1 = 440；库存 300 → 68%
    const kit1 = await H('GET', '/api/orders/' + conv.data.order_id + '/kit');
    chk('齐套率 68%（300/440）', kit1.data.kit_pct === 68 && kit1.data.shortage === 1, JSON.stringify(kit1.data));
    chk('缺口 140', kit1.data.lines[0].gap === 140, JSON.stringify(kit1.data.lines[0]));
    const adj2 = await H('POST', '/api/inventory/adjust', { material_id: mid, physical_qty: 500 });
    chk('补货到 500', adj2.ok, JSON.stringify(adj2));
    const kit2 = await H('GET', '/api/orders/' + conv.data.order_id + '/kit');
    chk('齐套率 100%', kit2.data.kit_pct === 100 && kit2.data.shortage === 0, JSON.stringify(kit2.data));
    const statsKit = await H('GET', '/api/stats/kit');
    const row = statsKit.data.orders.find((r) => r.id === conv.data.order_id);
    chk('排产看板含该工单且齐套100%', !!row && row.kit_pct === 100, JSON.stringify(row));
    chk('看板汇总统计正确', statsKit.data.summary.full_kit >= 1, JSON.stringify(statsKit.data.summary));

    // ---------- 4.5 排产看板增强：进度/瓶颈/速率/完工预测/逾期分级（日期相对化） ----------
    const todayStr = statsKit.data.today;
    const dstr = (off) => new Date(new Date(todayStr + 'T00:00:00Z').getTime() + off * 86400000).toISOString().slice(0, 10);
    const odId = conv.data.order_id;
    const odet = (await H('GET', '/api/orders/' + odId)).data;
    const odSteps = odet.steps || [];
    chk('转工单含≥2道工序', odSteps.length >= 2, JSON.stringify(odSteps.map((s) => s.id)));
    let repAllOk = true;
    for (const st of odSteps) {
      const rr = await H('POST', '/api/reports', { order_id: odId, order_step_id: st.id, qty_good: 60, qty_bad: 0, work_min: 30 });
      if (!rr.ok) repAllOk = false;
    }
    chk('各工序报工60成功', repAllOk, '');
    const sk1 = await H('GET', '/api/stats/kit');
    const r1 = sk1.data.orders.find((r) => r.id === odId);
    chk('进度=MIN瓶颈口径 60/200=30%', r1.qty_done === 60 && r1.progress_pct === 30, JSON.stringify({ qd: r1.qty_done, pp: r1.progress_pct }));
    chk('瓶颈=完成率最低未完成工序30%', r1.bottleneck && r1.bottleneck.pct === 30, JSON.stringify(r1.bottleneck));
    chk('瓶颈工序日速率>0且预测晚于今天', r1.daily_rate > 0 && r1.forecast_end > todayStr, JSON.stringify({ dr: r1.daily_rate, fe: r1.forecast_end }));
    await H('PUT', '/api/orders/' + odId + '/schedule', { plan_end: dstr(10) });
    const r2 = (await H('GET', '/api/stats/kit')).data.orders.find((x) => x.id === odId);
    chk('预测延期天数=预测完工-计划完工', r2.delay_days === Math.round((new Date(r2.forecast_end + 'T00:00:00Z') - new Date(dstr(10) + 'T00:00:00Z')) / 86400000), JSON.stringify({ fe: r2.forecast_end, dd: r2.delay_days }));
    const dueCases = [[-5, 'overdue_3p'], [-1, 'overdue_1_3'], [1, 'due_soon'], [10, 'none']];
    let dueAllOk = true;
    for (const [off, want] of dueCases) {
      await H('PUT', '/api/orders/' + odId + '/schedule', { plan_end: dstr(off) });
      const rc = (await H('GET', '/api/stats/kit')).data.orders.find((x) => x.id === odId);
      if (rc.due_class !== want) dueAllOk = false;
    }
    chk('逾期分级 4 档正确(-5/-1/+1/+10)', dueAllOk, '');
    const sumK = sk1.data.summary;
    chk('汇总含新KPI字段', ['due_today', 'due_soon', 'overdue', 'delayed_forecast', 'running', 'paused', 'plan_qty', 'done_qty'].every((k) => typeof sumK[k] === 'number'), JSON.stringify(sumK));
    await H('PUT', '/api/orders/' + odId + '/schedule', { plan_end: dstr(10) }); // 还原合理交期供后续用例

    // ---------- 4.6 计件工资核算：报工快照单价 + 按月核算 + 个人明细 + 隐私 ----------
    const workerId = lw.data.user.id;
    const odSteps2 = (await H('GET', '/api/orders/' + odId)).data.steps;
    const procId0 = odSteps2[0].process_id;
    const upPr1 = await H('PUT', '/api/processes/' + procId0, { std_price: 0.5 });
    chk('工序单价维护为0.5元/件', upPr1.ok, JSON.stringify(upPr1));
    const repW = await api('POST', '/api/reports', { order_id: odId, order_step_id: odSteps2[0].id, qty_good: 50, qty_bad: 0, work_min: 30 }, wTok);
    chk('操作工报工返回本次计件50×0.5=25', repW.ok && Math.abs((repW.data.total_wage || 0) - 25) < 0.001 && Math.abs((repW.data.steps[0].wage || 0) - 25) < 0.001, JSON.stringify(repW.data));
    // 单价快照：报工后把单价改成 1 元，历史工资不变
    await H('PUT', '/api/processes/' + procId0, { std_price: 1 });
    const pw1 = await H('GET', '/api/stats/piece_wage?days=1');
    const rowW = pw1.data.rows.find((r) => r.id === workerId);
    chk('单价调后历史工资仍按快照0.5计（25元）', !!rowW && Math.abs(rowW.wage - 25) < 0.001, JSON.stringify(pw1.data.rows));
    const pwM = await H('GET', '/api/stats/piece_wage?month=' + todayStr.slice(0, 7));
    const rowM = pwM.data.rows.find((r) => r.id === workerId);
    const pwMD = await H('GET', '/api/stats/piece_wage?month=' + todayStr.slice(0, 7) + '&worker_id=' + workerId + '&detail=1');
    const detSum = (pwMD.data.detail || []).reduce((a, x) => a + (x.amount || 0), 0);
    const hasNew = (pwMD.data.detail || []).some((x) => Math.abs(x.unit_price - 0.5) < 0.001 && Math.abs(x.amount - 25) < 0.001);
    chk('按月核算命中且明细与汇总自洽', !!rowM && Math.abs(rowM.wage - detSum) < 0.01 && hasNew, JSON.stringify({ wage: rowM && rowM.wage, detSum, hasNew }));
    const pwD = await H('GET', '/api/stats/piece_wage?days=1&worker_id=' + workerId + '&detail=1');
    const hasSnap = (pwD.data.detail || []).some((x) => Math.abs(x.unit_price - 0.5) < 0.001 && Math.abs(x.amount - 25) < 0.001);
    chk('个人明细逐单列出且单价快照0.5', pwD.ok && (pwD.data.detail || []).length >= 1 && hasSnap, JSON.stringify(pwD.data));
    const pwSelf = await api('GET', '/api/stats/piece_wage?days=30', null, wTok);
    chk('操作工仅能查本人工资', pwSelf.ok && pwSelf.data.self_only === true && (pwSelf.data.rows || []).every((r) => r.id === workerId), JSON.stringify(pwSelf.data));

    // ---------- 5. 出货核销（sale_ref 联动） ----------
    await H('POST', '/api/materials/import_products', {});
    const mats = (await H('GET', '/api/materials')).data;
    const finMat = mats.find((m2) => m2.code === (meta.products.find((p) => p.id === pid) || {}).code);
    chk('成品物料已导入', !!finMat, JSON.stringify(mats.map((m2) => m2.code)));
    await H('POST', '/api/inventory/adjust', { material_id: finMat.id, physical_qty: 500 });
    const ship1 = await H('POST', '/api/stock_shipments', { material_id: finMat.id, qty: 50, sale_ref: so1.data.code, customer: cust ? cust.name : '' });
    chk('成品出库 50 成功', ship1.ok, JSON.stringify(ship1));
    let soNow = (await H('GET', '/api/sales_orders')).data.find((r) => r.id === so1.data.id);
    chk('核销：shipped=50 状态 partial', soNow.shipped_qty === 50 && soNow.status === 'partial', JSON.stringify(soNow));
    const ship2 = await H('POST', '/api/stock_shipments', { material_id: finMat.id, qty: 150, sale_ref: so1.data.code });
    soNow = (await H('GET', '/api/sales_orders')).data.find((r) => r.id === so1.data.id);
    chk('核销：shipped=200 状态 done', soNow.shipped_qty === 200 && soNow.status === 'done', JSON.stringify(soNow));
    const delShip = await H('DELETE', '/api/stock_shipments/' + ship2.data.id);
    soNow = (await H('GET', '/api/sales_orders')).data.find((r) => r.id === so1.data.id);
    chk('删出库单后回滚 partial', delShip.ok && soNow.shipped_qty === 50 && soNow.status === 'partial', JSON.stringify({ del: delShip, so: soNow }));
    const cancel = await H('PATCH', '/api/sales_orders/' + so1.data.id + '/status', { status: 'cancelled' });
    chk('已有出货不可取消', cancel.ok === false, JSON.stringify(cancel));
    const delSo = await H('DELETE', '/api/sales_orders/' + so1.data.id);
    chk('已有出货不可删除', delSo.ok === false, JSON.stringify(delSo));

    // ---------- 6. 无出货订单的取消/删除 ----------
    const so2 = await H('POST', '/api/sales_orders', { product_id: pid, qty: 3, customer_name: '临时客户' });
    const cancel2 = await H('PATCH', '/api/sales_orders/' + so2.data.id + '/status', { status: 'cancelled', reason: '客户取消' });
    chk('无出货可取消', cancel2.ok, JSON.stringify(cancel2));
    const delSo2 = await H('DELETE', '/api/sales_orders/' + so2.data.id);
    chk('admin 可删除无出货订单', delSo2.ok, JSON.stringify(delSo2));
    const wDel = await api('DELETE', '/api/sales_orders/' + so1.data.id, null, wTok);
    chk('操作工删除被拒 403', wDel.ok === false, JSON.stringify(wDel));

  } finally {
    srv.kill();
  }
  console.log(`\n===== test_p2: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
