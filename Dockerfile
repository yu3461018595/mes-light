# 轻量生产管理系统 - 容器镜像
# 基于 Node 22（内置 node:sqlite，无需额外编译）
FROM node:22-bookworm-slim

WORKDIR /app

# 仅复制清单先安装依赖（本项目零依赖，但保留标准分层以便扩展）
COPY package.json ./

# 复制全部源码与静态资源
COPY . .

# 预建数据目录（运行时由 node:sqlite 自动初始化演示数据）
RUN mkdir -p data

# 声明端口（部署平台可用 PORT 环境变量覆盖）
ENV PORT=3000
EXPOSE 3000

# 健康检查：首页可访问即视为存活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
