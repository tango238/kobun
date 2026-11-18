# pi-durable は Node 22.19 以上を要求する
FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/sandbox
# Pi の NodeExecutionEnv (ファイル操作・コマンド実行・監視) をここで動かし、worker から RPC で使う
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs repo-access.mjs env-rpc.mjs ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p /workspace
ENTRYPOINT ["./entrypoint.sh"]
