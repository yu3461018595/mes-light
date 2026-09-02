# MES-Light 腾讯云部署 + ICP 备案全流程（微信可直接打开报工页）

> 背景：当前部署在 Railway（`*.up.railway.app`）是海外共享域名，微信内置浏览器不信任，扫码后要求「在浏览器中打开」。
> 根本解法：迁移到**国内服务器 + 已 ICP 备案的自定义域名 + HTTPS**。本文给出从零到可访问的完整步骤。

---

## 0. 目标架构

```
微信扫码 ──▶ https://你的域名（国内服务器）
                │
                ├─ Nginx（80/443，HTTPS，certbot 免费证书）
                └─ Docker 容器 mes-light（Node 22 + SQLite，数据在 ./data/mes.db）
```

- 为什么必须 HTTPS + 备案域名：微信对国内已备案域名信任度高，扫码会**直接打开**；对海外/未备案域名则弹「在浏览器打开」。
- 为什么用 Docker + SQLite：代码已就绪（零依赖、Node 22 内置 sqlite），部署简单；数据单文件 `mes.db` 易于迁移与备份。

---

## 1. 你需要先准备好的东西（前置清单）

| 项目 | 说明 | 周期 |
|---|---|---|
| 腾讯云账号 + **实名认证** | 备案与购机前置，个人/企业均可 | 0.5 天 |
| 轻量应用服务器（国内地域，如上海/广州） | 运行 Docker | 即时 |
| 域名（建议 `.cn`/`.com`） | 在腾讯云注册或转入 | 即时 |
| **ICP 备案** | 国内服务器对外提供访问的法定要求 | **约 1–2 周** |
| 服务器放行 80/443 端口 | 安全组/防火墙 | 即时 |

> ⏱️ 备案是最长的一条路径，建议**立刻先提交备案**，期间同步准备服务器与代码。

---

## 2. 阶段一：腾讯云账号与实名认证
1. 注册 https://cloud.tencent.com ，完成**实名认证**（个人用身份证、企业用营业执照）。
2. 实名通过后才能购买国内地域服务器与提交备案。

## 3. 阶段二：购买轻量应用服务器
- 地域：选**中国大陆**（如「上海/广州」），不要用境外地域（否则仍需备案且微信仍不信任）。
- 镜像：选 **Docker 基础镜像** 或 **Ubuntu 22.04**（脚本会自动装 Docker）。
- 配置建议：2 核 2G 起步（MES 是轻量 CRUD + SQLite，足够几十人车间）；数据量不大。
- 买好后记下**公网 IP**。

## 4. 阶段三：注册域名 + ICP 备案
1. 在腾讯云「域名注册」买一个域名（如 `mes-yourcompany.cn`）。
2. 进入「网站备案」→「新增备案」，按指引填写：
   - 主体信息（实名一致）；
   - 网站信息（域名、服务器 IP 来自阶段二）；
   - 上传幕布/人脸核验照片。
3. 提交后腾讯云初审 + 管局审核，约 **1–2 周**。期间保持电话畅通。
4. 备案通过后你会拿到**备案号**（如「沪ICP备2026XXXXXX号」），后续要挂在网站页脚。

> 备案期间服务器可以先部署调试（用 IP 或临时解析），但**正式对外访问需等备案通过**。

## 5. 阶段四：服务器初始化
SSH 登录服务器（root），放行端口（轻量服务器在控制台「防火墙」加 80、443 入站；CVM 在「安全组」）。其余由一键脚本完成。

## 6. 阶段五：部署 MES（Docker）
把仓库里的 `docker-compose.yml` 中 `PUBLIC_BASE_URL` 改成你的域名（**先填真实域名，即使备案未下也可先用占位，证书签发后再改**），然后：

