# AZM API — صورة الإنتاج
#
#   docker build -t azm-api .
#   docker run --env-file .env.production -p 3000:3000 azm-api
#
# تُطبَّق الترحيلات (prisma migrate deploy) عند كل إقلاع قبل تشغيل الخادم:
# آمنة للتكرار، ولا تُنشئ ولا تحذف شيئًا خارج ملفات prisma/migrations.
# على أكثر من نسخة: شغّل الترحيل خطوة نشر واحدة، و CMD ["node","dist/src/main"].

# ── البناء ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# ── التشغيل ─────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
