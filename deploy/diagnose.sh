#!/usr/bin/env bash
# MES-Light 部署诊断：逐层定位「浏览器打不开」的原因
#
# 用法（root 执行）：
#   bash /opt/mes-light/deploy/diagnose.sh
# 把输出整段贴出来即可定位问题。
#
set +e   # 诊断脚本不中断，必须跑完全部检查

HOST_PORT=${HOST_PORT:-8080}

say()  { echo -e "\033[36m$*\033[0m"; }
ok()   { echo -e "  \033[32m[OK]\033[0m  $*"; }
bad()  { echo -e "  \033[31m[!!]\033[0m  $*"; }
info() { echo "       $*"; }

say "================= MES-Light 部署诊断 ================="
say ""

# ---------- 1. 运行方式识别 ----------
say "【1】服务进程 / 容器状态"
MODE="未知"
if command -v docker >/dev/null 2>&1; then
  CID=$(docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | grep '^mes-light' || true)
  if [ -n "$CID" ]; then
    MODE="docker"
    echo "$CID" | sed 's/^/       /'
    STATUS=$(echo "$CID" | awk '{print $2}')
    case "$STATUS" in
      Up*) ok "容器正在运行（${STATUS}）" ;;
      *)   bad "容器未运行：${STATUS}　← 浏览器打不开的直接原因"
           info "查看退出原因：docker logs --tail 50 mes-light" ;;
    esac
  fi
fi
if systemctl list-unit-files 2>/dev/null | grep -q '^mes-light.service'; then
  MODE="systemd"
  ST=$(systemctl is-active mes-light 2>/dev/null)
  if [ "$ST" = "active" ]; then
    ok "systemd 服务运行中"
  else
    bad "systemd 服务未运行：${ST}　← 浏览器打不开的直接原因"
    info "排查：systemctl status mes-light / journalctl -u mes-light -n 50"
  fi
fi
if [ "$MODE" = "未知" ]; then
  bad "既没找到 mes-light 容器，也没找到 mes-light 服务"
  info "服务很可能从未启动成功。请回到部署脚本第 5 步检查导入是否报错："
  info "   cd /opt/mes-light && git pull && bash deploy/deploy_centos.sh /root/mes_live_export.json"
fi
say ""

# ---------- 2. 端口监听 ----------
say "【2】端口监听"
LISTEN=$(ss -lntp 2>/dev/null | grep -E ":${HOST_PORT}\b|:3000\b" || true)
if [ -n "$LISTEN" ]; then
  echo "$LISTEN" | sed 's/^/       /'
  if echo "$LISTEN" | grep -qE "0\.0\.0\.0:${HOST_PORT}|\*:${HOST_PORT}|\[::\]:${HOST_PORT}"; then
    ok "${HOST_PORT} 已对外监听（0.0.0.0）"
  else
    bad "${HOST_PORT} 只监听了 127.0.0.1，外部无法访问"
    info "原因：只加载了 docker-compose.yml，漏了 IP 覆盖文件。执行："
    info "   docker compose -f docker-compose.yml -f deploy/docker-compose.ip.yml up -d"
  fi
else
  bad "端口 ${HOST_PORT} / 3000 均无人监听"
fi
say ""

# ---------- 3. 本机自测（区分「服务问题」还是「网络问题」）----------
say "【3】本机自测"
CODE=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${HOST_PORT}/" 2>/dev/null || echo "000")
if [ "$CODE" = "200" ]; then
  ok "本机 curl 返回 HTTP 200 —— 应用本身是正常的"
  info "若浏览器打不开，问题在网络层（云平台安全组 / 系统防火墙），见下面第 4、5 项"
else
  bad "本机 curl 返回 HTTP ${CODE} —— 应用没起来或端口不对"
  info "看日志：docker logs --tail 50 mes-light   或   journalctl -u mes-light -n 50"
fi
say ""

# ---------- 4. 系统防火墙 ----------
say "【4】系统防火墙（firewalld）"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active firewalld >/dev/null 2>&1; then
  PORTS=$(firewall-cmd --list-ports 2>/dev/null)
  info "已放行端口：${PORTS:-（无）}"
  if echo "$PORTS" | grep -q "${HOST_PORT}/tcp"; then
    ok "${HOST_PORT}/tcp 已放行"
  else
    bad "${HOST_PORT}/tcp 未放行，补开：firewall-cmd --permanent --add-port=${HOST_PORT}/tcp && firewall-cmd --reload"
  fi
else
  info "firewalld 未运行（不影响，多数镜像默认不启用）"
fi
say ""

# ---------- 5. 云平台安全组（脚本无法代劳，必须人工确认）----------
say "【5】云平台安全组 / 防火墙（最关键，脚本管不到这一层）"
info "请到腾讯云控制台确认已放行 TCP ${HOST_PORT}："
info "   轻量应用服务器 → 防火墙"
info "   CVM → 安全组 → 入站规则"
info "这是「本机 curl 200 但浏览器打不开」的最常见原因。"
say ""

# ---------- 6. 地址 ----------
say "【6】访问地址"
IP=$(curl -s --max-time 5 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null || true)
[ -z "$IP" ] && IP=$(curl -s --max-time 8 https://ifconfig.me 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)
[ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
info "服务器公网 IP：${IP}"
info "应访问：       http://${IP}:${HOST_PORT}"
info "把这个 IP 告诉我，我可以从外网实测端口连通性。"
say ""

# ---------- 7. 最近日志 ----------
say "【7】最近日志（末 30 行）"
if [ "$MODE" = "docker" ]; then
  docker logs --tail 30 mes-light 2>/dev/null | sed 's/^/       /' || true
elif [ "$MODE" = "systemd" ]; then
  journalctl -u mes-light -n 30 --no-pager 2>/dev/null | sed 's/^/       /' || true
else
  info "无可用日志源"
fi
say ""
say "================= 诊断结束 ================="
say "请把以上输出整段发出来。"
