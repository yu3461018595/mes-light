/**
 * 数据层：node:sqlite（Node 22 内置，零第三方依赖）
 * 负责：建表、演示数据初始化、通用查询封装
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// 数据目录：默认 <项目根>/data；公网部署挂持久卷时可用 DATA_DIR 环境变量覆盖（如 /app/data）
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'mes.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ------------------------------ 表结构 ------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  password    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'worker',   -- admin | leader | worker
  team        TEXT,                              -- 班组
  work_center_id INTEGER,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  contact TEXT,
  phone   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  std_time  REAL NOT NULL DEFAULT 0,   -- 标准工时（分钟/件）
  std_price REAL NOT NULL DEFAULT 0,   -- 计件单价（元）
  remark    TEXT
);

CREATE TABLE IF NOT EXISTS work_centers (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  workshop TEXT,
  status   TEXT NOT NULL DEFAULT 'idle',  -- idle 空闲 | running 运转 | fault 故障 | maintain 保养
  remark   TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  spec    TEXT,
  unit    TEXT NOT NULL DEFAULT '件',
  price   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  process_id     INTEGER NOT NULL REFERENCES processes(id),
  work_center_id INTEGER REFERENCES work_centers(id),
  std_time       REAL NOT NULL DEFAULT 0,
  std_price      REAL NOT NULL DEFAULT 0,
  need_report    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bad_reasons (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  route_id    INTEGER NOT NULL REFERENCES routes(id),
  customer_id INTEGER REFERENCES customers(id),
  qty_plan    INTEGER NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 2,      -- 1 高 2 中 3 低
  plan_start  TEXT,
  plan_end    TEXT,
  status      TEXT NOT NULL DEFAULT 'created', -- created 待下发 | released 已下发 | running 生产中
                                               -- paused 已暂停 | done 已完成 | closed 已关闭
  remark      TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  start_time  TEXT,
  finish_time TEXT
);

CREATE TABLE IF NOT EXISTS order_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  process_id     INTEGER NOT NULL REFERENCES processes(id),
  work_center_id INTEGER REFERENCES work_centers(id),
  assignee_id    INTEGER REFERENCES users(id),
  qty_plan       INTEGER NOT NULL DEFAULT 0,
  qty_good       INTEGER NOT NULL DEFAULT 0,
  qty_bad        INTEGER NOT NULL DEFAULT 0,
  work_min       REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending 待生产 | running 生产中 | done 已完成
  start_time     TEXT,
  finish_time    TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_step_id  INTEGER REFERENCES order_steps(id) ON DELETE CASCADE,
  worker_id      INTEGER NOT NULL REFERENCES users(id),
  work_center_id INTEGER REFERENCES work_centers(id),
  qty_good       INTEGER NOT NULL DEFAULT 0,
  qty_bad        INTEGER NOT NULL DEFAULT 0,
  bad_reason     TEXT,
  work_min       REAL NOT NULL DEFAULT 0,
  report_date    TEXT NOT NULL,
  remark         TEXT,
  created_at     TEXT NOT NULL,
  bad_reason_id  INTEGER
);

CREATE TABLE IF NOT EXISTS order_bad_reasons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  bad_reason_id INTEGER NOT NULL REFERENCES bad_reasons(id) ON DELETE CASCADE,
  UNIQUE(order_id, bad_reason_id)
);

/* 报工不良明细：一道工序一次报工可登记多种不良（每种不良独立的数量/原因） */
CREATE TABLE IF NOT EXISTS report_bad_reasons (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id        INTEGER NOT NULL,                 -- 关联 reports.id
  bad_reason_id    INTEGER,                          -- 关联 bad_reasons.id（选「其他」时为空）
  bad_reason       TEXT,                             -- 不良原因名称（含「其他」的具体说明）
  bad_reason_detail TEXT,                            -- 「其他」时的具体说明
  qty              INTEGER NOT NULL DEFAULT 0        -- 该原因对应的不良数量
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  user_name  TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expire_at  TEXT NOT NULL
);

/* 来料记录（IQC 来料检验/收货）：供应商来料登记与检验结论 */
CREATE TABLE IF NOT EXISTS incoming_materials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT,                                  -- 来料单号（LM+日期+序号，可手动）
  incoming_date TEXT,                                  -- 来料日期
  supplier      TEXT,                                  -- 供应商
  material_code TEXT,                                  -- 物料编码
  material_name TEXT NOT NULL,                         -- 物料名称
  material_spec TEXT,                                  -- 规格型号
  qty           REAL NOT NULL DEFAULT 0,               -- 来料数量
  unit          TEXT NOT NULL DEFAULT '件',            -- 单位
  batch         TEXT,                                  -- 批次/批号
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,  -- 关联工单（选填）
  inspector     TEXT,                                  -- 检验员
  result        TEXT NOT NULL DEFAULT 'pending',       -- 检验结论 pending 待检 | qualified 合格 | rejected 不合格
  remark        TEXT,
  created_by    INTEGER,
  created_at    TEXT NOT NULL
);

