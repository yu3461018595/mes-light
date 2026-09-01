# 部署指南：把生产管理系统上线到公网

本项目是 **Node.js（22.5+，内置 `node:sqlite`）+ SQLite** 的零依赖应用，已改造为**云原生可直接部署**形态：

- 监听地址 `0.0.0.0`，端口读环境变量 `PORT`（默认 5173）
- 二维码地址自动跟随请求域名与协议（`Host` / `X-Forwarded-Proto`），部署后无需改代码
- 首次启动自动建库并写入演示数据；数据目录为项目根下的 `data/`

> ⚠️ 本工具内的 CloudStudio 部署**仅支持静态站点**，无法运行 Node 后端。请用下方任一平台部署，几分钟即可拿到可访问的公网链接。

---

## 一、准备（任选其一的部署源）

把 `mes/` 整个目录作为部署目录（含 `server.js`、`package.json`、`public/`、`lib/` 等）。推荐用 Git 仓库托管后连到平台。

需忽略的文件已写入 `.gitignore`（`data/`、`.secret`、日志），不会污染仓库。

---

## 二、Railway（最省心，推荐）

1. 打开 https://railway.app → New Project → Deploy from GitHub / GitLab（先 push 本目录到仓库）
2. 检测到 `package.json`，自动用 Nixpacks 构建；`startCommand` 已由 `railway.json` 指定为 `node server.js`
3. 在 Variables 中添加 `PORT = 3000`（Railway 会注入自己的端口，也可不填，平台注入的 PORT 会生效）
4. 生成域名（Settings → Domains）即得到可访问链接
5. **数据持久化**：Railway 默认磁盘在重启后会重置 `data/`。如需保留数据，在 Project → Volumes 添加一块卷，挂载到容器路径（如 `/app/data`），并在 Variables 中加 `DATA_DIR=/app/data`（与挂载路径保持一致，应用会优先使用此变量）。

---

## 三、Render

1. 打开 https://render.com → New → Web Service，连接仓库
2. 配置：
   - Runtime: **Node**
   - Build Command: `echo skip`
   - Start Command: `node server.js`
   - Plan: Starter 及以上（Free 计划磁盘随部署重置，仅适合演示）
3. 环境变量加 `PORT = 3000`
4. 部署完成后获得 `https://<服务名>.onrender.com`
5. **数据持久化**：在 Render 控制台为服务挂载「持久磁盘」到某路径（如 `/app/data`），并在环境变量加 `DATA_DIR=/app/data`（与挂载路径一致），否则每次部署数据回到演示初始态。

---

## 四、自建服务器 / VPS（Docker 或裸 Node）

### 方式 A：Docker（最干净）
```bash
# 在含 Docker 的服务器上
cd mes
docker build -t mes-light .
docker run -d --name mes -p 3000:3000 \
  -v mes-data:/app/data \
  mes-light
# 访问 http://<服务器IP>:3000
```
`-v mes-data:/app/data` 用命名卷持久化 SQLite 数据。

### 方式 B：裸 Node + 进程守护
```bash
# 需 Node >= 22.5
cd mes
npm install        # 本项目零依赖，这步通常无操作
PORT=3000 node server.js
# 用 pm2 守护： npm i -g pm2 && pm2 start server.js --name mes -- -p 3000
# 用 nginx 反代 3000 端口并配置 HTTPS 域名
```
前端用 nginx 反代示例：
```nginx
server {
  listen 80; server_name mes.your-domain.com;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }
}
```

---

## 五、微信扫码报工说明

- 工单码 / 员工码里的链接形如 `https://<你的域名>/m/report?o=ID&t=令牌`，已自动使用部署后的真实域名与 HTTPS。
- 用微信「扫一扫」打开该链接即进入移动端报工页，**无需登录**。
- 真正嵌入微信公众号菜单 / 小程序需额外做微信 JSSDK 鉴权，本项目未包含；H5 页面本身在任何浏览器（含微信内置浏览器）均可直接打开填报。
- 二维码令牌由服务端 `HMAC-SHA256(密钥, 类型:ID)` 生成，密钥存于 `.secret`（首次启动自动生成）。**迁移/重部署后若 `.secret` 被重置，旧二维码会失效，重新生成即可。**

---

## 六、默认账号（部署后请尽快改密码）

| 角色 | 账号 | 密码 |
|------|------|------|
| 管理员 | admin | 123456 |
| 班组长 | leader1 | 123456 |
| 操作工 | worker1 | 123456 |

修改密码：基础数据 → 人员 → 编辑。删除/停用员工、关闭工单等操作见 README。

---

## 七、常见坑

- **Node 版本过低**：`node:sqlite` 需 Node ≥ 22.5。平台默认若是 Node 20，请到平台设置 Node 版本（Railway/Render 可用 `engines` 或控制台指定）。
- **数据丢失**：未挂载持久卷时，容器/实例重启会重置 `data/` 回到演示数据。生产务必挂载卷。
- **端口冲突**：确保 `PORT` 与平台暴露端口一致；本项目已在 `0.0.0.0` 监听 `PORT`。
- **外网打不开**：检查平台防火墙 / 安全组是否放通对应端口，以及域名 DNS 是否解析到服务。
