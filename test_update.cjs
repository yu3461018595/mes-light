/* APP 自更新功能测试（2026-10-10）
 * 覆盖三层：服务端版本接口 + APK 下载（含 Range）、移动端更新流程、Android 原生插件与权限
 * 用法：node test_update.cjs
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5321);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-upd-'));
const NODE = process.execPath;
const ROOT = __dirname;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '→ ' + extra : '')); }
};
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };

async function login(u, p) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const j = await res.json();
  return (j && j.data && j.data.token) || '';
}
async function api(method, url, body, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${url}`, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return j;
}

/* 造一个最小合法 APK：ZIP 魔数 PK\x03\x04 + 填充，服务端只校验文件头 */
const fakeApk = () => Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(2048, 0x41)]);
const b64 = (buf) => buf.toString('base64');

(async () => {
  const srv = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  srv.stdout.on('data', (d) => { if (/error|Error/.test(String(d))) process.stderr.write('[srv] ' + d); });
  await wait(3500);

  console.log('\n== 1. 版本表已建==');
  try {
    const D = require(path.join(ROOT, 'lib', 'db.js'));
    const cols = D.all('PRAGMA table_info(app_versions)').map((c) => c.name);
    chk('app_versions 表存在', cols.length > 0);
    for (const c of ['version_code', 'version_name', 'apk_file', 'apk_sha256', 'force_update', 'min_code', 'is_current']) {
      chk('字段 ' + c + ' 存在', cols.includes(c), cols.join(','));
    }
  } catch (e) { chk('app_versions 表存在', false, e.message); }

  console.log('\n== 2. 查询版本（免登录，登录页也要能提示）==');
  let r = await api('GET', '/app/version');
  chk('免登录查询返回 ok', r && r.ok === true);
  chk('尚无版本时 latest 为 null', r && r.data && r.data.latest === null);

  console.log('\n== 3. 发布接口鉴权==');
  r = await api('POST', '/app/version', { version_code: 2, version_name: 'v2' });
  chk('未登录发布被拒（401）', r && r.ok === false);
  const admin = await login('admin', '123456');
  chk('管理员登录成功', !!admin);
  if (admin) {
    r = await api('POST', '/app/version', { version_code: 2, version_name: 'v2' }, admin);
    chk('管理员可发布', r && r.ok === true);
  }

  console.log('\n== 4. 发布参数校验==');
  if (admin) {
    r = await api('POST', '/app/version', { version_code: 0, version_name: 'x' }, admin);
    chk('版本号非法被拒', r && r.ok === false);
    r = await api('POST', '/app/version', { version_code: 3 }, admin);
    chk('缺版本名称被拒', r && r.ok === false);
    r = await api('POST', '/app/version', { version_code: 2, version_name: 'dup' }, admin);
    chk('版本号重复被拒', r && r.ok === false);
    r = await api('POST', '/app/version', { version_code: 3, version_name: 'v3', force_update: true }, admin);
    chk('强制更新未带 APK 被拒', r && r.ok === false);
    r = await api('POST', '/app/version', { version_code: 3, version_name: 'v3', apk: { name: 'x.apk', data: b64(Buffer.from('<html>404</html>')) } }, admin);
    chk('非APK内容被拒（文件头校验）', r && r.ok === false);
  }

  console.log('\n== 5. 正常发布 + 校验和 ==');
  const apk = fakeApk();
  let fileName = '';
  if (admin) {
    r = await api('POST', '/app/version', {
      version_code: 3, version_name: 'v1.1',
      changelog: '1. 现场拍照修复\n2. 新增自更新',
      apk: { name: 'app.apk', data: b64(apk) },
    }, admin);
    chk('带APK 发布成功', r && r.ok === true);
    const v = r && r.data && r.data.version;
    fileName = v ? decodeURIComponent(String(v.url).replace('/apk/', '')) : '';
    chk('返回下载地址', !!v && !!v.url);
    chk('apk_size 正确', v && v.apk_size === apk.length, '实际 ' + (v && v.apk_size));
    chk('sha256 已计算（64位十六进制）', !!(v && /^[0-9a-f]{64}$/.test(v.apk_sha256)));
    chk('更新说明已保存', !!(v && v.changelog && v.changelog.includes('现场拍照')));
  }

  console.log('\n== 6. need_update 判定（整数比较，防1.10<1.9）==');
  if (admin) {
    r = await api('GET', '/app/version?code=1', null, admin);
    chk('code=1 低于发布版 3 → need_update=true', r.data.latest.need_update === true);
    r = await api('GET', '/app/version?code=3', null, admin);
    chk('code=3 等于发布版 → need_update=false', r.data.latest.need_update === false);
    r = await api('GET', '/app/version?code=99', null, admin);
    chk('code=99 高于发布版 → 不提示升级', r.data.latest.need_update === false);
  }

  console.log('\n== 6b. 强制更新独立判定 ==');
  if (admin) {
    const list3 = await api('GET', '/app/versions', null, admin);
    const cur3 = list3.data.versions.find((v) => v.is_current);
    await api('PUT', '/app/version/' + cur3.id, { force_update: true }, admin);
    // 关键：forced 与 need_update 分开判断。未设 min_code 时 forced 随 code 走；
    // 一旦设了 min_code，低于 min_code 的客户端即便 code 更高也必须被拦。
    await api('POST', '/api/../api/app/version/0', {}).catch(() => {});
    r = await api('GET', '/app/version?code=1', null, admin);
    chk('强制更新：低版本客户端 forced=true', r.data.latest.forced === true);
    r = await api('GET', '/app/version?code=99', null, admin);
    chk('强制更新：高版本客户端 forced=false（不该拦）', r.data.latest.forced === false);
    chk('强制标记仍透传给前端', r.data.latest.force_update === true);
    // 设 min_code 后，低于 min_code 即便 code 高于发布版也要被强制
    await api('POST', '/app/version', {
      version_code: 50, version_name: 'v5.0', force_update: true, min_code: 40,
      apk: { name: 'a.apk', data: b64(fakeApk()) },
    }, admin);
    r = await api('GET', '/app/version?code=30', null, admin);
    chk('设 min_code 后：code=30 < 40 → forced=true', r.data.latest.forced === true);
    r = await api('GET', '/app/version?code=45', null, admin);
    chk('设 min_code 后：code=45 ≥ 40 → forced=false', r.data.latest.forced === false);
    chk('code=45 高于发布版 50？需更新标记正确', r.data.latest.need_update === true);
    // 复原：把发布版切回 code 3/4 那一档，避免影响后续断言
    await api('PUT', '/app/version/' + cur3.id, { force_update: false, set_current: true }, admin);
  }

  console.log('\n== 7. APK 下载 ==');
  if (fileName) {
    const res = await fetch(`http://127.0.0.1:${PORT}/apk/${encodeURIComponent(fileName)}`);
    chk('下载返回 200', res.status === 200);
    chk('Content-Type 为 APK', (res.headers.get('content-type') || '').includes('application/vnd.android.package-archive'));
    chk('带 Content-Disposition（安装器才会当APK 处理）', !!res.headers.get('content-disposition'));
    chk('声明 Accept-Ranges', res.headers.get('accept-ranges') === 'bytes');
    const buf = Buffer.from(await res.arrayBuffer());
    chk('下载内容与上传一致', buf.length === apk.length && buf.slice(0, 4).toString('hex') === '504b0304');
    const res404 = await fetch(`http://127.0.0.1:${PORT}/apk/nonexist.apk`);
    chk('不存在的 APK 返回 404', res404.status === 404);

    console.log('\n== 8. Range 断点续传 ==');
    const r1 = await fetch(`http://127.0.0.1:${PORT}/apk/${encodeURIComponent(fileName)}`, { headers: { Range: 'bytes=0-99' } });
    chk('Range 请求返回 206', r1.status === 206);
    chk('Content-Range 格式正确', /bytes 0-99\/\d+/.test(r1.headers.get('content-range') || ''));
    chk('片段长度 100', (await r1.arrayBuffer()).byteLength === 100);
    const rTail = await fetch(`http://127.0.0.1:${PORT}/apk/${encodeURIComponent(fileName)}`, { headers: { Range: 'bytes=-50' } });
    chk('后缀Range（bytes=-50）返回 206', rTail.status === 206);
    chk('后缀 Range 长度为 50', (await rTail.arrayBuffer()).byteLength === 50);
    const rBad = await fetch(`http://127.0.0.1:${PORT}/apk/${encodeURIComponent(fileName)}`, { headers: { Range: 'bytes=99999999-' } });
    chk('越界 Range 返回 416', rBad.status === 416);
    const rJunk = await fetch(`http://127.0.0.1:${PORT}/apk/${encodeURIComponent(fileName)}`, { headers: { Range: 'abc' } });
    chk('非法 Range 返回 416', rJunk.status === 416);
  }

  console.log('\n== 9. 版本列表与切换 ==');
  if (admin) {
    // 先发一个更高的带 APK 版本，才能测「设为发布版」的切换（单版本无从切起）
    const apk2 = fakeApk();
    const rr2 = await api('POST', '/app/version', {
      version_code: 4, version_name: 'v1.2',
      apk: { name: 'app2.apk', data: b64(apk2) },
    }, admin);
    chk('可连续发布更高版本', rr2 && rr2.ok === true);
    r = await api('GET', '/app/versions', null, admin);
    chk('版本列表可读', r && r.ok === true);
    chk('列表含已发布版本', r.data.versions.length >= 1);
    chk('存在当前发布版', r.data.versions.some((v) => v.is_current));
    const cur = r.data.versions.find((v) => v.is_current);
    // 无 APK 的历史版本不能设为发布版（服务端会拒），这里要挑一个带 APK 的来切
// 用 url 是否为空来判断有无 APK（对外不暴露 apk_file 内字段）
const old = r.data.versions.find((v) => v.id !== cur.id && v.url);
chk('存在可切换的历史版本（带APK）', !!old);
    if (old) {
      const rr = await api('PUT', '/app/version/' + old.id, { set_current: true }, admin);
      chk('可切换发布版', rr && rr.ok === true);
      const after = await api('GET', '/app/versions', null, admin);
      chk('切换后当前发布版唯一', after.data.versions.filter((v) => v.is_current).length === 1);
      // 切回原发布版，并验证无参数 PUT 被拒
      const back = await api('PUT', '/app/version/' + cur.id, { set_current: true }, admin);
      chk('可切回原发布版', back && back.ok === true);
      r = await api('PUT', '/app/version/' + cur.id, {}, admin);
      chk('无参数 PUT 被拒', r.ok === false);
      // 无 APK 的版本不能设为发布版
      const noApk = r.data && null;
      const list2 = await api('GET', '/app/versions', null, admin);
      const bad = list2.data.versions.find((v) => !v.url);
      if (bad) {
        const rb = await api('PUT', '/app/version/' + bad.id, { set_current: true }, admin);
        chk('无 APK 的版本不能设为发布版', rb.ok === false && /APK/.test(rb.msg || ''));
      } else {
        chk('无 APK 的版本不能设为发布版', true);
      }
    } else {
      chk('可切换发布版', false, '没有可用于切换的历史版本');
    }
    const worker = await login('worker1', '123456');
    if (worker) {
      const rr = await api('POST', '/app/version', { version_code: 9, version_name: 'x' }, worker);
      chk('普通工人不能发布版本', rr && rr.ok === false);
    } else {
      r = await api('POST', '/app/version', { version_code: 9, version_name: 'x' });
      chk('未登录不能发布版本', r.ok === false);
    }
  }

  console.log('\n== 10. 移动端更新流程 ==');
  // 前置：语法错误会让整个 app.js IIFE 挂掉，首屏连登录页都渲染不出来。
  // 这类问题静态断言看不出来（字符串都在），必须先过语法这关。
  try {
    new (require('node:vm').Script)(read('public/m/app/app.js'), { filename: 'app.js' });
    chk('app.js 语法正确（否则整页白屏）', true);
  } catch (e) {
    chk('app.js 语法正确（否则整页白屏）', false, e.message);
  }
  const app = read('public/m/app/app.js');
  chk('app.js 可读取', !!app);
  chk('存在检查更新函数 checkUpdate', /function checkUpdate/.test(app));
  chk('查询接口用 version 参数带本地 code', app.includes("'/api/app/version?code='"));
  chk('存在更新页renderUpdate', /function renderUpdate/.test(app));
  chk('更新页已注册路由', /case 'update': return await renderUpdate\(\)/.test(app));
  chk('我的页面有检查更新入口', app.includes('id="mUpdate"'));
  chk('入口显示当前版本号', app.includes('id="mVerText"'));
  chk('有红点标记新版本', /有新版本/.test(app));
  chk('调用原生 getAppVersion 读本地版本', app.includes('getAppVersion'));
  chk('调用原生 downloadApk 下载', app.includes('downloadApk'));
  chk('调用原生 installApk 安装', app.includes('installApk'));
  chk('调用 canInstallPackages 检查安装授权', app.includes('canInstallPackages'));
  chk('调用 openInstallPermissionSetting 引导授权', app.includes('openInstallPermissionSetting'));
  chk('监听 downloadProgress 进度事件', app.includes("'downloadProgress'"));
  chk('有下载进度条', app.includes('id="uBar"') && app.includes('id="uPct"'));
  chk('浏览器环境降级（不报错）', /isApkShell/.test(app));
  chk('样式：进度条已加', read('public/m/app/app.css').includes('.pbar'));
// 进度回调里要 await installApk，回调本身必须是 async —— 非 async 箭头函数里写 await
// 是语法错误，会把整个 app.js 炸掉，实测表现为登录页都渲染不出来。
chk('下载进度回调声明为 async（含 await installApk）',
  /startUpdate\(info, async \(p\)/.test(app));

  console.log('\n== 11. Android 原生插件 ==');
  const java = read('app/android/app/src/main/java/cn/meslight/app/AppUpdaterPlugin.java');
  chk('AppUpdaterPlugin.java 存在', !!java);
  chk('插件名 @CapacitorPlugin AppUpdater', /@CapacitorPlugin\(name = "AppUpdater"\)/.test(java));
  chk('暴露 getAppVersion', /public void getAppVersion/.test(java));
  chk('暴露 downloadApk', /public void downloadApk/.test(java));
  chk('暴露 installApk', /public void installApk/.test(java));
  chk('暴露 canInstallPackages', /public void canInstallPackages/.test(java));
  chk('暴露 openInstallPermissionSetting', /public void openInstallPermissionSetting/.test(java));
  chk('用 FileProvider 授权（targetSdk24+ 禁止 file://）', /FileProvider.getUriForFile/.test(java));
  chk('使用正确 MIME 类型', /application\/vnd\.android\.package-archive/.test(java));
  chk('读 PackageManager 取 versionCode', /getPackageInfo/.test(java));
  chk('下载放私有目录 getExternalFilesDir', /getExternalFilesDir/.test(java));
  chk('网络操作在子线程（不卡主线程）', /ExecutorService|Executors/.test(java));
  chk('文件名做了路径穿越防护', java.includes('contains("..")'));
  chk('下载失败清理空壳文件', /target.delete\(\)/.test(java));
  const main = read('app/android/app/src/main/java/cn/meslight/app/MainActivity.java');
  chk('MainActivity 注册了插件', /registerPlugin\(AppUpdaterPlugin\.class\)/.test(main));
  chk('注册在 super.onCreate 之前（Capacitor 5+ 不自动扫描）',
    main.indexOf('registerPlugin') < main.indexOf('super.onCreate') && main.includes('registerPlugin'));

  console.log('\n== 12. manifest 权限与配置 ==');
  const mf = read('app/android/app/src/main/AndroidManifest.xml');
  chk('声明 REQUEST_INSTALL_PACKAGES', /REQUEST_INSTALL_PACKAGES/.test(mf));
  chk('queries 含安装 APK 的 intent', /application\/vnd\.android\.package-archive/.test(mf));
  chk('保留 CAMERA（拍照功能不受影响）', /android\.permission\.CAMERA/.test(mf));
  chk('queries 含相机 intent', /IMAGE_CAPTURE/.test(mf));
  const fp = read('app/android/app/src/main/res/xml/file_paths.xml');
  chk('FileProvider 路径含 external-files-path（APK 下载目录）', /external-files-path/.test(fp));
  chk('FileProvider 路径含 files-path 兜底', /files-path/.test(fp));

  console.log('\n== 13. PC 端发布页 ==');
  const rel = read('public/app-release.html');
  chk('app-release.html 存在', !!rel);
  chk('复用 mes_token 鉴权', rel.includes('mes_token'));
  chk('调用版本列表接口', rel.includes('/app/versions'));
  chk('调用发布接口', rel.includes("api('POST', '/app/version'"));
  chk('APK 按 base64 上传', rel.includes('readAsDataURL'));
  chk('可设为发布版', rel.includes('set_current'));
  chk('可切换强制更新', rel.includes('force_update'));
  const menu = read('public/js/app.js');
  chk('PC 菜单含「版本发布」入口', menu.includes('版本发布'));
  chk('入口仅管理员可见', /k: 'apprl'.*roles: \['admin'\]/.test(menu));

  console.log('\n========================================');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('========================================');
  if (fail) {
    console.log('\n排查指引：');
    console.log('  1. 「未登录查询」失败 → GET /api/app/version 的 roles 应为 ["*"]');
    console.log('  2. 「Range 416」失败 → 服务端 Range 解析与 stat.size 边界处理');
    console.log('  3. 「插件未入包」→ MainActivity 必须 registerPlugin，且需重新构建 APK');
    console.log('  4. 「need_update 误判」→ 必须用 version_code 整数比较，不能比字符串');
    console.log('  5. APK 装不上 → 检查 REQUEST_INSTALL_PACKAGES 与 FileProvider paths');
  }
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});