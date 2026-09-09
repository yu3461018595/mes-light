/* 物料仓储：来料记录（IQC）+ 成品入库
 * 对标市面小工单系统的「来料检验」与「成品入库」模块。 */
window.Views = window.Views || {};
Views.warehouse = {
  title: '物料仓储',
  icon: 'box',
  tab: 'incoming',
  tabs: [['incoming', '来料记录'], ['finished', '成品入库']],

  // 检验/质检结论样式
  RESULT: {
    pending: ['待检', 'chip-gray'],
    qualified: ['合格', 'chip-ok'],
    rejected: ['不合格', 'chip-danger'],
  },
  resChip(r) {
    const m = this.RESULT[r] || ['—', 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },

  /* 两个标签页的资源配置：接口 + 列表列 + 表单字段 */
  conf() {
    const M = this.meta;
    const ordersOpts = () => [[null, '不关联']].concat((M.orders || []).map((o) => [o.id, o.code + ' ' + o.product_name]));
    const resultOpts = [['pending', '待检'], ['qualified', '合格'], ['rejected', '不合格']];

    return {
      // ---------------- 来料记录 ----------------
      incoming: {
        api: '/incoming_materials', name: '来料记录',
        cols: [
          { t: '来料单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
          { t: '来料日期', f: (r) => UI.esc(r.incoming_date || '') },
          { t: '供应商', f: (r) => UI.esc(r.supplier || '—') },
          { t: '物料', f: (r) => `${UI.esc(r.material_name || '')}${r.material_spec ? ` <span class="small muted">${UI.esc(r.material_spec)}</span>` : ''}` },
          { t: '数量', f: (r) => `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit || '')}` },
          { t: '批次', f: (r) => UI.esc(r.batch || '—') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '检验结论', f: (r) => this.resChip(r.result) },
          { t: '检验员', f: (r) => UI.esc(r.inspector || '—') },
        ],
        fields: [
          { k: 'code', t: '来料单号', hint: '留空自动生成（LM+日期+序号）' },
          { k: 'incoming_date', t: '来料日期', type: 'date', def: UI.today() },
          { k: 'supplier', t: '供应商', list: 'supList', placeholder: '可输入或从下拉选择' },
          { k: 'material_code', t: '物料编码' },
          { k: 'material_name', t: '物料名称', req: 1 },
          { k: 'material_spec', t: '规格型号' },
          { k: 'qty', t: '数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批次/批号' },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts },
          { k: 'inspector', t: '检验员' },
          { k: 'result', t: '检验结论', type: 'select', opts: resultOpts, def: 'pending' },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 成品入库 ----------------
      finished: {
        api: '/finished_goods_in', name: '成品入库',
        cols: [
          { t: '入库单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
          { t: '入库日期', f: (r) => UI.esc(r.in_date || '') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '产品', f: (r) => `${UI.esc(r.product_name || '')}${r.spec ? ` <span class="small muted">${UI.esc(r.spec)}</span>` : ''}` },
          { t: '入库数量', f: (r) => `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit || '')}` },
          { t: '批号', f: (r) => UI.esc(r.batch || '—') },
          { t: '库位', f: (r) => UI.esc(r.location || '—') },
          { t: '质检结果', f: (r) => this.resChip(r.result) },
          { t: '入库人', f: (r) => UI.esc(r.inspector || '—') },
        ],
        fields: [
          { k: 'code', t: '入库单号', hint: '留空自动生成（RK+日期+序号）' },
          { k: 'in_date', t: '入库日期', type: 'date', def: UI.today() },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts, hint: '选中工单可自动带出产品编码/名称/规格' },
          { k: 'product_code', t: '产品编码' },
          { k: 'product_name', t: '产品名称', req: 1 },
          { k: 'spec', t: '规格型号' },
          { k: 'qty', t: '入库数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批号' },
          { k: 'location', t: '库位' },
          { k: 'inspector', t: '入库人/质检员' },
          { k: 'result', t: '质检结果', type: 'select', opts: resultOpts, def: 'pending' },
          { k: 'remark', t: '备注' },
        ],
      },
    };
  },

  async render(el) {
    this.meta = await API.get('/meta');
    this.meta.orders = await API.get('/orders');
    const canEdit = App.canEdit();
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card">
        <div class="card-h"><h3 id="tbTitle"></h3>
          ${canEdit ? `<button class="btn btn-primary btn-sm" id="add">${UI.icon('plus')}新增</button>` : ''}
        </div>
        <div class="card-b tight" id="tb">加载中…</div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    if (canEdit) el.querySelector('#add').onclick = () => this.form();
    await this.loadTable(el);
  },

  async loadTable(el) {
    const c = this.conf()[this.tab];
    el.querySelector('#tbTitle').textContent = c.name + '列表';
    const rows = await API.get(c.api);
    const canEdit = App.canEdit();
    el.querySelector('#tb').innerHTML = UI.table(
      c.cols.concat(canEdit ? [{
        t: '操作', align: 'right', w: '120px',
        f: (r) => `<button class="btn btn-sm" data-edit="${r.id}">编辑</button> <button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>`,
      }] : []), rows);
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => this.form(b.dataset.edit));
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该记录？删除后不可恢复。'))) return;
      try { await API.del(c.api + '/' + b.dataset.del); UI.toast('已删除', 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  async form(id) {
    const c = this.conf()[this.tab];
    const rows = await API.get(c.api);
    const row = id ? rows.find((r) => r.id == id) : {};
    const M = this.meta;

    const body = `<div class="grid g2">` + c.fields.map((f) => {
      const v = (row[f.k] === undefined || row[f.k] === null) ? (f.def === undefined ? '' : f.def) : row[f.k];
      if (f.type === 'select') {
        const opts = typeof f.opts === 'function' ? f.opts() : f.opts;
        return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
          <select class="input" data-k="${f.k}">${UI.options(opts.map(([val, lb]) => ({ id: val, name: lb })), v, 'name')}</select>
          ${f.hint ? `<span class="small muted">${UI.esc(f.hint)}</span>` : ''}</label>`;
      }
      if (f.type === 'date') {
        return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
          <input class="input" data-k="${f.k}" type="date" value="${UI.esc(v)}" ${f.req ? 'required' : ''}></label>`;
      }
      if (f.list) {
        const list = (f.list === 'supList' ? (M.customers || []) : []).map((s) => `<option value="${UI.esc(s.name)}">`).join('');
        return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
          <input class="input" data-k="${f.k}" list="${f.list}" value="${UI.esc(v)}" ${f.req ? 'required' : ''} placeholder="${f.placeholder || ''}">
          <datalist id="${f.list}">${list}</datalist></label>`;
      }
      return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
        <input class="input" data-k="${f.k}" type="${f.type === 'number' ? 'number' : 'text'}" value="${UI.esc(v)}" ${f.req ? 'required' : ''} ${f.type === 'number' ? 'step="0.01"' : ''}>
        ${f.hint ? `<span class="small muted">${UI.esc(f.hint)}</span>` : ''}</label>`;
    }).join('') + `</div>`;

    // 选中关联工单后，自动带出产品编码/名称/规格（仅当对应字段为空时填充）
    const bindOrder = (mask) => {
      if (this.tab !== 'finished') return;
      const osel = mask.querySelector('[data-k="order_id"]');
      if (!osel) return;
      osel.addEventListener('change', async () => {
        const oid = osel.value;
        if (!oid) return;
        try {
          const o = await API.get('/orders/' + oid);
          const setIfEmpty = (k, val) => { const el = mask.querySelector(`[data-k="${k}"]`); if (el && !el.value) el.value = val || ''; };
          setIfEmpty('product_code', o.product_code);
          setIfEmpty('product_name', o.product_name);
          setIfEmpty('spec', o.spec);
          setIfEmpty('unit', o.unit || '件');
        } catch (e) { /* 忽略 */ }
      });
    };

    UI.modal({
      title: (id ? '编辑' : '新增') + c.name,
      size: 'lg',
      body,
      onMount: (mask) => bindOrder(mask),
      onOk: async (mask) => {
        const payload = {};
        c.fields.forEach((f) => {
          const inp = mask.querySelector(`[data-k="${f.k}"]`);
          let v = inp ? inp.value : '';
          if (f.type === 'number') v = (v === '' || v === null) ? 0 : Number(v);
          if (f.k === 'order_id') v = (v === '' || v === 'null' || v === null) ? null : Number(v);
          if (f.req && (v === '' || v === null)) throw new Error('请填写「' + f.t + '」');
          payload[f.k] = v;
        });
        if (!payload.code) payload.code = (this.tab === 'incoming' ? 'LM' : 'RK') + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 900) + 100);
        if (id) await API.put(c.api + '/' + id, payload);
        else await API.post(c.api, payload);
        UI.toast('已保存', 'ok');
        Views.warehouse.render(document.getElementById('view'));
      },
    });
  },
};
