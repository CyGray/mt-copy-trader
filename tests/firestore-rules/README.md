# Firestore security rules tests

`rules.test.ts` checks `../../firestore.rules` against the local Firestore
emulator. It never contacts a real Firebase project: the project id is
`demo-bytrader` (the `demo-` prefix keeps the emulator offline), no credentials
are read, and the emulator listens on `127.0.0.1:8080` only.

```bash
bash tests/firestore-rules/run.sh
```

`run.sh` uses `java` 21+ from `PATH`, or downloads a Temurin 21 JRE once into
`.cache/` (git-ignored). firebase-tools runs through `npx` at a pinned version.
This directory is a standalone npm package, not a workspace, so its
dependencies never enter the repository's root `node_modules`.

What is asserted:

- every client write is denied, for every collection and every user;
- reads need a verified email and `users/{uid}` with role `admin` or `viewer`;
- a revoked role, a missing users document, an unverified email and
  unauthenticated clients read nothing;
- a user may read only their own `users/{uid}`;
- collections without a rule (for example `autotrader_state`) are denied.
