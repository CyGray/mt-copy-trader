# Build context is the repository root (docker-compose.yml: context: .), because
# the web app imports pure shared modules from ../worker/src/lib and ../docs/.
# Those files are copied below with the same relative layout, so the @shared
# alias (web/tsconfig.json -> ../worker/src/lib/*) resolves unchanged.
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY web/package.json ./web/package.json
COPY worker/package.json ./worker/package.json
# Only the web workspace: the worker's native dependencies are not needed here.
# web pins its own next version, so it lands in web/node_modules, not the root.
RUN npm install --workspace=web --no-audit --no-fund

FROM base AS builder
COPY package.json ./
COPY web ./web
# Pure shared sources imported by web (type-only imports are included so tsc can check them).
COPY worker/src/lib/executionProfile.ts worker/src/lib/positionSizing.ts worker/src/lib/entryPolicy.ts \
     worker/src/lib/tradeSetTypes.ts worker/src/lib/brokerTypes.ts worker/src/lib/vipSignalParser.ts \
     ./worker/src/lib/
COPY docs/project_memory/examples ./docs/project_memory/examples
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they
# must be passed as build args (see docker-compose.yml). They are not secrets.
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID
RUN npm run build --workspace web

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/web
COPY --from=builder /app/web/.next ./.next
COPY --from=builder /app/web/public ./public
COPY --from=builder /app/web/package.json ./package.json
COPY --from=builder /app/web/next.config.js ./next.config.js
COPY --from=builder /app/web/node_modules ./node_modules
COPY --from=builder /app/node_modules /app/node_modules
EXPOSE 3000
CMD ["npm", "run", "start"]
