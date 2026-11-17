FROM node:20-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/sandbox
COPY server.mjs ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p /workspace
ENTRYPOINT ["./entrypoint.sh"]
