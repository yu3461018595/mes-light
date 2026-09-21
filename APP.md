# APP 打包指南（Android APK）

把现有 H5 移动工作台（`public/m/app/`）用 **Capacitor** 打成原生 Android APK。
主项目保持**零依赖**，所有打包相关的东西都隔离在 `app/` 子目录里。

---

## 一、为什么这么做

`public/m/app/` 已经是一个完整的移动端单页应用（登录 / 工作台 / 报工 / 质检 / 质量异常 / 库存预警 / 消息中心 / 我的），
并且已经支持 PWA（`manifest.json` + `sw.js`）。Capacitor 只做一件事：
**把这份 H5 装进一个 Android WebView 外壳，编译成 APK**，业务代码一行都不用改。

三端共用同一份前端代码：

| 形态 | 入口 | 说明 |
|------|------|------|
| 电脑网页 | `/` | PC 版完整后台 |
| 手机浏览器 / PWA | `/m/app/` | 可「添加到主屏幕」，秒开 |
| Android APK | 同 `/m/app/` | Capacitor 打包，可装到手机 |

---

## 二、环境（本机已装好，路径见下）

| 组件 | 版本 | 本机路径 |
|------|------|----------|
| Node.js | 22.22.2 | `C:\Users\Admin\.workbuddy\binaries\node\versions\22.22.2-3\node.exe` |
| JDK | Temurin 21.0.12.1+1 | `C:\Users\Admin\jdk21\jdk-21.0.12.1+1` |
| Android cmdline-tools | latest | `C:\Users\Admin\android-sdk\cmdline-tools\latest` |
| Android SDK | **platform-36** + platform-34 / build-tools 34.0.0 + 35.0.0 / platform-tools | `C:\Users\Admin\asdk` |
| Gradle | 8.14.3（华为云镜像下载） | `~/.gradle/wrapper/dists/gradle-8.14.3-all/<hash>/gradle-8.14.3` |
| Capacitor | 8.x | `mes\app\node_modules` |

> 以上都是**免管理员**安装的（zip 解压，不走 MSI）。
>
> ⚠️ **不要把 SDK 同时放在两个目录**。曾经有过 `C:\Users\Admin\android-sdk`（残缺）
> 与 `C:\Users\Admin\asdk`（完整）并存，构建时误指向残缺那份，导致卡死。
> 现在统一只用 **`C:\Users\Admin\asdk`**。
>
> ⚠️ **Capacitor 8 必须用 compileSdk 36**。`androidx.activity:1.11.0`、
> `androidx.core:1.17.0`、`androidx.core:core-splashscreen:1.2.0` 的 AAR 元数据
> 硬性要求 35+，用 34 会在 `checkDebugAarMetadata` 直接失败。安装方法见第七节。

### 每次构建前设置环境变量

```bat
set JAVA_HOME=C:\Users\Admin\jdk21\jdk-21.0.12.1+1
set ANDROID_HOME=C:\Users\Admin\asdk
set ANDROID_SDK_ROOT=C:\Users\Admin\asdk
set PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%
```

Capacitor 需要知道 SDK 位置，在 `app/android/local.properties` 写（`cap add android` 后再建）：

```properties
sdk.dir=C\:\\Users\\Admin\\asdk
```

---

## 三、打包步骤

```bat
cd app
npm install                 :: 首次
node build_www.js           :: 生成 app/www（离线模式才需要）
npx cap add android         :: 首次，生成 app/android 原生工程
npx cap sync android        :: 每次改前端后都要跑
```

编译 APK（**必须在沙箱外执行**，Gradle 要写 `~/.gradle/caches`）：

```bat
set JAVA_HOME=C:\Users\Admin\jdk21\jdk-21.0.12.1+1
set ANDROID_HOME=C:\Users\Admin\asdk
set ANDROID_SDK_ROOT=C:\Users\Admin\asdk
set GRADLE_OPTS=-Djava.io.tmpdir=C:\Users\Admin\gradle-home\.tmp
cd app\android
%USERPROFILE%\.gradle\wrapper\dists\gradle-8.14.3-all\5tfljrrqry1m9p18o354pood1\gradle-8.14.3\bin\gradle.bat assembleDebug --no-daemon
```

产物：`app/android/app/build/outputs/apk/debug/app-debug.apk`