/* 成品入库记录：完工成品入库（仓库收货），按工单追溯 */
CREATE TABLE IF NOT EXISTS finished_goods_in (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT,                                  -- 入库单号（RK+日期+序号，可手动）
  in_date       TEXT,                                  -- 入库日期
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,  -- 关联工单（选填）
  report_id     INTEGER,                               -- 关联来源报工（自动入库时写入，用于撤销报工联动回滚）
  product_code  TEXT,                                  -- 产品编码（入库时快照）
  product_name  TEXT NOT NULL,                         -- 产品名称（快照）
  spec          TEXT,                                  -- 规格（快照）
  qty           REAL NOT NULL DEFAULT 0,               -- 入库数量
  unit          TEXT NOT NULL DEFAULT '件',            -- 单位
  batch         TEXT,                                  -- 批号
  location      TEXT,                                  -- 库位
  inspector     TEXT,                                  -- 入库人/质检员
  result        TEXT NOT NULL DEFAULT 'pending',       -- 质检结果 pending 待检 | qualified 合格 | rejected 不合格
  remark        TEXT,
  source        TEXT,                                  -- 来源标记：sync=完工入库补齐；NULL=手工/报工自动（以 report_id 区分）
  created_by    INTEGER,
  created_at    TEXT NOT NULL
);

/* 仓库（精简为一层：仓库 + 库位文本） */
CREATE TABLE IF NOT EXISTS warehouses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  remark     TEXT,
  created_at TEXT NOT NULL
);

/* 物料档案：原料 / 半成品 / 成品 / 外协件 统一主数据，录单下拉选择，杜绝一物多码 */
CREATE TABLE IF NOT EXISTS materials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  spec         TEXT,                              -- 规格型号
  material     TEXT,                              -- 材质
  category     TEXT NOT NULL DEFAULT '原料',      -- 原料 | 半成品 | 成品 | 外协件
  unit         TEXT NOT NULL DEFAULT '件',
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,  -- 默认仓库
  location     TEXT,                              -- 默认库位
  safe_min     REAL NOT NULL DEFAULT 0,           -- 安全库存下限（低于=缺料预警）
  safe_max     REAL,                              -- 安全库存上限（高于=积压提示）
  active       INTEGER NOT NULL DEFAULT 1,
  remark       TEXT,
  created_at   TEXT NOT NULL
);

/* 库存台账：物料 + 仓库 + 批次 一行，数量只能由收发明细流水汇总产生 */
CREATE TABLE IF NOT EXISTS inventory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id  INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  batch        TEXT,
  location     TEXT,
  qty          REAL NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

/* 库存收发明细（流水）：每一笔库存变动都留痕，可追溯到单据与工单 */
CREATE TABLE IF NOT EXISTS inventory_tx (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id  INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  batch        TEXT,
  tx_type      TEXT NOT NULL,   -- in_incoming 来料入库 | in_finish 成品入库 | out_pick 领料出库 | in_return 退料入库 | out_ship 成品出库 | adjust 盘点调整
  qty          REAL NOT NULL,   -- 正=入库 负=出库
  before_qty   REAL NOT NULL DEFAULT 0,
  after_qty    REAL NOT NULL DEFAULT 0,
  ref_type     TEXT,            -- incoming_materials | finished_goods_in
  ref_id       INTEGER,
  ref_code     TEXT,
  order_id     INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  operator     TEXT,
  tx_date      TEXT NOT NULL,
  remark       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date);
CREATE INDEX IF NOT EXISTS idx_reports_order ON reports(order_id);
CREATE INDEX IF NOT EXISTS idx_ordersteps_order ON order_steps(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_mat ON inventory(material_id);
CREATE INDEX IF NOT EXISTS idx_tx_mat ON inventory_tx(material_id);
CREATE INDEX IF NOT EXISTS idx_tx_ref ON inventory_tx(ref_type, ref_id);

/* ==================== 检验与质量异常（一期：初版检验模式） ==================== */

/* 检验记录：工序报工后的检验判定（检验点为工序属性，报工即入待检队列） */
CREATE TABLE IF NOT EXISTS inspections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT,                                 -- 检验单号 QC+日期+序号
  order_id      INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  order_step_id INTEGER REFERENCES order_steps(id) ON DELETE CASCADE,
  report_id     INTEGER,                              -- 触发检验的报工（末条）
  process_name  TEXT,                                 -- 工序名快照
  inspector_id  INTEGER REFERENCES users(id),
  inspector     TEXT,                                 -- 检验员姓名快照
  qty_check     INTEGER NOT NULL DEFAULT 0,           -- 受检数量
  qty_pass      INTEGER NOT NULL DEFAULT 0,           -- 合格数
  qty_fail      INTEGER NOT NULL DEFAULT 0,           -- 不合格数
  conclusion    TEXT NOT NULL DEFAULT 'pass',         -- pass 合格 | fail 不合格 | concession 让步接收
  remark        TEXT,
  created_at    TEXT NOT NULL
);

/* 检验发现的不良明细：一次检验可登记多种不良（结构与 report_bad_reasons 对齐） */
CREATE TABLE IF NOT EXISTS inspection_defects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id     INTEGER NOT NULL,                 -- 关联 inspections.id
  bad_reason_id     INTEGER,                          -- 关联 bad_reasons.id（「其他」时为空）
  bad_reason        TEXT,                             -- 不良原因名称
  bad_reason_detail TEXT,                             -- 「其他」的具体说明
  qty               INTEGER NOT NULL DEFAULT 0
);

