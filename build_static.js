/**
 * 生成静态版种子数据：把当前 SQLite 演示库导出为 public/data/seed.json
 * 供浏览器端数据层 Store 初始化使用（无需后端即可运行整套系统）。
 *
 * 用法： node build_static.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const D = require('./lib/db');

const TABLES = [
  'users', 'customers', 'processes', 'work_centers', 'products',
  'routes', 'route_steps', 'bad_reasons', 'orders', 'order_steps',
  'reports', 'logs',
];

const out = {};
for (const t of TABLES) {
  out[t] = D.all(`SELECT * FROM ${t}`);
}

const dir = path.join(__dirname, 'public', 'data');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'seed.json');
fs.writeFileSync(file, JSON.stringify(out, null, 0));

console.log('已生成 public/data/seed.json');
for (const t of TABLES) console.log('  ' + t.padEnd(14) + out[t].length + ' 条');
console.log('文件大小:', (fs.statSync(file).size / 1024).toFixed(1) + ' KB');
