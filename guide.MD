# guide.md — Local-only Testing (Current Version)

## Prerequisites
- Node.js 20+
- Firebase project + service account JSON
- (Optional) Docker installed if you want compose testing

## Environment Setup
1. Convert service account JSON to env vars in `.env.local`:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY` (with \n)
2. Add Firebase client vars for web:
   - `NEXT_PUBLIC_FIREBASE_*` keys

## Install
- `npm install --no-audit --no-fund`

## Firestore Seed
- `npm run seed:firestore --workspace worker`

## Lint
- `npm run lint --workspace worker`
- `npm run lint --workspace web`

## Run (Local)
- `npm run dev`
- Web: http://localhost:3000
- Worker health: http://localhost:4000/health

## Auth Smoke Test
1. Open http://localhost:3000/login
2. Sign in with Google
3. Confirm user doc is created in Firestore `users` with role `viewer`
4. (Optional) Set role to `admin` in Firestore and reload /admin

## Admin API Smoke Test
1. Sign in, open browser devtools
2. From console, call `/api/admin/ping` with ID token
3. Expect `ok: true` for admin role and `403` for viewer

## Telegram Onboarding Smoke Test
1. Ensure `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `MASTER_KEY` are set in `.env.local`
2. Start the stack with `npm run dev`
3. Visit `/telegram`, enter your phone number, and submit OTP
4. If prompted, enter your Telegram 2FA password
5. Confirm dashboard shows Telegram session as `authorized`

## Notes
- Docker tests are not included here. If Docker is installed, run `docker-compose up --build` and check both services.
- Do not commit secrets or service account JSON.