> 首次构建约 5~6 分钟（要下依赖）；之后增量构建 30 秒级。
> `--no-daemon` 是为了避免 daemon 残留进程，慢一点但更省心。

正式签名包：

```bat
keytool -genkey -v -keystore mes.keystore -alias mes -keyalg RSA -keysize 2048 -validity 10000
gradlew.bat assembleRelease
```

安装到手机（USB 调试打开后）：

```bat
adb install -r app\android\app\build\outputs\apk\debug\app-debug.apk
```

---

## 四、服务器地址怎么配（二选一）

### 方案 A：APK 只做外壳，页面仍从服务器加载（推荐，当前阶段）

改 `app/capacitor.config.json`：

```json
{
  "server": {
    "url": "http://114.117.233.47:8080/m/app/",
    "cleartext": true
  }
}
```

优点：**改了后端或前端逻辑，手机端重开即生效，不用重新发版**。
`cleartext: true` 是 Android 9+ 允许 http 明文所必需。上了 HTTPS 后删掉它并改 `url`。

### 方案 B：把 H5 打进 APK，完全离线（演示用）

删掉 `capacitor.config.json` 里的整个 `server` 段，保留 `webDir: "www"`，
然后跑 `node build_www.js` 生成 `app/www/`（静态模式，数据存 localStorage）。

---

## 五、已知限制

- **扫码**：WebView 里 `getUserMedia` 需额外授权。当前 H5 扫码已内置
  「手输工单号 / 粘贴链接」降级方案，**不依赖相机也能跑通全流程**。
- **推送**：当前是**站内消息中心 + 15 秒轮询 + 角标**，不依赖 FCM/厂商通道，
  熄屏时不实时。要真推送需接 FCM 或个推，属二期。
- **HTTPS**：Android 9+ 限制 http；上线正式版前必须配域名 + HTTPS。

---

## 六、当前状态（已上线）

- [x] H5 移动工作台全部页面完成，渲染冒烟 42/42 通过
- [x] PWA（manifest 图标尺寸已校正、sw 缓存升 v7 并纳入 APP shell）
- [x] Capacitor 工程（`app/capacitor.config.json`、`app/package.json`、`app/build_www.js`）
- [x] 离线包 `app/www/` 生成并验证（`test_www_bundle.cjs` 17/17：无后端也能出登录页）
- [x] JDK 21 + Android cmdline-tools 免管理员安装完成
- [x] **platform-36 离线安装完成**（长路径手工解包）
- [x] **`cap add android` + 编译出 APK** —— `BUILD SUCCESSFUL in 5m 36s`
- [x] 全量回归 **18 个测试文件 / 226 项断言全绿**（约 21 秒）
- [x] **已推送 GitHub main（`9882d0b7`）并部署上线**

### 线上地址

| 入口 | 地址 |
|---|---|
| PC 后台 | `http://114.117.233.47:8080/` |
| 移动端 / PWA | `http://114.117.233.47:8080/m/app/` |
| APK 内置入口 | 同上（`capacitor.config.json` 的 `server.url`） |

**登录**：用户名为中文姓名（如 `管理员`、`丁桢`），初始密码 `123456`。

> ⚠️ **线上目前没有「质检员」角色的账号**。一期检验模式虽已上线，
> 但要真正走「报工 → 待检 → 质检台判定」流程，需先在 PC 后台把某人的角色改成质检员。

### 产物

| 项 | 值 |
|---|---|
| 路径 | `app/android/app/build/outputs/apk/debug/app-debug.apk` |
| 副本 | `app/dist/智工MES-v1.0-debug.apk` |
| 体积 | 4.5 MB（4,668,579 字节） |
| 包名 | `cn.meslight.app` |
| 应用名 | 智工MES |
| versionCode / Name | 1 / 1.0 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 24（Android 7.0+） |

APK 内部含 `assets/public/`（11 个条目：`index.html`、`app.js`、`app.css`、
`js/store.js`、`js/api.js`、`lib/qrcode.js`、`data/seed.json`、图标等），
即 H5 已完整打进包内，同时通过 `server.url` 走服务器渲染。

> 这是 **debug 包**（无签名），可直接 `adb install` 侧载安装；
> 正式分发需按第三节做 `assembleRelease` 签名。