/* 质量异常单：不合格自动生成，推送给对应管理人员跟踪处理直至闭环 */
CREATE TABLE IF NOT EXISTS quality_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL,                      -- 异常单号 QA+日期+序号
  level           TEXT NOT NULL DEFAULT 'major',      -- minor 轻微 | major 严重 | critical 致命
  source          TEXT NOT NULL DEFAULT 'inspect',    -- inspect 检验 | report 报工上报 | patrol 巡检
  order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_step_id   INTEGER REFERENCES order_steps(id) ON DELETE SET NULL,
  inspection_id   INTEGER,                            -- 来源检验记录
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name    TEXT,
  order_code      TEXT,
  process_name    TEXT,
  qty_affected    INTEGER NOT NULL DEFAULT 0,         -- 受影响数量
  bad_summary     TEXT,                               -- 不良原因摘要（如「尺寸超差×12；表面划伤×3」）
  status          TEXT NOT NULL DEFAULT 'open',       -- open 待认领 | processing 处理中 | verifying 待验证
                                                      -- closed 已关闭 | cancelled 已作废
  assignee_user_id INTEGER REFERENCES users(id),      -- 责任管理人员（按工序班组 leader）
  assignee_name   TEXT,
  claimed_at      TEXT,
  due_at          TEXT,                               -- 处理期限（超时升级）
  escalated       INTEGER NOT NULL DEFAULT 0,         -- 是否已升级通知（0/1）
  cause           TEXT,                               -- 原因分析
  action          TEXT,                               -- 处理措施
  disposition     TEXT,                               -- rework 返工 | repair 返修 | concession 让步接收 | scrap 报废
  verifier        TEXT,                               -- 验证人
  closed_at       TEXT,
  created_by      INTEGER,
  created_at      TEXT NOT NULL
);

/* 通知/待办投递记录：站内消息 + 可选外部 webhook，形成催办痕迹 */
CREATE TABLE IF NOT EXISTS issue_notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER,                                -- 关联 quality_issues.id（通用消息可为空）
  to_user_id  INTEGER,                                -- 站内：接收人（可为空=仅外部渠道）
  to_name     TEXT,
  channel     TEXT NOT NULL DEFAULT 'inbox',          -- inbox 站内 | wecom 企业微信/钉钉机器人
  kind        TEXT NOT NULL DEFAULT 'created',        -- created 新建 | remind 催办 | escalate 升级 | closed 关闭回执
  title       TEXT,
  body        TEXT,
  read_at     TEXT,                                   -- 站内消息阅读时间（未读为空）
  sent_at     TEXT NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 1              -- 外部推送是否成功
);

