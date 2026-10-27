FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/scripts ./scripts
RUN chmod +x /app/scripts/run-with-backoff.sh
# 4000 = forwarder (dist/index.js), 4001 = AutoTrader (dist/autotrader.js).
# Neither is published to the host by docker-compose.yml; containers only.
EXPOSE 4000 4001
CMD ["/app/scripts/run-with-backoff.sh"]
