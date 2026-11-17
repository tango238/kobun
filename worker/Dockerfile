FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
# Claude Max を `claude -p` で使うため公式 Claude Code CLI を入れる
RUN npm install -g @anthropic-ai/claude-code
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
CMD ["npx", "ts-node", "src/worker.ts"]
