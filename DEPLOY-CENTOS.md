# MES-Light 腾讯云部署手册（CentOS 系 · 无域名阶段）

适用：**CentOS / TencentOS / OpenCloudOS / Rocky / AlmaLinux**
当前阶段：**还没有域名** → 用 `http://公网IP:8080` 访问（80/443 需要备案，8080 不需要）

---

## 0. 本次部署会一并带上什么

从 GitHub `main` 拉取，包含已修复的：

- 报工完工逻辑（`qty_done` 用 MIN，所有工序合格才算完工，commit `afaf9e6`）
- **看板图表不显示**（`.chart` 补 `height:auto`，commit `552392eb`）
- **看板数据不自动刷新**（每 30 秒自动刷新，同上）
- 二维码链接指向 `/m/index.html`

---

## 1. 腾讯云控制台（先做，2 分钟）

**安全组 / 防火墙**放行入站：

| 端口 | 用途 |
|---|---|
| 22 | SSH |
| 8080 | MES 访问（本阶段） |

> 轻量应用服务器在「防火墙」页，CVM 在「安全组」页。

---

## 2. 上传备份数据到服务器

把 `mes_live_export.json`（已从 Railway 导出）传到服务器 `/root/`：

- Windows 可用 WinSCP，或 `scp mes_live_export.json root@你的IP:/root/`

---

## 3. 执行部署

SSH 登录服务器后（root）：

### 3.1 拿最新代码

国内服务器直连 GitHub 经常被重置（`Failure when receiving data from the peer`）。
**推荐直接用源码包，绕开 git**：

```bash
cd /tmp && rm -rf mes-new && mkdir mes-new
curl -fsSL --retry 3 --connect-timeout 10 \
  https://codeload.github.com/yu3461018595/mes-light/tar.gz/refs/heads/main -o mes.tar.gz \
  && tar -xzf mes.tar.gz -C mes-new --strip-components=1
mkdir -p /opt/mes-light
cp -a /tmp/mes-new/. /opt/mes-light/    # 保留已有 data/，只覆盖代码
cd /opt/mes-light && ls deploy/
```

> 若 codeload 也不通，换镜像前缀重试：
> `https://gh-proxy.com/https://codeload.github.com/yu3461018595/mes-light/tar.gz/refs/heads/main`
>
> **部署脚本本身已内置四级自动回退**（git pull → 直连 clone → 代理 clone → 源码包），
> 后续更新直接重跑部署脚本即可，不用手工拉代码。

### 路线 A：Docker 部署（推荐）

```bash
bash deploy/deploy_centos.sh /root/mes_live_export.json
```

脚本会自动完成：清理坏源 → 装 Docker（自动兼容 TencentOS Server 4）→ 生成 `.env`（二维码指向本机 IP）
→ 构建镜像 → **在应用首次启动前导入数据**（避免混入演示数据）→ 启动容器 → 放行 8080。

> 公网 IP 若识别不准，可手工指定：`bash deploy/deploy_centos.sh /root/mes_live_export.json 你的公网IP`

### 路线 B：零 Docker 部署（Docker 装不上时用）

直接跑 Node + systemd，不依赖任何容器，也不需要从 Docker Hub 拉镜像：

```bash
bash deploy/deploy_node.sh /root/mes_live_export.json
```

自动完成：安装 Node 22（多镜像源自动选取）→ 拉代码 → 导入数据 → 注册 systemd 服务并启动 → 放行 8080。

---

## 3.5 已知坑：TencentOS Server 4 装不了 Docker CE

**现象**：`https://mirrors.aliyun.com/docker-ce/linux/centos/4/x86_64/stable/repodata/repomd.xml` 返回 404。

**原因**：TencentOS Server 4 的 `$releasever` 是 **4**，而 Docker CE 官方及镜像源只维护
`centos/7`、`centos/8`、`centos/9` 三条路径，没有 `centos/4`。

