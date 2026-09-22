/* 移动端扫码报工（免登录 H5，微信内打开） */
(function () {
  const $app = document.getElementById('app');
  const $back = document.getElementById('back');
  const S = { mode: null, o: null, w: null, t: null, order: null, steps: [], workers: [], worker: null, step: null, sel: new Set(), vals: {} };

  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const BADGE = { released: ['已下发', 'b-released'], running: ['生产中', 'b-running'], paused: ['已暂停', 'b-paused'], done: ['已完成', 'b-done'], closed: ['已关闭', 'b-closed'] };

  // 通过统一 API 客户端访问（静态部署走浏览器数据层，动态部署走 /api）
  async function api(path) { return API.raw('GET', path); }
  async function post(path, body) { return API.raw('POST', path, body); }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast2'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
  }

  function showError(msg) {
    $app.innerHTML = `<div class="card center" style="padding:40px 20px"><div style="font-size:40px">⚠️</div>
      <p style="color:#5a6673;line-height:1.7;margin-top:10px">${esc(msg)}</p></div>`;
    $back.style.display = 'none';
  }

  async function loadOrder(o, t, wid) {
    const q = wid ? `?t=${encodeURIComponent(t)}&wid=${wid}` : `?t=${encodeURIComponent(t)}`;
    const data = await api('/api/public/order/' + o + q);
    S.order = data.order; S.steps = data.steps; S.workers = data.workers; S.badReasons = data.badReasons || []; S.mode = 'order'; S.o = o; S.t = t; S.w = wid || null;
    S.sel = new Set(); S.vals = {};
    const first = data.steps.find((s) => s.status !== 'done') || data.steps[0];
    S.step = first || null;
    renderReport();
  }

  async function loadWorker(w, t) {
    const data = await api('/api/public/worker/' + w + '?t=' + encodeURIComponent(t));
    S.worker = data.worker; S.w = w; S.t = t; S.mode = 'worker';
    renderWorker(data.orders);
  }

  /* ==================== 质检台（扫码即判） ==================== */
  const INSPECT_LABEL = { iqc: '首检', ipqc: '过程检', fqc: '终检' };

  async function loadInspector(w, t) {
    const data = await api('/api/public/inspector/' + w + '?t=' + encodeURIComponent(t));
    S.inspector = data.worker; S.q = w; S.t = t; S.mode = 'inspector';
    S.qSteps = data.steps || [];
    S.badReasons = data.badReasons || [];
    renderInspector();
  }

  function renderInspector() {
    $back.style.display = 'none';
    const w = S.inspector;
    const list = S.qSteps || [];
    $app.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">质检台</div>
        <div class="pname">${esc(w.name)} · ${esc(w.team || '')} · 待检 <b>${list.length}</b> 道工序</div>
      </div></div>
      ${list.length ? list.map((s) => {
        const isFinal = String(s.inspect_type) === 'fqc';
        return `<div class="card insp" data-s="${s.order_step_id}">
          <div class="card-b">
            <div class="ocode" style="font-size:15px">${esc(s.order_code)} · 第 ${s.seq} 道 ${esc(s.process_name)}
              <span class="badge ${isFinal ? 'b-paused' : 'b-released'}">${INSPECT_LABEL[s.inspect_type] || '检验'}</span></div>
            <div class="pname">${esc(s.product_name || '')} · 计划 ${s.qty_plan} · 已报合格 ${s.qty_good}${s.qty_bad ? ' · 自报不良 ' + s.qty_bad : ''}</div>
            <div class="pname">指派班组 ${esc(s.assignee_team || '暂无')} · 最近报工人 ${esc(s.last_worker || '—')}</div>
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
              <div class="field"><span>本次受检数</span>
                <input class="plain qi-pass" type="number" min="0" inputmode="numeric" value="${s.qty_good}"></div>
              <div class="field"><span>不合格数</span>
                <input class="plain qi-fail" type="number" min="0" inputmode="numeric" placeholder="0" value="0"></div>
              <div class="badrows" data-rows="${s.order_step_id}"></div>
            </div>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn ok" data-judge="${s.order_step_id}" data-cc="pass">合格放行</button>
              <button type="button" class="btn warnbtn" data-judge="${s.order_step_id}" data-cc="concession">让步接收</button>
              <button type="button" class="btn dangerbtn" data-judge="${s.order_step_id}" data-cc="fail">不合格</button>
            </div>
            <div class="pname" style="margin-top:8px">${isFinal ? '终检放行将自动成品入库；' : ''}不合格会自动开质量异常单并通知责任管理人员。</div>
          </div>
        </div>`;
      }).join('') : `<div class="card center" style="padding:34px 20px;color:#6b7682">当前没有待检工序 👍</div>`}
      <div style="height:20px"></div>`;

    bindBadRows();
    list.forEach((s) => { S.vals[s.order_step_id] = { badRows: [{ reason: '', qty: '', detail: '' }] }; renderBadRows(s.order_step_id); });
    $app.querySelectorAll('[data-judge]').forEach((b) => b.onclick = () => judgeMobile(b.dataset.judge, b.dataset.cc));
  }

  async function judgeMobile(stepId, conclusion) {
    const card = $app.querySelector('.insp[data-s="' + stepId + '"]');
    if (!card) return;
    const qtyPass = Math.max(0, Math.floor(Number(card.querySelector('.qi-pass').value) || 0));
    const qtyFail = Math.max(0, Math.floor(Number(card.querySelector('.qi-fail').value) || 0));
    if (conclusion === 'pass' && qtyFail > 0) { toast('合格放行时不合格数须为 0'); return; }
    if (conclusion !== 'pass' && qtyFail <= 0) { toast('请填写不合格数'); return; }
    if (!confirm(`判定「${conclusion === 'pass' ? '合格放行' : conclusion === 'concession' ? '让步接收' : '不合格'}」：受检 ${qtyPass} 件 / 不合格 ${qtyFail} 件。确定提交？`)) return;
    const defects = [...card.querySelectorAll('.badrows .brow')].map((br) => {
      const det = br.querySelector('.brow-detail');
      return { bad_reason_id: Number(br.querySelector('.brow-reason').value) || 0, qty: Number(br.querySelector('.brow-qty').value) || 0, bad_reason_detail: det ? det.value.trim() : '' };
    }).filter((x) => x.qty > 0);
    try {
      const r = await post('/api/inspections', { order_step_id: stepId, qty_pass: qtyPass, qty_fail: qtyFail, conclusion, defects, remark: '' });
      showInspOk(conclusion, r && r.autoFinishIn, r && r.issue);
    } catch (e) { toast(e.message); }
  }

  function showInspOk(conclusion, auto, issue) {
    const mask = document.createElement('div'); mask.className = 'ok-mask';
    mask.innerHTML = `<div class="ok-circle"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18"/></svg></div>
      <div style="font-size:18px;font-weight:700">判定已提交</div>
      ${auto ? `<div style="color:#2bb673;margin-top:6px">末道工序已自动入库 ${auto.qty} 件</div>` : ''}
      ${issue ? `<div style="color:#d93b3b;margin-top:6px">已生成质量异常单 ${esc(issue.code)}<br>责任人 ${esc(issue.assignee_name || '—')} 已收到待办</div>` : ''}
      <button class="btn" style="max-width:220px" id="again">继续判定</button>`;
    document.body.appendChild(mask);
    mask.querySelector('#again').onclick = () => { mask.remove(); loadInspector(S.q, S.t).catch((e) => showError(e.message)); };
  }

  function renderWorker(orders) {
    $back.style.display = 'none';
    const w = S.worker;
    $app.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">${esc(w.name)}</div>
        <div class="pname">${esc(w.team || '')} · 我的在制工单</div>
      </div></div>
      <div class="pick-hint">点击工单进入报工</div>
      <div class="card" style="padding:0">
        ${orders.length ? orders.map((o) => `
          <div class="ord" data-oid="${o.id}">
            <div><b>${esc(o.code)}</b><div class="pname">${esc(o.product_name)} · 计划 ${o.qty_plan}</div></div>
            <div style="text-align:right">${badge(o.status)}<div class="pname" style="margin-top:4px">完工 ${o.qty_done}</div></div>
          </div>`).join('') : `<div class="card-b center muted">暂无在制工单</div>`}
      </div>`;
    $app.querySelectorAll('[data-oid]').forEach((el) => el.onclick = () => {
      $back.style.display = 'block';
      loadOrder(el.dataset.oid, S.t, S.w).catch((e) => showError(e.message));
    });
  }

  function badge(st) { const m = BADGE[st] || [st, 'b-released']; return `<span class="badge ${m[1]}">${m[0]}</span>`; }

  /* 不良明细多行逻辑：一道工序可登记多种不良，填一种自动出现下一种 */
  function ensureBadRows(v) {
    if (!v.badRows) v.badRows = [{ reason: '', qty: '', detail: '' }];
    if (!v.badRows.length || v.badRows[v.badRows.length - 1].reason) v.badRows.push({ reason: '', qty: '', detail: '' });
  }
  function renderBadRows(sid) {
    const v = S.vals[sid]; if (!v) return;
    ensureBadRows(v);
    const box = $app.querySelector('#br' + sid);
    if (!box) return;
    box.innerHTML = v.badRows.map((row, i) => {
      const isOther = (S.badReasons || []).find((x) => String(x.id) === String(row.reason) && x.name === '其他');
      return `<div class="brow" data-i="${i}" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <select class="plain reason brow-reason" style="flex:2;min-width:0">${'<option value="">无</option>' + (S.badReasons || []).map((x) => `<option value="${x.id}"${String(row.reason) === String(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <input class="plain brow-qty" type="number" min="0" inputmode="numeric" placeholder="数量" style="flex:1;min-width:0" value="${row.qty === '' ? '' : esc(row.qty)}">
        ${isOther ? `<input class="plain brow-detail" type="text" placeholder="具体原因" style="flex:2;min-width:0" value="${esc(row.detail || '')}">` : ''}
        <button type="button" class="brow-del" style="flex:0 0 auto;width:28px;height:28px;border:1px solid #d5dae0;background:#fff;border-radius:6px;color:#e5484d;font-size:15px;cursor:pointer">×</button>
      </div>`;
    }).join('');
  }
  function bindBadRows() {
    if (S._badBound) return; S._badBound = true;
    $app.addEventListener('change', (e) => {
      const br = e.target.closest('.brow'); if (!br) return;
      const box = br.closest('.badrows'); if (!box) return;
      const sid = Number(box.id.slice(2)); const i = +br.dataset.i; const v = S.vals[sid]; if (!v) return;
      if (e.target.classList.contains('brow-reason')) { v.badRows[i].reason = e.target.value; renderBadRows(sid); }
    });
    $app.addEventListener('input', (e) => {
      const br = e.target.closest('.brow'); if (!br) return;
      const box = br.closest('.badrows'); if (!box) return;
      const sid = Number(box.id.slice(2)); const i = +br.dataset.i; const v = S.vals[sid]; if (!v) return;
      if (e.target.classList.contains('brow-qty')) v.badRows[i].qty = e.target.value;
      if (e.target.classList.contains('brow-detail')) v.badRows[i].detail = e.target.value;
    });
    $app.addEventListener('click', (e) => {
      if (e.target.classList.contains('brow-del')) {
        const br = e.target.closest('.brow'); const box = br.closest('.badrows'); if (!box) return;
        const sid = Number(box.id.slice(2)); const i = +br.dataset.i; const v = S.vals[sid]; if (!v) return;
        if (v.badRows.length > 1) { v.badRows.splice(i, 1); renderBadRows(sid); }
      }
    });
  }

  function renderReport() {
    const o = S.order;
    const closed = ['done', 'closed'].includes(o.status);
    const pct = o.qty_plan > 0 ? Math.round((o.qty_done / o.qty_plan) * 100) : 0;
    const workerSel = S.w
      ? `<input type="hidden" id="fWorker" value="${S.w}"><div class="pname">报工人：<b>${esc(S.worker ? S.worker.name : '本人')}</b></div>`
      : `<select id="fWorker" class="input"><option value="">请选择报工人</option>${S.workers.map((x) => `<option value="${x.id}">${esc(x.name)}（${esc(x.team || '—')}）</option>`).join('')}</select>`;

    const canReport = (s) => s.allow_report !== 0 && s.status !== 'done';
    const selCount = S.steps.filter((s) => S.sel.has(s.id) && canReport(s)).length;

    const stepCards = S.steps.map((s) => {
      const lock = s.allow_report === 0;
      const done = s.status === 'done';
      const sel = S.sel.has(s.id);
      const otherId = (S.badReasons || []).find((x) => x.name === '其他');
      const cls = ['step'];
      if (sel) cls.push('sel');
      if (lock || done) cls.push('locked');
      const v = S.vals[s.id] || { good: 0, bad: 0, reason: '', min: '' };
      const note = lock ? '<span class="lock">🔒 需管理员/技术员报工</span>'
        : (done ? '<span class="lock" style="color:#6b7682;background:#eef1f5">已完成</span>' : '');
      const detail = (sel && canReport(s)) ? `
        <div class="subrep">
          <div class="field"><span>合格数量</span><div class="stepper sm">
            <button type="button" class="dec" data-dec="${s.id}" aria-label="减少合格数量"></button>
            <input id="g${s.id}" type="number" inputmode="numeric" min="0" value="${v.good}">
            <button type="button" class="inc" data-inc="${s.id}" aria-label="增加合格数量"></button></div></div>
          <div class="field"><span>工时（小时，选填）</span><input id="w${s.id}" class="plain" type="number" inputmode="decimal" min="0" step="0.5" value="${v.min || ''}" placeholder="如 2"></div>
          <div class="field"><span>不良明细（可多种：选原因 + 数量）</span><div class="badrows" id="br${s.id}"></div></div>
        </div>` : '';
      return `<div class="${cls.join(' ')}" data-s="${s.id}">
        <div class="step-main">
          <div class="nm">${s.seq}. ${esc(s.process_name)}</div>
          <div class="sub">${esc(s.process_code || '')} · 指派班组 ${esc(s.assignee_team || '暂无')}${done ? ' · 已完成' : ''} · 已报 ${s.qty_good}/${s.qty_plan}</div>
          ${note}
        </div>
        ${canReport(s) ? `<div class="tick">${sel ? '✓' : ''}</div>` : ''}
        ${detail}
      </div>`;
    }).join('');

    $app.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">${esc(o.code)}</div>
        <div class="pname">${esc(o.product_name)} ${esc(o.spec || '')}</div>
        <div style="margin-top:8px">${badge(o.status)}</div>
        <div class="bar" style="margin-top:10px"><i style="width:${pct}%"></i></div>
        <div class="prog-txt"><span>已完工 ${o.qty_done}/${o.qty_plan}</span><span>${pct}%</span></div>
      </div></div>

      ${closed ? `<div class="card center" style="padding:30px 20px;color:#6b7682">该工单已${o.status === 'closed' ? '关闭' : '完成'}，不可再报工。</div>`
        : `<div class="card"><div class="card-h"><h3>选择工序（可多选）</h3>
            <div class="pick-tools">
              <button type="button" class="link" id="allSel">全选可报</button>
              <button type="button" class="link" id="clearSel">清空</button>
            </div></div>
          <div class="card-b" id="steps">${stepCards}</div>
          <div class="sel-count">已选 <b>${selCount}</b> 道工序</div>
        </div>

        <div class="card"><div class="card-h"><h3>报工录入</h3></div><div class="card-b">
          <div class="field"><span>报工人</span>${workerSel}</div>
          <button class="btn" id="submit">提交报工（${selCount} 道）</button>
        </div></div>`}`;

    if (closed) return;

    // 步骤卡片点击 → 切换选中（点输入区不触发切换）
    $app.querySelectorAll('[data-s]').forEach((el) => el.onclick = (e) => {
      if (e.target.closest('.subrep')) return;
      const id = Number(el.dataset.s);
      const s = S.steps.find((x) => x.id === id);
      if (!canReport(s)) { toast('该工序暂不可由员工申报'); return; }
      readVals();
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      renderReport();
    });
    const allSel = $app.querySelector('#allSel');
    if (allSel) allSel.onclick = () => { readVals(); S.steps.forEach((s) => { if (canReport(s)) S.sel.add(s.id); }); renderReport(); };
    const clearSel = $app.querySelector('#clearSel');
    if (clearSel) clearSel.onclick = () => { readVals(); S.sel.clear(); renderReport(); };

    // 每个选中工序的 ± 按钮
    S.steps.forEach((s) => {
      if (!S.sel.has(s.id) || !canReport(s)) return;
      const g = $app.querySelector('#g' + s.id);
      const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
      $app.querySelector('[data-dec="' + s.id + '"]').onclick = () => g.value = Math.max(0, clamp(g.value) - 10);
      $app.querySelector('[data-inc="' + s.id + '"]').onclick = () => g.value = clamp(g.value) + 10;
    });

    // 不良明细多行渲染 + 事件绑定
    bindBadRows();
    S.steps.forEach((s) => { if (S.sel.has(s.id) && canReport(s)) renderBadRows(s.id); });

    $app.querySelector('#submit').onclick = submit;
  }

  // 将当前页面各工序输入框数值读回 S.vals，便于重渲染后保留
  function readVals() {
    S.steps.forEach((s) => {
      const g = $app.querySelector('#g' + s.id), w = $app.querySelector('#w' + s.id);
      const prev = S.vals[s.id] || { good: 0, min: '', badRows: [{ reason: '', qty: '', detail: '' }] };
      const v = {
        good: g ? Math.max(0, Math.floor(Number(g.value) || 0)) : prev.good,
        min: w ? (w.value === '' ? '' : Math.max(0, Number(w.value) || 0)) : prev.min,
        badRows: prev.badRows || [{ reason: '', qty: '', detail: '' }],
      };
      const box = $app.querySelector('#br' + s.id);
      if (box) {
        const rows = [...box.querySelectorAll('.brow')].map((br) => {
          const det = br.querySelector('.brow-detail');
          return { reason: br.querySelector('.brow-reason').value, qty: br.querySelector('.brow-qty').value, detail: det ? det.value : '' };
        });
        v.badRows = rows.length ? rows : [{ reason: '', qty: '', detail: '' }];
      }
      S.vals[s.id] = v;
    });
  }

  async function submit() {
    readVals();
    const workerId = S.w ? S.w : Number($app.querySelector('#fWorker').value);
    if (!S.w && !workerId) { toast('请先选择报工人'); return; }
    const steps = S.steps
      .filter((s) => S.sel.has(s.id) && s.allow_report !== 0 && s.status !== 'done')
      .map((s) => {
        const v = S.vals[s.id] || { good: 0, badRows: [] };
        const badRows = (v.badRows || []).filter((r) => r.reason && Number(r.qty) > 0).map((r) => {
          const isOther = (S.badReasons || []).find((x) => String(x.id) === String(r.reason) && x.name === '其他');
          return { bad_reason_id: Number(r.reason) || 0, qty: Number(r.qty) || 0, bad_reason_detail: isOther ? (r.detail || '').trim() : '' };
        });
        const totalBad = badRows.reduce((a, e) => a + e.qty, 0);
        return { order_step_id: s.id, qty_good: v.good, qty_bad: totalBad, bad_reasons: badRows, work_min: (Number(v.min) || 0) * 60 };
      })
      .filter((x) => (x.qty_good + x.qty_bad) > 0);
    if (!steps.length) { toast('请选择工序并填写合格/不良数量'); return; }
    const btn = $app.querySelector('#submit'); btn.disabled = true;
    try {
      const r = await post('/api/public/reports', {
        token: S.t, order_id: S.order.id, worker_id: workerId,
        steps, work_min: 0, report_date: today(), remark: '',
      });
      const auto = (r && r.steps || []).filter((s) => s.autoFinishIn);
      const autoQty = auto.reduce((a, s) => a + Number(s.autoFinishIn.qty), 0);
      showOk(autoQty);
    } catch (e) { toast(e.message); btn.disabled = false; }
  }

  function showOk(autoQty) {
    const mask = document.createElement('div'); mask.className = 'ok-mask';
    mask.innerHTML = `<div class="ok-circle"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18"/></svg></div>
      <div style="font-size:18px;font-weight:700">报工成功</div>
      ${autoQty ? `<div style="color:#2bb673;margin-top:6px">末道工序已自动入库 ${autoQty} 件</div>` : ''}
      <button class="btn" style="max-width:220px" id="again">继续报工</button>
      ${S.mode === 'worker' ? '<button class="btn ghost" style="max-width:220px" id="wh">返回我的工单</button>' : ''}`;
    document.body.appendChild(mask);
    mask.querySelector('#again').onclick = () => { mask.remove(); loadOrder(S.o, S.t, S.w).catch((e) => showError(e.message)); };
    const wh = mask.querySelector('#wh'); if (wh) wh.onclick = () => { mask.remove(); loadWorker(S.w, S.t); };
  }

  $back.onclick = () => {
    if (S.mode === 'worker') loadWorker(S.w, S.t);
    else showError('请通过微信扫描报工二维码进入');
  };

  function init() {
    const p = new URLSearchParams(location.search);
    const o = p.get('o'), w = p.get('w'), q = p.get('q'), t = p.get('t');
    if (q && t) loadInspector(q, t).catch((e) => showError(e.message));
    else if (o && t) loadOrder(o, t, null).catch((e) => showError(e.message));
    else if (w && t) loadWorker(w, t).catch((e) => showError(e.message));
    else showError('无效的报工链接，请用微信扫描「报工二维码」进入。');
  }
  init();
})();
