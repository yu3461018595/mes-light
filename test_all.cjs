#!/usr/bin/env node
/* 全量回归：串行跑所有 test_*.cjs，汇总通过/失败，任一失败则退出码非 0。
 * 注意：并跑会抢端口/临时库，必须串行。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = __dirname;

const files = fs.readdirSync(ROOT)
  .filter((f) => /^test_.*\.cjs$/.test(f) && f !== 'test_all.cjs')
  .sort();

const rows = [];
let failed = 0;

for (const f of files) {
  const out = path.join(ROOT, '.tmp_test_out', f + '.log');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, f)], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
    // Windows 下保持原 PATH（覆盖成 Unix 路径会导致 node 子进程无法启动）
    env: Object.assign({}, process.env, process.platform === 'win32' ? {} : { PATH: '/usr/bin:/bin:' + (process.env.PATH || '') }),
  });
  const ms = Date.now() - t0;
  const log = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(out, log);
  // 抓「共 N 项断言：通过 A，失败 B」这类汇总行
  const m = log.match(/共\s*(\d+)\s*项断言[：:]\s*通过\s*(\d+)[，,]\s*失败\s*(\d+)/);
  const okExit = r.status === 0;
  const summary = m ? `断言 ${m[2]}/${m[1]}（失败 ${m[3]}）` : (okExit ? '通过（无断言汇总）' : '失败');
  if (!okExit || (m && Number(m[3]) > 0)) failed++;
  rows.push({
    file: f, exit: r.status, ms,
    pass: m ? Number(m[2]) : null, total: m ? Number(m[1]) : null, failN: m ? Number(m[3]) : null,
    summary, ok: okExit && (!m || Number(m[3]) === 0),
  });
  process.stdout.write(`${rows[rows.length - 1].ok ? '✔' : '✘'} ${f.padEnd(28)} ${summary}  (${(ms / 1000).toFixed(1)}s)\n`);
}

console.log('\n————————————————————————');
console.log(`共 ${files.length} 个测试文件：通过 ${files.length - failed}，失败 ${failed}`);
const tp = rows.reduce((a, r) => a + (r.pass || 0), 0);
const tt = rows.reduce((a, r) => a + (r.total || 0), 0);
if (tt) console.log(`断言合计：通过 ${tp} / ${tt}`);
process.exit(failed ? 1 : 0);