**脚本已自动处理**，无需手工干预：

1. 先把上一轮可能写入的坏源 `docker-ce*.repo` 删掉（否则后续任何 `dnf` 都会报错）
2. 按发行版映射到正确版本号（TencentOS 4 → `centos/9`，TencentOS 3 → `centos/8`）
3. **repo 文件里硬编码写死版本号**，不再使用 `$releasever` 变量
4. 多个源依次回退：腾讯云 → 阿里云 → Docker 官方
5. 都失败则退到系统内置 **Moby** 引擎；仍失败会提示改用路线 B

> 若你手工折腾过导致环境残留，先执行：`rm -f /etc/yum.repos.d/docker-ce*.repo && dnf clean all`

---

## 4. 验收清单

打开 `http://你的IP:8080`，用 **管理员 / 123456** 登录（导入后密码被统一重置，请立即修改）。

| 检查项 | 预期 |
|---|---|
| 看板图表 | 折线图、柱状图**正常显示**（不再是空白） |
| 看板刷新 | 副标题显示「每30秒刷新（时:分:秒）」，数字会跳动 |
| 工单 | 2 张（含 `WO2609024653`） |
| 报工记录 | 4 条 |
| 扫码报单 | 二维码链接为 `http://你的IP:8080/m/index.html?...` |

**数据条数核对**（应与线上一致）：

```
products 4 / processes 12 / work_centers 6 / customers 6 / bad_reasons 8
users 18 / routes 4 / route_steps 20 / orders 2 / order_steps 8 / reports 4
```

若工单里出现 12 张演示工单，说明先启动了容器、后导入数据，重跑一次即可（注意**必须重新 build**，原因见 4.5）：

```bash
# 项目实际位于 /opt/mes-light（不是 ~/mes-light），务必用绝对路径
cd /opt/mes-light
git pull                 # 1. 拉取修复后的迁移脚本（拉不到用文档 3.1 的 codeload 兜底）
# 2. 先停并删除旧容器，避免容器名 mes-light 冲突（stop 只停不删，up 时仍可能报重名）
docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml down || docker rm -f mes-light
docker compose build     # 3. 重建镜像，否则容器内仍是旧脚本
docker compose run --rm -v /opt/mes-light/mes_live_export.json:/tmp/backup.json:ro mes \
  node deploy/migrate_db.cjs /tmp/backup.json --clean
docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml up -d
```

---

## 4.5 已知坑：迁移脚本在镜像里 / 数据导入的外键连锁失败

### ① 迁移脚本是烘焙进镜像的

`migrate_db.cjs` 在**容器镜像内部**，宿主机 `git pull` 拿到新脚本后，
**必须执行 `docker compose build` 重新构建镜像**才会生效，否则 `docker compose run mes ...`
跑的仍是镜像里的旧脚本，故障依旧。

### ② FOREIGN KEY constraint failed —— 真因在 users 表

曾经的现象是插入 `orders` 时报外键错误，真正原因却是前面几张表的 `users`：

```
users 失败：NOT NULL constraint failed: users.password
```

- 线上导出的 JSON **不含 `password` 字段**（API 出于安全不返回），而 `users.password` 是 `NOT NULL`
- 旧脚本用 `INSERT OR IGNORE`，失败行会被**静默丢弃**，18 个用户全部没入库、`users` 表为空
- 于是 `orders.created_by=1` 找不到父记录 → 报成 `FOREIGN KEY constraint failed`
- 连锁导致 `orders` / `order_steps` / `reports` 全部为空

**报错位置与真正病因相隔好几张表**，只看最后的错误信息极易误判。

修复后的脚本：

1. `NOT NULL` 且无默认值的列自动补兜底值，`password` 统一补 `123456` 的哈希
2. 不再用 `INSERT OR IGNORE`；改用 `ON CONFLICT(id) DO UPDATE` 的 upsert——
   **不能用 `INSERT OR REPLACE`**，它底层是「先 DELETE 再 INSERT」，删除父行会触发
   `ON DELETE CASCADE` 级联删掉子表数据（如删 products 会连带删 routes）
