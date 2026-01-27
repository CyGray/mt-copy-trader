# pipeline.md — CI/CD Guide (v1)

## Overview
This pipeline runs lint, build, and worker tests on every push and PR. It does not deploy or manage secrets.

## Files
- GitHub Actions workflow: .github/workflows/ci.yml

## Step-by-step (GitHub Actions)
1. Push to `main` or open a PR.
2. Workflow runs on `ubuntu-latest`:
   - `npm install --no-audit --no-fund`
   - `npm run lint`
   - `npm run build`
   - `npm run test`
3. Check CI results in GitHub Actions tab.

## Notes
- CI is intentionally minimal for v1.
- No production secrets are required for lint/build/test.
- If Firebase access is required in tests later, add GitHub Secrets and load them in the workflow.

## Future Enhancements (optional)
- Add `docker build` checks.
- Add deployment job gated on tags.
- Add `npm audit` step.
