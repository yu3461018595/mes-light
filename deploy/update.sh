#!/usr/bin/env bash
# MES-Light 更新脚本：拉取最新代码并重建/重启服务
#
# 不依赖 git，走 GitHub codeload 公共 tarball（仓库为 public，无需鉴权）。
# 覆盖代码时保留 ./data（含 mes.db）与 ./backups，不改动任何业务数据。
# 前端/静态资源已烘焙进镜像，故必须 docker compose build 重建后才生效。
#
# 用法（在服务器上以 root 执行）：
#   本地已在 /opt/mes-light 时：  bash /opt/mes-light/deploy/update.sh
#   或远端一键（自动拉最新版脚本）：
#     curl -fsSL https://raw.githubusercontent.com/yu3461018595/mes-light/main/deploy/update.sh | bash
#
set -e

APP_DIR=/opt/mes-light
REPO_TAR="https://codeload.github.com/yu3461018595/mes-light/tar.gz/refs/heads/main"
say()  { echo -e "\033[36m$*\033[0m"; }
warn() { echo -e "\033[33m$*\033[0m"; }

cd "$APP_DIR" 2>/dev/null || { echo "找不到 $APP_DIR，请确认部署目录"; exit 1; }

say "== 1/4 备份数据库 =="
mkdir -p "$APP_DIR/backups"
BKF="$APP_DIR/backups/mes-$(date +%Y%m%d-%H%M%S).db"
if [ -f "$APP_DIR/data/mes.db" ]; then
  cp "$APP_DIR/data/mes.db" "$BKF"
  say "   已备份到 $BKF"
else
  warn "   未找到 data/mes.db，跳过备份"
fi

say "== 2/4 拉取最新代码（codeload 公共 tarball，保留 ./data）=="
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$REPO_TAR" -o "$TMP/mes.tgz"
mkdir -p "$TMP/mes"
tar -xzf "$TMP/mes.tgz" -C "$TMP/mes" --strip-components=1
# 覆盖代码，但保留已有 ./data（含 mes.db）
cp -a "$TMP/mes/." "$APP_DIR/"
say "   代码覆盖完成，新增/改动文件已生效"

say "== 3/4 停止旧容器并重建镜像 =="
# 二维码稳定性：先从旧容器抢救扫码密钥到持久数据卷（data/.secret），避免重建后已印二维码失效
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^mes-light$'; then
  if [ ! -f "$APP_DIR/data/.secret" ] && docker exec mes-light test -f /app/.secret 2>/dev/null; then
    docker cp mes-light:/app/.secret "$APP_DIR/data/.secret" && chmod 600 "$APP_DIR/data/.secret" \
      && say "   已迁移扫码密钥到 data/.secret（二维码保持有效）"
  fi
fi
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^mes-light$'; then
  if docker compose version >/dev/null 2>&1; then
    docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml down
    docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml build
    docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml up -d
  else
    docker rm -f mes-light >/dev/null 2>&1 || true
    docker build -t mes-light:latest .
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
  warn "未识别到运行中的 mes-light 容器，请确认 Docker 部署是否正常。"
fi

say "== 4/4 健康检查 =="
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || echo 000)
say "   首页 HTTP 状态： $CODE"

say ""
say "更新完成。若页面异常，可回滚数据库："
say "   cp $BKF ${APP_DIR}/data/mes.db && docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml restart"