### 仓库里不包含 android 原生工程

`push_main.cjs` 的 `EXCLUDE_PATHS` 会跳过 `app/android` 与 `app/www`（构建产物，
体积大且可重建）。换台电脑后重新生成：

```bat
cd app && npm install && node build_www.js && npx cap add android
```

然后按第五节补 `local.properties`、`gradle.properties`（`android.overridePathCheck=true`）、
`build.gradle`（阿里云仓库）、`gradle-wrapper.properties`（华为云）四处配置。

---

## 七、platform-36 离线安装（本机已验证的完整步骤）

`sdkmanager` 会被两个问题卡死，所以走手工安装：

1. **Windows MAX_PATH(260)** —— platform 包含大量深嵌套 `data/res/values-xxx`，
   `sdkmanager` 自带的解压器会在中途失败。
2. **网络不稳** —— `sdkmanager` 自身下载大文件时容易中断。

正确做法：

```bash
# 1) 从 repository2-3.xml 查真实文件名（别猜 URL，实测过 404）
curl -s "https://dl.google.com/android/repository/repository2-3.xml" \
  | grep -o 'platform-3[46]_r[0-9]*\.zip' | sort -u
#   → platform-36_r02.zip / platform-35_r02.zip / platform-34-ext7_r03.zip

# 2) 下载（dl.google.com 本机可直连）
curl -sSL -o platform-36_r02.zip \
  "https://dl.google.com/android/repository/platform-36_r02.zip"

# 3) 用长路径解压器解（脚本在 C:\Users\Admin\unzip_longpath.py，用 \\?\ 前缀）
python C:/Users/Admin/unzip_longpath.py \
  platform-36_r02.zip C:/Users/Admin/asdk/platforms/android-36

# 4) zip 内层有一层 android-36/ 目录，需要扁平化
cd C:/Users/Admin/asdk/platforms/android-36/android-36
mv -f ./* .. && cd .. && rmdir android-36

# 5) 补 source.properties（sdkmanager 会生成，手工装要自己写）
#    内容见 C:\Users\Admin\asdk\platforms\android-36\source.properties
```

`source.properties` 关键字段：

```properties
Pkg.Desc=Android SDK Platform 16
Platform.Version=16
Pkg.Revision=2
AndroidVersion.ApiLevel=36
AndroidVersion.IsBaseSdk=true
Layoutlib.Api=16
```

装完用 `aapt2 dump badging <apk>` 应看到 `compileSdkVersion='36'`。

---

## 八、构建踩坑速查（都已解决，留着省时间）

| 现象 | 原因 | 解法 |
|------|------|------|
| Gradle 停在 `Preparing "Install Android SDK Platform 36"` 十几分钟不动 | `sdkmanager` 下载/解包卡死 | 手工装 platform（第七节） |
| `checkDebugAarMetadata FAILED`，要求 compileSdk ≥35/36 | Capacitor 8 的 androidx 依赖要求 | 用 compileSdk 36 |
| `C:\Users\Admin\.gradle\.tmp\gradle_download*bin (拒绝访问)` | 上一次被 kill 的构建留下 stale 锁 | 删 `.tmp/gradle_download*bin`；或 `GRADLE_OPTS=-Djava.io.tmpdir=<可写目录>` |
| AAR 只有 `.pom`/`.module` 没有 `.aar` | 下载中断，缓存半残 | 从 `maven.aliyun.com/repository/google` 手工 curl `.aar`，按 `sha1` 目录名塞进缓存 |
| `AGP 拒绝非 ASCII 路径` | 项目在 `…/正常办公/…` | `gradle.properties` 加 `android.overridePathCheck=true` |
| Gradle wrapper 下载不了 | `services.gradle.org` 不通 | `distributionUrl` 改华为云 `mirrors.huaweicloud.com/gradle/gradle-8.14.3-all.zip` |
| 沙箱里 Gradle 报 `~/.gradle/caches` 拒绝访问 | 沙箱策略 | 构建需在沙箱外执行 |

> **沙箱提示**：本环境 `curl -o /tmp/xxx` 在 Git Bash 下可能写不出文件（路径转换问题），
> 下载时请显式 `cd` 到 Windows 原生目录（如 `C:/Users/Admin/gdltmp`）再 `-o 文件名`。
