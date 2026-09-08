#!/usr/bin/env bash
# MES-Light 更新脚本：拉取最新代码并重启服务
#
# 自动识别部署方式：
#   - systemd 方式（deploy_node.sh 部署）→ git pull + systemctl restart
#   - Docker 方式（deploy_centos.sh 部署）→ git pull + 重建镜像 + 重启容器
#
# 注意：只更新代码，不会动业务数据（数据保存在 ./data/mes.db，不在版本控制内）
#
# 用法（root 执行）：
#   bash /opt/mes-light/deploy/update.sh
#
set -e

APP_DIR=/opt/mes-light
say() { echo -e "\033[36m$*\033[0m"; }
warn() { echo -e "\033[33m$*\033[0m"; }

cd "$APP_DIR"

say "== 1/3 备份数据库 =="
mkdir -p "$APP_DIR/backups"
BKF="$APP_DIR/backups/mes-$(date +%Y%m%d-%H%M%S).db"
if [ -f "$APP_DIR/data/mes.db" ]; then
  cp "$APP_DIR/data/mes.db" "$BKF"
  say "   已备份到 $BKF"
else
  warn "   未找到 data/mes.db，跳过备份"
fi

say "== 2/3 拉取最新代码 =="
git pull
say "   当前 HEAD: $(git rev-parse --short HEAD)"

say "== 3/3 重启服务 =="
if systemctl list-unit-files 2>/dev/null | grep -q '^mes-light.service'; then
  systemctl restart mes-light
  sleep 3
  say "   服务状态： $(systemctl is-active mes-light)"
  say "   健康检查： HTTP $(curl -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || echo 000)"
  say "日志查看： journalctl -u mes-light -f"
elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^mes-light$'; then
  if docker compose version >/dev/null 2>&1; then
    docker compose build
    docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml up -d
  else
    docker build -t mes-light:latest .
    docker rm -f mes-light >/dev/null 2>&1 || true
    docker run -d --name mes-light --restart unless-stopped \
      -p 127.0.0.1:3000:3000 -p 0.0.0.0:8080:3000 \
      --env-file "$APP_DIR/.env" \
      -v "$APP_DIR/data:/app/data" \
      mes-light:latest
  fi
  sleep 3
  docker ps --filter name=mes-light --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  say "日志查看： docker logs -f mes-light"
else
  warn "未识别到运行中的部署方式，请手工重启。"
fi

say ""
say "更新完成。若页面异常，可回滚数据库："
say "   cp $BKF ${APP_DIR}/data/mes.db && 重启服务"
