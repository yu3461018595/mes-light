#!/usr/bin/env bash
# MES-Light 一键部署脚本（在腾讯云轻量应用服务器上以 root 运行）
# 前置：已把域名 A 记录解析到本机公网 IP、已在防火墙/安全组开放 80 与 443 端口
set -e
export DEBIAN_FRONTEND=noninteractive

echo "== 1/5 安装 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  # 国内镜像安装源，比官方 get.docker.com 快且稳
  curl -fsSL https://get.daocloud.io/docker | bash
  systemctl enable --now docker
fi
docker --version

echo "== 2/5 获取代码 =="
cd /opt
if [ -d mes-light ]; then (cd mes-light && git pull); else git clone https://github.com/yu3461018595/mes-light.git; fi
cd mes-light

echo "== 3/5 构建并启动容器 =="
docker compose build
docker compose up -d

echo "== 4/5 安装 Nginx 并申请 HTTPS 证书 =="
if ! command -v nginx >/dev/null 2>&1; then apt-get update && apt-get install -y nginx; fi
cp deploy/nginx/mes.conf /etc/nginx/conf.d/mes.conf
read -r -p "请输入你的已备案域名（如 mes.example.com）: " DOMAIN
sed -i "s/CHANGE-ME.example.com/$DOMAIN/g" /etc/nginx/conf.d/mes.conf
nginx -t && systemctl enable --now nginx && systemctl reload nginx

if ! command -v certbot >/dev/null 2>&1; then apt-get install -y certbot python3-certbot-nginx; fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@"$DOMAIN" \
  || echo "⚠️ 证书自动申请失败，请手动执行：certbot --nginx -d $DOMAIN"

echo "== 5/5 完成 =="
echo "请访问 https://$DOMAIN 验证；微信扫码应能直接打开报工页。"
echo "业务数据位于 /opt/mes-light/data/mes.db，迁移/备份直接拷贝该文件即可。"
