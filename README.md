# ByTrader — Marine Trader Crypto Bot (v1)

## Overview
Monorepo with two services:
- `web`: Next.js (App Router + TypeScript + Tailwind)
- `worker`: Node.js + TypeScript trading engine

## Quick Start
1. Copy environment variables:
   - `cp .env.example .env`
2. Install dependencies:
   - `npm install`
3. Run locally:
   - `npm run dev`

## Firestore Setup
- Seed base collections:
  - `npm run seed:firestore --workspace worker`

## Docker Compose
- `docker-compose up --build`

## Services
- Web (Next.js) exposes `http://localhost:3000`
- Worker exposes `http://localhost:4000/health`

## Notes
- Firestore credentials are required for worker to start.
- Telegram session is stored in `./data/telegram` (volume-mapped).
