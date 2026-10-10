# APP 自更新功能说明（2026-10-10）

## 一句话

管理员在电脑端上传新 APK → 手机端「我的 → 检查更新」一键下载并安装，工人不必再扫码侧载。

## 为什么需要

此前每次升级都要：把APK 传到服务器 → 让工人扫码 install.html → 下载 → 手动安装。
车间人多、机型杂，版本必然参差不齐。工单报工照片、检验判定这些功能一升级就断档。

## 三层架构

```
[PC 端 app-release.html]  管理员上传 APK + 填版本
         │ POST /api/app/version (base64)
         ▼
[服务端]  app_versions 表 + /apk/<file> 下载（支持 Range）
         ▲ GET /api/app/version?code=N
         │
[移动端 m/app]  我的 → 检查更新 → 显示新版本 → 下载进度 → 调起系统安装
         │ Capacitor 原生插件 AppUpdater
         ▼
[Android]  AppUpdaterPlugin.java
```

WebView 做不到三件事，必须原生：调起系统安装器、写文件到安装器可读位置、读PackageManager 的 versionCode。

## 运营用法

### 发版（管理员）

1. PC 端菜单「版本发布」（仅 admin 可见），或直接访问 `/app-release.html`
2. 先构建 APK：`mes/app/` 下 `node build_www.js && npx cap sync android && cd android && gradlew.bat assembleDebug`
3. **关键**：`app/android/app/build.gradle` 里的 `versionCode` 必须 +1（每次出包都要）
4. 回发布页填：版本号 code（与 build.gradle 一致）、版本名称、选 APK、填更新说明
5. 按需勾「强制更新」（版本停用时用，见下）
6. 点发布 → 手机端随即可见

### 手机端

- 「我的 → 检查更新」手动检查，有新版会显示版本号、大小、更新说明
- 有新版时「我的」页版本号标红提示
- 强制更新时 APP 启动即跳转更新页
- 浏览器（非 APK）打开时会降级为直接下载 APK，不会报错

## 接口清单

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/app/version?code=N` | 免登录 | 查最新版本；code 为客户端本地 versionCode |
| GET | `/api/app/versions` | admin/technician | 版本记录列表 |
| POST | `/api/app/version` | admin | 发布新版本（APK 走 base64） |
| PUT | `/api/app/version/:id` | admin | 设发布版 / 切强制标记 |
| GET | `/apk/<file>` | 免登录 | APK 下载，支持 Range |

## 关键设计决策

**用 version_code 整数比较，不用 version_name 字符串**
字符串比大小会踩`'1.10' < '1.9'` 的坑。版本名只是给人看的。

**强制更新与「有新版」是两个独立字段**
`need_update`（本地版本低于发布版）和 `forced`（标记为强制且本地被卡住）。
早期把强制并进 need_update，导致 code 高于发布版的客户端 forced=false，强制标记形同虚设。

**发布时校验 APK 文件头**
base64 上传可能被截断成 HTML 错误页。校验 ZIP魔数 `PK\x03\x04`，不符直接拒绝。

**发布时自动算 sha256**
让客户端能校验传输完整性，且能对照出是不是同一个包。

**用事务保证「当前发布版」唯一**
`UPDATE ... SET is_current=0` 与 `INSERT is_current=1` 同事务，避免并发发布出两个当前版。

**APK 走 base64 而非 multipart**
与项目既有 base64 落盘范式一致（storeScanPhoto），不引入 multipart 解析依赖。
代价是体积膨胀约 1/3，已把 version/release/apk 路由的请求体上限放宽到 80MB。

**下载放getExternalFilesDir，不用公共 Download**
免存储权限；公共目录 Android 10+ 分区存储受限。

**Range 请求越界必须回 416，不能忽略后返回全量**
否则客户端进度会算错（以为下了 100% 实际只拿到片段）。

## 常见问题

**Q：发布后手机端提示"已是最新版本"**
A：检查 build.gradle 的 versionCode 是否真的 +1 了。客户端上报的 code 与服务端发布版相等即视为最新。

**Q：点「下载并安装更新」没反应 / 提示无法调起安装**
A：Android 8+ 需要「安装未知来源应用」授权。APP 会先检查，没授权会弹窗引导去系统设置。

**Q：一直显示"无法连接服务器"**
A：客户端 code 拿不到（未打包 APK 在浏览器打开）。用 APK 打开即可。

**Q：Range 下载后 APK 装不上**
A：检查 sha256 是否一致。服务端记录了发布时的校验和，可与手机端下载的包比对。

**Q：旧版本 APK 文件会一直占磁盘吗**
A：会。发布新版本不删旧文件，磁盘紧张需手工清理服务器 `data/uploads/apk/`。

## 已知限制

- **debug 包无签名**，覆盖安装同包名 debug APK 可行；后续若出 release 包签名不同，需先卸载旧版（会丢本地缓存，但服务端数据不受影响）
- 下载不校验 sha256（客户端未接），仅服务端记录供人工比对
- 强制更新只在启动与进「我的」时检查，未做全局路由拦截 —— 工人若不退出 APP 可继续用旧版操作

## 相关文件

- `lib/db.js` — app_versions 表定义
- `server.js` — 版本接口（搜「APP 自更新」）+ `/apk/` 下载路由
- `public/m/app/app.js` — checkUpdate / renderUpdate / UPD 模块
- `public/m/app/app.css` — .pbar 进度条 / .clog 更新说明样式
- `public/app-release.html` — PC 端发布页
- `app/android/app/src/main/java/cn/meslight/app/AppUpdaterPlugin.java` — 原生插件
- `app/android/app/src/main/java/cn/meslight/app/MainActivity.java` — 插件注册
- `test_update.cjs` — 106 断言