```bash
# 方式 A：一键脚本（推荐）
curl -fsSL https://raw.githubusercontent.com/yu3461018595/mes-light/main/deploy/deploy.sh | bash
# 脚本会要你输入域名，并自动申请 HTTPS 证书

# 方式 B：手动
cd /opt && git clone https://github.com/yu3461018595/mes-light.git && cd mes-light
# 编辑 docker-compose.yml，把 PUBLIC_BASE_URL 改为 https://你的域名
docker compose build && docker compose up -d
```

> 国内服务器访问 github.com 可能慢/不稳。若 `git clone` 卡住，改用镜像：
> `git clone https://ghproxy.com/https://github.com/yu3461018595/mes-light.git`
> 或在本机（能访问 GitHub 的电脑）`docker build` 后推到**腾讯云容器镜像服务 TCR**，服务器再 `docker pull`。

## 7. 阶段六：Nginx 反代 + HTTPS
- 配置已随 `deploy/nginx/mes.conf` 提供，脚本阶段四会自动复制并申请证书。
- 手动时：
  ```bash
  cp deploy/nginx/mes.conf /etc/nginx/conf.d/mes.conf
  # 编辑把 CHANGE-ME.example.com 改成你的域名
  nginx -t && systemctl reload nginx
  certbot --nginx -d 你的域名   # 自动签发并改写 443/SSL
  ```
- 验证：`curl -I https://你的域名` 返回 200/3xx 且为 https。

## 8. 阶段七：域名解析 + 悬挂备案号
1. 域名控制台把 `A 记录` 指向服务器**公网 IP**。
2. 网站页脚加入备案号并链接到 https://beian.miit.gov.cn （可在前端页脚加一行，或 nginx 返回页加）。

## 9. 阶段八：数据迁移（从 Railway 迁过来）
**优先做法（最稳，保留密码与全部数据）：直接拷数据库文件**
1. 从 Railway 取出 `mes.db`：Railway 控制台 → 项目 → Volumes → 找到 `/app/data` 卷 → 下载；或用有全权限的 Railway CLI `railway volume` 下载。
2. 传到新服务器：
   ```bash
   scp mes.db root@服务器IP:/opt/mes-light/data/mes.db
   docker compose restart   # 让容器加载新库
   ```
3. 完成。原 Railway 可继续保留作备份，确认无误后再下线。

**兜底做法（JSON 导入，可能缺部分表）：**
```bash
# 在仓库根目录
node deploy/migrate_db.cjs /path/to/mes_live_backup_YYYYMMDD.json
# 导入后所有用户密码重置为 123456，请立即修改
```
> 注意：JSON 备份可能不含 `route_steps` 等表，导入后请在页面核对「产品→工艺路线→工序」是否完整。

## 10. 阶段九：验证与收尾
- [ ] 浏览器打开 `https://你的域名`，后台可登录（admin/123456）。
- [ ] **用微信扫一张工单二维码**：应**直接打开**报工页，不再提示「在浏览器打开」。
- [ ] 在「系统/用户」处**修改默认密码**（admin、leader1、worker1 等均为 123456）。
- [ ] 页脚挂备案号。
- [ ] 配置定期备份：把 `/opt/mes-light/data/mes.db` 定时打包到对象存储/其他机器。

---

## 11. 常见问题
- **微信仍提示在浏览器打开？** 确认：①域名已 ICP 备案；②全站 HTTPS（含证书有效、未过期）；③二维码链接是 `https://你的域名/...`（看 `PUBLIC_BASE_URL` 是否填对）；④服务器在国内。
- **国内拉不动 GitHub？** 用 `ghproxy.com` 镜像或先把镜像推到 TCR/ACR 再 pull。
- **SQLite 并发？** MES 是轻量读写，SQLite 足够；若未来并发高，可换云数据库，但需改 `lib/db.js`。
- **证书续期？** certbot 默认 90 天自动续期（需 80 端口通畅）；可用 `certbot renew --dry-run` 验证。
- **想完全脱离海外依赖？** 把仓库镜像到 Gitee / 腾讯云 CODING，部署时从这些国内源拉取。
