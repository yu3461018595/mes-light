#!/usr/bin/env bash
# MES-Light 腾讯云一键部署（TencentOS Server / CentOS / OpenCloudOS / Rocky / Alma）
#
# 阶段一：暂无域名、未备案 → 用 http://公网IP:8080 访问（非 80/443 端口无需备案）
#
# 用法（root 执行）：
#   bash deploy/deploy_centos.sh                               # 只部署，不导入数据
#   bash deploy/deploy_centos.sh /root/mes_live_export.json    # 部署并导入线上数据（推荐）
#   bash deploy/deploy_centos.sh /root/mes_live_export.json 1.2.3.4   # 手工指定公网 IP
#
# 特别说明：
#   TencentOS Server 4 的 $releasever 是 4，而 Docker CE 官方/镜像源没有 centos/4 仓库，
#   直接用 $releasever 拼路径会 404。本脚本会自动映射到 centos/9 并硬编码写入 repo，
#   不再依赖 $releasever，彻底避开该问题。
#
# 若 Docker 实在装不上（极少数网络受限环境），改用零 Docker 方案：
#   bash deploy/deploy_node.sh /root/mes_live_export.json
#
set -e

APP_DIR=/opt/mes-light
HOST_PORT=8080
BACKUP="$1"
FORCE_IP="$2"

say()  { echo -e "\033[36m$*\033[0m"; }
warn() { echo -e "\033[33m$*\033[0m"; }
err()  { echo -e "\033[31m$*\033[0m"; }

PM="dnf"; command -v dnf >/dev/null 2>&1 || PM="yum"

# ==========================================================
echo "== 0/7 检测公网 IP =="
# ==========================================================
IP="$FORCE_IP"
if [ -z "$IP" ]; then
  # 腾讯云 metadata 服务（内网直连，最快最准）
  IP=$(curl -s --max-time 5 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null || true)
fi
if [ -z "$IP" ]; then IP=$(curl -s --max-time 8 http://myip.ipip.net 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true); fi
if [ -z "$IP" ]; then IP=$(curl -s --max-time 8 https://ifconfig.me 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true); fi
if [ -z "$IP" ]; then IP=$(hostname -I 2>/dev/null | awk '{print $1}'); fi
[ -z "$IP" ] && { err "无法自动获取公网 IP，请手工指定：bash deploy/deploy_centos.sh <备份文件> <公网IP>"; exit 1; }
echo "   公网 IP: $IP"

# ==========================================================
# Docker 安装：自动版本映射 + 多源回退
# ==========================================================

# 把发行版映射到「可用的 docker-ce 仓库版本号」
detect_compat_ver() {
  local id="" vid="" maj="" v=""
  if [ -r /etc/os-release ]; then
    id=$(. /etc/os-release 2>/dev/null; echo "${ID:-}")
    vid=$(. /etc/os-release 2>/dev/null; echo "${VERSION_ID:-}")
  fi
  maj="${vid%%.*}"
  case "$id" in
    tencentos|tlinux)
      case "$maj" in
        4) v=9 ;;   # TencentOS Server 4 ≈ RHEL 9
        3) v=8 ;;   # TencentOS Server 3 ≈ RHEL 8
        2) v=7 ;;
      esac ;;
    opencloudos)
      case "$maj" in 9) v=9 ;; 8) v=8 ;; esac ;;
    centos|rhel|rocky|almalinux|anolis)
      v="$maj" ;;
  esac
  if [ -z "$v" ]; then
    local rh; rh=$(rpm -E '%{rhel}' 2>/dev/null || echo "")
    case "$rh" in 7|8|9) v="$rh" ;; esac
  fi
  case "$v" in
    7|8|9) echo "$v" ;;
    *)     echo 9 ;;   # 兜底
  esac
}

write_docker_repo() {
  local base="$1" ver="$2"
  cat > /etc/yum.repos.d/docker-ce.repo <<REPO
[docker-ce-stable]
name=Docker CE Stable - \$basearch
baseurl=${base}/docker-ce/linux/centos/${ver}/\$basearch/stable
enabled=1
gpgcheck=1
gpgkey=${base}/docker-ce/linux/centos/gpg
REPO
}

try_install_from_repo() {
  $PM -y makecache --disablerepo='*' --enablerepo=docker-ce-stable >/dev/null 2>&1 || return 1
  $PM install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1 && return 0
  $PM install -y docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 && return 0
  $PM install -y --nogpgcheck docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 && return 0
  return 1
}

echo "== 1/7 安装 Docker（自动兼容 TencentOS Server 4）=="
if command -v docker >/dev/null 2>&1; then
  echo "   docker 已存在，跳过安装"
