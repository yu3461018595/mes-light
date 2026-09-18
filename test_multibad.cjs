/* 一道工序多种不良（bad_reasons 明细）冒烟测试
 * 覆盖：多不良入库、qty_bad=合计、统计按明细聚合、旧版单原因兼容、删除联动。
 * 用法：node test_multibad.cjs  （临时 DATA_DIR 另起服务，不污染生产库） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5291);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-multibad-'));
process.env.NODE_PATH = '';

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

    // 取两个不良原因（不足则创建）
    let meta = await H('GET', '/api/meta');
    let reasons = meta.data.badReasons || [];
    if (reasons.length < 2) {
      await H('POST', '/api/bad-reasons', { name: '外观不良' });
      await H('POST', '/api/bad-reasons', { name: '尺寸不良' });
      meta = await H('GET', '/api/meta');
      reasons = meta.data.badReasons || [];
    }
    const A = reasons[0], B = reasons[1];
    chk('取到至少 2 个不良原因', reasons.length >= 2, 'count=' + reasons.length);

    // 统计基线（临时库已含种子示例数据，用差值验证本工单贡献）
    const baseSb = await H('GET', '/api/stats/bad?days=30');
    const baseA = (baseSb.data.find((x) => x.name === A.name) || {}).qty || 0;
    const baseB = (baseSb.data.find((x) => x.name === B.name) || {}).qty || 0;

    // 建工单 P2001 + R-P2001（多工序）
    const products = await H('GET', '/api/products');
    const p2001 = products.data.find((p) => p.code === 'P2001');
    const routes = await H('GET', '/api/routes');
    const rP2001 = routes.data.find((r) => r.code === 'R-P2001');
    chk('取到产品 P2001 与工艺路线 R-P2001', p2001 && rP2001, '');
    const created = await H('POST', '/api/orders', { product_id: p2001.id, route_id: rP2001.id, qty_plan: 100, code: 'WO-TEST-MULTIBAD' });
    chk('创建测试工单', created.ok, JSON.stringify(created));
    const oid = created.data.id;

    const detail = await H('GET', '/api/orders/' + oid);
    const steps = detail.data.steps.slice().sort((a, b) => a.seq - b.seq);
    const step1 = steps[0];
    chk('工单含多道工序', steps.length >= 2, 'steps=' + steps.length);

    // 1) 一道工序报两种不良：A×3、B×5，合格 10
    const r1 = await H('POST', '/api/reports', {
      order_id: oid, order_step_id: step1.id, qty_good: 10, qty_bad: 0,
      bad_reasons: [
        { bad_reason_id: A.id, qty: 3, bad_reason_detail: '' },
        { bad_reason_id: B.id, qty: 5, bad_reason_detail: '' },
      ],
    });
    chk('多不良报工成功', r1.ok, JSON.stringify(r1));

    const d1 = await H('GET', '/api/orders/' + oid);
    const s1 = d1.data.steps.find((s) => s.id === step1.id);
    chk('工序不良合计=8（3+5），而非单值', Number(s1.qty_bad) === 8, 'qty_bad=' + s1.qty_bad);

    // 工单详情 reports 携带 bad_reasons 明细
    const rep1 = d1.data.reports.find((x) => x.order_step_id === step1.id && Number(x.qty_bad) === 8);
    chk('报工记录含 2 条不良明细', rep1 && rep1.bad_reasons && rep1.bad_reasons.length === 2, rep1 ? 'len=' + rep1.bad_reasons.length : '无记录');
    chk('明细数量正确(3/5)', rep1 && rep1.bad_reasons
      && rep1.bad_reasons.reduce((a, e) => a + Number(e.qty), 0) === 8, rep1 ? JSON.stringify(rep1.bad_reasons) : '');

    // 统计按明细聚合（A=3, B=5）—— 用基线差值验证
    const sb1 = await H('GET', '/api/stats/bad?days=30');
    const a1 = sb1.data.find((x) => x.name === A.name);
    const b1 = sb1.data.find((x) => x.name === B.name);
    chk('统计-原因A 增量=3', a1 && Number(a1.qty) === baseA + 3, a1 ? 'A=' + a1.qty + ' base=' + baseA : 'A缺失');
    chk('统计-原因B 增量=5', b1 && Number(b1.qty) === baseB + 5, b1 ? 'B=' + b1.qty + ' base=' + baseB : 'B缺失');

    // 2) 旧版单原因兼容：第二道工序报 单原因A qty_bad=2
    const step2 = steps[1];
    const r2 = await H('POST', '/api/reports', {
      order_id: oid, order_step_id: step2.id, qty_good: 0, qty_bad: 2, bad_reason_id: A.id, bad_reason_detail: '',
    });
    chk('旧版单原因报工成功', r2.ok, JSON.stringify(r2));
    const d2 = await H('GET', '/api/orders/' + oid);
    const s2 = d2.data.steps.find((s) => s.id === step2.id);
    chk('旧版单原因 qty_bad=2', Number(s2.qty_bad) === 2, 'qty_bad=' + s2.qty_bad);

    const sb2 = await H('GET', '/api/stats/bad?days=30');
    const a2 = sb2.data.find((x) => x.name === A.name);
    chk('统计-旧版单原因累加后原因A 增量=5（3+2）', a2 && Number(a2.qty) === baseA + 5, a2 ? 'A=' + a2.qty + ' base=' + baseA : 'A缺失');

    // 3) 删除多不良报工 → 工序不良回退 8，明细随删（统计减 8）
    const delRes = await H('DELETE', '/api/reports/' + rep1.id);
    chk('删除多不良报工成功', delRes.ok, JSON.stringify(delRes));
    const d3 = await H('GET', '/api/orders/' + oid);
    const s3 = d3.data.steps.find((s) => s.id === step1.id);
    chk('删除后工序1不良回退为 0', Number(s3.qty_bad) === 0, 'qty_bad=' + s3.qty_bad);
    const sb3 = await H('GET', '/api/stats/bad?days=30');
    const a3 = sb3.data.find((x) => x.name === A.name);
    const b3 = sb3.data.find((x) => x.name === B.name);
    chk('删除多不良后原因A 增量=2（仅剩旧版单原因）', a3 && Number(a3.qty) === baseA + 2, a3 ? 'A=' + a3.qty + ' base=' + baseA : 'A缺失');
    chk('删除后原因B 回到基线（明细已随删）', b3 && Number(b3.qty) === baseB, b3 ? 'B=' + b3.qty + ' base=' + baseB : 'B已消失');
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + e.message);
  } finally {
    srv.kill();
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
