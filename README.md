# ByTrader: Automated Telegram to Bybit Crypto Copy Trading System

ByTrader is an automated cryptocurrency trading system designed to bridge Telegram signal channels with Bybit Unified Trading Accounts (USDT Perpetuals). It listens to private signal channels via MTProto user sessions, extracts structured trading parameters, and executes orders with dynamic risk management and automated position management.

The system includes a mobile-first Next.js web dashboard for real-time monitoring, analytics, configuration, and emergency control.

---

## Key Features

- Telegram MTProto Integration: Operates as a user client to monitor private channels, forwarded messages, replies, and edits without requiring bot admin permissions.
- Robust Signal Parsing: Parses structured trade setups including symbol, direction (Long/Short), entry targets, Stop Loss (SL), and Take Profit levels (TP1 to TP3).
- Automated Bybit Execution: Executes USDT Perpetual orders on Bybit Unified Trading Account with configurable leverage and margin modes.
- Dynamic Risk Management:
  - Automatic position sizing based on risk per trade or fixed margin.
  - Automated stop-loss updates (moves SL to entry after TP1 fill, locks profits after TP2 fill).
  - Configurable safety limits: maximum open positions, maximum exposure per symbol, maximum daily drawdown, and consecutive loss circuit breakers.
- State Synchronization: Uses Google Cloud Firestore as the single source of truth, backed by a 15-second background reconciliation loop against Bybit live order and position states.
- Web Management Dashboard: Responsive Next.js PWA interface providing live PnL, open position tracking, trade history, Telegram session management, and system logs.
- Security and Access Control: Google OAuth with role-based access (Admin and Viewer roles) and AES-GCM encryption for stored API keys and Telegram session credentials.
- Emergency Overrides: Dashboard-accessible global kill switch and immediate emergency close-all capability.
- Multi-Channel Notifications: Alerts dispatched via Telegram, Email (SMTP), and Web Push (VAPID).

---

## Architecture

ByTrader is structured as a TypeScript monorepo managed via Docker Compose:

```
bytrader/
|-- web/                  # Next.js frontend and dashboard API
|   |-- src/app/          # Next.js App Router pages and API routes
|   |-- src/components/   # Reusable UI components and layouts
|   \-- src/lib/          # Firebase client/admin, auth helpers, API clients
|-- worker/               # Background trading and execution engine
|   |-- src/index.ts      # Worker entrypoint and reconciliation loop
|   \-- src/lib/          # Telegram listener, parser, Bybit client, trade engine
|-- docker-compose.yml    # Container orchestration for web and worker services
\-- .env.example          # Environment variable template
```

### Services

1. Worker Service (`worker`):
   - Maintains persistent MTProto connection to Telegram.
   - Parses signals and dispatches execution instructions.
   - Communicates with Bybit v5 API for order placement and position adjustments.
   - Periodically reconciles local Firestore state with remote exchange state.
   - Exposes a health endpoint at `http://localhost:4000/health`.

2. Web Dashboard (`web`):
   - Next.js application exposing the user interface at `http://localhost:3000`.
   - Connects to Firestore for live data feeds and configuration management.
   - Exposes secure API routes for administrative operations and worker proxies.

---

## Tech Stack

- Frontend: Next.js (App Router), React, TypeScript, Tailwind CSS
- Backend Engine: Node.js, TypeScript
- Database and Auth: Google Cloud Firestore, Firebase Authentication
- External Integrations: Telegram MTProto API, Bybit v5 REST API
- Deployment: Docker, Docker Compose

---

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm 9 or higher
- Docker and Docker Compose (for containerized deployment)
- Telegram API credentials (`api_id` and `api_hash` from my.telegram.org)
- Bybit account with API key and secret (read and trade permissions for Unified Trading Account)
- Firebase project with Firestore and Authentication enabled

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/CyGray/mt-copy-trader.git
   cd mt-copy-trader
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   Populate `.env` with required API keys, database credentials, and secrets.

4. Initialize Firestore collections:
   ```bash
   npm run seed:firestore --workspace worker
   ```

### Running Locally

To run both `web` and `worker` in development mode:

```bash
npm run dev
```

Alternatively, run each workspace independently:

```bash
# Start Next.js dashboard
npm run dev --workspace web

# Start trading worker
npm run dev --workspace worker
```

### Running with Docker Compose

Build and launch all services in detached mode:

```bash
docker-compose up -d --build
```

View service logs:

```bash
docker-compose logs -f
```

---

## Configuration Reference

Key environment variables defined in `.env.example`:

- `MASTER_KEY`: 32-byte base64 string used for AES-GCM secret encryption.
- `WORKER_URL`: HTTP endpoint of the worker service (default: `http://localhost:4000`).
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: Service account credentials for server-side Firestore operations.
- `NEXT_PUBLIC_FIREBASE_*`: Firebase Client SDK settings for web authentication and dashboard updates.
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`: Telegram application credentials.
- `TELEGRAM_SESSION_PATH`: Filesystem destination for the encrypted Telegram session file.
- `BYBIT_API_KEY`, `BYBIT_API_SECRET`: Bybit credentials for order execution.
- `BYBIT_TESTNET`: Set to `true` for paper trading / testnet, or `false` for live execution.
- `SMTP_*`: Optional configuration for email notifications.
- `VAPID_*`: Optional configuration for Web Push notifications.

---

## Trade Lifecycle

1. Signal Detection: Telegram listener captures message from configured channel.
2. Parsing and Validation: Parser extracts trade parameters and checks for invalid formats or outdated market entries.
3. Order Execution: Worker places entry order and initial Stop Loss order on Bybit.
4. Take Profit Management: Three reduce-only take-profit orders are submitted (60% at TP1, 25% at TP2, 15% at TP3).
5. Dynamic Adjustment: When TP1 fills, Stop Loss is amended to the entry price. When TP2 fills, Stop Loss is amended to the TP1 price.
6. Position Close: Trade marks completed in Firestore once all targets or stop-loss trigger.

---

## Security Practices

- Secret Protection: Never commit `.env` files or session tokens to version control.
- API Key Scoping: Use Bybit API keys restricted to necessary trade permissions and bound to trusted server IP addresses.
- Encrypted Storage: Telegram MTProto credentials and exchange secrets are encrypted at rest using AES-GCM.
- Access Control: Web dashboard routes enforce Firebase authentication with role validation.

---

## License

Private and proprietary. All rights reserved.
