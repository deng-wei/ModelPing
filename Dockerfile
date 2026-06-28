# 多阶段构建：build 阶段编译前端+后端，runtime 阶段只带运行时依赖。
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 仅安装生产依赖（hono / @hono/node-server）。
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
# 拷贝构建产物：dist/server（后端）、dist/client（前端）。
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data /data \
  && chown -R node:node /app /data
USER node
EXPOSE 8787
# 不在镜像中烘焙任何 API Key。APP_PASSWORD / ALLOWED_HOSTS 运行时按需注入。
CMD ["node", "dist/server/node.js"]
