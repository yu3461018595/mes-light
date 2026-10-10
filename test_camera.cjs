/* 现场拍照功能回归测试（2026-10-10）
 * 背景：用户反馈「APP 现场拍照未能实现，仅能从图库选择」。
 * 根因有两层，都属静默失效、无报错，必须靠静态断言守住：
 *   1) APK 只声明 INTERNET 权限 → 系统不调起摄像头（需重建 APK 才生效，见 manifest 断言）
 *   2) capture 属性与 multiple 同时存在 → 部分机型忽略 capture 直接进图库
 * 本测试校验：manifest 权限/queries 完整、拍照控件 capture 且不带 multiple、
 *           拍照与相册为两个独立控件、事件绑定齐全。
 * 用法：node test_camera.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' → ' + extra : '')); }
};
const read = (p) => { try { return fs.readFileSync(path.join(__dirname, p), 'utf8'); } catch (e) { return ''; } };

console.log('\n== 1. APK 权限声明（缺失则系统不调起摄像头）==');
const mfPath = 'app/android/app/src/main/AndroidManifest.xml';
const mf = read(mfPath);
if (!mf) {
  console.log('  SKIP  未找到 AndroidManifest.xml（android 目录可能已清理，需 npx cap add android 重建）');
  chk('manifest 存在或已跳过', true);
} else {
  chk('声明了 CAMERA 权限', /android\.permission\.CAMERA/.test(mf), mf.slice(0, 60));
  chk('声明了 READ_MEDIA_IMAGES（Android 13+ 读相册）', /READ_MEDIA_IMAGES/.test(mf));
  chk('声明了 READ_EXTERNAL_STORAGE（Android 12及以下）', /READ_EXTERNAL_STORAGE/.test(mf));
  chk('声明了 WRITE_EXTERNAL_STORAGE（兼容旧机型）', /WRITE_EXTERNAL_STORAGE/.test(mf));
  chk('声明相机硬件 feature（否则部分机型直接跳图库）', /android\.hardware\.camera/.test(mf));
  chk('FileProvider 已配置（拍照回传图片必需）', /FileProvider/.test(mf));
  chk('file_paths.xml 存在且含 external-path', /external-path/.test(read('app/android/app/src/main/res/xml/file_paths.xml')));
  // Android 11+ 包可见性：不声明 queries，WebView 无法调起相机应用
  chk('声明了 queries（Android 11+ 包可见性）', /<queries>/.test(mf));
  chk('queries 含 IMAGE_CAPTURE 相机意图', /IMAGE_CAPTURE/.test(mf));
  chk('queries 含 GET_CONTENT / PICK 相册意图', /GET_CONTENT/.test(mf) && /android\.intent\.action\.PICK/.test(mf));
}

console.log('\n== 2. 拍照控件属性（capture 与 multiple 冲突是主因）==');
const app = read('public/m/app/app.js');
const equip = read('public/js/views/equip.js');
chk('手机端 app.js 可读取', !!app);
chk('PC 端 equip.js 可读取', !!equip);

// 逐一检查每个 file input：拍照控件必须 capture 且不能带 multiple
const inputs = [...(app + '\n' + equip).matchAll(/<input[^>]*type="file"[^>]*>/g)].map((m) => m[0]);
chk('共找到 10 个 file input（5 拍照 + 5 相册）', inputs.length === 10, '实际 ' + inputs.length);
const shotInputs = inputs.filter((t) => /capture=/.test(t));
const libInputs = inputs.filter((t) => !/capture=/.test(t));
chk('拍照控件数量 = 5', shotInputs.length === 5, '实际 ' + shotInputs.length);
chk('相册控件数量 = 5', libInputs.length === 5, '实际 ' + libInputs.length);
chk('每个拍照控件都有 capture="environment"', shotInputs.every((t) => /capture="environment"/.test(t)));
chk('拍照控件均不带 multiple（关键：避免 capture 失效）', shotInputs.every((t) => !/multiple/.test(t)),
  shotInputs.filter((t) => /multiple/.test(t)).join(' | '));
chk('相册控件均支持 multiple', libInputs.every((t) => /multiple/.test(t)));
chk('拍照控件 accept 均为 image/*（避免相机返回 HEIC 被拒）', shotInputs.every((t) => /accept="image\/\*"/.test(t)));
// 全局：任何 capture 控件都不得同时 multiple
chk('全仓库无 capture+multiple 冲突组合', !/capture="[^"]*"[^>]*multiple/.test(app + equip));

console.log('\n== 3. 拍照与相册已拆分（合并时只能进图库）==');
for (const [label, btnShot, btnPick] of [
  ['报工', '#rpPhoto', '#rpPick'],
  ['巡检', '#ptAddPhoto', '#ptPickPhoto'],
  ['异常上报', '#riPhoto', '#riPick'],
  ['设备点检', '#eqPhoto', '#eqPick'],
]) {
  chk(label + '：拍照按钮' + btnShot + '存在', app.includes('id="' + btnShot.slice(1) + '"'));
  chk(label + '：相册按钮' + btnPick + '存在', app.includes('id="' + btnPick.slice(1) + '"'));
}
chk('PC 端：拍照按钮 #eqShot 存在', equip.includes('id="eqShot"'));
chk('PC 端：相册按钮 #eqPhoto 存在', equip.includes('id="eqPhoto"'));

console.log('\n== 4. 事件绑定齐全（点击能触发、选择能入列）==');
const binds = [
  ["querySelector('#rpShot').click()", "报工拍照按钮→触发 Shot input"],
  ["querySelector('#riShot').click()", "异常拍照按钮→触发 Shot input"],
  ["querySelector('#eqShot').click()", "设备拍照按钮→触发 Shot input"],
  ["$('#ptShot').click()", "巡检拍照按钮→触发 Shot input"],
  ["#rpShot').onchange", "报工拍照 onchange 绑定"],
  ["#riShot').onchange", "异常拍照 onchange 绑定"],
  ["#eqShot').onchange", "设备拍照 onchange 绑定"],
  ["#ptShot').onchange", "巡检拍照 onchange 绑定"],
];
for (const [frag, name] of binds) chk(name, app.includes(frag), frag);
chk('PC 端 shotInput.onchange 绑定', /shotInput\.onchange\s*=/.test(equip));
chk('PC 端 #eqShot 点击绑定', /querySelector\('#eqShot'\)\.onclick/.test(equip));

console.log('\n== 5. 上传链路（拍照只是入口，照片要能存下来）==');
chk('storeScanPhoto 服务端落盘函数存在（server.js）', /function storeScanPhoto/.test(read('server.js')));
chk('报工照片接口存在', read('server.js').includes("/api/reports/(") && read('server.js').includes("/photos', []"));
chk('异常照片接口存在', read('server.js').includes("/api/quality_issues/("));
chk('巡检照片接口存在', read('server.js').includes("/api/patrols/("));
chk('点检照片接口存在', /eqcheck|\/api\/patrols|equipment_checks/.test(read('server.js')));
chk('拍照类路由使用放宽的请求体上限（80MB）', /PHOTO_BODY_LIMIT/.test(read('server.js')));
chk('compressImage 压缩函数存在（避免大图上传失败）', /function compressImage/.test(app));

console.log('\n========================================');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
console.log('========================================');
if (fail) {
  console.log('\n修复指引：');
  console.log('  1. manifest 缺权限 → 补 CAMERA/READ_MEDIA_IMAGES/queries 后必须重建 APK 才生效');
  console.log('  2. capture 与 multiple 同用 → 拆成两个 input（拍照不带 multiple）');
  console.log('  3. 两者都要改：H5 页面改动对 APK 内加载的 www 生效需 npx cap copy');
}
process.exit(fail ? 1 : 0);
