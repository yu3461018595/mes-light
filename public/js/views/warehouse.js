/* 物料仓储：库存台账 + 来料入库 + 成品入库 + 收发明细 + 物料档案
 * 对标市面小工单系统的库存闭环：单据 → 收发明细（流水）→ 库存台账 → 安全库存预警。
 * 台账与流水由单据自动生成，不允许手工修改；单据删除/修改会自动冲销并重算库存。 */
window.Views = window.Views || {};
Views.warehouse = {
  title: '物料仓储',
  icon: 'box',
  tab: 'stock',
  tabs: [
    ['stock', '库存台账'],
    ['incoming', '来料入库'],
    ['finished', '成品入库'],
    ['tx', '收发明细'],
    ['materials', '物料档案'],
    ['warehouses', '仓库'],
  ],

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
  // 收发明细类型
  TX_TYPE: {
    in_incoming: ['来料入库', 'chip-blue'],
    in_finish: ['成品入库', 'chip-ok'],
    out_pick: ['领料出库', 'chip-warn'],
    in_return: ['退料入库', 'chip-info'],
    out_ship: ['成品出库', 'chip-warn'],
    adjust: ['盘点调整', 'chip-gray'],
  },
  txChip(t) {
    const m = this.TX_TYPE[t] || [t || '—', 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },
  // 安全库存预警：低于下限=缺料，高于上限=积压（total 传入时按物料全部批次合计判定）
  alertOf(r, total) {
    const q = total === undefined ? (Number(r.qty) || 0) : Number(total) || 0;
    const mn = r.safe_min === null || r.safe_min === undefined ? null : Number(r.safe_min);
    const mx = r.safe_max === null || r.safe_max === undefined ? null : Number(r.safe_max);
    if (mn !== null && q < mn) return ['缺料预警', 'chip-danger', 'low'];
    if (mx !== null && mx > 0 && q > mx) return ['库存积压', 'chip-warn', 'high'];
    return ['正常', 'chip-ok', 'ok'];
  },
  alertChip(r) {
    const tot = this._tot ? this._tot[r.material_id] : undefined;
    const a = this.alertOf(r, tot);
    return `<span class="chip ${a[1]}">${a[0]}</span>`;
  },

  /* 各标签页配置：接口 + 列表列 + 表单字段 */
  conf() {
    const M = this.meta || {};
    const ordersOpts = () => [[null, '不关联']].concat((M.orders || []).map((o) => [o.id, o.code + ' ' + o.product_name]));
    const resultOpts = [['pending', '待检'], ['qualified', '合格'], ['rejected', '不合格']];
    const matOpts = () => [[null, '不关联物料（只记单据，不计库存）']]
      .concat((M.materials || []).filter((m) => m.active !== 0).map((m) => [m.id, m.code + ' ' + m.name]));
    const whOpts = () => [[null, '默认']].concat((M.warehouses || []).map((w) => [w.id, w.code + ' ' + w.name]));
    const CATS = ['原料', '半成品', '成品', '外协件'];

    return {
      // ---------------- 库存台账（只读，由流水汇总） ----------------
      stock: {
        api: '/inventory', name: '库存台账', readonly: true, export: true,
        cols: [
          { t: '物料编码', f: (r) => `<b>${UI.esc(r.material_code || '')}</b>` },
          { t: '物料名称', f: (r) => `${UI.esc(r.material_name || '')}${r.spec ? ` <span class="small muted">${UI.esc(r.spec)}</span>` : ''}` },
          { t: '分类', f: (r) => UI.esc(r.category || '—') },
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '库位', f: (r) => UI.esc(r.location || '—') },
          { t: '批次', f: (r) => UI.esc(r.batch || '—') },
          { t: '当前库存', align: 'right', f: (r) => `<b class="mono">${UI.n2(r.qty)}</b> ${UI.esc(r.unit || '')}` },
          { t: '安全库存', align: 'right', f: (r) => `<span class="muted">${r.safe_min == null ? '—' : UI.n2(r.safe_min)} ~ ${r.safe_max == null ? '—' : UI.n2(r.safe_max)}</span>` },
          { t: '状态', f: (r) => this.alertChip(r) },
          { t: '更新时间', f: (r) => `<span class="small muted">${UI.esc((r.updated_at || '').slice(0, 16).replace('T', ' '))}</span>` },
        ],
        fields: [],
      },

      // ---------------- 收发明细（只读流水） ----------------
      tx: {
        api: '/inventory_tx', name: '收发明细', readonly: true, export: true, noAdd: true,
        cols: [
          { t: '时间', f: (r) => `<span class="small">${UI.esc((r.created_at || '').slice(0, 16).replace('T', ' '))}</span>` },
          { t: '单据类型', f: (r) => this.txChip(r.tx_type) },
          { t: '物料', f: (r) => `${UI.esc(r.material_code || '')} ${UI.esc(r.material_name || '')}` },
          { t: '变动数量', align: 'right', f: (r) => `<b class="mono" style="color:${Number(r.qty) >= 0 ? 'var(--ok)' : 'var(--danger)'}">${Number(r.qty) >= 0 ? '+' : ''}${UI.n2(r.qty)}</b>` },
          { t: '变动前', align: 'right', f: (r) => `<span class="mono muted">${UI.n2(r.before_qty)}</span>` },
          { t: '变动后', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.after_qty)}</span>` },
          { t: '关联单据', f: (r) => UI.esc(r.ref_code || '—') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '操作人', f: (r) => UI.esc(r.operator || '—') },
          { t: '备注', f: (r) => `<span class="small muted">${UI.esc(r.remark || '')}</span>` },
        ],
        fields: [],
      },

      // ---------------- 来料入库 ----------------
      incoming: {
        api: '/incoming_materials', name: '来料入库',
        cols: [
          { t: '来料单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
          { t: '来料日期', f: (r) => UI.esc(r.incoming_date || '') },
          { t: '供应商', f: (r) => UI.esc(r.supplier || '—') },
          { t: '物料', f: (r) => `${UI.esc(r.material_name || '')}${r.material_spec ? ` <span class="small muted">${UI.esc(r.material_spec)}</span>` : ''}` },
          { t: '数量', f: (r) => `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit || '')}` },
          { t: '批次', f: (r) => UI.esc(r.batch || '—') },
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '检验结论', f: (r) => this.resChip(r.result) },
          { t: '检验员', f: (r) => UI.esc(r.inspector || '—') },
        ],
        fields: [
          { k: 'code', t: '来料单号', hint: '留空自动生成（LM+日期+序号）' },
          { k: 'incoming_date', t: '来料日期', type: 'date', def: UI.today() },
          { k: 'supplier', t: '供应商', list: 'supList', placeholder: '可输入或从下拉选择' },
          { k: 'material_id', t: '物料档案', type: 'select', opts: matOpts, hint: '选择后自动生成库存与收发明细' },
          { k: 'warehouse_id', t: '入库仓库', type: 'select', opts: whOpts },
          { k: 'material_code', t: '物料编码' },
          { k: 'material_name', t: '物料名称', req: 1 },
          { k: 'material_spec', t: '规格型号' },
          { k: 'qty', t: '来料数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批次/批号' },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts },
          { k: 'inspector', t: '检验员' },
          { k: 'result', t: '检验结论', type: 'select', opts: resultOpts, def: 'qualified', hint: '不合格不计入库存' },
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
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '库位', f: (r) => UI.esc(r.location || '—') },
          { t: '质检结果', f: (r) => this.resChip(r.result) },
          { t: '入库人', f: (r) => UI.esc(r.inspector || '—') },
        ],
        fields: [
          { k: 'code', t: '入库单号', hint: '留空自动生成（RK+日期+序号）' },
          { k: 'in_date', t: '入库日期', type: 'date', def: UI.today() },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts, hint: '选中工单可自动带出产品编码/名称/规格' },
          { k: 'material_id', t: '物料档案', type: 'select', opts: matOpts, hint: '选择后自动生成库存与收发明细' },
          { k: 'warehouse_id', t: '入库仓库', type: 'select', opts: whOpts },
          { k: 'product_code', t: '产品编码' },
          { k: 'product_name', t: '产品名称', req: 1 },
          { k: 'spec', t: '规格型号' },
          { k: 'qty', t: '入库数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批号' },
          { k: 'location', t: '库位' },
          { k: 'inspector', t: '入库人/质检员' },
          { k: 'result', t: '质检结果', type: 'select', opts: resultOpts, def: 'qualified', hint: '不合格不计入库存' },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 物料档案 ----------------
      materials: {
        api: '/materials', name: '物料档案',
        cols: [
          { t: '物料编码', f: (r) => `<b>${UI.esc(r.code || '')}</b>` },
          { t: '物料名称', f: (r) => `${UI.esc(r.name || '')}${r.spec ? ` <span class="small muted">${UI.esc(r.spec)}</span>` : ''}` },
          { t: '分类', f: (r) => UI.esc(r.category || '—') },
          { t: '材质', f: (r) => UI.esc(r.material || '—') },
          { t: '单位', f: (r) => UI.esc(r.unit || '') },
          { t: '默认仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '库位', f: (r) => UI.esc(r.location || '—') },
          { t: '安全下限', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.safe_min)}</span>` },
          { t: '安全上限', align: 'right', f: (r) => r.safe_max == null ? '<span class="muted">—</span>' : `<span class="mono">${UI.n2(r.safe_max)}</span>` },
          { t: '状态', f: (r) => (r.active === 0 ? '<span class="chip chip-gray">已停用</span>' : '<span class="chip chip-ok">启用</span>') },
        ],
        fields: [
          { k: 'code', t: '物料编码', req: 1 },
          { k: 'name', t: '物料名称', req: 1 },
          { k: 'category', t: '分类', type: 'select', opts: CATS.map((c) => [c, c]), def: '原料' },
          { k: 'spec', t: '规格型号' },
          { k: 'material', t: '材质' },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'warehouse_id', t: '默认仓库', type: 'select', opts: whOpts },
          { k: 'location', t: '默认库位' },
          { k: 'safe_min', t: '安全库存下限', type: 'number', def: 0, hint: '库存低于此值 → 缺料预警' },
          { k: 'safe_max', t: '安全库存上限', type: 'number', hint: '留空表示不限制；高于此值 → 积压提示' },
          { k: 'active', t: '状态', type: 'select', opts: [[1, '启用'], [0, '停用']], def: 1 },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 仓库 ----------------
      warehouses: {
        api: '/warehouses', name: '仓库',
        cols: [
          { t: '仓库编号', f: (r) => `<b>${UI.esc(r.code || '')}</b>` },
          { t: '仓库名称', f: (r) => UI.esc(r.name || '') },
          { t: '备注', f: (r) => `<span class="small muted">${UI.esc(r.remark || '—')}</span>` },
          { t: '创建时间', f: (r) => `<span class="small muted">${UI.esc((r.created_at || '').slice(0, 16).replace('T', ' '))}</span>` },
        ],
        fields: [
          { k: 'code', t: '仓库编号', req: 1, hint: '如 WH01' },
          { k: 'name', t: '仓库名称', req: 1 },
          { k: 'remark', t: '备注' },
        ],
      },
    };
  },

  async render(el) {
    try { this.meta = await API.get('/meta'); } catch (e) { this.meta = {}; }
    try { this.meta.orders = await API.get('/orders'); } catch (e) { this.meta.orders = []; }
    try { this.meta.materials = await API.get('/materials'); } catch (e) { this.meta.materials = []; }
    try { this.meta.warehouses = await API.get('/warehouses'); } catch (e) { this.meta.warehouses = []; }
    const canEdit = App.canEdit();
    const c = this.conf()[this.tab];
    const showAdd = canEdit && !c.noAdd && (c.fields || []).length > 0;
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card">
        <div class="card-h"><h3 id="tbTitle"></h3>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="tbStat" class="small muted"></span>
            ${c.export ? `<button class="btn btn-sm" id="exp">导出 CSV</button>` : ''}
            ${(this.tab === 'materials' && canEdit) ? `<button class="btn btn-sm" id="imp">从产品导入</button>` : ''}
            ${showAdd ? `<button class="btn btn-primary btn-sm" id="add">${UI.icon('plus')}新增</button>` : ''}
          </div>
        </div>
        <div class="card-b tight" id="tb">加载中…</div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    if (showAdd) el.querySelector('#add').onclick = () => this.form();
    if (c.export) el.querySelector('#exp').onclick = () => this.exportCsv(el);
    const imp = el.querySelector('#imp');
    if (imp) imp.onclick = async () => {
      try { const r = await API.post('/materials/import_products', {}); UI.toast(`已导入 ${r.imported} 条成品物料`, 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    };
    await this.loadTable(el);
  },

  async loadTable(el) {
    const c = this.conf()[this.tab];
    el.querySelector('#tbTitle').textContent = c.name;
    const rows = await API.get(c.api);
    this.rows = rows;
    const canEdit = App.canEdit();
    const stat = el.querySelector('#tbStat');
    if (this.tab === 'stock') {
      // 预警按「物料全部批次合计」判定，避免同物料多批次时误报
      const tot = {};
      rows.forEach((r) => { tot[r.material_id] = (tot[r.material_id] || 0) + (Number(r.qty) || 0); });
      this._tot = tot;
    } else { this._tot = null; }
    if (stat) {
      if (this.tab === 'stock') {
        const seen = {};
        const matRows = rows.filter((r) => (seen[r.material_id] ? false : (seen[r.material_id] = true)));
        const low = matRows.filter((r) => this.alertOf(r, this._tot[r.material_id])[2] === 'low').length;
        const high = matRows.filter((r) => this.alertOf(r, this._tot[r.material_id])[2] === 'high').length;
        stat.innerHTML = `共 ${rows.length} 条 · <span style="color:var(--danger)">缺料 ${low}</span> · <span style="color:var(--warn)">积压 ${high}</span>`;
      } else if (this.tab === 'tx') {
        stat.textContent = `共 ${rows.length} 条流水（自动生成，只读）`;
      } else {
        stat.textContent = `共 ${rows.length} 条`;
      }
    }
    const cols = c.cols.concat((canEdit && !c.readonly) ? [{
      t: '操作', align: 'right', w: '120px',
      f: (r) => `<button class="btn btn-sm" data-edit="${r.id}">编辑</button> <button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>`,
    }] : []);
    el.querySelector('#tb').innerHTML = UI.table(cols, rows);
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => this.form(b.dataset.edit));
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该记录？删除后不可恢复（关联的库存与流水会自动冲销）。'))) return;
      try { await API.del(c.api + '/' + b.dataset.del); UI.toast('已删除，库存已冲销', 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  exportCsv(el) {
    const c = this.conf()[this.tab];
    const rows = this.rows || [];
    const strip = (s) => String(s).replace(/<[^>]*>/g, '');
    const headers = c.cols.map((x) => x.t);
    const lines = [headers.join(',')].concat(rows.map((r) => c.cols.map((x) => {
      let v;
      try { v = strip(x.f(r)); } catch (e) { v = ''; }
      v = String(v).replace(/\s+/g, ' ').trim();
      return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${c.name}_${UI.today()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    UI.toast('已导出 CSV', 'ok');
  },

  async form(id) {
    const c = this.conf()[this.tab];
    const rows = await API.get(c.api);
    const row = id ? rows.find((r) => r.id == id) : {};
    const M = this.meta || {};

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

    const bind = (mask) => {
      // 选中关联工单后，自动带出产品编码/名称/规格（仅当对应字段为空时填充）
      if (this.tab === 'finished') {
        const osel = mask.querySelector('[data-k="order_id"]');
        if (osel) osel.addEventListener('change', async () => {
          const oid = osel.value;
          if (!oid) return;
          try {
            const o = await API.get('/orders/' + oid);
            const setIfEmpty = (k, val) => { const e2 = mask.querySelector(`[data-k="${k}"]`); if (e2 && !e2.value) e2.value = val || ''; };
            setIfEmpty('product_code', o.product_code);
            setIfEmpty('product_name', o.product_name);
            setIfEmpty('spec', o.spec);
            setIfEmpty('unit', o.unit || '件');
          } catch (e) { /* 忽略 */ }
        });
      }
      // 选中物料档案后，自动带出编码/名称/规格/单位/仓库
      const msel = mask.querySelector('[data-k="material_id"]');
      if (msel) msel.addEventListener('change', () => {
        const m = (M.materials || []).find((x) => String(x.id) === String(msel.value));
        if (!m) return;
        const setIfEmpty = (k, val) => { const e2 = mask.querySelector(`[data-k="${k}"]`); if (e2 && !e2.value) e2.value = val || ''; };
        setIfEmpty('material_code', m.code);
        setIfEmpty('product_code', m.code);
        setIfEmpty('material_name', m.name);
        setIfEmpty('product_name', m.name);
        setIfEmpty('material_spec', m.spec);
        setIfEmpty('spec', m.spec);
        const ue = mask.querySelector('[data-k="unit"]');
        if (ue && m.unit) ue.value = m.unit;
        const we = mask.querySelector('[data-k="warehouse_id"]');
        if (we && (!we.value || we.value === 'null') && m.warehouse_id) we.value = String(m.warehouse_id);
        const le = mask.querySelector('[data-k="location"]');
        if (le && !le.value && m.location) le.value = m.location;
      });
    };

    UI.modal({
      title: (id ? '编辑' : '新增') + c.name,
      size: 'lg',
      body,
      onMount: bind,
      onOk: async (mask) => {
        const payload = {};
        c.fields.forEach((f) => {
          const inp = mask.querySelector(`[data-k="${f.k}"]`);
          let v = inp ? inp.value : '';
          if (f.type === 'number') v = (v === '' || v === null) ? (f.k === 'safe_max' ? null : 0) : Number(v);
          if (f.k === 'order_id' || f.k === 'material_id' || f.k === 'warehouse_id') v = (v === '' || v === 'null' || v === null) ? null : Number(v);
          if (f.k === 'active') v = Number(v);
          if (f.req && (v === '' || v === null)) throw new Error('请填写「' + f.t + '」');
          payload[f.k] = v;
        });
        if ((this.tab === 'incoming' || this.tab === 'finished') && !payload.code) payload.code = (this.tab === 'incoming' ? 'LM' : 'RK') + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 900) + 100);
        if (id) await API.put(c.api + '/' + id, payload);
        else await API.post(c.api, payload);
        UI.toast('已保存', 'ok');
        Views.warehouse.render(document.getElementById('view'));
      },
    });
  },
};