CREATE INDEX IF NOT EXISTS idx_insp_order ON inspections(order_id);
CREATE INDEX IF NOT EXISTS idx_insp_step ON inspections(order_step_id);
CREATE INDEX IF NOT EXISTS idx_issue_status ON quality_issues(status);
CREATE INDEX IF NOT EXISTS idx_issue_assignee ON quality_issues(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON issue_notifications(to_user_id);
CREATE INDEX IF NOT EXISTS idx_notif_issue ON issue_notifications(issue_id);
CREATE INDEX IF NOT EXISTS idx_defects_insp ON inspection_defects(inspection_id);

/* 系统设置（键值对）：质量提醒 webhook、超时阈值等 */
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// 兼容已存在的旧库：来料单 / 成品入库单 补 物料、仓库 字段（新库随上面建表语句携带）
try { db.exec('ALTER TABLE incoming_materials ADD COLUMN material_id INTEGER'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE incoming_materials ADD COLUMN warehouse_id INTEGER'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE finished_goods_in ADD COLUMN material_id INTEGER'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE finished_goods_in ADD COLUMN warehouse_id INTEGER'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE finished_goods_in ADD COLUMN report_id INTEGER'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE finished_goods_in ADD COLUMN source TEXT'); } catch (e) { /* 字段已存在则忽略 */ }

// 旧库升级到物料仓储阶段1：仓库表为空时补默认仓库（物料档案为空属正常，由用户在页面点「从产品导入」建档）
try {
  if (!get('SELECT id FROM warehouses LIMIT 1')) {
    const _t = new Date().toISOString().replace('T', ' ').slice(0, 19);
    insert('INSERT INTO warehouses(code,name,remark,created_at) VALUES(?,?,?,?)', ['WH01', '主仓库', '原料存放', _t]);
    insert('INSERT INTO warehouses(code,name,remark,created_at) VALUES(?,?,?,?)', ['WH02', '成品仓', '成品存放', _t]);
  }
} catch (e) { /* 忽略 */ }

// 兼容已存在的旧库：补充「关闭原因」字段（新库随上面建表语句携带）
try { db.exec('ALTER TABLE orders ADD COLUMN close_reason TEXT'); } catch (e) { /* 字段已存在则忽略 */ }

// 兼容已存在的旧库：补充「指派班组」字段（按班组派工、限制只有该班组可报工）
try { db.exec('ALTER TABLE order_steps ADD COLUMN assignee_team TEXT'); } catch (e) { /* 字段已存在则忽略 */ }

// 兼容已存在的旧库：补充「员工可申报」字段（工序是否开放给员工扫码自行报工；0=仅管理员/班组长）
try { db.exec('ALTER TABLE order_steps ADD COLUMN allow_report INTEGER NOT NULL DEFAULT 1'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE reports ADD COLUMN bad_reason_id INTEGER'); } catch (e) { /* 字段已存在则忽略 */ }

// 兼容已存在的旧库：检验点标记（工艺路线默认值 → 下发工单时带到 order_steps）
// inspect_type: '' / NULL 不检验 | iqc 首检 | ipqc 过程检 | fqc 终检（允许为空，与通用 CRUD 的空值语义一致）
try { db.exec('ALTER TABLE order_steps ADD COLUMN inspect_type TEXT'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE order_steps ADD COLUMN inspect_ratio INTEGER NOT NULL DEFAULT 100'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE processes ADD COLUMN inspect_type TEXT'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE route_steps ADD COLUMN inspect_type TEXT'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE order_steps ADD COLUMN inspect_status TEXT'); } catch (e) { /* 字段已存在则忽略 */ }

/* 通用消息中心（APP 通知）：把 issue_notifications 扩展为全场景消息表 */
try { db.exec("ALTER TABLE issue_notifications ADD COLUMN source TEXT NOT NULL DEFAULT 'quality'"); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE issue_notifications ADD COLUMN ref_type TEXT'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE issue_notifications ADD COLUMN ref_id INTEGER'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('ALTER TABLE issue_notifications ADD COLUMN link TEXT'); } catch (e) { /* 字段已存在则忽略 */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_notif_source ON issue_notifications(source)'); } catch (e) { /* 忽略 */ }

/* 库存预警去重表：同一物料同一天只提醒一次，库存恢复后重置 */
try {
  db.exec(`CREATE TABLE IF NOT EXISTS stock_alerts (
    material_id INTEGER NOT NULL,
    alert_date  TEXT NOT NULL,
    level       TEXT,
    qty         REAL,
    safe_min    REAL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (material_id, alert_date)
  )`);
} catch (e) { /* 忽略 */ }

// 旧库统一补种：质检员账号 + 检验工序标记（幂等）
// 重要：只在「已存在管理员账号」的老库执行——新库交给 seed() 建整套演示数据，避免抢先插入 qc01 导致种子判空失效。
// 注意：此处不能用下方定义的 hashPassword/now（const 箭头函数有 TDZ，会抛 ReferenceError），故内联实现。
try {
  const hasAdmin = get("SELECT COUNT(*) c FROM users WHERE username='admin'").c > 0;
  if (hasAdmin && !get("SELECT id FROM users WHERE role='inspector' LIMIT 1")) {
    const _ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const _pw = crypto.createHash('sha256').update('mes:' + '123456').digest('hex');
    insert('INSERT INTO users(username,name,password,role,team,work_center_id,active,created_at) VALUES(?,?,?,?,?,?,1,?)',
      ['qc01', '赵质检', _pw, 'inspector', '质检组', null, _ts]);
  }
  if (hasAdmin) {
    const hasInspect = get("SELECT COUNT(*) c FROM processes WHERE inspect_type<>''").c;
    if (!hasInspect) {
      run("UPDATE processes SET inspect_type='fqc' WHERE name LIKE '%检验%' OR name LIKE '%检测%'");
      run("UPDATE route_steps SET inspect_type='fqc' WHERE process_id IN (SELECT id FROM processes WHERE inspect_type<>'')");
      run("UPDATE order_steps SET inspect_type='fqc' WHERE process_id IN (SELECT id FROM processes WHERE inspect_type<>'') AND status IN ('pending','running')");
    }
  }
} catch (e) { /* 忽略 */ }
// 老库兜底：若一道检验点都没有（工序命名不含「检验」），把每张工单的末道工序设为终检点
try {
  if (get("SELECT COUNT(*) c FROM users WHERE username='admin'").c > 0) {
    const anyInspect = get("SELECT COUNT(*) c FROM order_steps WHERE inspect_type<>''").c;
    if (!anyInspect) {
      all("SELECT id FROM orders").forEach((o) => {
        const last = get('SELECT id FROM order_steps WHERE order_id=? ORDER BY seq DESC LIMIT 1', [o.id]);
        if (last) run("UPDATE order_steps SET inspect_type='fqc' WHERE id=?", [last.id]);
      });
    }
  }
} catch (e) { /* 忽略 */ }

/* ------------------------------ 查询封装 ------------------------------ */
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}
function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
function insert(sql, params = []) {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const hashPassword = (pw) =>
  crypto.createHash('sha256').update('mes:' + pw).digest('hex');

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);
const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function log(user, action, detail) {
  run('INSERT INTO logs(user_id,user_name,action,detail,created_at) VALUES(?,?,?,?,?)', [
    user ? user.id : null,
    user ? user.name : 'system',
    action,
    detail || '',
    now(),
  ]);
}

/* ------------------------------ 演示数据 ------------------------------ */
function seed() {
  if (get('SELECT COUNT(*) c FROM users').c > 0) return false;

  tx(() => {
    // 用户：管理员、班组长、操作工
    const u = (username, name, role, team, wc) =>
      insert('INSERT INTO users(username,name,password,role,team,work_center_id,created_at) VALUES(?,?,?,?,?,?,?)',
        [username, name, hashPassword('123456'), role, team, wc || null, now()]);

    u('admin', '张建国', 'admin', '厂部');
    u('leader1', '李伟', 'leader', '甲班');
    u('leader2', '陈静', 'leader', '乙班');
    u('qc01', '赵质检', 'inspector', '质检组', 6);
    const w = (i, n, wc) => u('worker' + i, n, 'worker', i % 2 ? '甲班' : '乙班', wc);
    w(1, '王强', 1); w(2, '刘洋', 2); w(3, '赵敏', 3); w(4, '孙磊', 4);
    w(5, '周涛', 5); w(6, '吴娜', 6); w(7, '郑凯', 1); w(8, '冯莉', 2);

    // 工作中心
    const wc = (code, name, workshop, status) =>
      insert('INSERT INTO work_centers(code,name,workshop,status) VALUES(?,?,?,?)', [code, name, workshop, status]);
    wc('WC-01', '数控车床 A1', '一车间', 'running');
    wc('WC-02', '加工中心 B2', '一车间', 'running');
    wc('WC-03', '磨床 C1', '一车间', 'idle');
    wc('WC-04', '焊接工位 D1', '二车间', 'running');
    wc('WC-05', '装配线 E1', '二车间', 'running');
    wc('WC-06', '检验台 F1', '质检区', 'idle');
    wc('WC-07', '冲压机 G1', '一车间', 'maintain');

    // 工序
    const pr = (code, name, std_time, std_price) =>
      insert('INSERT INTO processes(code,name,std_time,std_price) VALUES(?,?,?,?)', [code, name, std_time, std_price]);
    pr('OP10', '下料', 2, 0.5);
    pr('OP20', '车削', 8, 2.4);
    pr('OP30', '铣削', 10, 3.0);
    pr('OP40', '磨削', 6, 1.8);
    pr('OP50', '焊接', 12, 3.6);
    pr('OP60', '装配', 7, 2.1);
    pr('OP70', '检验', 3, 0.9);
    pr('OP80', '包装', 2, 0.6);
    // 「检验」工序默认作为终检点（一期：以工序为检验点，判定后放行）
    run("UPDATE processes SET inspect_type='fqc' WHERE name LIKE '%检验%'");
    // 「下料」工序作为首检点（一期先默认标记，便于演示首检 → 过程检 → 终检链路）
    run("UPDATE processes SET inspect_type='iqc' WHERE name='下料'");

    // 客户
    const cu = (code, name, contact, phone) =>
      insert('INSERT INTO customers(code,name,contact,phone,created_at) VALUES(?,?,?,?,?)', [code, name, contact, phone, now()]);
    cu('C1001', '瑞泰机械有限公司', '徐经理', '13800138001');
    cu('C1002', '华东汽车零部件厂', '沈主管', '13800138002');
    cu('C1003', '恒通重工集团', '范总', '13800138003');
    cu('C1004', '南方精工科技股份有限公司', '黄工', '13800138004');
    cu('C1005', '中远液压设备厂', '陆经理', '13800138005');

    // 产品
    const pd = (code, name, spec, unit, price) =>
      insert('INSERT INTO products(code,name,spec,unit,price,created_at) VALUES(?,?,?,?,?,?)', [code, name, spec, unit, price, now()]);
    pd('P2001', '传动轴', 'Φ40×320', '件', 128);
    pd('P2002', '齿轮箱体', 'GB-220A', '件', 460);
    pd('P2003', '液压阀块', 'HV-08', '件', 320);
    pd('P2004', '连接法兰', 'DN100', '件', 86);
    pd('P2005', '支撑支架', 'SC-150', '件', 74);
    pd('P2006', '精密衬套', 'Φ25×60', '件', 42);
    pd('P2007', '电机端盖', 'MD-330', '件', 156);
    pd('P2008', '输送辊筒', 'Ø89×600', '件', 210);

    // 工艺路线（每个产品一条，工序组合不同）
    const rt = (code, name, product_id, steps) => {
      const rid = insert('INSERT INTO routes(code,name,product_id,created_at) VALUES(?,?,?,?)', [code, name, product_id, now()]);
      steps.forEach((s, i) => {
        const p = get('SELECT std_time,std_price,inspect_type FROM processes WHERE id=?', [s[0]]);
        run('INSERT INTO route_steps(route_id,seq,process_id,work_center_id,std_time,std_price,need_report,inspect_type) VALUES(?,?,?,?,?,?,1,?)',
          [rid, (i + 1) * 10, s[0], s[1], p.std_time, p.std_price, p.inspect_type || '']);
      });
      return rid;
    };
    rt('R-P2001', '传动轴标准工艺', 1, [[1, 1], [2, 1], [4, 3], [7, 6], [8, 6]]);
    rt('R-P2002', '齿轮箱体加工工艺', 2, [[1, 1], [3, 2], [4, 3], [6, 5], [7, 6], [8, 6]]);
    rt('R-P2003', '液压阀块工艺', 3, [[1, 1], [3, 2], [4, 3], [7, 6], [8, 6]]);
    rt('R-P2004', '连接法兰工艺', 4, [[1, 1], [2, 1], [7, 6], [8, 6]]);
    rt('R-P2005', '支撑支架工艺', 5, [[1, 1], [5, 4], [7, 6], [8, 6]]);
    rt('R-P2006', '精密衬套工艺', 6, [[1, 1], [2, 1], [4, 3], [7, 6]]);
    rt('R-P2007', '电机端盖工艺', 7, [[1, 1], [3, 2], [7, 6], [8, 6]]);
    rt('R-P2008', '输送辊筒工艺', 8, [[1, 1], [2, 1], [5, 4], [7, 6], [8, 6]]);

    ['尺寸超差', '表面划伤', '气孔砂眼', '材料缺陷', '装配不良', '螺纹损坏', '磕碰变形', '其他'].forEach((n) =>
      run('INSERT INTO bad_reasons(name) VALUES(?)', [n]));

    createSeedOrders();

    // 演示：仓库 + 物料档案 + 来料记录 & 成品入库（同步生成库存台账与收发明细）
    try {
      // 幂等：旧库升级时可能已补过默认仓库
      const w1 = (get('SELECT id FROM warehouses WHERE code=?', ['WH01']) || {}).id
        || insert('INSERT INTO warehouses(code,name,remark,created_at) VALUES(?,?,?,?)', ['WH01', '主仓库', '原料存放', now()]);
      const w2 = (get('SELECT id FROM warehouses WHERE code=?', ['WH02']) || {}).id
        || insert('INSERT INTO warehouses(code,name,remark,created_at) VALUES(?,?,?,?)', ['WH02', '成品仓', '成品存放', now()]);
      const mkMat = (code, name, spec, material, category, unit, wid, loc, smin, smax) =>
        insert(`INSERT INTO materials(code,name,spec,material,category,unit,warehouse_id,location,safe_min,safe_max,active,remark,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`, [code, name, spec, material, category, unit, wid, loc, smin, smax, null, now()]);
      const m1 = mkMat('RM-001', '45#圆钢', 'Φ45', '45#', '原料', 'kg', w1, 'A-01', 200, 3000);
      const m2 = mkMat('RM-002', '深沟球轴承', '6204-2RS', 'GCr15', '原料', '套', w1, 'A-02', 300, 800);
      const m3 = mkMat('P2002', '齿轮箱体', 'GB-220A', null, '成品', '件', w2, 'B-01', 50, 500);
      const so = get('SELECT id,product_id FROM orders ORDER BY id LIMIT 1');
      const sp = so ? get('SELECT code,name,spec FROM products WHERE id=?', [so.product_id]) : null;
      let m4 = null;
      if (so && sp) {
        const ex = get('SELECT id FROM materials WHERE code=?', [sp.code]);
        m4 = ex ? ex.id : mkMat(sp.code, sp.name, sp.spec, null, '成品', '件', w2, 'B-02', 30, 600);
      }
      // 入账：更新台账 + 写一条收发明细
      const addStock = (mid, wid, batch, qty, txType, refType, refId, refCode, orderId, operator, date, remark) => {
        let r = get('SELECT * FROM inventory WHERE material_id=? AND IFNULL(warehouse_id,0)=? AND IFNULL(batch,\'\')=?', [mid, wid || 0, batch || '']);
        if (!r) {
          const id = insert('INSERT INTO inventory(material_id,warehouse_id,batch,location,qty,updated_at) VALUES(?,?,?,?,0,?)', [mid, wid || null, batch || null, null, now()]);
          r = get('SELECT * FROM inventory WHERE id=?', [id]);
        }
        const before = Number(r.qty) || 0, after = before + qty;
        run('UPDATE inventory SET qty=?,updated_at=? WHERE id=?', [after, now(), r.id]);
        insert(`INSERT INTO inventory_tx(material_id,warehouse_id,batch,tx_type,qty,before_qty,after_qty,ref_type,ref_id,ref_code,order_id,operator,tx_date,remark,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [mid, wid || null, batch || null, txType, qty, before, after, refType, refId, refCode, orderId || null, operator, date, remark, now()]);
      };

      const i1 = insert(`INSERT INTO incoming_materials(code,incoming_date,supplier,material_id,warehouse_id,material_code,material_name,material_spec,qty,unit,batch,order_id,inspector,result,remark,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['LM26090101', '2026-09-01', '瑞泰机械有限公司', m1, w1, 'RM-001', '45#圆钢', 'Φ45', 500, 'kg', 'B250901', so ? so.id : null, '李伟', 'qualified', '首件检验合格', 1, now()]);
      addStock(m1, w1, 'B250901', 500, 'in_incoming', 'incoming_materials', i1, 'LM26090101', so ? so.id : null, '李伟', '2026-09-01', '来料入库 LM26090101');
      const i2 = insert(`INSERT INTO incoming_materials(code,incoming_date,supplier,material_id,warehouse_id,material_code,material_name,material_spec,qty,unit,batch,order_id,inspector,result,remark,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['LM26090201', '2026-09-02', '华东汽车零部件厂', m2, w1, 'RM-002', '深沟球轴承', '6204-2RS', 200, '套', 'B250902', null, '陈静', 'qualified', '待复检', 1, now()]);
      addStock(m2, w1, 'B250902', 200, 'in_incoming', 'incoming_materials', i2, 'LM26090201', null, '陈静', '2026-09-02', '来料入库 LM26090201');
      const f1 = insert(`INSERT INTO finished_goods_in(code,in_date,order_id,material_id,warehouse_id,product_code,product_name,spec,qty,unit,batch,location,inspector,result,remark,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['RK26090601', '2026-09-06', null, m3, w2, 'P2002', '齿轮箱体', 'GB-220A', 120, '件', 'P250906', 'B-01', '刘洋', 'qualified', '补库入库', 1, now()]);
      addStock(m3, w2, 'P250906', 120, 'in_finish', 'finished_goods_in', f1, 'RK26090601', null, '刘洋', '2026-09-06', '成品入库 RK26090601');
      if (so && sp && m4) {
        const f2 = insert(`INSERT INTO finished_goods_in(code,in_date,order_id,material_id,warehouse_id,product_code,product_name,spec,qty,unit,batch,location,inspector,result,remark,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['RK26090501', '2026-09-05', so.id, m4, w2, sp.code, sp.name, sp.spec, 300, '件', 'P250905', 'B-02', '王强', 'qualified', '完工入库', 1, now()]);
        addStock(m4, w2, 'P250905', 300, 'in_finish', 'finished_goods_in', f2, 'RK26090501', so.id, '王强', '2026-09-05', '成品入库 RK26090501');
      }
    } catch (e) { /* 演示数据失败不影响主流程 */ }
  });
  return true;
}

/* 演示工单 + 历史报工 */
function createSeedOrders() {
  const workers = all("SELECT id,name,work_center_id FROM users WHERE role='worker'");
  const routes = all('SELECT id,product_id FROM routes');
  const customers = all('SELECT id FROM customers');
  const reasons = all('SELECT name FROM bad_reasons');

  const plans = [
    { p: 1, qty: 1200, cust: 1, pr: 1, offsetStart: -6, offsetEnd: 4 },
    { p: 2, qty: 300, cust: 2, pr: 1, offsetStart: -4, offsetEnd: 6 },
    { p: 3, qty: 500, cust: 3, pr: 2, offsetStart: -8, offsetEnd: 1 },
    { p: 4, qty: 2000, cust: 4, pr: 2, offsetStart: -3, offsetEnd: 5 },
    { p: 5, qty: 800, cust: 5, pr: 3, offsetStart: -2, offsetEnd: 8 },
    { p: 6, qty: 3000, cust: 1, pr: 2, offsetStart: -10, offsetEnd: -1 },
    { p: 7, qty: 600, cust: 2, pr: 1, offsetStart: -1, offsetEnd: 9 },
    { p: 8, qty: 400, cust: 3, pr: 3, offsetStart: -5, offsetEnd: 3 },
    { p: 1, qty: 900, cust: 4, pr: 2, offsetStart: 0, offsetEnd: 7 },
    { p: 4, qty: 1500, cust: 5, pr: 1, offsetStart: 1, offsetEnd: 10 },
    { p: 2, qty: 200, cust: 1, pr: 3, offsetStart: 2, offsetEnd: 12 },
    { p: 6, qty: 2500, cust: 2, pr: 2, offsetStart: 3, offsetEnd: 13 },
  ];

  let seq = 0;
  plans.forEach((pl, idx) => {
    seq++;
    const route = routes.find((r) => r.product_id === pl.p);
    const code = 'WO' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(1000 + seq).slice(1);
    // 前 5 张单已开工/完工，后面的处于待下发或已下发
    let status;
    if (idx === 0) status = 'running';
    else if (idx === 1) status = 'running';
    else if (idx === 2) status = 'paused';
    else if (idx === 3) status = 'running';
    else if (idx === 4) status = 'paused';
    else if (idx === 5) status = 'done';
    else if (idx < 9) status = 'released';
    else status = 'created';

    const oid = insert(
      'INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,plan_start,plan_end,status,remark,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        code, pl.p, route.id, pl.cust, pl.qty, pl.pr,
        dayOffset(pl.offsetStart), dayOffset(pl.offsetEnd), status,
        idx % 3 === 0 ? '客户加急，注意交期' : '', 1, dayOffset(pl.offsetStart - 1) + ' 08:00:00',
      ]);

    // 工单工序（透传工艺路线的检验点标记）
    const rsteps = all('SELECT * FROM route_steps WHERE route_id=? ORDER BY seq', [route.id]);
    const stepIds = rsteps.map((s) =>
      insert('INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,status,inspect_type) VALUES(?,?,?,?,?,?,?)',
        [oid, s.seq, s.process_id, s.work_center_id, pl.qty, 'pending', s.inspect_type || '']));

    // 生成历史报工
    if (status === 'done' || status === 'running' || status === 'paused') {
      const progressMap = { done: 1, running: 0.55, paused: 0.3 };
      const ratio = progressMap[status] * (0.7 + Math.random() * 0.3);
      const totalQty = Math.floor(pl.qty * ratio);

      // 按工序逐级递减（合格品流向下道工序）
      let remain = totalQty;
      rsteps.forEach((s, i) => {
        const sid = stepIds[i];
        const good = Math.max(0, remain - Math.floor(remain * (Math.random() * 0.05)));
        const bad = Math.max(0, remain - good);
        remain = good;

        run('UPDATE order_steps SET qty_good=?, qty_bad=?, work_min=?, status=?, assignee_id=?, start_time=? WHERE id=?', [
          good, bad, +(good * s.std_time / 60).toFixed(1),
          good > 0 ? 'done' : 'pending',
          workers[i % workers.length].id,
          dayOffset(pl.offsetStart) + ' 08:00:00',
          sid,
        ]);

        // 拆成近几天的报工流水
        const days = Math.max(1, Math.min(5, Math.ceil(-pl.offsetStart) || 1));
        let left = good;
        for (let d = 0; d < days && left > 0; d++) {
          const day = dayOffset(pl.offsetStart + d);
          const q = d === days - 1 ? left : Math.floor(good / days) + Math.floor(Math.random() * 20);
          const qg = Math.min(q, left);
          const qb = Math.random() < 0.25 ? Math.floor(qg * 0.03) : 0;
          left -= qg;
          if (qg <= 0) continue;
          insert('INSERT INTO reports(order_id,order_step_id,worker_id,work_center_id,qty_good,qty_bad,bad_reason,work_min,report_date,remark,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            [oid, sid, workers[(i + d) % workers.length].id, s.work_center_id, qg, qb,
              qb ? reasons[Math.floor(Math.random() * reasons.length)].name : '',
              +(qg * s.std_time / 60).toFixed(1), day, '',
              day + ' ' + (8 + Math.floor(Math.random() * 9)) + ':' + String(Math.floor(Math.random() * 60)).padStart(2, '0') + ':00']);
        }
      });

      if (status === 'running') {
        run('UPDATE orders SET start_time=? WHERE id=?', [dayOffset(pl.offsetStart) + ' 08:00:00', oid]);
        run("UPDATE order_steps SET status='running' WHERE order_id=? AND qty_good < qty_plan AND id=(SELECT MIN(id) FROM order_steps WHERE order_id=? AND qty_good < qty_plan)", [oid, oid]);
      } else if (status === 'done') {
        run("UPDATE orders SET start_time=?, finish_time=?, status='done' WHERE id=?",
          [dayOffset(pl.offsetStart) + ' 08:00:00', dayOffset(0) + ' 17:30:00', oid]);
      }
    }
  });

  // 为在制工单补一批「今天」的报工，保证看板首屏有实时数据
  all("SELECT * FROM orders WHERE status='running'").forEach((o, i) => {
    const step = get('SELECT * FROM order_steps WHERE order_id=? AND qty_good < qty_plan ORDER BY seq LIMIT 1', [o.id]);
    if (!step) return;
    const qg = 40 + Math.floor(Math.random() * 130);
    const qb = Math.random() < 0.6 ? Math.floor(qg * 0.02) + 1 : 0;
    const worker = workers[(i + 2) % workers.length];
    const hour = 8 + i * 2;
    insert(`INSERT INTO reports(order_id,order_step_id,worker_id,work_center_id,qty_good,qty_bad,bad_reason,work_min,report_date,remark,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [o.id, step.id, worker.id, step.work_center_id, qg, qb, qb ? reasons[(i * 3) % reasons.length].name : '',
        +(qg * 0.15).toFixed(1), today(), '',
        today() + ' ' + hour + ':' + String(10 + i * 7).padStart(2, '0') + ':00']);
    run("UPDATE order_steps SET qty_good=qty_good+?, qty_bad=qty_bad+?, work_min=work_min+?, status='running', start_time=IFNULL(start_time,?) WHERE id=?",
      [qg, qb, +(qg * 0.15).toFixed(1), now(), step.id]);
  });

  // 演示「待检」样本：把一张在制工单的检验点工序置为待检，质检台首屏即有数据可判
  try {
    const po = get("SELECT * FROM orders WHERE status='running' ORDER BY id LIMIT 1");
    const pstep = po ? get("SELECT * FROM order_steps WHERE order_id=? AND IFNULL(inspect_type,'')<>'' AND qty_good>0 ORDER BY seq LIMIT 1", [po.id]) : null;
    if (pstep) run("UPDATE order_steps SET inspect_status='waiting' WHERE id=?", [pstep.id]);
  } catch (e) { /* 忽略 */ }

  run('INSERT INTO logs(user_id,user_name,action,detail,created_at) VALUES(?,?,?,?,?)',
    [1, '张建国', '系统初始化', '写入演示数据：12 张工单 / 8 个产品 / 8 道工序', now()]);
}

module.exports = { db, all, get, run, insert, tx, seed, hashPassword, log, now, today, dayOffset };
