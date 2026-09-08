/* 移动端扫码报工（免登录 H5，微信内打开） */
(function () {
  const $app = document.getElementById('app');
  const $back = document.getElementById('back');
  const S = { mode: null, o: null, w: null, t: null, order: null, steps: [], workers: [], worker: null, step: null };

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
      : `<select id="fWorker" class="input">${S.workers.map((x) => `<option value="${x.id}"${S.step && x.id === S.step.assignee_id ? ' selected' : ''}>${esc(x.name)}（${esc(x.team || '—')}）</option>`).join('')}</select>`;

    $app.innerHTML = `
      <div class="card"><div class="card-b">
        <div class="ocode">${esc(o.code)}</div>
        <div class="pname">${esc(o.product_name)} ${esc(o.spec || '')}</div>
        <div style="margin-top:8px">${badge(o.status)}</div>
        <div class="bar" style="margin-top:10px"><i style="width:${pct}%"></i></div>
        <div class="prog-txt"><span>已完工 ${o.qty_done}/${o.qty_plan}</span><span>${pct}%</span></div>
      </div></div>

      ${closed ? `<div class="card center" style="padding:30px 20px;color:#6b7682">该工单已${o.status === 'closed' ? '关闭' : '完成'}，不可再报工。</div>`
        : `<div class="card"><div class="card-h"><h3>选择工序</h3></div><div class="card-b" id="steps">
          ${S.steps.map((s) => `<div class="step ${s.id === (S.step && S.step.id) ? 'active' : ''} ${s.status === 'done' ? 'done' : ''}" data-s="${s.id}">
            <div class="nm">${s.seq}. ${esc(s.process_name)}</div>
            <div class="sub">${esc(s.process_code || '')} · 责任人 ${esc(s.assignee_name || '暂无')}${s.status === 'done' ? ' · 已完成' : ''} · 已报 ${s.qty_good}/${s.qty_plan}</div>
          </div>`).join('')}
        </div></div>

        <div class="card"><div class="card-h"><h3>报工录入</h3></div><div class="card-b">
          <div class="field"><span>合格数量</span><div class="stepper">
            <button type="button" id="gDec">−</button>
            <input id="fGood" type="number" inputmode="numeric" min="0" value="0">
            <button type="button" id="gInc">＋</button></div></div>
          <div class="field"><span>不良数量</span><div class="stepper">
            <button type="button" id="bDec">−</button>
            <input id="fBad" type="number" inputmode="numeric" min="0" value="0">
            <button type="button" id="bInc">＋</button></div></div>
          <div class="field"><span>不良原因（选填）</span><input id="fReason" type="text" placeholder="如：尺寸超差 / 划伤"></div>
          <div class="field"><span>报工人</span>${workerSel}</div>
          <button class="btn" id="submit">提交报工</button>
        </div></div>`}`;

    if (closed) return;

    $app.querySelectorAll('[data-s]').forEach((el) => el.onclick = () => {
      S.step = S.steps.find((x) => x.id == el.dataset.s);
      renderReport();
    });
    const g = $app.querySelector('#fGood'), b = $app.querySelector('#fBad');
    const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
    $app.querySelector('#gDec').onclick = () => g.value = Math.max(0, clamp(g.value) - 10);
    $app.querySelector('#gInc').onclick = () => g.value = clamp(g.value) + 10;
    $app.querySelector('#bDec').onclick = () => b.value = Math.max(0, clamp(b.value) - 1);
    $app.querySelector('#bInc').onclick = () => b.value = clamp(b.value) + 1;

    $app.querySelector('#submit').onclick = submit;
  }

  async function submit() {
    const good = Math.max(0, Math.floor(Number($app.querySelector('#fGood').value) || 0));
    const bad = Math.max(0, Math.floor(Number($app.querySelector('#fBad').value) || 0));
    if (good + bad <= 0) { toast('请填写合格数或不良数'); return; }
    const workerId = S.w ? S.w : Number($app.querySelector('#fWorker').value);
    const btn = $app.querySelector('#submit'); btn.disabled = true;
    try {
      await post('/api/public/reports', {
        token: S.t, order_id: S.order.id, order_step_id: S.step.id, worker_id: workerId,
        qty_good: good, qty_bad: bad, bad_reason: $app.querySelector('#fReason').value.trim(),
        work_min: 0, report_date: today(), remark: '',
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
