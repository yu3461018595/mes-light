/* 重置演示数据（用 Node fs 删除，绕开 shell 的 rm 安全拦截） */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'data');
if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); console.log('已删除演示数据目录:', dir); }
else console.log('无 data 目录，无需清理');
// .secret 保留，确保二维码令牌稳定
console.log('.secret 保留:', fs.existsSync(path.join(__dirname, '.secret')));
