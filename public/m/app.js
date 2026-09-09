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
    S.order = data.order; S.steps = data.steps; S.workers = data.workers; S.mode = 'order'; S.o = o; S.t = t; S.w = wid || null;
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

  function renderReport() {
    const o = S.order;
    const closed = ['done', 'closed'].includes(o.status);
    const pct = o.qty_plan > 0 ? Math.round((o.qty_done / o.qty_plan) * 100) : 0;
    const workerSel = S.w
      ? `<input type="hidden" id="fWorker" value="${S.w}"><div class="pname">报工人：<b>${esc(S.worker ? S.worker.name : '本人')}</b></div>`
      : `<select id="fWorker" class="input">${S.workers.map((x) => `<option value="${x.id}"${S.worker && x.id == S.worker.id ? ' selected' : ''}>${esc(x.name)}（${esc(x.team || '—')}）</option>`).join('')}</select>`;

    const canReport = (s) => s.allow_report !== 0 && s.status !== 'done';
    const selCount = S.steps.filter((s) => S.sel.has(s.id) && canReport(s)).length;

    const stepCards = S.steps.map((s) => {
      const lock = s.allow_report === 0;
      const done = s.status === 'done';
      const sel = S.sel.has(s.id);
      const cls = ['step'];
      if (sel) cls.push('sel');
      if (lock || done) cls.push('locked');
      const v = S.vals[s.id] || { good: 0, bad: 0, reason: '' };
      const note = lock ? '<span class="lock">🔒 需管理员/班组长报工</span>'
        : (done ? '<span class="lock" style="color:#6b7682;background:#eef1f5">已完成</span>' : '');
      const detail = (sel && canReport(s)) ? `
        <div class="subrep">
          <div class="field"><span>合格数量</span><div class="stepper sm">
            <button type="button" class="dec" data-dec="${s.id}" aria-label="减少合格数量"></button>
            <input id="g${s.id}" type="number" inputmode="numeric" min="0" value="${v.good}">
            <button type="button" class="inc" data-inc="${s.id}" aria-label="增加合格数量"></button></div></div>
          <div class="field"><span>不良数量</span><div class="stepper sm">
            <button type="button" class="dec" data-bdec="${s.id}" aria-label="减少不良数量"></button>
            <input id="b${s.id}" type="number" inputmode="numeric" min="0" value="${v.bad}">
            <button type="button" class="inc" data-binc="${s.id}" aria-label="增加不良数量"></button></div></div>
          <div class="field"><span>不良原因（选填）</span><textarea id="r${s.id}" class="reason" placeholder="如：尺寸超差 / 划伤">${esc(v.reason)}</textarea></div>
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
      const g = $app.querySelector('#g' + s.id), b = $app.querySelector('#b' + s.id);
      const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
      $app.querySelector('[data-dec="' + s.id + '"]').onclick = () => g.value = Math.max(0, clamp(g.value) - 10);
      $app.querySelector('[data-inc="' + s.id + '"]').onclick = () => g.value = clamp(g.value) + 10;
      $app.querySelector('[data-bdec="' + s.id + '"]').onclick = () => b.value = Math.max(0, clamp(b.value) - 1);
      $app.querySelector('[data-binc="' + s.id + '"]').onclick = () => b.value = clamp(b.value) + 1;
    });

    $app.querySelector('#submit').onclick = submit;
  }

  // 将当前页面各工序输入框数值读回 S.vals，便于重渲染后保留
  function readVals() {
    S.steps.forEach((s) => {
      const g = $app.querySelector('#g' + s.id), b = $app.querySelector('#b' + s.id), r = $app.querySelector('#r' + s.id);
      const prev = S.vals[s.id] || { good: 0, bad: 0, reason: '' };
      S.vals[s.id] = {
        good: g ? Math.max(0, Math.floor(Number(g.value) || 0)) : prev.good,
        bad: b ? Math.max(0, Math.floor(Number(b.value) || 0)) : prev.bad,
        reason: r ? r.value.trim() : prev.reason,
      };
    });
  }

  async function submit() {
    readVals();
    const workerId = S.w ? S.w : Number($app.querySelector('#fWorker').value);
    const steps = S.steps
      .filter((s) => S.sel.has(s.id) && s.allow_report !== 0 && s.status !== 'done')
      .map((s) => {
        const v = S.vals[s.id] || { good: 0, bad: 0, reason: '' };
        return { order_step_id: s.id, qty_good: v.good, qty_bad: v.bad, bad_reason: v.reason };
      })
      .filter((x) => (x.qty_good + x.qty_bad) > 0);
    if (!steps.length) { toast('请选择工序并填写合格/不良数量'); return; }
    const btn = $app.querySelector('#submit'); btn.disabled = true;
    try {
      await post('/api/public/reports', {
        token: S.t, order_id: S.order.id, worker_id: workerId,
        steps, work_min: 0, report_date: today(), remark: '',
      });
      showOk();
    } catch (e) { toast(e.message); btn.disabled = false; }
  }

  function showOk() {
    const mask = document.createElement('div'); mask.className = 'ok-mask';
    mask.innerHTML = `<div class="ok-circle"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18"/></svg></div>
      <div style="font-size:18px;font-weight:700">报工成功</div>
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
    const o = p.get('o'), w = p.get('w'), t = p.get('t');
    if (o && t) loadOrder(o, t, null).catch((e) => showError(e.message));
    else if (w && t) loadWorker(w, t).catch((e) => showError(e.message));
    else showError('无效的报工链接，请用微信扫描「报工二维码」进入。');
  }
  init();
})();
