#!/usr/bin/env bash
# MES-Light 腾讯云一键部署（CentOS / TencentOS / OpenCloudOS / Rocky / Alma）
#
# 阶段一：暂无域名、未备案 → 用 http://公网IP:8080 访问（非 80/443 端口无需备案）
#
# 用法（root 执行）：
#   bash deploy/deploy_centos.sh                        # 只部署，不导入数据
#   bash deploy/deploy_centos.sh /root/mes_live_export.json   # 部署并导入线上数据（推荐）
#
set -e

APP_DIR=/opt/mes-light
PORT=8080
BACKUP="$1"

echo "== 0/7 检测公网 IP =="
IP=$(curl -s --max-time 8 ifconfig.me || true)
if [ -z "$IP" ]; then IP=$(curl -s --max-time 8 ip.sb || true); fi
if [ -z "$IP" ]; then IP=$(hostname -I 2>/dev/null | awk '{print $1}'); fi
echo "   公网 IP: $IP"

echo "== 1/7 安装 Docker（阿里云镜像源）=="
if ! command -v docker >/dev/null 2>&1; then
  (dnf install -y dnf-plugins-core 2>/dev/null || yum install -y yum-utils)
  (dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo 2>/dev/null \
    || yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo)
  (dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin 2>/dev/null \
    || yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin)
  systemctl enable --now docker
fi
docker --version
docker compose version

echo "== 2/7 获取代码（GitHub main，含最新修复）=="
mkdir -p /opt
if [ -d "$APP_DIR/.git" ]; then
  (cd "$APP_DIR" && git pull)
else
  git clone https://github.com/yu3461018595/mes-light.git "$APP_DIR"
fi
cd "$APP_DIR"

echo "== 3/7 写入环境变量（二维码链接指向本机 IP）=="
cat > .env <<EOF
NODE_ENV=production
PORT=3000
DATA_DIR=/app/data
PUBLIC_BASE_URL=http://${IP}:${PORT}
EOF
echo "   PUBLIC_BASE_URL=http://${IP}:${PORT}"

echo "== 4/7 构建镜像 =="
docker compose build

if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
  echo "== 5/7 导入业务数据（首次启动前，避免混入演示数据）=="
  cp -f "$BACKUP" "$APP_DIR/mes_live_export.json"
  docker compose run --rm -v "$APP_DIR/mes_live_export.json:/tmp/backup.json:ro" mes \
    node deploy/migrate_db.cjs /tmp/backup.json --clean
else
  echo "== 5/7 未提供备份文件，跳过数据导入（将使用演示数据）=="
fi

echo "== 6/7 启动容器 =="
docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml up -d

echo "== 7/7 开放防火墙端口 ${PORT} =="
if command -v firewall-cmd >/dev/null 2>&1; then
  systemctl enable --now firewalld 2>/dev/null || true
  firewall-cmd --permanent --add-port=${PORT}/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
  echo "   已放行 ${PORT}/tcp"
fi

sleep 3
echo
echo "容器状态："
docker ps --filter name=mes-light --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo
echo "================ 部署完成 ================"
echo "访问地址： http://${IP}:${PORT}"
echo "默认账号： 管理员 / 123456（导入数据时密码被重置，请登录后立即修改）"
echo "数据目录： ${APP_DIR}/data/mes.db（备份直接拷贝该文件）"
echo
echo "若浏览器打不开，请到腾讯云控制台 → 防火墙/安全组 → 放行 TCP ${PORT}"
echo "========================================"
