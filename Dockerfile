FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./

COPY . .

ENV PORT=8080 \
    DATABASE_PATH=/data/app.sqlite3 \
    ENVELOPE_DIR=/data/envelopes
VOLUME ["/data"]
EXPOSE 8080
# 首次启动自动幂等迁移（src/db.js 调用 migrate）
CMD ["npm", "start"]
