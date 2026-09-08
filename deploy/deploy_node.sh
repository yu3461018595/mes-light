#!/usr/bin/env bash
# MES-Light 腾讯云部署 —— 零 Docker 方案（Node 直跑 + systemd）
#
# 适用场景：
#   1) TencentOS Server 4 等发行版上 Docker CE 源不可用（$releasever=4 导致 404）
#   2) 服务器拉不动 Docker Hub 镜像
#   3) 你更希望少一层容器、资源占用更低
#
# 阶段一：暂无域名、未备案 → 用 http://公网IP:8080 访问（非 80/443 端口无需备案）
#
# 用法（root 执行）：
#   bash deploy/deploy_node.sh                                       # 只部署，不导入数据
#   bash deploy/deploy_node.sh /root/mes_live_export.json            # 部署并导入线上数据（推荐）
#   bash deploy/deploy_node.sh /root/mes_live_export.json 1.2.3.4    # 手工指定公网 IP
#
set -e

APP_DIR=/opt/mes-light
NODE_HOME=/opt/node
NODE_VER=v22.20.0
HOST_PORT=8080
BACKUP="$1"
FORCE_IP="$2"

say()  { echo -e "\033[36m$*\033[0m"; }
warn() { echo -e "\033[33m$*\033[0m"; }
err()  { echo -e "\033[31m$*\033[0m"; }

PM="dnf"; command -v dnf >/dev/null 2>&1 || PM="yum"

# ==========================================================
# 获取源码：多级回退，绕开国内服务器访问 GitHub 被重置的问题
# 顺序：git pull → 直连 clone → 代理 clone → tarball 直连 → tarball 代理
# 任何方式成功都不会动已有的 data/（业务数据库在 data/mes.db）
# ==========================================================
REPO_URL=yu3461018595/mes-light
fetch_code() {
  local dir="$1"
  local tmp="/tmp/mes-src-$$"
  local got=0

  if [ -d "$dir/.git" ]; then
    if git -C "$dir" pull -q 2>/dev/null; then
      say "   ✓ git pull 成功"; return 0
    fi
    warn "   git pull 失败（GitHub 连接被重置），自动切换到其他通道…"
  fi

  local mirror
  for mirror in "" "https://gh-proxy.com/" "https://ghps.cc/"; do
    [ "$got" -eq 1 ] && break
    rm -rf "$tmp"; mkdir -p "$tmp"
    if timeout 180 git clone -q --depth 1 "${mirror}https://github.com/${REPO_URL}.git" "$tmp" 2>/dev/null \
       && [ -f "$tmp/server.js" ]; then
      got=1; say "   ✓ clone 成功${mirror:+（镜像：${mirror}）}"
    fi
  done

  if [ "$got" -eq 0 ]; then
    for mirror in "https://codeload.github.com" "https://gh-proxy.com/https://codeload.github.com"; do
      [ "$got" -eq 1 ] && break
      rm -rf "$tmp"; mkdir -p "$tmp"
      if curl -fsSL --retry 2 --connect-timeout 10 --max-time 180 \
           "${mirror}/${REPO_URL}/tar.gz/refs/heads/main" -o /tmp/mes-src.tgz 2>/dev/null \
         && tar -xzf /tmp/mes-src.tgz -C "$tmp" --strip-components=1 2>/dev/null \
         && [ -f "$tmp/server.js" ]; then
        got=1; say "   ✓ 源码包下载成功（${mirror}）"
      fi
    done
  fi

  if [ "$got" -eq 0 ]; then
    err "   所有通道均失败，无法获取源码。"
    err "   请手工下载源码包放到 /opt/mes-light 后重跑本脚本："
    err "     https://github.com/${REPO_URL}/archive/refs/heads/main.tar.gz"
    return 1
  fi

  mkdir -p "$dir"
  cp -a "$tmp"/. "$dir"/ 2>/dev/null   # 保留已有 data/ 与 .env
  rm -rf "$tmp" /tmp/mes-src.tgz 2>/dev/null
  return 0
}

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)  NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) err "不支持的 CPU 架构：$ARCH"; exit 1 ;;
esac

# ==========================================================
echo "== 0/6 检测公网 IP =="
# ==========================================================
IP="$FORCE_IP"
if [ -z "$IP" ]; then
  IP=$(curl -s --max-time 5 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null || true)
