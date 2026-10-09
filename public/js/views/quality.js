/* 质量：待检队列（质检台）+ 质量异常单 + 检验记录 + 质量看板 + 通知设置
 * 一期「初版检验模式」前端入口：
 *   工序档案标记检验点（inspect_type）→ 报工后落待检 → 质检员判定 →
 *   合格/让步放行（末道自动入库）｜不合格自动开异常单并推送给责任管理人员跟踪闭环。
 * 三级页面：quality（列表/判定）、quality/issue/<id>（异常单详情处理）。 */
window.Views = window.Views || {};

Views.quality = {
  title: '质量',
  icon: 'check',
  tab: 'pending',

  INSPECT_LABEL: { iqc: '首检', ipqc: '过程检', fqc: '终检' },
  LEVEL: { pending: ['待定级', 'chip-gray'], minor: ['轻微', 'chip-minor'], major: ['严重', 'chip-major'], critical: ['致命', 'chip-critical'] },
  ISSUE_STATUS: {
    open: ['待认领', 'chip-danger'], processing: ['处理中', 'chip-warn'],
    verifying: ['待验证', 'chip-info'], closed: ['已闭环', 'chip-ok'], cancelled: ['已作废', 'chip-gray'],
  },
  CONCLUSION: { pass: ['合格', 'chip-ok'], fail: ['不合格', 'chip-danger'], concession: ['让步接收', 'chip-warn'] },
  DISPOSITION: { rework: '返工', repair: '返修', concession: '让步接收', scrap: '报废' },
  RESULT: { pending: ['待检', 'chip-gray'], qualified: ['合格', 'chip-ok'], rejected: ['不合格', 'chip-danger'] },
  resChip(r) { const m = this.RESULT[r] || [r || '—', 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; },

  levelChip(l) { const m = this.LEVEL[l] || [l || '—', 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; },
  statusChip(s) { const m = this.ISSUE_STATUS[s] || [s || '—', 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; },
  concChip(c) { const m = this.CONCLUSION[c] || [c || '—', 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; },
  // 工序行的检验标记
  inspectMark(r) {
    const t = String(r.inspect_type || '').trim();
    if (!t) return '<span class="muted small">—</span>';
    const name = this.INSPECT_LABEL[t] || t;
    const st = String(r.inspect_status || '').trim();
    if (st === 'waiting') return `<span class="ins-mark waiting" title="报工完成，等待质检判定">${name}·待检</span>`;
    if (st === 'failed') return `<span class="ins-mark failed" title="检验不合格，返修后重新报工送检；重大异常已开单">${name}·不合格</span>`;
    if (st === 'passed') return `<span class="ins-mark passed" title="检验已放行">${name}·已放行</span>`;
    return `<span class="ins-mark" title="该工序为检验点">${name}</span>`;
  },
  // 是否可判定（待检状态）
  isWaiting(r) { return String(r.inspect_status || '') === 'waiting'; },

  /* ------------------------------ 列表页 ------------------------------ */
  async render(el, sub) {
    if (sub === 'issue') {
      const id = (arguments[2] || location.hash.split('/')[3] || '').replace(/\D/g, '');
      return this.renderIssue(el, id);
    }
    if (sub === 'rec') return this.renderRecord(el, arguments[2]);
    try { this.meta = await API.get('/meta'); } catch (e) { this.meta = {}; }
    const noEdit = !App.canEdit();
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs().map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div id="qbody">加载中…</div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    const body = el.querySelector('#qbody');
    try {
      if (this.tab === 'pending') await this.renderPending(body);
      else if (this.tab === 'incoming') await this.renderIncoming(body);
      else if (this.tab === 'issues') await this.renderIssues(body);
      else if (this.tab === 'patrols') await this.renderPatrols(body);
      else if (this.tab === 'records') await this.renderRecords(body);
      else if (this.tab === 'dash') await this.renderDash(body);
      else if (this.tab === 'setup') await this.renderSetup(body);
    } catch (e) {
      body.innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`;
    }
  },

  tabs() {
    const t = [['pending', '待检队列'], ['incoming', '来料检验'], ['issues', '质量异常单'], ['patrols', '巡检记录'], ['records', '检验记录'], ['dash', '质量看板']];
    if (App.user && ['admin', 'technician'].includes(App.user.role)) t.push(['setup', '检验设置']);
    return t;
  },

  /* ---------------- 待检队列（质检台） ---------------- */
  async renderPending(el) {
    const rows = await API.get('/inspections/pending');
    this.pending = rows;
    if (!rows.length) {
      el.innerHTML = `<div class="card"><div class="card-b">
        <div class="empty">${UI.icon('check')}<div>当前没有待检工序，产线很顺畅 👍</div></div></div></div>`;
      return;
    }
    let badReasons = [];
    try { badReasons = await API.get('/bad_reasons'); } catch (e) { /* 忽略 */ }
    this.badReasons = badReasons;

    el.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>待检队列</h3>
          <span class="small muted">共 <b style="color:var(--warn)">${rows.length}</b> 道工序待判定 · 合格自动放行；重大异常自动开单并上报管理层</span>
          <div class="spacer"></div>
          <button class="btn btn-sm" id="refresh">刷新</button></div>
        <div class="card-b" id="insps">
          ${rows.map((r) => this.pendingCard(r, badReasons)).join('')}
        </div>
      </div>`;
    el.querySelector('#refresh').onclick = () => this.render(document.getElementById('view'));
    el.querySelectorAll('[data-judge]').forEach((b) => b.onclick = () => this.judge(b.dataset.judge));
    // 检验方式切换：抽检显示样本数；检查表 NG 项显示数量输入
    el.querySelectorAll('[data-k="inspect_mode"]').forEach((sel) => sel.onchange = () => {
      const card = sel.closest('.insp-step');
      const wrap = card && card.querySelector('[data-sample-wrap]');
      if (wrap) wrap.hidden = sel.value !== 'sample';
    });
    el.querySelectorAll('.cl-item select[data-cres]').forEach((sel) => sel.onchange = () => {
      const q = sel.closest('.cl-item').querySelector('[data-cqty]');
      if (q) q.hidden = sel.value !== 'ng';
    });
  },

  pendingCard(r, badReasons) {
    const isFinal = String(r.inspect_type) === 'fqc';
    const qty = Number(r.qty_good) || 0;
    const bad = Number(r.qty_bad) || 0;
    const cl = Array.isArray(r.checklist) ? r.checklist : [];
    return `<div class="insp-step ${isFinal ? 'crit' : ''}" id="insp${r.order_step_id}">
      <h4>${UI.esc(r.order_code)} · 第 ${r.seq_no || r.seq} 道 <b>${UI.esc(r.process_name)}</b>
        <span class="ins-mark ${isFinal ? 'failed' : ''}">${this.INSPECT_LABEL[r.inspect_type] || '检验'}</span>
        ${isFinal ? '<span class="chip chip-danger">终检</span>' : ''}</h4>
      <div class="small muted">
        产品 ${UI.esc(r.product_name || '—')} · 计划 ${UI.n2(r.qty_plan)} 件 ·
        工序累计合格 <b>${UI.n2(qty)}</b>${bad ? ` / 自报不良 <span style="color:var(--danger)">${UI.n2(bad)}</span>` : ''} ·
        指派班组 ${UI.esc(r.assignee_team || '暂无')} · 最近报工人 ${UI.esc(r.last_worker || '—')}
      </div>
      <div class="insp-grid">
        <label class="field" style="margin:0"><span>检验方式</span>
          <select class="input" data-k="inspect_mode">
            <option value="full">全检</option>
            <option value="sample">抽检</option>
          </select></label>
        <label class="field" style="margin:0" data-sample-wrap hidden><span>样本数</span>
          <input class="input" type="number" min="1" data-k="sample_qty" value="${qty}"></label>
        <label class="field" style="margin:0"><span>本次受检数</span>
          <input class="input" type="number" min="0" data-k="qty_pass" value="${qty}" readonly></label>
        <label class="field" style="margin:0"><span>不合格数</span>
          <input class="input" type="number" min="0" data-k="qty_fail" value="0" placeholder="0"></label>
        <label class="field" style="margin:0"><span>判定结论</span>
          <select class="input" data-k="conclusion">
            <option value="pass">合格放行</option>
            <option value="fail">不合格</option>
            <option value="concession">让步接收（特采放行）</option>
          </select></label>
      </div>
      ${cl.length ? `<div class="field" style="margin:0 0 10px"><span>检验项目（模板：${UI.esc(r.checklist_name || '默认')} · NG 项自动计入不良）</span>
        <div class="cl-rows">${cl.map((it, i) => `<div class="row cl-item" data-ci="${i}" data-cname="${UI.esc(it.name)}" data-cstd="${UI.esc(it.standard || '')}" style="gap:8px;align-items:center;flex-wrap:nowrap;margin:4px 0">
          <span style="flex:1;min-width:120px">${UI.esc(it.name)}${it.standard ? `<span class="small muted" style="margin-left:6px">${UI.esc(it.standard)}</span>` : ''}</span>
          <select class="input" data-cres style="width:88px;margin:0">
            <option value="skip">未检</option><option value="ok">OK</option><option value="ng">NG</option>
          </select>
          <input class="input" type="number" min="0" data-cqty placeholder="NG数" style="width:76px;margin:0" hidden>
        </div>`).join('')}</div></div>` : ''}
      <div class="field" style="margin:0 0 10px"><span>不良明细（可多种：选原因 + 数量，选「其他」需填说明）</span>
        <div class="badrows" data-rows="${r.order_step_id}"></div></div>
      <label class="field" style="margin:0 0 10px"><span>检验备注</span>
        <input class="input" data-k="remark" placeholder="如：抽检 20 件，外观合格"></label>
      <div class="row">
        <button class="btn btn-primary" data-judge="${r.order_step_id}">提交判定</button>
        <span class="small muted">提交后：合格/让步 → 放行完工${isFinal ? '（末道同时自动成品入库）' : ''}；不合格 → 工序转待返工，返修后重新报工送检；重大异常（终检不合格或不良率超阈值）自动开单并逐级上报管理层。</span>
      </div>
    </div>`;
  },

  /* ---------------- 来料检验（IQC） ---------------- */
  async renderIncoming(el) {
    const [rows, sup, cfg] = await Promise.all([
      API.get('/incoming_materials'),
      API.get('/stats/supplier_quality').catch(() => []),
      API.get('/quality/settings').catch(() => ({})),
    ]);
    this.settings = cfg;
    const pending = rows.filter((r) => r.result === 'pending');
    const done = rows.filter((r) => r.result !== 'pending').slice(0, 20);
    el.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>来料待检</h3>
          <span class="small muted">共 <b style="color:var(--warn)">${pending.length}</b> 单待判定 · 待检来料暂不计库存，合格判定后自动入库</span>
          <div class="spacer"></div>
          <a class="link small" href="#/warehouse" onclick="sessionStorage.setItem('wh_tab','incoming')">去仓储录来料 →</a></div>
        <div class="card-b" id="iqcList">
          ${pending.length ? pending.map((r) => `<div class="insp-step" id="iqc${r.id}">
            <h4>${UI.esc(r.code || '—')} · <b>${UI.esc(r.material_name || '')}</b>
              <span class="ins-mark waiting">待检</span></h4>
            <div class="small muted">
              供应商 ${UI.esc(r.supplier || '—')} · 数量 <b>${UI.n2(r.qty)}</b> ${UI.esc(r.unit || '')}
              ${r.batch ? ' · 批次 ' + UI.esc(r.batch) : ''} · 来料日期 ${UI.esc((r.incoming_date || '').slice(0, 10))}
              ${r.order_code ? ' · 关联工单 ' + UI.esc(r.order_code) : ''}
            </div>
            <div class="insp-grid">
              <label class="field" style="margin:0"><span>不合格数</span>
                <input class="input" type="number" min="0" max="${r.qty}" data-k="qty_fail" value="0" placeholder="0"></label>
              <label class="field" style="margin:0"><span>判定结论</span>
                <select class="input" data-k="conclusion">
                  <option value="pass">合格入库</option>
                  <option value="concession">让步接收（特采入库）</option>
                  <option value="fail">不合格（退货处理）</option>
                </select></label>
              <label class="field" style="margin:0"><span>备注</span>
                <input class="input" data-k="remark" placeholder="如：抽检合格 / 尺寸超差"></label>
            </div>
            <div class="row"><button class="btn btn-primary" data-iqc="${r.id}">提交判定</button>
              <span class="small muted">合格/让步 → 整单自动入库；不合格 → 不入库并自动开质量异常单（含供应商留痕）。</span></div>
          </div>`).join('') : `<div class="empty">${UI.icon('check')}<div>没有待检来料，去「仓储 → 来料入库」录入（结论选「待检」）</div></div>`}
        </div>
      </div>

      <div class="grid" style="grid-template-columns:1.2fr 1fr;margin-bottom:14px">
        <div class="card">
          <div class="card-h"><h3>供应商来料质量</h3><span class="small muted">按来料数量排序 · 合格率=合格÷已检</span></div>
          <div class="card-b tight">
            ${UI.table([
              { t: '供应商', f: (r) => UI.esc(r.name || '—') },
              { t: '来料', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.total)}</span>` },
              { t: '合格', align: 'right', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.qualified)}</span>` },
              { t: '不合格', align: 'right', f: (r) => `<span class="mono" style="color:var(--danger)">${UI.n2(r.rejected)}</span>` },
              { t: '待检', align: 'right', f: (r) => `<span class="mono muted">${UI.n2(r.pending)}</span>` },
              { t: '合格率', align: 'right', f: (r) => r.pass_rate == null
                  ? '<span class="muted">—</span>'
                  : `<b class="mono" style="color:${r.pass_rate < 0.9 ? 'var(--danger)' : r.pass_rate < 0.98 ? 'var(--warn)' : 'var(--ok)'}">${UI.f1(r.pass_rate * 100)}%</b>` },
            ], sup, { emptyText: '暂无来料数据' })}
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h3>最近判定</h3></div>
          <div class="card-b tight">
            ${UI.table([
              { t: '单号', f: (r) => UI.esc(r.code || '—') },
              { t: '物料', f: (r) => UI.esc(r.material_name || '—') },
              { t: '供应商', f: (r) => UI.esc(r.supplier || '—') },
              { t: '结论', f: (r) => this.resChip(r.result) },
              { t: '检验员', f: (r) => UI.esc(r.inspector || '—') },
              { t: '时间', f: (r) => `<span class="small muted">${UI.esc((r.updated_at || r.created_at || '').slice(5, 16))}</span>` },
            ], done, { emptyText: '暂无判定记录' })}
          </div>
        </div>
      </div>`;
    el.querySelectorAll('[data-iqc]').forEach((b) => b.onclick = async () => {
      const card = document.getElementById('iqc' + b.dataset.iqc);
      if (!card) return;
      const g = (k) => { const e2 = card.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
      const qtyFail = Number(g('qty_fail')) || 0;
      const conclusion = g('conclusion');
      if (conclusion === 'pass' && qtyFail > 0) return UI.toast('判定合格时不合格数必须为 0', 'err');
      if (conclusion !== 'pass' && qtyFail <= 0) return UI.toast('判定不合格/让步接收时须填写不合格数', 'err');
      const label = conclusion === 'pass' ? '合格入库' : conclusion === 'concession' ? '让步接收（特采入库）' : '不合格（退货处理）';
      if (!confirm(`来料判定「${label}」：不合格 ${qtyFail} 件。${conclusion === 'fail' ? '将不开库存并自动开质量异常单。' : '整单自动入库。'}确定提交？`)) return;
      try {
        const r = await API.post('/incoming_inspections', { id: Number(b.dataset.iqc), conclusion, qty_fail: qtyFail, remark: g('remark') });
        UI.toast('判定已提交' + (r.issue ? `，已生成异常单 ${r.issue.code}` : ''), 'ok');
        this.render(el.closest('#qbody') ? document.getElementById('view') : el);
      } catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  /* ---------------- 异常单列表 ---------------- */
  async renderIssues(el) {
    const [rows, stat] = await Promise.all([
      API.get('/quality_issues'),
      API.get('/stats/quality').catch(() => ({})),
    ]);
    this.issues = rows;
    const open = rows.filter((r) => ['open', 'processing', 'verifying'].includes(r.status));
    const crit = open.filter((r) => r.level === 'critical');
    const mine = open.filter((r) => App.user && r.assignee_user_id === App.user.id);

    el.innerHTML = `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--danger)"></i>未闭环异常</div>
          <div class="stat-v" style="color:${open.length ? 'var(--danger)' : 'var(--ok)'}">${open.length}</div>
          <div class="stat-s">待认领 ${open.filter((r) => r.status === 'open').length} · 处理中 ${open.filter((r) => r.status === 'processing').length} · 待验证 ${open.filter((r) => r.status === 'verifying').length}</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--danger)"></i>致命异常</div>
          <div class="stat-v" style="color:${crit.length ? 'var(--danger)' : 'inherit'}">${crit.length}</div>
          <div class="stat-s">会暂停工单后续流转并禁止入库</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--warn)"></i>指派给我</div>
          <div class="stat-v" style="color:var(--warn)">${mine.length}</div>
          <div class="stat-s">按工序指派班组的技术员定责</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--ok)"></i>已闭环</div>
          <div class="stat-v" style="color:var(--ok)">${stat.total_closed || 0}</div>
          <div class="stat-s">平均响应 ${stat.avg_claim_minutes == null ? '—' : stat.avg_claim_minutes + ' 分钟'}</div></div>
      </div>

      <div class="card">
        <div class="card-h"><h3>质量异常单</h3>
          <div style="display:flex;gap:8px;align-items:center">
            <label class="small muted" style="display:flex;gap:4px;align-items:center;cursor:pointer">
              <input type="checkbox" id="onlyOpen" checked> 仅未闭环</label>
            <button class="btn btn-sm" id="exp">导出 CSV</button>
            ${App.canEdit() ? `<button class="btn btn-sm btn-primary" id="newIssue">${UI.icon('plus')}上报异常</button>` : ''}
          </div></div>
        <div class="card-b tight" id="ilist"></div>
      </div>`;
    const paint = () => {
      const onlyOpen = el.querySelector('#onlyOpen').checked;
      const list = onlyOpen ? open : rows;
      el.querySelector('#ilist').innerHTML = UI.table([
        { t: '异常单号', f: (r) => `<b class="link" data-open="${r.id}">${UI.esc(r.code)}</b>` },
        { t: '等级', f: (r) => this.levelChip(r.level) },
        { t: '状态', f: (r) => this.statusChip(r.status) + (r.escalated ? ' <span class="chip chip-danger">已升级</span>' : '') },
        { t: '工单/产品', f: (r) => `<div>${UI.esc(r.order_code || '—')}</div><div class="small muted">${UI.esc(r.product_name || '')}</div>` },
        { t: '工序', f: (r) => UI.esc(r.process_name || '—') },
        { t: '影响数量', align: 'right', f: (r) => `<b class="mono" style="color:var(--danger)">${UI.n2(r.qty_affected)}</b>` },
        { t: '不良原因', f: (r) => `<span class="small">${UI.esc(r.bad_summary || '—')}</span>` },
        { t: '责任人', f: (r) => UI.esc(r.assignee_name || '未指派') },
        { t: '发现时间', f: (r) => `<span class="small muted">${UI.esc((r.created_at || '').slice(5, 16))}</span>` },
        { t: '操作', align: 'right', f: (r) => `<button class="btn btn-sm" data-open="${r.id}">${['closed', 'cancelled'].includes(r.status) ? '查看' : '处理'}</button>` },
      ], list, { emptyText: '没有符合条件的异常单' });
      el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => location.hash = '#/quality/issue/' + b.dataset.open);
    };
    paint();
    el.querySelector('#onlyOpen').onchange = paint;
    el.querySelector('#exp').onclick = () => this.exportIssues();
    const ni = el.querySelector('#newIssue');
    if (ni) ni.onclick = () => this.newIssueForm();
  },

  exportIssues() {
    const cols = ['异常单号', '等级', '状态', '来源', '工单', '产品', '工序', '影响数量', '不良原因', '责任人', '已升级', '原因分析', '处理措施', '处置方式', '报废数量', '损失金额', '验证人', '发现时间', '关闭时间'];
    const lines = [cols.join(',')];
    (this.issues || []).forEach((r) => lines.push([
      r.code, (this.LEVEL[r.level] || [r.level])[0], (this.ISSUE_STATUS[r.status] || [r.status])[0],
      r.source, r.order_code || '', r.product_name || '', r.process_name || '', r.qty_affected,
      r.bad_summary || '', r.assignee_name || '', r.escalated ? '是' : '否',
      r.cause || '', r.action || '', this.DISPOSITION[r.disposition] || '',
      r.loss_qty != null ? r.loss_qty : '', r.loss_amount != null ? r.loss_amount : '',
      r.verifier || '', r.created_at || '', r.closed_at || '',
    ].map((v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `质量异常单_${UI.today()}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    UI.toast('已导出 CSV', 'ok');
  },

  // 自主上报异常（报工环节发现的问题，不一定来自检验）
  async newIssueForm() {
    let orders = [];
    try { orders = await API.get('/orders'); } catch (e) { /* 忽略 */ }
    try { this.badReasons = await API.get('/bad_reasons'); } catch (e) { this.badReasons = []; }
    const isInsp = !!(App.user && App.user.role === 'inspector');
    const opts = [[null, '不关联工单']].concat(orders.slice(0, 100).map((o) => [o.id, o.code + ' ' + (o.product_name || '')]));
    UI.modal({
      title: '上报质量异常',
      size: 'lg',
      body: `<div class="grid g2">
        <label class="field"><span>关联工单</span><select class="input" data-k="order_id">${UI.options(opts.map(([id, n]) => ({ id, name: n })), null, 'name')}</select></label>
        ${isInsp
          ? `<label class="field"><span>异常等级</span><select class="input" data-k="level"><option value="major">严重</option><option value="minor">轻微</option><option value="critical">致命</option></select></label>`
          : `<label class="field"><span>严重程度（申报）</span><select class="input" data-k="level"><option value="minor">轻微</option><option value="major">严重</option><option value="critical">致命</option></select></label>`}
        <label class="field"><span>工序 / 环节</span><input class="input" data-k="process_name" placeholder="如：车削 / 来料 / 装配"></label>
        <label class="field"><span>影响数量</span><input class="input" type="number" min="0" data-k="qty_affected" value="0"></label>
      </div>
      <label class="field"><span>问题描述 <b style="color:var(--danger)">*</b></span>
        <input class="input" data-k="bad_summary" placeholder="如：来料圆钢表面锈蚀，影响下料质量"></label>
      <p class="small muted" style="margin-top:6px">${isInsp
        ? '提示：严重程度由你判定；上报将同步通知责任处理人与厂部管理层，致命级额外升级（群通知）。'
        : '提示：上报仅留存记录与统计，正式等级由检验员判定；申报「严重/致命」会通知检验员及时定级。'}</p>`,
      onOk: async (mask) => {
        const g = (k) => { const e2 = mask.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
        if (!g('bad_summary').trim()) throw new Error('请填写问题描述');
        await API.post('/quality_issues', {
          order_id: g('order_id') ? Number(g('order_id')) : null,
          source: 'report', level: g('level') || (isInsp ? 'major' : 'minor'),
          process_name: g('process_name'), qty_affected: Number(g('qty_affected')) || 0,
          bad_summary: g('bad_summary').trim(),
        });
        const lv = g('level');
        UI.toast(isInsp
          ? (lv === 'critical' ? '异常已上报，已通知责任人与厂部管理层（致命级已升级群通知）' : '异常已上报，已通知责任人与厂部管理层')
          : (lv === 'minor' ? '异常已上报（仅留存记录）' : '重大异常已上报，已通知检验员定级'), 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  /* ---------------- 检验记录 ---------------- */
  /* ---------------- 巡检记录（现场巡查留痕，异常联动异常单） ---------------- */
  async renderPatrols(el) {
    const days = this.patrolDays || 7;
    const [rows, stats] = await Promise.all([
      API.get('/patrols?days=' + days + (this.patrolResult ? '&result=' + this.patrolResult : '')),
      API.get('/stats/patrol').catch(() => null),
    ]);
    const st = stats || { today: { total: 0, abnormal: 0 }, week: { total: 0, abnormal: 0, rate: 0, inspectors: 0 }, by_user: [] };
    el.innerHTML = `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="stat-l">今日巡检</div><div class="stat-v" style="color:var(--primary)">${UI.n2(st.today.total)}</div>
          <div class="stat-s">异常检出 ${UI.n2(st.today.abnormal)} 次</div></div>
        <div class="stat"><div class="stat-l">近 7 天巡检</div><div class="stat-v">${UI.n2(st.week.total)}</div>
          <div class="stat-s">${st.week.inspectors} 人参与巡查</div></div>
        <div class="stat"><div class="stat-l">异常检出率</div><div class="stat-v" style="color:${st.week.rate > 30 ? 'var(--warn)' : 'var(--ok)'}">${UI.f1(st.week.rate)}%</div>
          <div class="stat-s">异常 ${UI.n2(st.week.abnormal)} / 巡检 ${UI.n2(st.week.total)}</div></div>
        <div class="stat"><div class="stat-l">巡查人员排行</div><div class="stat-v small" style="font-size:15px;line-height:1.5;padding-top:4px">
          ${(st.by_user || []).slice(0, 3).map((x) => `${UI.esc(x.name)} ${x.total}次`).join('<br>') || '<span class="muted">暂无</span>'}</div></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>巡检明细</h3>
          <span class="small muted">巡检为主动过程抽查，不占用报工待检队列；异常可一键生成质量异常单</span>
          <div class="spacer"></div>
          <select class="input" id="ptDays" style="width:110px">
            <option value="7" ${days === 7 ? 'selected' : ''}>近 7 天</option>
            <option value="30" ${days === 30 ? 'selected' : ''}>近 30 天</option>
            <option value="90" ${days === 90 ? 'selected' : ''}>近 90 天</option>
          </select>
          <select class="input" id="ptResult" style="width:100px">
            <option value="">全部结果</option>
            <option value="normal" ${this.patrolResult === 'normal' ? 'selected' : ''}>正常</option>
            <option value="abnormal" ${this.patrolResult === 'abnormal' ? 'selected' : ''}>异常</option>
          </select>
        </div>
        <div class="card-b">
          ${rows.length ? UI.table([
            { t: '单号', f: (r) => `<span class="mono small">${UI.esc(r.code)}</span>` },
            { t: '时间', f: (r) => `<span class="small">${UI.esc(String(r.created_at).slice(5, 16))}</span>` },
            { t: '巡检人', f: (r) => UI.esc(r.inspector_name || '—') },
            { t: '工单/工序', f: (r) => `<b>${UI.esc(r.order_code || '—')}</b>${r.step_name ? ` · 第 ${r.step_seq} 道 ${UI.esc(r.step_name)}` : ' · 整单巡查'}` },
            { t: '结果', f: (r) => r.result === 'abnormal' ? '<span class="chip chip-danger">异常</span>' : '<span class="chip chip-ok">正常</span>' },
            { t: '抽检/不良', f: (r) => r.qty_checked || r.qty_bad ? `<span class="mono">${UI.n2(r.qty_checked)}</span> / <span class="mono" style="color:var(--danger)">${UI.n2(r.qty_bad)}</span>` : '<span class="muted">—</span>' },
            { t: '描述', f: (r) => `<span class="small">${UI.esc(r.findings || '—')}</span>` },
            { t: '照片', f: (r) => (r.photos || []).length ? (r.photos || []).map((p) => `<a href="/uploads/${encodeURIComponent(p.file)}" target="_blank" rel="noopener" title="${UI.esc(p.name)}">📷</a>`).join(' ') : '<span class="muted">—</span>' },
            { t: '异常单', f: (r) => r.issue_id ? `<a href="#/quality/issue/${r.issue_id}" class="mono small" style="color:var(--danger)">查看 ›</a>` : '<span class="muted">—</span>' },
          ], rows, { emptyText: '暂无巡检记录' }) : `<div class="muted" style="padding:22px 6px">该时段暂无巡检记录。检验员可在手机 APP「工作台 → 质检快捷 → 现场巡检」提交巡查。</div>`}
        </div>
      </div>`;
    el.querySelector('#ptDays').onchange = (e) => { this.patrolDays = Number(e.target.value); this.renderPatrols(el); };
    el.querySelector('#ptResult').onchange = (e) => { this.patrolResult = e.target.value; this.renderPatrols(el); };
  },

  async renderRecords(el) {
    const rows = await API.get('/inspections');
    el.innerHTML = `
      <div class="card">
        <div class="card-h"><h3>检验记录</h3><span class="small muted">共 ${rows.length} 条 · 最近 200 条</span>
          <div class="spacer"></div><button class="btn btn-sm" id="exp">导出 CSV</button></div>
        <div class="card-b tight">
          ${UI.table([
            { t: '检验单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
            { t: '工单', f: (r) => UI.esc(r.order_code || '—') },
            { t: '工序', f: (r) => UI.esc(r.process_name || '—') },
            { t: '受检', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.qty_check)}</span>` },
            { t: '合格', align: 'right', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.qty_pass)}</span>` },
            { t: '不合格', align: 'right', f: (r) => `<span class="mono" style="color:${Number(r.qty_fail) ? 'var(--danger)' : 'var(--text3)'}">${UI.n2(r.qty_fail)}</span>` },
            { t: '结论', f: (r) => this.concChip(r.conclusion) },
            { t: '检验员', f: (r) => UI.esc(r.inspector || '—') },
            { t: '不良明细', f: (r) => `<span class="small muted">${UI.esc(r.defect_summary || r.remark || '—')}</span>` },
            { t: '时间', f: (r) => `<span class="small muted">${UI.esc((r.created_at || '').slice(5, 16))}</span>` },
            { t: '', align: 'right', f: (r) => `<button class="btn btn-sm btn-ghost" data-det="${r.id}">明细</button>` },
          ], rows, { emptyText: '还没有检验记录' })}
        </div>
      </div>`;
    el.querySelectorAll('[data-det]').forEach((b) => b.onclick = async () => {
      try {
        const d = await API.get('/inspections/' + b.dataset.det);
        UI.modal({
          title: '检验单 ' + (d.code || '') + ' 明细',
          body: `<dl class="kv">
            <dt>工单</dt><dd>${UI.esc(d.order_code || '—')}</dd>
            <dt>工序</dt><dd>${UI.esc(d.process_name || '—')}</dd>
            <dt>受检/合格/不合格</dt><dd>${UI.n2(d.qty_check)} / <span style="color:var(--ok)">${UI.n2(d.qty_pass)}</span> / <span style="color:var(--danger)">${UI.n2(d.qty_fail)}</span></dd>
            <dt>结论</dt><dd>${this.concChip(d.conclusion)}</dd>
            <dt>检验员</dt><dd>${UI.esc(d.inspector || '—')}</dd>
            <dt>检验时间</dt><dd>${UI.esc(d.created_at || '')}</dd>
            <dt>备注</dt><dd>${UI.esc(d.remark || '—')}</dd>
          </dl>
          <div class="hr" style="margin:14px 0;border-top:1px solid var(--line2)"></div>
          <div class="small muted" style="margin-bottom:6px">不良明细</div>
          ${(d.defects || []).length ? `<div class="table-wrap"><table class="table"><thead><tr><th>不良原因</th><th>说明</th><th class="num">数量</th></tr></thead><tbody>
            ${d.defects.map((x) => `<tr><td>${UI.esc(x.bad_reason || '—')}</td><td class="small muted">${UI.esc(x.bad_reason_detail || '—')}</td><td class="num mono">${UI.n2(x.qty)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="muted small">无不良</div>'}`,
          footer: '<button class="btn" data-close>关闭</button>',
        });
      } catch (e) { UI.toast(e.message, 'err'); }
    });
    el.querySelector('#exp').onclick = () => {
      const cols = ['检验单号', '工单', '工序', '受检', '合格', '不合格', '结论', '检验员', '检验时间', '备注'];
      const lines = [cols.join(',')].concat(rows.map((r) => [
        r.code, r.order_code || '', r.process_name || '', r.qty_check, r.qty_pass, r.qty_fail,
        (this.CONCLUSION[r.conclusion] || [r.conclusion])[0], r.inspector || '', r.created_at || '', r.remark || '',
      ].map((v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')));
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `检验记录_${UI.today()}.csv`; a.click();
      UI.toast('已导出 CSV', 'ok');
    };
  },

  /* ---------------- 质量看板 ---------------- */
  async renderDash(el) {
    const [st, fpy, trend] = await Promise.all([
      API.get('/stats/quality'),
      API.get('/stats/fpy').catch(() => ({})),
      API.get('/stats/quality_trend').catch(() => []),
    ]);
    const lv = {}; (st.open_by_level || []).forEach((x) => { lv[x.level] = x.c; });
    const pareto = (st.pareto || []).map((x) => ({ name: x.name, qty: x.qty, unit: ' 件' }));
    const procs = (st.by_process || []).filter((x) => x.chk);
    const trendRows = (trend || []).map((r) => Object.assign({}, r, {
      pass_rate_pct: r.pass_rate != null ? Math.round(r.pass_rate * 1000) / 10 : 0,
    }));
    el.innerHTML = `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--danger)"></i>未闭环异常</div>
          <div class="stat-v" style="color:${st.total_open ? 'var(--danger)' : 'var(--ok)'}">${st.total_open || 0}</div>
          <div class="stat-s">致命 ${lv.critical || 0} · 严重 ${lv.major || 0} · 轻微 ${lv.minor || 0}${lv.pending ? ' · 待定级 ' + lv.pending : ''}</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--ok)"></i>已闭环</div>
          <div class="stat-v" style="color:var(--ok)">${st.total_closed || 0}</div>
          <div class="stat-s">形成「发现 → 处理 → 验证」完整痕迹</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--warn)"></i>超期未闭环</div>
          <div class="stat-v" style="color:${(st.overdue || []).length ? 'var(--danger)' : 'inherit'}">${(st.overdue || []).length}</div>
          <div class="stat-s">超时自动抄送技术员 / 升级管理员</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--primary)"></i>平均响应时长</div>
          <div class="stat-v">${st.avg_claim_minutes == null ? '—' : st.avg_claim_minutes}</div>
          <div class="stat-s">从开单到认领（分钟）</div></div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--primary)"></i>直通率 FPY</div>
          <div class="stat-v" style="color:${fpy.fpy == null ? 'inherit' : fpy.fpy >= 0.95 ? 'var(--ok)' : fpy.fpy >= 0.85 ? 'var(--warn)' : 'var(--danger)'}">${fpy.fpy == null ? '—' : UI.f1(fpy.fpy * 100) + '%'}</div>
          <div class="stat-s">终检一次合格 ${fpy.first_pass || 0} / 受检工单 ${fpy.total || 0}（返工越少越高）</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--danger)"></i>报废合计</div>
          <div class="stat-v">${st.scrap_qty ? UI.n2(st.scrap_qty) : '0'}</div>
          <div class="stat-s">异常单登记的报废数量（件）</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--warn)"></i>损失金额</div>
          <div class="stat-v">${st.loss_amount ? '¥ ' + UI.n2(st.loss_amount) : '¥ 0'}</div>
          <div class="stat-s">异常单登记的估计损失</div></div>
        <div class="stat"><div class="stat-l"><i class="dot" style="background:var(--ok)"></i>检验判定</div>
          <div class="stat-v">${(trendRows || []).reduce((a, r) => a + (r.insp_n || 0), 0)}</div>
          <div class="stat-s">近 12 个月检验单累计</div></div>
      </div>

      <div class="grid" style="grid-template-columns:1.4fr 1fr;margin-bottom:14px">
        <div class="card">
          <div class="card-h"><h3>不良原因帕累托（检验发现）</h3><span class="small muted">按不合格数量排序</span></div>
          <div class="card-b">${pareto.length
            ? UI.barChart(pareto, { color: '#d93b3b', labelW: 84, title: '不良原因帕累托' })
            : `<div class="empty">${UI.icon('empty')}<div>暂无检验不良数据</div></div>`}</div>
        </div>
        <div class="card">
          <div class="card-h"><h3>各工序检验不良率</h3></div>
          <div class="card-b tight">
            ${UI.table([
              { t: '工序', f: (r) => UI.esc(r.process_name || '—') },
              { t: '受检', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.chk)}</span>` },
              { t: '不合格', align: 'right', f: (r) => `<span class="mono" style="color:var(--danger)">${UI.n2(r.fail)}</span>` },
              { t: '不良率', align: 'right', f: (r) => {
                  const p = r.chk > 0 ? (r.fail / r.chk) * 100 : 0;
                  return `<b class="mono" style="color:${p >= 5 ? 'var(--danger)' : p > 0 ? 'var(--warn)' : 'var(--ok)'}">${UI.f1(p)}%</b>`;
                } },
            ], procs, { emptyText: '暂无检验数据' })}
          </div>
        </div>
      </div>

      <div class="grid" style="grid-template-columns:1.4fr 1fr;margin-bottom:14px">
        <div class="card">
          <div class="card-h"><h3>质量月度趋势</h3><span class="small muted">检验合格率与异常开单数</span></div>
          <div class="card-b">${trendRows.length
            ? UI.lineChart(trendRows, [
                { key: 'pass_rate_pct', label: '检验合格率 %', color: '#0f9d58' },
                { key: 'issue_n', label: '异常开单数', color: '#d93b3b' },
              ], { title: '质量月度趋势' })
            : `<div class="empty">${UI.icon('empty')}<div>暂无趋势数据</div></div>`}</div>
        </div>
        <div class="card">
          <div class="card-h"><h3>FPY 按产品</h3><span class="small muted">一次合格率最低前 10</span></div>
          <div class="card-b tight">
            ${UI.table([
              { t: '产品', f: (r) => UI.esc(r.name || '—') },
              { t: '受检工单', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.total)}</span>` },
              { t: '一次合格', align: 'right', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.pass)}</span>` },
              { t: 'FPY', align: 'right', f: (r) => r.fpy == null ? '—' : `<b class="mono" style="color:${r.fpy >= 0.95 ? 'var(--ok)' : r.fpy >= 0.85 ? 'var(--warn)' : 'var(--danger)'}">${UI.f1(r.fpy * 100)}%</b>` },
            ], fpy.by_product || [], { emptyText: '暂无终检数据' })}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>超期未闭环异常</h3><span class="small muted">按处理期限升序</span></div>
        <div class="card-b tight">
          ${UI.table([
            { t: '异常单号', f: (r) => `<b class="link" data-open="${r.id}">${UI.esc(r.code)}</b>` },
            { t: '等级', f: (r) => this.levelChip(r.level) },
            { t: '状态', f: (r) => this.statusChip(r.status) },
            { t: '工序', f: (r) => UI.esc(r.process_name || '—') },
            { t: '责任人', f: (r) => UI.esc(r.assignee_name || '—') },
            { t: '开单时间', f: (r) => `<span class="small muted">${UI.esc(r.created_at || '')}</span>` },
          ], st.overdue || [], { emptyText: '没有超期异常，闭环及时 👍' })}
        </div>
      </div>`;
    el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => location.hash = '#/quality/issue/' + b.dataset.open);
  },

  /* ---------------- 检验设置 ---------------- */
  async renderSetup(el) {
    let cfg = {};
    try { cfg = await API.get('/quality/settings'); } catch (e) { /* 忽略 */ }
    this.settings = cfg;
    let checklists = [];
    let processes = [];
    try { [checklists, processes] = await Promise.all([API.get('/checklists'), API.get('/meta').then((m) => m.processes || [])]); } catch (e) { /* 忽略 */ }
    this.checklists = checklists;
    this.processes = processes;
    const isAdmin = App.user && App.user.role === 'admin';
    el.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>质量提醒设置</h3></div>
        <div class="card-b">
          <div class="grid g3">
            <label class="field"><span>待认领催办（分钟）</span>
              <input class="input" type="number" min="1" id="remind" value="${cfg.remind_minutes || 30}" ${isAdmin ? '' : 'disabled'}>
              <span class="small muted">超过该时长未认领 → 抄送该技术员</span></label>
            <label class="field"><span>超时升级（分钟）</span>
              <input class="input" type="number" min="1" id="esc" value="${cfg.escalate_minutes || 240}" ${isAdmin ? '' : 'disabled'}>
              <span class="small muted">超过该时长未处理 → 升级管理员并标记</span></label>
            <label class="field"><span>外部推送 Webhook</span>
              <input class="input" id="wh" placeholder="企业微信/钉钉群机器人地址，留空则仅站内待办" value="${UI.esc(cfg.webhook_url || '')}" ${isAdmin ? '' : 'disabled'}>
              <span class="small muted">支持企业微信（文本）与钉钉（markdown）机器人</span></label>
          </div>
          <div class="grid g2" style="margin-top:10px">
            <label class="field"><span>重大异常判定占比（%）</span>
              <input class="input" type="number" min="1" max="100" id="critRatio" value="${cfg.critical_ratio != null ? cfg.critical_ratio : 20}" ${isAdmin ? '' : 'disabled'}>
              <span class="small muted">不合格占比 ≥ 该值 或 终检不合格 → 致命异常（自动开单+暂停工单）</span></label>
            <label class="field"><span>轻微异常上限占比（%）</span>
              <input class="input" type="number" min="0" max="50" id="minorRatio" value="${cfg.minor_ratio != null ? cfg.minor_ratio : 5}" ${isAdmin ? '' : 'disabled'}>
              <span class="small muted">不合格占比 ≤ 该值 → 轻微异常（不惊动管理层，返工闭环）</span></label>
          </div>
          ${isAdmin ? '<button class="btn btn-primary" id="save">保存设置</button>'
            : '<div class="small muted">仅管理员可修改，可查看当前配置。</div>'}
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>检验项目模板（Checklist）</h3>
          <span class="small muted">绑定工序后，质检台待检自动带出，逐项 OK/NG</span>
          <div class="spacer"></div>
          ${isAdmin || (App.user && App.user.role === 'technician') ? `<button class="btn btn-sm btn-primary" id="newCl">${UI.icon('plus')}新建模板</button>` : ''}</div>
        <div class="card-b tight" id="clList"></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>检验点设置说明</h3></div>
        <div class="card-b">
          <div class="small" style="line-height:1.9">
            检验点 = <b>工序属性</b>，在「基础数据 → 工序档案」为工序选择检验类型，随工艺路线透传到工单：
            <ul style="margin:8px 0 0 18px;line-height:1.9">
              <li><b>首检（IQC）</b>：批次/首件确认，一般放在首个工序（如下料）</li>
              <li><b>过程检（IPQC）</b>：关键工序抽检</li>
              <li><b>终检（FQC）</b>：末道工序，放行即触发成品自动入库</li>
              <li><b>不检验</b>：报工即完工（保持原流程）</li>
            </ul>
            <div style="margin-top:10px">报工流程：员工报工 → 该工序落「<span class="ins-mark waiting">待检</span>」→ 质检员在「待检队列」判定
              → 合格/让步放行；不合格自动开「质量异常单」，推送给该工序<b>指派班组的技术员</b>跟踪处理，超时自动催办/升级。</div>
            <div style="margin-top:10px" class="muted">不是所有工单都需要检验：在「工单详情 → 检验点」可将任意工序改回「不检验」，
              即使已报工、处于待检或不合格状态也可取消检验（按普通工序放行流转）。</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>质检员账号</h3><span class="small muted">角色 inspector，可登录 PC 端 / 扫码进入待检队列</span></div>
        <div class="card-b tight" id="qclist">加载中…</div>
      </div>`;
    const save = el.querySelector('#save');
    if (save) save.onclick = async () => {
      try {
        await API.post('/quality/settings', {
          remind_minutes: Number(el.querySelector('#remind').value) || 30,
          escalate_minutes: Number(el.querySelector('#esc').value) || 240,
          critical_ratio: Number(el.querySelector('#critRatio').value) || 20,
          minor_ratio: Number(el.querySelector('#minorRatio').value) || 5,
          webhook_url: el.querySelector('#wh').value.trim(),
        });
        UI.toast('设置已保存', 'ok');
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    const nc = el.querySelector('#newCl');
    if (nc) nc.onclick = () => this.clForm();
    // 模板列表
    const clList = el.querySelector('#clList');
    clList.innerHTML = UI.table([
      { t: '模板名称', f: (r) => `<b>${UI.esc(r.name)}</b>` },
      { t: '绑定工序', f: (r) => r.process_name ? UI.esc(r.process_name) : '<span class="muted">通用（不绑定）</span>' },
      { t: '项目数', align: 'right', f: (r) => `<span class="mono">${(r.items || []).length}</span>` },
      { t: '项目预览', f: (r) => `<span class="small muted">${UI.esc((r.items || []).map((x) => x.name).join('、'))}</span>` },
      { t: '操作', align: 'right', f: (r) => `${isAdmin || (App.user && App.user.role === 'technician') ? `<button class="btn btn-sm" data-cledit="${r.id}">编辑</button>` : ''}${isAdmin ? ` <button class="btn btn-sm btn-ghost" data-cldel="${r.id}">删除</button>` : ''}` },
    ], checklists, { emptyText: '还没有检验项目模板，点「新建模板」创建（如：机加终检：外观 / 尺寸 / 螺纹）' });
    clList.querySelectorAll('[data-cledit]').forEach((b) => b.onclick = () => {
      const it = checklists.find((x) => x.id == b.dataset.cledit);
      if (it) this.clForm(it);
    });
    clList.querySelectorAll('[data-cldel]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('删除后绑定该模板的工序待检将不再带出检查表。确定删除？', '删除模板'))) return;
      try { await API.del('/checklists/' + b.dataset.cldel); UI.toast('已删除', 'ok'); this.render(el.closest('#view') || document.getElementById('view')); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
    try {
      const users = await API.get('/users');
      const qcs = users.filter((u) => u.role === 'inspector');
      el.querySelector('#qclist').innerHTML = UI.table([
        { t: '账号', f: (r) => `<b>${UI.esc(r.username)}</b>` },
        { t: '姓名', f: (r) => UI.esc(r.name) },
        { t: '班组', f: (r) => UI.esc(r.team || '—') },
        { t: '默认设备', f: (r) => UI.esc(r.wc_name || '—') },
        { t: '状态', f: (r) => (r.active ? '<span class="chip chip-ok">启用</span>' : '<span class="chip chip-gray">停用</span>') },
      ], qcs, { emptyText: '还没有质检员账号，可在「基础数据 → 员工」新增，角色选「质检员」' });
    } catch (e) {
      el.querySelector('#qclist').innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`;
    }
  },

  // 检验项目模板 新建/编辑弹窗
  clForm(it) {
    const isNew = !it;
    it = it || { name: '', process_id: null, items: [{ name: '', standard: '' }] };
    const rowHtml = (item) => `<div class="row cl-row" style="gap:8px;margin:6px 0;flex-wrap:nowrap">
      <input class="input cl-name" placeholder="项目名（如：外观无划伤）" value="${UI.esc(item.name || '')}" style="flex:1">
      <input class="input cl-std" placeholder="标准（选填，如：目视）" value="${UI.esc(item.standard || '')}" style="flex:1">
      <button class="btn btn-sm btn-ghost cl-del" title="删除该行">✕</button></div>`;
    UI.modal({
      title: isNew ? '新建检验项目模板' : '编辑检验项目模板',
      size: 'lg',
      body: `<div class="grid g2">
          <label class="field"><span>模板名称 <b style="color:var(--danger)">*</b></span>
            <input class="input" id="clName" placeholder="如：机加终检" value="${UI.esc(it.name || '')}"></label>
          <label class="field"><span>绑定工序（绑定后该工序待检自动带出）</span>
            <select class="input" id="clProc"><option value="">通用（不绑定）</option>
              ${(this.processes || []).map((p) => `<option value="${p.id}"${it.process_id === p.id ? ' selected' : ''}>${UI.esc(p.name)}</option>`).join('')}
            </select></label>
        </div>
        <label class="field"><span>检验项目（至少一项）</span></label>
        <div id="clRows">${(it.items || []).map(rowHtml).join('')}</div>
        <button class="btn btn-sm" id="clAdd">${UI.icon('plus')}加一项</button>`,
      onMount: (mask) => {
        const bindDel = () => mask.querySelectorAll('.cl-del').forEach((d) => d.onclick = () => {
          if (mask.querySelectorAll('.cl-row').length <= 1) return UI.toast('至少保留一项', 'err');
          d.closest('.cl-row').remove();
        });
        bindDel();
        mask.querySelector('#clAdd').onclick = () => {
          mask.querySelector('#clRows').insertAdjacentHTML('beforeend', rowHtml({}));
          bindDel();
        };
      },
      onOk: async (mask) => {
        const name = mask.querySelector('#clName').value.trim();
        const items = [...mask.querySelectorAll('.cl-row')]
          .map((r) => ({ name: r.querySelector('.cl-name').value.trim(), standard: r.querySelector('.cl-std').value.trim() }))
          .filter((x) => x.name);
        if (!name) throw new Error('请填写模板名称');
        if (!items.length) throw new Error('至少填写一个检验项目');
        const procId = mask.querySelector('#clProc').value;
        const payload = { name, items, process_id: procId ? Number(procId) : null };
        if (isNew) await API.post('/checklists', payload);
        else await API.put('/checklists/' + it.id, payload);
        UI.toast('模板已保存', 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  /* ------------------------------ 判定提交 ------------------------------ */
  judge(stepId) {
    const card = document.getElementById('insp' + stepId);
    if (!card) return;
    const r = (this.pending || []).find((x) => String(x.order_step_id) === String(stepId)) || {};
    const g = (k) => { const e2 = card.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
    const mode = g('inspect_mode') === 'sample' ? 'sample' : 'full';
    const qtyFail = Number(g('qty_fail')) || 0;
    let sampleQty = 0;
    let qtyPass = Number(g('qty_pass')) || 0;
    if (mode === 'sample') {
      sampleQty = Number(g('sample_qty')) || 0;
      if (sampleQty <= 0) return UI.toast('抽检时请填写样本数', 'err');
      if (qtyFail > sampleQty) return UI.toast('不合格数不能大于样本数', 'err');
      qtyPass = sampleQty - qtyFail;
    }
    let conclusion = g('conclusion');
    if (conclusion === 'pass' && qtyFail > 0) conclusion = qtyFail >= qtyPass ? 'fail' : 'concession';
    if (conclusion !== 'pass' && qtyFail <= 0) return UI.toast('判定不合格/让步接收时须填写不合格数', 'err');

    // 检查表 NG 项联动：有 NG 且结论为合格 → 自动改判不合格
    const checklist = [...card.querySelectorAll('.cl-item')].map((ci) => ({
      name: ci.dataset.cname || '',
      standard: ci.dataset.cstd || '',
      result: ci.querySelector('[data-cres]').value,
      qty: Number(ci.querySelector('[data-cqty]').value) || 0,
    }));
    const cl = (r.checklist || []).map((it, i) => Object.assign({ name: it.name, standard: it.standard || '' }, checklist[i] || {}));
    const ngNames = cl.filter((c) => c.result === 'ng' && c.qty > 0).map((c) => c.name);
    if (ngNames.length && conclusion === 'pass') {
      conclusion = 'fail';
      UI.toast(`检验项 NG（${ngNames.join('、')}），结论已自动改为不合格`, 'warn');
    }

    const isFinal = String(r.inspect_type) === 'fqc';
    const willBe = conclusion === 'pass' ? '放行完工' : conclusion === 'concession' ? '让步接收并放行（入库单备注特采）' : '生成质量异常单并暂停/挂起';
    const critThreshold = (this.settings && this.settings.critical_ratio) || 20;
    const ask = conclusion === 'fail'
      ? `判定「不合格」将：① 该工序挂起；② 自动生成质量异常单推送给责任管理人员；③ ${(isFinal || (qtyPass + qtyFail > 0 && qtyFail / (qtyPass + qtyFail) >= critThreshold / 100)) ? '因属严重异常，暂停工单后续流转并禁止入库。' : '继续等待处理结果。'}\n\n受检 ${qtyPass} 件 / 不合格 ${qtyFail} 件。确定提交？`
      : `判定「${conclusion === 'pass' ? '合格' : '让步接收'}」将${willBe}${isFinal ? '，末道工序同时自动成品入库' : ''}。受检 ${qtyPass} 件。确定提交？`;
    if (!confirm(ask)) return;

    const defects = [...card.querySelectorAll('.badrows .brow')].map((br) => {
      const det = br.querySelector('.brow-detail');
      return {
        bad_reason_id: Number(br.querySelector('.brow-reason').value) || 0,
        qty: Number(br.querySelector('.brow-qty').value) || 0,
        bad_reason_detail: det ? det.value.trim() : '',
      };
    }).filter((x) => x.qty > 0);
    if (conclusion !== 'pass' && !defects.length && !ngNames.length && !confirm('未选择具体不良原因，将以「未分类不良」登记异常。确定继续？')) return;

    const payload = {
      order_step_id: Number(stepId), qty_fail: qtyFail,
      conclusion, defects, remark: g('remark'),
      inspect_mode: mode, checklist: cl,
    };
    if (mode === 'sample') payload.sample_qty = sampleQty; else payload.qty_pass = qtyPass;
    API.post('/inspections', payload).then((res) => {
      const auto = res && res.autoFinishIn;
      UI.toast(`判定已提交：${(this.CONCLUSION[res.conclusion] || [res.conclusion])[0]}`
        + (auto ? `，末道已自动入库 ${UI.n2(auto.qty)} 件` : ''), auto ? 'ok' : '');
      this.render(document.getElementById('view'));
    }).catch((e) => UI.toast(e.message, 'err'));
  },

  /* ------------------------------ 异常单详情 ------------------------------ */
  async renderIssue(el, id) {
    let it;
    try { it = await API.get('/quality_issues/' + id); }
    catch (e) { el.innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`; return; }
    this.issue = it;
    const canHandle = App.canEdit();
    const canClose = App.user && ['admin', 'technician'].includes(App.user.role);
    const openState = !['closed', 'cancelled'].includes(it.status);
    const insp = it.inspection;
    const levelLabel = (this.LEVEL[it.level] || [it.level])[0];

    el.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <button class="btn btn-sm" id="back">${UI.icon('back')}返回列表</button>
        ${it.order_code ? `<a class="link small" href="#/orders/${it.order_id}">查看工单 ${UI.esc(it.order_code)} →</a>` : ''}
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>${UI.esc(it.code)} <span style="margin-left:6px">${this.levelChip(it.level)}</span>
            ${this.statusChip(it.status)}${it.escalated ? ' <span class="chip chip-danger">已升级</span>' : ''}</h3>
          <div class="spacer"></div>
          <span class="small muted">${UI.esc(it.source === 'inspect' ? '检验发现' : it.source === 'report' ? '报工上报' : '巡检发现')}</span></div>
        <div class="card-b">
          ${it.level === 'pending' ? `<div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:#fff8e6;border:1px solid #ffe2a8;color:#8a5a00;font-size:13px">⏳ 该异常为「待定级」：严重等级待质检员判定，期间不推送厂部管理层。</div>` : ''}
          <dl class="kv">
            <dt>工单 / 产品</dt><dd>${UI.esc(it.order_code || '—')} · ${UI.esc(it.product_name || '—')}</dd>
            <dt>工序</dt><dd>${UI.esc(it.process_name || '—')}</dd>
            <dt>影响数量</dt><dd><b class="mono" style="color:var(--danger)">${UI.n2(it.qty_affected)}</b> 件</dd>
            <dt>不良原因</dt><dd>${UI.esc(it.bad_summary || '—')}</dd>
            <dt>责任人</dt><dd>${UI.esc(it.assignee_name || '未指派')}（按工序指派班组的技术员定责）</dd>
            <dt>开单时间</dt><dd>${UI.esc(it.created_at || '')}</dd>
            <dt>认领时间</dt><dd>${UI.esc(it.claimed_at || '—')}</dd>
            ${it.closed_at ? `<dt>关闭时间</dt><dd>${UI.esc(it.closed_at)} · 验证人 ${UI.esc(it.verifier || '—')}</dd>` : ''}
            ${it.cause ? `<dt>原因分析</dt><dd>${UI.esc(it.cause)}</dd>` : ''}
            ${it.action ? `<dt>处理措施</dt><dd>${UI.esc(it.action)}</dd>` : ''}
            ${it.disposition ? `<dt>处置方式</dt><dd><span class="chip chip-info">${UI.esc(this.DISPOSITION[it.disposition] || it.disposition)}</span></dd>` : ''}
            ${it.loss_qty != null && it.loss_qty !== '' ? `<dt>报废数量</dt><dd><b class="mono" style="color:var(--danger)">${UI.n2(it.loss_qty)}</b> 件</dd>` : ''}
            ${it.loss_amount != null && it.loss_amount !== '' ? `<dt>损失金额</dt><dd><b class="mono">¥ ${UI.n2(it.loss_amount)}</b></dd>` : ''}
            ${it.status === 'cancelled' ? `<dt>作废说明</dt><dd>${UI.esc(it.cause || '误报')}</dd>` : ''}
          </dl>
          ${(() => {
            let ph = [];
            try { ph = typeof it.photos === 'string' ? JSON.parse(it.photos || '[]') : (it.photos || []); } catch (e) { /* 忽略 */ }
            return ph.length ? `<div style="margin-top:12px"><div class="small muted" style="margin-bottom:6px">现场照片（${ph.length}）</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">${ph.map((p) => `<a href="/uploads/${encodeURIComponent(p.file)}" target="_blank"><img src="/uploads/${encodeURIComponent(p.file)}" alt="${UI.esc(p.name || '')}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line,#e2e8f0)"></a>`).join('')}</div></div>` : '';
          })()}
        </div>
      </div>

      ${insp ? `<div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>来源检验单 ${UI.esc(insp.code || '')}</h3></div>
        <div class="card-b tight">
          ${UI.table([
            { t: '受检', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.qty_check)}</span>` },
            { t: '合格', align: 'right', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.qty_pass)}</span>` },
            { t: '不合格', align: 'right', f: (r) => `<span class="mono" style="color:var(--danger)">${UI.n2(r.qty_fail)}</span>` },
            { t: '结论', f: (r) => this.concChip(r.conclusion) },
            { t: '检验员', f: (r) => UI.esc(r.inspector || '—') },
          ], [insp])}
          ${(insp.defects || []).length ? `<div class="card-b"><div class="small muted" style="margin-bottom:6px">不良明细</div>
            ${(insp.defects || []).map((x) => `<span class="chip chip-danger" style="margin:0 6px 6px 0">${UI.esc(x.bad_reason || '—')} × ${UI.n2(x.qty)}</span>`).join('')}
            ${insp.remark ? `<div class="small muted" style="margin-top:8px">备注：${UI.esc(insp.remark)}</div>` : ''}</div>` : ''}
        </div>
      </div>` : ''}

      ${openState ? `<div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>处理</h3></div>
        <div class="card-b">
          <div class="grid g2">
            <label class="field"><span>原因分析</span>
              <input class="input" id="fCause" placeholder="如：刀具磨损未及时更换" value="${UI.esc(it.cause || '')}" ${canHandle && it.status !== 'open' ? '' : ''}></label>
            <label class="field"><span>处理措施</span>
              <input class="input" id="fAction" placeholder="如：更换刀具并全检该批次" value="${UI.esc(it.action || '')}"></label>
            <label class="field"><span>处置方式</span>
              <select class="input" id="fDisp">
                <option value="">未定</option>
                ${Object.entries(this.DISPOSITION).map(([k, v]) => `<option value="${k}"${it.disposition === k ? ' selected' : ''}>${v}</option>`).join('')}
              </select></label>
            <label class="field"><span>报废数量（处置=报废时填写）</span>
              <input class="input" type="number" min="0" id="fLossQty" value="${it.loss_qty != null ? it.loss_qty : ''}" placeholder="选填，默认=影响数量"></label>
            <label class="field"><span>估计损失金额（元）</span>
              <input class="input" type="number" min="0" step="0.01" id="fLossAmt" value="${it.loss_amount != null ? it.loss_amount : ''}" placeholder="选填"></label>
          </div>
          <div class="row">
            ${it.status === 'open' ? `<button class="btn btn-primary" id="claim">认领该异常</button>` : ''}
            ${canHandle ? `<button class="btn" id="handle">提交处理 → 待验证</button>` : ''}
            ${canClose ? `<button class="btn btn-ok" id="close">验证关闭（放行）</button>` : ''}
            ${(App.user && (App.user.role === 'inspector' || App.user.role === 'admin')) ? `<button class="btn btn-warn" id="grade">检验员定级</button>` : ''}
            ${App.isAdmin() ? `<button class="btn btn-danger" id="cancel">作废（误报）</button>` : ''}
            <span class="small muted">关闭后：该工序放行，因致命异常暂停的工单自动恢复流转。</span>
          </div>
        </div>
      </div>` : ''}

      <div class="card">
        <div class="card-h"><h3>处理痕迹 / 通知记录</h3><span class="small muted">站内待办与外部推送留痕</span></div>
        <div class="card-b">
          ${(it.timeline || []).length ? `<div class="tl">${it.timeline.map((n) => `
            <div class="tl-item">
              <b>${UI.esc(n.title || '')}</b><span class="when">${UI.esc(n.sent_at || '')} · 收件人 ${UI.esc(n.to_name || '—')} · ${n.kind_label || (n.kind === 'created' ? '开单通知' : n.kind === 'remind' ? '催办' : n.kind === 'escalate' ? '升级' : n.kind === 'graded' ? '定级' : '闭环回执')}</span>
              <div class="small muted">${UI.esc(n.body || '')}</div>
            </div>`).join('')}</div>`
            : '<div class="muted small">暂无通知记录</div>'}
        </div>
      </div>`;

    el.querySelector('#back').onclick = () => location.hash = '#/quality';
    const rb = el.querySelector('#claim');
    if (rb) rb.onclick = () => this.issueAction(it.id, 'claim', {}, '已认领，开始处理');
    const hb = el.querySelector('#handle');
    if (hb) hb.onclick = () => this.issueAction(it.id, 'handle', {
      cause: el.querySelector('#fCause').value.trim(),
      action: el.querySelector('#fAction').value.trim(),
      disposition: el.querySelector('#fDisp').value || null,
      loss_qty: el.querySelector('#fLossQty').value === '' ? null : Number(el.querySelector('#fLossQty').value),
      loss_amount: el.querySelector('#fLossAmt').value === '' ? null : Number(el.querySelector('#fLossAmt').value),
    }, '已提交处理，等待验证关闭');
    const cb = el.querySelector('#close');
    if (cb) cb.onclick = async () => {
      if (!(await UI.confirm('验证关闭后该异常单闭环，受阻工序将放行、暂停工单恢复流转。确定关闭？', '验证关闭'))) return;
      this.issueAction(it.id, 'close', { release: true }, '异常已闭环');
    };
    const gb = el.querySelector('#grade');
    if (gb) gb.onclick = () => this.gradeIssue(it.id, it.level);
    const xb = el.querySelector('#cancel');
    if (xb) xb.onclick = async () => {
      const reason = prompt('作废原因（如：误报 / 重复开单）', '误报');
      if (reason === null) return;
      this.issueAction(it.id, 'cancel', { reason }, '异常单已作废');
    };
  },

  issueAction(id, act, body, okMsg) {
    API.post(`/quality_issues/${id}/${act}`, body)
      .then(() => {
        UI.toast(okMsg, 'ok');
        if (act === 'close' || act === 'cancel') location.hash = '#/quality';
        else this.render(document.getElementById('view'), 'issue');
      })
      .catch((e) => UI.toast(e.message, 'err'));
  },
  // 检验员定级：工人/现场报工上报的异常，严重等级由质检员判定
  gradeIssue(id, cur) {
    const cur0 = cur || 'pending';
    UI.modal({
      title: '检验员定级',
      size: 'sm',
      body: `<p class="small muted" style="margin-bottom:8px">工人/现场上报的异常，严重等级由质检员判定。</p>
        <label class="field"><span>严重等级</span><select class="input" id="gLv">
          <option value="minor">轻微</option>
          <option value="major"${cur0 === 'major' ? ' selected' : ''}>严重</option>
          <option value="critical"${cur0 === 'critical' ? ' selected' : ''}>致命（暂停工单）</option>
        </select></label>
        ${cur0 === 'pending' ? '<p class="small muted">当前状态：待定级</p>' : ''}`,
      onOk: async (mask) => {
        const lv = mask.querySelector('#gLv').value;
        await API.put(`/quality_issues/${id}/level`, { level: lv });
        UI.toast('已定级：' + (this.LEVEL[lv] || [lv])[0], 'ok');
        this.render(document.getElementById('view'), 'issue');
      },
    });
  },
};

/* ==================== 通知中心（红点 + 抽屉） ==================== */
window.Notify = {
  _timer: null,
  count: 0,

  // 在顶栏挂铃铛（App.enter 调用）
  mount() {
    if (Notify._mounted) return;
    Notify._mounted = true;
    const bar = document.querySelector('.topbar-right');
    if (!bar) return;
    const b = document.createElement('button');
    b.className = 'icon-btn bell';
    b.id = 'btnBell';
    b.title = '我的待办与通知';
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><span class="dot"></span>';
    bar.insertBefore(b, bar.firstChild);
    b.onclick = () => Notify.open();
    Notify.refresh();
    if (Notify._timer) clearInterval(Notify._timer);
    Notify._timer = setInterval(() => Notify.refresh(), 60000);
  },

  async refresh() {
    if (!App.user) return;
    try {
      const r = await API.get('/notifications/unread_count');
      Notify.count = (r && r.count) || 0;
      const b = document.getElementById('btnBell');
      if (b) {
        b.classList.toggle('has-unread', Notify.count > 0);
        const d = b.querySelector('.dot');
        if (d) d.textContent = Notify.count > 99 ? '99+' : String(Notify.count);
      }
    } catch (e) { /* 忽略 */ }
  },

  async open() {
    let rows = [];
    try { rows = await API.get('/notifications'); }
    catch (e) { return UI.toast(e.message, 'err'); }
    const KIND = { created: ['新开单', 'chip-danger'], remind: ['催办', 'chip-warn'], escalate: ['升级', 'chip-danger'], closed: ['闭环', 'chip-ok'] };
    const m = UI.modal({
      title: '我的待办与通知',
      size: 'lg',
      body: rows.length ? `<div style="border:1px solid var(--line);border-radius:var(--r);overflow:hidden">
          ${rows.map((n) => {
            const k = KIND[n.kind] || [n.kind, 'chip-gray'];
            return `<div class="notif ${n.read_at ? '' : 'unread'}" data-issue="${n.issue_id || ''}">
              <div class="nt">
                <b>${UI.esc(n.title || '')} <span class="chip ${k[1]}">${k[0]}</span>
                  ${n.issue_status && ['open', 'processing', 'verifying'].includes(n.issue_status) ? '<span class="chip chip-gray">未闭环</span>' : ''}</b>
                <div class="nb">${UI.esc(n.body || '')}</div>
              </div>
              <div class="nw">${UI.esc((n.sent_at || '').slice(5, 16))}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="row" style="margin-top:12px;justify-content:space-between">
          <span class="small muted">共 ${rows.length} 条 · 未读 <b>${Notify.count}</b> 条</span>
          <button class="btn btn-sm" id="readAll">全部标为已读</button>
        </div>`
        : `<div class="empty">${UI.icon('check')}<div>暂无通知，一切正常 👍</div></div>`,
      footer: '<button class="btn" data-close>关闭</button>',
      onMount: (mask, close) => {
        mask.querySelectorAll('.notif').forEach((n) => n.onclick = async () => {
          const iid = n.dataset.issue;
          if (!n.classList.contains('unread') && iid) { close(); location.hash = '#/quality/issue/' + iid; return; }
          try { await API.post('/notifications/read', {}); } catch (e) { /* 忽略 */ }
          Notify.refresh();
          close();
          if (iid) location.hash = '#/quality/issue/' + iid;
        });
        const ra = mask.querySelector('#readAll');
        if (ra) ra.onclick = async () => {
          try { await API.post('/notifications/read', {}); Notify.refresh(); UI.toast('已全部标为已读', 'ok'); close(); }
          catch (e) { UI.toast(e.message, 'err'); }
        };
      },
    });
    return m;
  },
};
