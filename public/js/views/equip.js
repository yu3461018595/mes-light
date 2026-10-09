/* 设备管理：设备台账 + 点检 + 稼动分析 + 模具管理（设备模块分支） */
window.Views = window.Views || {};
Views.equip = {
  title: '设备管理',
  icon: 'dash',
  subTab: 'equip',
  utilDays: 7,

  async render(el) {
    el.innerHTML = `
      <div class="tabs" style="margin-bottom:14px">
        <div class="tab ${this.subTab === 'equip' ? 'active' : ''}" data-st="equip" style="padding:8px 16px">设备台账</div>
        <div class="tab ${this.subTab === 'util' ? 'active' : ''}" data-st="util" style="padding:8px 16px">稼动分析</div>
        <div class="tab ${this.subTab === 'mold' ? 'active' : ''}" data-st="mold" style="padding:8px 16px">模具管理</div>
      </div>
      <div id="subPanel"><div class="muted" style="padding:30px">加载中…</div></div>`;
    el.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => { this.subTab = b.dataset.st; this.render(el); });
    const panel = el.querySelector('#subPanel');
    if (this.subTab === 'mold') return this.renderMold(panel);
    if (this.subTab === 'util') return this.renderUtil(panel);
    return this.renderEquip(panel);
  },

  /* ============ 页签：设备台账 + 点检 ============ */
  async renderEquip(panel) {
    const [eqs, canEdit] = [await API.get('/equipments'), App.canEdit()];
    this.data = eqs;
    const today = new Date().toISOString().slice(0, 10);
    panel.innerHTML = `
      <div class="card">
        <div class="card-h">
          <h3>设备台账（${eqs.length} 台）</h3>
          <div style="display:flex;gap:8px">
            ${canEdit ? `<button class="btn btn-primary btn-sm" id="eqAdd">${UI.icon('plus')}新增设备</button>` : ''}
          </div>
        </div>
        <div class="card-b tight">
          ${eqs.length ? UI.table([
            { t: '编码', f: (r) => `<b>${UI.esc(r.code)}</b>` },
            { t: '名称', f: (r) => UI.esc(r.name) },
            { t: '型号', f: (r) => UI.esc(r.model || '—') },
            { t: '位置', f: (r) => UI.esc(r.location || '—') },
            { t: '状态', f: (r) => this.statusChip(r.status) },
            { t: '点检周期', f: (r) => r.check_cycle > 0 ? `<span class="mono">${r.check_cycle}</span> 天` : '<span class="muted">不定期</span>' },
            { t: '最近点检', f: (r) => this.lastCheck(r, today) },
            { t: '操作', align: 'right', w: '270px', f: (r) => this.opButtons(r, canEdit) },
          ], eqs) : `<div class="muted" style="padding:22px 6px">暂无设备。${canEdit ? '点右上角「新增设备」建立台账；生成二维码贴到机台，员工扫码即可点检。' : '请联系管理员建立设备台账。'}</div>`}
        </div>
      </div>
      <p class="small muted" style="margin-top:10px">点检规则：异常点检可勾选「生成质量异常单」，走统一异常口径（非检验员上报为待定级，申报重大时通知检验员及时定级；检验员可直接定级）。</p>`;

    if (canEdit) panel.querySelector('#eqAdd').onclick = () => this.form();
    panel.querySelectorAll('[data-check]').forEach((b) => b.onclick = () => this.checkForm(Number(b.dataset.check)));
    panel.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => this.history(Number(b.dataset.hist)));
    if (canEdit) panel.querySelectorAll('[data-eqr]').forEach((b) => b.onclick = async () => {
      try {
        const d = await API.get('/qr/equipment/' + b.dataset.eqr);
        UI.qrModal('设备点检码 · ' + d.equipment.name, {
          svg: d.svg, url: d.url,
          subtitle: '微信/APP 扫一扫即可打开点检页面',
          fileName: '设备_' + d.equipment.name,
        });
      } catch (e) { UI.toast(e.message, 'err'); }
    });
    if (canEdit) panel.querySelectorAll('[data-eedit]').forEach((b) => b.onclick = () => this.form(Number(b.dataset.eedit)));
    if (canEdit) panel.querySelectorAll('[data-edel]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该设备？其点检记录将一并删除。'))) return;
      try { await API.del('/equipments/' + b.dataset.edel); UI.toast('已删除', 'ok'); this.render(document.getElementById('view')); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  /* ============ 页签：稼动分析 ============ */
  async renderUtil(panel) {
    const util = await API.get('/stats/equip_util?days=' + (this.utilDays || 7)).catch(() => null);
    if (!util) { panel.innerHTML = '<div class="muted" style="padding:30px">稼动数据加载失败</div>'; return; }
    panel.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h">
          <h3>设备稼动分析（近 ${util.days} 天）</h3>
          <div class="tabs" style="border-bottom:none;margin-bottom:0">
            <div class="tab ${this.utilDays !== 30 ? 'active' : ''}" data-ud="7" style="padding:6px 12px">近 7 天</div>
            <div class="tab ${this.utilDays === 30 ? 'active' : ''}" data-ud="30" style="padding:6px 12px">近 30 天</div>
          </div>
        </div>
        <div class="card-b">
          <div class="grid g4" style="margin-bottom:12px">
            <div class="stat"><div class="stat-l">平均稼动率</div>
              <div class="stat-v" style="color:${util.summary.avg_util >= 60 ? 'var(--ok)' : util.summary.avg_util >= 30 ? 'var(--warn)' : 'var(--danger)'}">${UI.f1(util.summary.avg_util)}%</div>
              <div class="stat-s">${util.summary.used_machines}/${util.summary.total_machines} 台设备有报工</div></div>
            <div class="stat"><div class="stat-l">实动工时合计</div><div class="stat-v">${UI.f1(util.summary.total_hours)}<span class="small muted"> h</span></div>
              <div class="stat-s">按 <b id="shiftH">${util.shift_hours}</b>h/天班制基准折算</div></div>
            <div class="stat"><div class="stat-l">加工合格</div><div class="stat-v" style="color:var(--ok)">${UI.n2(util.summary.good)}</div>
              <div class="stat-s">件 · 经该设备报工</div></div>
            <div class="stat"><div class="stat-l">综合合格率</div><div class="stat-v">${UI.f1(util.summary.good + util.summary.bad ? util.summary.good * 100 / (util.summary.good + util.summary.bad) : 100)}%</div>
              <div class="stat-s">不良 ${UI.n2(util.summary.bad)} 件</div></div>
          </div>
          ${UI.table([
            { t: '设备', f: (r) => `<b>${UI.esc(r.code)}</b> <span class="small muted">${UI.esc(r.name)}</span>` },
            { t: '车间', f: (r) => UI.esc(r.workshop || '—') },
            { t: '实动工时', f: (r) => `<span class="mono">${UI.f1(r.minu / 60)}</span> h` },
            { t: '稼动率', f: (r) => `${UI.progress(r.util_pct, r.util_pct >= 60 ? 'ok' : r.util_pct >= 30 ? 'warn' : 'danger')} <span class="mono small">${UI.f1(r.util_pct)}%</span>` },
            { t: '合格/不良', f: (r) => r.cnt ? `<span class="mono" style="color:var(--ok)">${UI.n2(r.good)}</span> / <span class="mono" style="color:var(--danger)">${UI.n2(r.bad)}</span>` : '<span class="muted">未使用</span>' },
          ], util.rows, { emptyText: '暂无设备' })}
          <div class="small muted" style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <span>稼动率 = 设备实动工时 ÷（${util.days} 天 × ${util.shift_hours} 小时/天班制基准），上限 100%；数据来自工序报工自动累计。</span>
            ${App.isAdmin() ? `<span style="display:inline-flex;gap:6px;align-items:center">
              <input class="input" id="shiftInput" type="number" min="1" max="24" step="0.5" value="${util.shift_hours}" style="width:70px;padding:2px 8px">
              <button class="btn btn-sm" id="shiftSave">改班制</button>
            </span>` : ''}
          </div>
        </div>
      </div>`;
    const shiftSave = panel.querySelector('#shiftSave');
    if (shiftSave) shiftSave.onclick = async () => {
      const v = Number(panel.querySelector('#shiftInput').value);
      if (!(v >= 1 && v <= 24)) return UI.toast('班制基准需在 1~24 小时之间', 'err');
      try {
        await API.post('/equip/settings', { shift_hours: v });
        UI.toast('班制基准已改为 ' + v + ' 小时/天', 'ok');
        this.render(document.getElementById('view'));
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    panel.querySelectorAll('[data-ud]').forEach((b) => b.onclick = () => { this.utilDays = Number(b.dataset.ud); this.render(document.getElementById('view')); });
  },

  /* ============ 页签：模具管理 ============ */
  async renderMold(panel) {
    const [data, wcs, orders] = await Promise.all([
      API.get('/molds'),
      API.get('/work_centers').catch(() => []),
      API.get('/orders?status=running,released').catch(() => []),
    ]);
    this.moldData = data.rows || [];
    this.wcs = wcs || [];
    const s = data.summary || {};
    const canEdit = App.canEdit();
    const filters = [['', '全部'], ['idle', '在库'], ['producing', '在机'], ['repairing', '维修中'], ['scrapped', '已报废']];
    const list = this.moldFilter ? this.moldData.filter((r) => r.status === this.moldFilter) : this.moldData;

    panel.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:14px">
        <div class="stat"><div class="stat-l">模具总数</div><div class="stat-v">${UI.n2(s.total || 0)}</div><div class="stat-s">不含已报废</div></div>
        <div class="stat"><div class="stat-l">在机生产</div><div class="stat-v" style="color:var(--primary)">${UI.n2(s.producing || 0)}</div><div class="stat-s">绑定机台生产中</div></div>
        <div class="stat"><div class="stat-l">维修中</div><div class="stat-v" style="color:var(--warn)">${UI.n2(s.repairing || 0)}</div><div class="stat-s">送修待完修</div></div>
        <div class="stat"><div class="stat-l">需保养</div><div class="stat-v" style="color:${s.need_maintain ? 'var(--danger)' : 'var(--ok)'}">${UI.n2(s.need_maintain || 0)}</div><div class="stat-s">达到保养周期</div></div>
        <div class="stat"><div class="stat-l">寿命预警</div><div class="stat-v" style="color:${s.life_warn ? 'var(--danger)' : 'var(--ok)'}">${UI.n2(s.life_warn || 0)}</div><div class="stat-s">达到设计寿命</div></div>
      </div>
      <div class="card">
        <div class="card-h">
          <h3>模具台账</h3>
          <div style="display:flex;gap:8px;align-items:center">
            <div class="tabs" style="border-bottom:none;margin-bottom:0">
              ${filters.map(([k, t]) => `<div class="tab ${String(this.moldFilter || '') === k ? 'active' : ''}" data-mf="${k}" style="padding:4px 10px">${t}</div>`).join('')}
            </div>
            ${canEdit ? `<button class="btn btn-primary btn-sm" id="moldAdd">${UI.icon('plus')}新增模具</button>` : ''}
          </div>
        </div>
        <div class="card-b tight">
          ${list.length ? UI.table([
            { t: '模具', f: (r) => `<b>${UI.esc(r.code)}</b> <span class="small muted">${UI.esc(r.name)}</span><div class="small muted">${UI.esc(r.category || '未分类')}${r.cavities ? ' · ' + r.cavities + ' 腔' : ''}${r.product_name ? ' · ' + UI.esc(r.product_name) : ''}</div>` },
            { t: '状态', f: (r) => `${this.moldChip(r)}${r.need_maintain ? ' <span class="chip chip-warn">需保养</span>' : ''}${r.life_warn ? ' <span class="chip chip-danger">寿命到</span>' : ''}` },
            { t: '所在机台', f: (r) => r.status === 'producing' ? UI.esc(r.work_center_name || '—') : (r.status === 'idle' ? UI.esc(r.location || '在库') : '—') },
            { t: '累计生产', f: (r) => `<span class="mono">${UI.n2(r.total_shots)}</span> 件${r.design_life > 0 ? `<div class="small muted" style="margin-top:3px">${UI.progress(r.life_pct, r.life_warn ? 'danger' : r.life_pct >= 80 ? 'warn' : 'ok')} 寿命 ${r.life_pct}%（余 ${UI.n2(r.life_left)}）</div>` : '<div class="small muted">未设寿命上限</div>'}` },
            { t: '保养', f: (r) => r.maintain_every > 0
                ? `${UI.progress(r.maintain_pct, r.need_maintain ? 'danger' : 'ok')} <span class="small mono">${UI.n2(r.total_shots - r.last_maintain_at)}/${UI.n2(r.maintain_every)}</span>${r.last_maintain_time ? `<div class="small muted">上次 ${UI.esc(String(r.last_maintain_time).slice(0, 10))}</div>` : '<div class="small muted">未保养过</div>'}`
                : '<span class="small muted">不按周期</span>' },
            { t: '操作', align: 'right', w: '250px', f: (r) => this.moldOps(r, canEdit) },
          ], list) : `<div class="muted" style="padding:22px 6px">暂无模具。${canEdit ? '点右上角「新增模具」建立台账。' : '请联系管理员建立模具台账。'}</div>`}
        </div>
      </div>
      <p class="small muted" style="margin-top:10px">口径：累计生产数 = 经该模具所在机台报工的合格数 + 不良数（报工自动累计）；保养周期与设计寿命均按生产件数折算，达到周期/寿命自动标红提醒。</p>`;

    panel.querySelectorAll('[data-mf]').forEach((b) => b.onclick = () => { this.moldFilter = b.dataset.mf || ''; this.render(document.getElementById('view')); });
    if (canEdit) panel.querySelector('#moldAdd').onclick = () => this.moldForm();
    panel.querySelectorAll('[data-miss]').forEach((b) => b.onclick = () => this.moldIssue(Number(b.dataset.miss)));
    panel.querySelectorAll('[data-mret]').forEach((b) => b.onclick = () => this.moldAction(Number(b.dataset.mret), 'return', '下机归还', '请下机说明（选填）'));
    panel.querySelectorAll('[data-mrep]').forEach((b) => b.onclick = () => this.moldAction(Number(b.dataset.mrep), 'repair', '送修', '故障描述 / 维修原因'));
    panel.querySelectorAll('[data-mrdone]').forEach((b) => b.onclick = () => this.moldAction(Number(b.dataset.mrdone), 'repair_done', '完修', '维修结果说明'));
    panel.querySelectorAll('[data-mmt]').forEach((b) => b.onclick = () => this.moldAction(Number(b.dataset.mmt), 'maintain', '保养', '保养内容'));
    panel.querySelectorAll('[data-mscrap]').forEach((b) => b.onclick = () => this.moldAction(Number(b.dataset.mscrap), 'scrap', '报废', '报废原因'));
    panel.querySelectorAll('[data-medit]').forEach((b) => b.onclick = () => this.moldForm(Number(b.dataset.medit)));
    panel.querySelectorAll('[data-mhist]').forEach((b) => b.onclick = () => this.moldHistory(Number(b.dataset.mhist)));
    if (canEdit) panel.querySelectorAll('[data-mdel]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该模具档案？流转/维修/保养履历将一并删除。如需保留履历请改用「报废」。'))) return;
      try { await API.del('/molds/' + b.dataset.mdel); UI.toast('已删除', 'ok'); this.render(document.getElementById('view')); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  moldChip(r) {
    const m = { idle: ['在库', 'chip-gray'], producing: ['在机', 'chip-ok'], repairing: ['维修中', 'chip-warn'], scrapped: ['已报废', 'chip-danger'] }[r.status] || [r.status_label, 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },

  moldOps(r, canEdit) {
    if (!canEdit) return `<button class="btn btn-sm" data-mhist="${r.id}">履历</button>`;
    const btns = [];
    if (r.status === 'idle') {
      btns.push(`<button class="btn btn-sm btn-primary" data-miss="${r.id}">上机</button>`);
      btns.push(`<button class="btn btn-sm" data-mrep="${r.id}">送修</button>`);
    } else if (r.status === 'producing') {
      btns.push(`<button class="btn btn-sm btn-primary" data-mret="${r.id}">下机</button>`);
    } else if (r.status === 'repairing') {
      btns.push(`<button class="btn btn-sm btn-primary" data-mrdone="${r.id}">完修</button>`);
    }
    if (r.status !== 'scrapped') btns.push(`<button class="btn btn-sm" data-mmt="${r.id}">保养</button>`);
    btns.push(`<button class="btn btn-sm" data-mhist="${r.id}">履历</button>`);
    btns.push(`<button class="btn btn-sm" data-medit="${r.id}">编辑</button>`);
    if (r.status !== 'scrapped') btns.push(`<button class="btn btn-sm btn-danger" data-mscrap="${r.id}">报废</button>`);
    else btns.push(`<button class="btn btn-sm btn-danger" data-mdel="${r.id}">删除</button>`);
    return btns.join(' ');
  },

  /* 新增/编辑模具 */
  async moldForm(id) {
    const row = id ? this.moldData.find((r) => r.id === id) : {};
    UI.modal({
      title: (id ? '编辑' : '新增') + '模具',
      body: `<div class="grid g2">
        <label class="field"><span class="label-req">模具编码</span><input class="input" data-k="code" value="${UI.esc(row.code || '')}" required placeholder="如 MJ-001"></label>
        <label class="field"><span class="label-req">模具名称</span><input class="input" data-k="name" value="${UI.esc(row.name || '')}" required placeholder="如 面壳注塑模"></label>
        <label class="field"><span>类型 / 分类</span><input class="input" data-k="category" value="${UI.esc(row.category || '')}" placeholder="如 注塑模 / 冲压模 / 压铸模"></label>
        <label class="field"><span>模腔数</span><input class="input" type="number" min="1" step="1" data-k="cavities" value="${row.cavities == null ? 1 : row.cavities}"></label>
        <label class="field"><span>适用产品</span><input class="input" data-k="product_name" value="${UI.esc(row.product_name || '')}" placeholder="如 电池面壳"></label>
        <label class="field"><span>存放库位</span><input class="input" data-k="location" value="${UI.esc(row.location || '')}" placeholder="如 模具架 A-01"></label>
        <label class="field"><span>设计寿命（件）</span><input class="input" type="number" min="0" step="1000" data-k="design_life" value="${row.design_life == null ? 0 : row.design_life}"><span class="small muted">0 = 不限；达到后标红提醒</span></label>
        <label class="field"><span>保养周期（每 N 件）</span><input class="input" type="number" min="0" step="1000" data-k="maintain_every" value="${row.maintain_every == null ? 0 : row.maintain_every}"><span class="small muted">0 = 不按周期保养</span></label>
      </div>
      <label class="field"><span>备注</span><input class="input" data-k="remark" value="${UI.esc(row.remark || '')}"></label>`,
      onOk: async (mask) => {
        const g = (k) => { const e2 = mask.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
        if (!g('code').trim() || !g('name').trim()) throw new Error('请填写模具编码与名称');
        const payload = {
          code: g('code').trim(), name: g('name').trim(), category: g('category').trim(),
          cavities: Number(g('cavities')) || 1, product_name: g('product_name').trim(), location: g('location').trim(),
          design_life: Number(g('design_life')) || 0, maintain_every: Number(g('maintain_every')) || 0, remark: g('remark'),
        };
        if (id) await API.put('/molds/' + id, payload); else await API.post('/molds', payload);
        UI.toast('已保存', 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  /* 上机：选机台（可带工单） */
  async moldIssue(id) {
    const r = this.moldData.find((x) => x.id === id);
    const wcs = (this.wcs || []).map((w) => ({ id: w.id, name: `${w.code || ''} ${w.name}` }));
    const os = await API.get('/orders?status=running,released').catch(() => []);
    UI.modal({
      title: `模具上机 · ${r.code} ${r.name}`,
      body: `
        <label class="field"><span class="label-req">上机机台 / 工位</span><select class="input" data-k="work_center_id">${UI.options(wcs, '', 'name')}</select><span class="small muted">上机后经该机台报工自动累计生产数</span></label>
        <label class="field"><span>关联工单（可选）</span><select class="input" data-k="order_id"><option value="">不关联</option>${(os || []).map((o) => `<option value="${o.id}">${UI.esc(o.code)} ${UI.esc(o.product_name || '')}</option>`).join('')}</select></label>
        <label class="field"><span>说明</span><input class="input" data-k="note" placeholder="选填"></label>`,
      onOk: async (mask) => {
        const g = (k) => mask.querySelector(`[data-k="${k}"]`).value;
        if (!g('work_center_id')) throw new Error('请选择机台');
        await API.post('/molds/' + id + '/issue', { work_center_id: Number(g('work_center_id')), order_id: g('order_id') ? Number(g('order_id')) : null, note: g('note') });
        UI.toast('模具已上机', 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  /* 通用动作：下机/送修/完修/保养/报废（说明 + 费用） */
  moldAction(id, type, title, noteLabel) {
    const r = this.moldData.find((x) => x.id === id);
    const needCost = type === 'repair' || type === 'repair_done' || type === 'maintain';
    UI.modal({
      title: `${title} · ${r.code} ${r.name}`,
      body: `<label class="field"><span>${noteLabel}${type === 'scrap' || type === 'repair' ? '' : '（选填）'}</span><input class="input" data-k="note" placeholder="如：顶针磨损、滑块卡滞"></label>
        ${needCost ? `<label class="field"><span>费用（元，选填）</span><input class="input" type="number" min="0" step="0.01" data-k="cost" value="0"></label>` : ''}
        ${type === 'scrap' ? '<div class="small muted">报废为终态操作，履历保留，不可恢复。</div>' : ''}`,
      onOk: async (mask) => {
        const payload = { note: mask.querySelector('[data-k="note"]').value.trim() };
        if (needCost) payload.cost = Number(mask.querySelector('[data-k="cost"]').value) || 0;
        await API.post(`/molds/${id}/${type}`, payload);
        UI.toast(title + '已记录', 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  /* 模具履历 */
  async moldHistory(id) {
    const r = await API.get('/molds/' + id);
    const evName = { create: '建档', issue: '上机', return: '下机', repair: '送修', repair_done: '完修', maintain: '保养', scrap: '报废', edit: '编辑' };
    UI.modal({
      title: `模具履历 · ${r.code} ${r.name}`,
      size: 'lg',
      body: `
        <div class="grid g4" style="margin-bottom:12px">
          <div class="stat"><div class="stat-l">当前状态</div><div class="stat-v" style="font-size:18px">${r.status_label}</div></div>
          <div class="stat"><div class="stat-l">所在机台</div><div class="stat-v" style="font-size:18px">${UI.esc(r.work_center_name || (r.status === 'idle' ? (r.location || '在库') : '—'))}</div></div>
          <div class="stat"><div class="stat-l">累计生产</div><div class="stat-v" style="font-size:18px">${UI.n2(r.total_shots)}<span class="small"> 件</span></div></div>
          <div class="stat"><div class="stat-l">寿命</div><div class="stat-v" style="font-size:18px">${r.design_life > 0 ? r.life_pct + '%' : '不限'}</div></div>
        </div>
        ${r.events && r.events.length ? `<div class="tight">${UI.table([
          { t: '时间', f: (e) => `<span class="mono small">${UI.esc(String(e.created_at).slice(0, 16))}</span>` },
          { t: '事件', f: (e) => `<span class="chip chip-gray">${UI.esc(evName[e.type] || e.type)}</span>` },
          { t: '机台', f: (e) => UI.esc(e.work_center_name || '—') },
          { t: '说明', f: (e) => UI.esc(e.note || '—') },
          { t: '费用', align: 'right', f: (e) => e.cost > 0 ? `¥${UI.f2(e.cost)}` : '—' },
          { t: '操作人', f: (e) => UI.esc(e.operator_name || '—') },
        ], r.events)}</div>` : '<div class="muted" style="padding:18px 4px">暂无流转记录</div>'}`,
      footer: '<button class="btn" data-close>关闭</button>',
    });
  },

  statusChip(s) {
    const m = { idle: ['空闲', 'chip-gray'], running: ['运转', 'chip-ok'], fault: ['故障', 'chip-danger'], maintain: ['保养', 'chip-warn'] }[s] || [s, 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },

  lastCheck(r, today) {
    if (!r.last_check_at) return '<span class="chip chip-gray">未点检</span>';
    const d = String(r.last_check_at).slice(0, 10);
    if (r.check_cycle > 0) {
      const due = new Date(d); due.setDate(due.getDate() + r.check_cycle);
      const overdue = due.toISOString().slice(0, 10) < today;
      return `${UI.esc(d)}${overdue ? ' <span class="chip chip-danger">已超期</span>' : ''}`;
    }
    return UI.esc(d);
  },

  opButtons(r, canEdit) {
    return `<button class="btn btn-sm btn-primary" data-check="${r.id}">点检</button>`
      + ` <button class="btn btn-sm" data-hist="${r.id}">记录</button>`
      + (canEdit ? ` <button class="btn btn-sm" data-eqr="${r.id}">二维码</button>`
        + ` <button class="btn btn-sm" data-eedit="${r.id}">编辑</button>`
        + ` <button class="btn btn-sm btn-danger" data-edel="${r.id}">删除</button>` : '');
  },

  /* 新增/编辑设备 */
  async form(id) {
    const row = id ? this.data.find((r) => r.id === id) : {};
    UI.modal({
      title: (id ? '编辑' : '新增') + '设备',
      body: `<div class="grid g2">
        <label class="field"><span class="label-req">设备编码</span><input class="input" data-k="code" value="${UI.esc(row.code || '')}" required placeholder="如 EQ-001"></label>
        <label class="field"><span class="label-req">设备名称</span><input class="input" data-k="name" value="${UI.esc(row.name || '')}" required placeholder="如 CNC 车床 1#"></label>
        <label class="field"><span>规格型号</span><input class="input" data-k="model" value="${UI.esc(row.model || '')}"></label>
        <label class="field"><span>安装位置</span><input class="input" data-k="location" value="${UI.esc(row.location || '')}" placeholder="如 一车间 A 区"></label>
        <label class="field"><span>状态</span><select class="input" data-k="status">${UI.options([{ id: 'idle', name: '空闲' }, { id: 'running', name: '运转' }, { id: 'fault', name: '故障' }, { id: 'maintain', name: '保养' }], row.status || 'idle', 'name')}</select></label>
        <label class="field"><span>点检周期(天)</span><input class="input" type="number" min="0" step="1" data-k="check_cycle" value="${row.check_cycle == null ? 1 : row.check_cycle}"><span class="small muted">0 = 不定期；设为 1 即每日点检，超期列表会标红</span></label>
      </div>
      <label class="field"><span>备注</span><input class="input" data-k="remark" value="${UI.esc(row.remark || '')}"></label>`,
      onOk: async (mask) => {
        const g = (k) => { const e2 = mask.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
        if (!g('code').trim() || !g('name').trim()) throw new Error('请填写设备编码与名称');
        const payload = { code: g('code').trim(), name: g('name').trim(), model: g('model'), location: g('location'), status: g('status'), check_cycle: Number(g('check_cycle')) || 0, remark: g('remark') };
        if (id) await API.put('/equipments/' + id, payload); else await API.post('/equipments', payload);
        UI.toast('已保存', 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  /* 点检打分 */
  checkForm(id) {
    const r = this.data.find((x) => x.id === id);
    const isInsp = App.isQC();
    const m = UI.modal({
      title: `设备点检 · ${r.code} ${r.name}`,
      body: `<div class="grid g2">
        <label class="field"><span>点检结果</span><select class="input" data-k="result"><option value="ok">✅ 正常</option><option value="abnormal">⚠️ 异常</option></select></label>
        <label class="field"><span>设备状态（可选同步）</span><select class="input" data-k="fault"><option value="">不更改</option><option value="1">转为「故障」</option><option value="running">转为「运转」</option></select></label>
      </div>
      <label class="field"><span>点检说明 / 异常描述</span><input class="input" data-k="note" placeholder="如：主轴异响、漏油、导轨磨损"></label>
      <div id="abArea" style="display:none;margin-top:4px">
        <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="eqReport" checked style="width:auto"> 同时生成质量异常单（走统一异常上报口径）</label>
        <label class="field"><span>异常等级（${isInsp ? '检验员可直接定级' : '申报等级，重大异常将通知检验员及时定级'}）</span>
          <select class="input" data-k="level"><option value="major">严重</option><option value="critical">致命</option><option value="minor">轻微</option></select></label>
      </div>`,
      onOk: async (mask) => {
        const g = (k) => { const e2 = mask.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
        const payload = { result: g('result'), note: g('note').trim() };
        if (g('fault')) payload.fault = g('fault') === '1';
        if (g('result') === 'abnormal' && mask.querySelector('#eqReport').checked) {
          payload.report = 1; payload.level = g('level');
        }
        const res = await API.post('/equipments/' + id + '/check', payload);
        if (res && res.issue) UI.toast(`已记录异常，并生成异常单 ${res.issue.code}（${res.issue.level === 'pending' ? '待检验员定级' : '等级：' + res.issue.level}）`, 'ok');
        else UI.toast('点检已记录', 'ok');
        this.render(document.getElementById('view'));
      },
    });
    // 切换结果时显示/隐藏异常联动区
    const sel = m.el.querySelector('select[data-k="result"]');
    sel.onchange = () => { m.el.querySelector('#abArea').style.display = sel.value === 'abnormal' ? '' : 'none'; };
  },

  /* 点检历史 */
  async history(id) {
    const r = this.data.find((x) => x.id === id);
    const list = await API.get('/equipments/' + id + '/checks');
    const lvChip = { pending: ['待定级', 'chip-gray'], minor: ['轻微', 'chip-info'], major: ['严重', 'chip-warn'], critical: ['致命', 'chip-danger'] };
    UI.modal({
      title: `点检记录 · ${r.code} ${r.name}`,
      size: 'lg',
      body: list.length ? `<div class="tight">${UI.table([
        { t: '时间', f: (c) => `<span class="mono">${UI.esc(String(c.created_at).slice(0, 16))}</span>` },
        { t: '结果', f: (c) => c.result === 'ok' ? '<span class="chip chip-ok">正常</span>' : '<span class="chip chip-danger">异常</span>' },
        { t: '点检人', k: 'checked_name' },
        { t: '说明', f: (c) => UI.esc(c.note || '—') },
        { t: '关联异常单', f: (c) => c.issue_code
            ? `<span class="chip ${lvChip[c.issue_level] ? lvChip[c.issue_level][1] : 'chip-gray'}">${UI.esc(c.issue_code)}</span>`
            : '—' },
      ], list)}</div>` : '<div class="muted" style="padding:18px 4px">暂无点检记录</div>',
      footer: '<button class="btn" data-close>关闭</button>',
    });
  },
};
