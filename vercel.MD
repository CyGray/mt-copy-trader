# Vercel setup guide

## Checklist
- [ ] Repository connected in Vercel
- [ ] Project root set to web
- [ ] Framework preset: Next.js
- [ ] Build command: npm run build
- [ ] Output directory: .next
- [ ] Install command: npm install
- [ ] Required environment variables added
- [ ] Worker public URL reachable from Vercel
- [ ] Deployment succeeds and login works

## Step-by-step
1. In Vercel, click Add New → Project, then import the GitHub repo.
2. In Configure Project:
   - Root Directory: web
   - Framework Preset: Next.js
   - Build Command: npm run build
   - Output Directory: .next
   - Install Command: npm install
3. Open Project Settings → Environment Variables and add the following for Production (and Preview if desired):
   - NEXT_PUBLIC_FIREBASE_API_KEY
   - NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
   - NEXT_PUBLIC_FIREBASE_PROJECT_ID
   - NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
   - NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
   - NEXT_PUBLIC_FIREBASE_APP_ID
   - NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
   - FIREBASE_PROJECT_ID
   - FIREBASE_CLIENT_EMAIL
   - FIREBASE_PRIVATE_KEY
   - WORKER_URL
   - WORKER_HEALTH_URL
4. Set the worker URLs to the public worker endpoint, for example:
   - WORKER_URL=https://worker.yourdomain.com
   - WORKER_HEALTH_URL=https://worker.yourdomain.com/health
5. For FIREBASE_PRIVATE_KEY, paste the full private key and keep \n line breaks intact.
6. Click Deploy.

## Notes
- The admin SDK is used by API routes to resolve roles. Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are present in Vercel.
- If you use a raw IP for the worker, ensure TLS is not required. Prefer a domain with HTTPS.
- If the worker is hosted on the same server as before, make sure its port is reachable from the internet and not blocked by the firewall.