3. 逐行捕获并打印失败明细，结束时输出「备份行数 vs 库内行数」逐表核对表
4. 最后执行 `PRAGMA foreign_key_check` 完整性校验，成功打印 `导入完成，数据与备份完全一致`
5. 导入后统一重置所有用户密码为 `123456`（导出数据无密码，这是必然结果）

> 导入失败时脚本会以非零退出码结束，部署脚本会立刻中断，不会带着残缺数据继续启动。

---

## 4.8 已知坑：本机 curl 200，但浏览器打不开

这是**最常见**的情况，和应用无关，90% 是云平台防火墙没放行端口。

**判定方法**（服务器端执行）：

```bash
bash /opt/mes-light/deploy/diagnose.sh
```

| 诊断结果 | 说明 | 处理 |
|---|---|---|
| 本机 curl **200**，外网打不开 | 应用正常，网络层被拦 | 到云平台放行端口 |
| 本机 curl **非 200** | 应用没起来 | 看诊断脚本输出的日志部分 |

**放行端口（必须做，脚本管不到这一层）：**

- 轻量应用服务器 → **防火墙** → 添加规则：`TCP : 8080`（来源 `0.0.0.0/0`）
- CVM → **安全组** → 入站规则 → 添加：`TCP : 8080`

> 新建实例默认往往**只开放了 22（SSH）**，80/443/8080 都是关闭的，必须手工添加。
> 可用 `bash deploy/diagnose.sh` 输出的第 6 项拿到公网 IP，让外部协助确认。

**换端口**（不想用 8080，或已放行的是别端口）：脚本与 compose 均支持 `MES_PORT` 环境变量：

```bash
MES_PORT=80 bash deploy/deploy_centos.sh /root/mes_live_export.json
# 或已部署后单独重建：
cd /opt/mes-light && MES_PORT=80 docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml up -d
```

注意：改端口后需同步更新 `.env` 里的 `PUBLIC_BASE_URL`，否则扫码链接仍指向旧端口。

---

## 5. 下一步：买域名 + ICP 备案（微信扫码才能直接打开）

当前用 IP 访问时，**微信仍会拦截**（微信不信任 IP 形式的链接）。彻底解决需要：

1. 购买域名（腾讯云/阿里云均可）
2. 提交 ICP 备案（腾讯云有备案小程序，一般 1–3 周）
3. 备案通过后：
   - 域名 A 记录解析到服务器公网 IP
   - 改 `.env`：`PUBLIC_BASE_URL=https://你的域名`
   - 用 `deploy/nginx/mes.conf` 配 Nginx 反代 + `certbot` 申请 HTTPS
   - 去掉 IP 覆盖文件，只保留回环监听：`docker compose up -d`
4. 重新生成二维码 → 微信扫码即可**直接打开**报工页

---

## 6. 运维备忘

**通用**

- **数据文件**：`/opt/mes-light/data/mes.db`，备份直接拷贝该文件
- **更新代码（推荐）**：`bash /opt/mes-light/deploy/update.sh`
  → 自动备份数据库 → `git pull` → 按部署方式重启（systemd 或 Docker）

**Docker 方式**

- **重启**：`cd /opt/mes-light && docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml restart`
- **看日志**：`docker logs -f mes-light`

**systemd 方式（路线 B）**

- **重启/停止**：`systemctl restart|stop mes-light`
- **看日志**：`journalctl -u mes-light -f`
- **环境变量**：`/etc/mes-light.env`（改完执行 `systemctl daemon-reload && systemctl restart mes-light`）

> `update.sh` 会在更新前把数据库备份到 `/opt/mes-light/backups/`，出问题可回滚。