else
  # 关键：先清掉上一轮可能写入的「$releasever=4 → centos/4」坏源，否则后续任何 dnf 都会 404
  warn "   清理可能存在的损坏 docker 源…"
  rm -f /etc/yum.repos.d/docker-ce*.repo 2>/dev/null || true
  $PM clean all >/dev/null 2>&1 || true

  $PM install -y dnf-plugins-core >/dev/null 2>&1 \
    || $PM install -y yum-utils >/dev/null 2>&1 \
    || true

  CV=$(detect_compat_ver)
  echo "   检测到发行版：$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")"
  echo "   映射到 Docker 仓库版本：centos/${CV}"

  INSTALLED=0
  for pair in \
      "${CV} https://mirrors.tencent.com" \
      "${CV} https://mirrors.aliyun.com" \
      "9 https://mirrors.tencent.com" \
      "9 https://mirrors.aliyun.com" \
      "8 https://mirrors.tencent.com" \
      "${CV} https://download.docker.com"; do
    set -- $pair
    ver="$1"; base="$2"
    echo "   尝试源：${base}/docker-ce/linux/centos/${ver} …"
    write_docker_repo "$base" "$ver"
    if try_install_from_repo; then
      say "   ✓ 安装成功（源：${base}，仓库版本 centos/${ver}）"
      INSTALLED=1
      break
    fi
    rm -f /etc/yum.repos.d/docker-ce.repo 2>/dev/null || true
  done

  if [ "$INSTALLED" -eq 0 ]; then
    warn "   仓库方式均失败，尝试系统内置容器引擎（Moby）…"
    rm -f /etc/yum.repos.d/docker-ce*.repo 2>/dev/null || true
    $PM makecache >/dev/null 2>&1 || true
    $PM install -y moby-engine moby-cli >/dev/null 2>&1 \
      || $PM install -y moby >/dev/null 2>&1 \
      || $PM install -y docker >/dev/null 2>&1 \
      || true
    command -v docker >/dev/null 2>&1 || {
      err "Docker 安装失败。"
      err "请改用零 Docker 方案（推荐，对网络要求更低）："
      err "    bash deploy/deploy_node.sh ${BACKUP:-}"
      exit 1
    }
  fi

  # 镜像加速（仅在新机无配置时写入，避免覆盖用户自定义）
  if [ ! -f /etc/docker/daemon.json ]; then
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<'JSON'
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
    echo "   已配置腾讯云镜像加速"
  fi

  systemctl daemon-reload
  systemctl enable --now docker >/dev/null 2>&1 || systemctl start docker || true
fi

# 等待 docker 守护进程就绪
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
docker info >/dev/null 2>&1 || { err "Docker 守护进程未就绪，请检查 systemctl status docker"; exit 1; }
docker --version

HAVE_COMPOSE=0
if docker compose version >/dev/null 2>&1; then
  HAVE_COMPOSE=1
  echo "   compose 插件： $(docker compose version)"
else
  warn "   未检测到 docker compose 插件，将改用 docker build/run 方式部署（效果相同）"
fi

# ==========================================================
echo "== 2/7 获取代码（GitHub main，含最新修复）=="
# ==========================================================
$PM install -y git >/dev/null 2>&1 || true
mkdir -p /opt
if [ -d "$APP_DIR/.git" ]; then
  (cd "$APP_DIR" && git pull -q)
  say "   已更新到最新代码"
else
  git clone -q https://github.com/yu3461018595/mes-light.git "$APP_DIR"
fi
cd "$APP_DIR"

# ==========================================================
echo "== 3/7 写入环境变量（二维码链接指向本机 IP）=="
# ==========================================================
cat > .env <<EOF
NODE_ENV=production
PORT=3000
DATA_DIR=/app/data
PUBLIC_BASE_URL=http://${IP}:${HOST_PORT}
EOF
mkdir -p "$APP_DIR/data"
echo "   PUBLIC_BASE_URL=http://${IP}:${HOST_PORT}"

# ==========================================================
echo "== 4/7 构建镜像 =="
# ==========================================================
if [ "$HAVE_COMPOSE" -eq 1 ]; then
  docker compose build
else
  docker build -t mes-light:latest .
fi

# ==========================================================
echo "== 5/7 导入业务数据（首次启动前，避免混入演示数据）=="
# ==========================================================
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
  cp -f "$BACKUP" "$APP_DIR/mes_live_export.json"
  if [ "$HAVE_COMPOSE" -eq 1 ]; then
    docker compose run --rm -v "$APP_DIR/mes_live_export.json:/tmp/backup.json:ro" mes \
      node deploy/migrate_db.cjs /tmp/backup.json --clean
  else
    docker run --rm \
      -e DATA_DIR=/app/data \
      -v "$APP_DIR/data:/app/data" \
      -v "$APP_DIR/mes_live_export.json:/tmp/backup.json:ro" \
      mes-light:latest node deploy/migrate_db.cjs /tmp/backup.json --clean
  fi
  say "   ✓ 数据导入完成"
else
  warn "   未提供备份文件，跳过导入（将使用演示数据）"
fi

# ==========================================================
echo "== 6/7 启动容器 =="
# ==========================================================
if [ "$HAVE_COMPOSE" -eq 1 ]; then
  docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml up -d
else
  docker rm -f mes-light >/dev/null 2>&1 || true
  docker run -d --name mes-light --restart unless-stopped \
    -p 127.0.0.1:3000:3000 -p 0.0.0.0:${HOST_PORT}:3000 \
    --env-file "$APP_DIR/.env" \
    -v "$APP_DIR/data:/app/data" \
    mes-light:latest
fi

# ==========================================================
echo "== 7/7 开放防火墙端口 ${HOST_PORT} =="
# ==========================================================
if command -v firewall-cmd >/dev/null 2>&1; then
  systemctl enable --now firewalld 2>/dev/null || true
  firewall-cmd --permanent --add-port=${HOST_PORT}/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
  echo "   已放行 ${HOST_PORT}/tcp"
fi

sleep 5
say ""
say "容器状态："
if [ "$HAVE_COMPOSE" -eq 1 ]; then
  docker compose ps
else
  docker ps --filter name=mes-light --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
fi

say ""
say "================ 部署完成 ================"
say "访问地址： http://${IP}:${HOST_PORT}"
say "默认账号： 管理员 / 123456（导入数据后密码被重置，请登录后立即修改）"
say "数据目录： ${APP_DIR}/data/mes.db（备份直接拷贝该文件）"
say ""
say "若浏览器打不开，请到腾讯云控制台 → 防火墙/安全组 → 放行 TCP ${HOST_PORT}"
say "========================================"
