#!/usr/bin/env bash
# ============================================================
# MES-Light 阶段二一键脚本：Nginx 反代 + Let's Encrypt HTTPS + 关闭公网 8080
#
# 用法（在服务器 /opt/mes-light 目录，root 执行）：
#   bash deploy/setup_https.sh <域名> [邮箱]
#   例：bash deploy/setup_https.sh mes-yourcompany.cn admin@yourcompany.cn
#
# 前置（必须用户先完成，否则证书签发会失败）：
#   1) 域名已购买，且 ICP 备案已通过（国内放 80/443 的硬性要求）
#   2) 域名 A 记录指向本服务器公网 IP（114.117.233.47）
#   3) 云控制台已放行 80/443 入站（轻量=防火墙 / CVM=安全组）
#   4) 服务器已装 nginx + certbot（deploy 阶段已预装）
#
# 脚本做什么：
#   1) 用 deploy/nginx/mes.conf 模板生成 /etc/nginx/conf.d/mes.conf（替换 server_name）
#   2) nginx -t 校验并启动（80 端口反代到 127.0.0.1:3000）
#   3) certbot --nginx 自动签发证书、改写 443/SSL、加 http→https 跳转
#   4) 改写 /opt/mes-light/.env 的 PUBLIC_BASE_URL=https://域名（扫码链接变 https）
#   5) 用主 docker-compose.yml（仅 127.0.0.1:3000）重启容器，关闭公网 8080
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-admin@${DOMAIN:-example.com}}"
if [ -z "$DOMAIN" ]; then
  echo "用法: $0 <域名> [邮箱]"; exit 1
fi
if [ "$(id -u)" != "0" ]; then
  echo "请使用 root 运行"; exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
CONF=/etc/nginx/conf.d/mes.conf

echo "[1/5] 生成 Nginx 配置 ($CONF, server_name=$DOMAIN)"
if [ -f "$HERE/nginx/mes.conf" ]; then
  cp "$HERE/nginx/mes.conf" "$CONF"
else
  # 仓库被裁剪时也允许从 /opt/mes-light/deploy/nginx 取
  cp /opt/mes-light/deploy/nginx/mes.conf "$CONF"
fi
sed -i "s/CHANGE-ME.example.com/$DOMAIN/g" "$CONF"

echo "[2/5] 校验并启动 Nginx"
nginx -t
systemctl enable --now nginx
sleep 1

echo "[3/5] 申请 Let's Encrypt 证书 (certbot)"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect

echo "[4/5] 更新 .env: PUBLIC_BASE_URL=https://$DOMAIN"
ENV=/opt/mes-light/.env
if [ -f "$ENV" ]; then
  sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://$DOMAIN#" "$ENV"
else
  echo "PUBLIC_BASE_URL=https://$DOMAIN" > "$ENV"
fi

echo "[5/5] 用主 compose（仅 127.0.0.1:3000）重启，关闭公网 8080"
cd /opt/mes-light
docker compose down
docker compose up -d

sleep 3
echo "=== 验证 ==="
curl -sI "https://$DOMAIN/" | head -1 || echo "(https 验证失败，请检查 DNS/备案/证书)"
echo "完成。微信扫码应直接打开 https://$DOMAIN/..."