fi
if [ -z "$IP" ]; then IP=$(curl -s --max-time 8 http://myip.ipip.net 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true); fi
if [ -z "$IP" ]; then IP=$(curl -s --max-time 8 https://ifconfig.me 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true); fi
if [ -z "$IP" ]; then IP=$(hostname -I 2>/dev/null | awk '{print $1}'); fi
[ -z "$IP" ] && { err "无法自动获取公网 IP，请手工指定：bash deploy/deploy_node.sh <备份文件> <公网IP>"; exit 1; }
echo "   公网 IP: $IP"

# ==========================================================
echo "== 1/6 安装基础工具 =="
# ==========================================================
$PM install -y tar gzip git curl >/dev/null 2>&1 || true

# ==========================================================
echo "== 2/6 安装 Node ${NODE_VER}（自带 node:sqlite，无需编译）=="
# ==========================================================
need_node=1
if command -v node >/dev/null 2>&1; then
  HAVE=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  if [ -n "$HAVE" ] && [ "$HAVE" -ge 22 ] 2>/dev/null; then
    echo "   系统已存在 Node $(node -v)，复用"
    need_node=0
  fi
fi

if [ "$need_node" -eq 1 ]; then
  TMP="/tmp/node-${NODE_VER}.tar.gz"
  OK=0
  for base in \
      "https://mirrors.tencent.com/nodejs-release" \
      "https://mirrors.aliyun.com/nodejs-release" \
      "https://npmmirror.com/mirrors/node" ; do
    URL="${base}/${NODE_VER}/node-${NODE_VER}-linux-${NODE_ARCH}.tar.gz"
    echo "   尝试下载：${URL}"
    rm -f "$TMP"
    if curl -sSL --max-time 300 -o "$TMP" "$URL" 2>/dev/null && [ -s "$TMP" ]; then
      OK=1; say "   ✓ 下载成功"; break
    fi
    echo "   该源失败，换下一个…"
  done
  [ "$OK" -eq 1 ] || { err "Node 下载失败，请检查网络或手工下载 ${NODE_VER} 安装包"; exit 1; }

  rm -rf "$NODE_HOME"
  mkdir -p "$NODE_HOME"
  tar -xzf "$TMP" -C "$NODE_HOME" --strip-components=1
  rm -f "$TMP"
  ln -sf "$NODE_HOME/bin/node" /usr/local/bin/node
  ln -sf "$NODE_HOME/bin/npm"  /usr/local/bin/npm
  ln -sf "$NODE_HOME/bin/npx"  /usr/local/bin/npx
fi
NODE_BIN=$(command -v node)
echo "   Node: $(${NODE_BIN} -v)  （$NODE_BIN）"

# ==========================================================
echo "== 3/6 获取代码（GitHub main，含最新修复）=="
# ==========================================================
mkdir -p /opt
fetch_code "$APP_DIR"
cd "$APP_DIR"
mkdir -p "$APP_DIR/data"

# ==========================================================
echo "== 4/6 写入环境变量（二维码链接指向本机 IP）=="
# ==========================================================
cat > /etc/mes-light.env <<EOF
NODE_ENV=production
PORT=${HOST_PORT}
PUBLIC_BASE_URL=http://${IP}:${HOST_PORT}
EOF
echo "   PUBLIC_BASE_URL=http://${IP}:${HOST_PORT}"

# ==========================================================
echo "== 5/6 导入业务数据（首次启动前，避免混入演示数据）=="
# ==========================================================
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
  set -a; . /etc/mes-light.env; set +a
  "$NODE_BIN" deploy/migrate_db.cjs "$BACKUP" --clean
  say "   ✓ 数据导入完成"
else
  warn "   未提供备份文件，跳过导入（将使用演示数据）"
fi

# ==========================================================
echo "== 6/6 注册 systemd 服务并启动 =="
# ==========================================================
cat > /etc/systemd/system/mes-light.service <<SVC
[Unit]
Description=MES-Light Production Management System
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/mes-light.env
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable mes-light >/dev/null 2>&1
systemctl restart mes-light

if command -v firewall-cmd >/dev/null 2>&1; then
  systemctl enable --now firewalld 2>/dev/null || true
  firewall-cmd --permanent --add-port=${HOST_PORT}/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
  echo "   已放行 ${HOST_PORT}/tcp"
fi

sleep 4
say ""
say "服务状态："
systemctl is-active mes-light
ss -lntp 2>/dev/null | grep ":${HOST_PORT}" || true

HEALTH=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${HOST_PORT}/" || echo "000")
say ""
if [ "$HEALTH" = "200" ]; then
  say "================ 部署完成 ================"
  say "访问地址： http://${IP}:${HOST_PORT}"
  say "默认账号： 管理员 / 123456（导入数据后密码被重置，请登录后立即修改）"
  say "数据目录： ${APP_DIR}/data/mes.db（备份直接拷贝该文件）"
  say ""
  say "常用命令："
  say "   systemctl status|restart|stop mes-light"
  say "   journalctl -u mes-light -f          # 看实时日志"
  say "   bash ${APP_DIR}/deploy/update.sh    # 后续更新代码并重启"
  say ""
  say "若浏览器打不开，请到腾讯云控制台 → 防火墙/安全组 → 放行 TCP ${HOST_PORT}"
  say "========================================"
else
  err "服务未正常响应（HTTP ${HEALTH}），请查看日志："
  err "   journalctl -u mes-light -n 50 --no-pager"
  err "若日志中出现权限拒绝且系统开启了 SELinux，可临时执行 setenforce 0 验证是否为 SELinux 限制。"
  exit 1
fi
