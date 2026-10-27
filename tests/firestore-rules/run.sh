#!/usr/bin/env bash
# Runs the Firestore rules tests inside the local Firestore emulator.
#
# - Project id "demo-bytrader": the demo- prefix makes the emulator refuse any
#   connection to a real Firebase project, and no credentials are read.
# - The emulator binds 127.0.0.1:8080 only and is stopped when the tests end.
# - Java: uses `java` from PATH when it is version 21 or newer; otherwise a
#   Temurin 21 JRE is downloaded once into ./.cache (git-ignored).
# - firebase-tools is run through npx at a pinned version (npm cache, not the repo).
set -euo pipefail
cd "$(dirname "$0")"

FIREBASE_TOOLS_VERSION="15.20.0"
CACHE_DIR="$(pwd)/.cache"

java_major() {
  "$1" -version 2>&1 | awk -F'"' '/version/ { split($2, v, "."); print v[1]; exit }'
}

JAVA_BIN="$(command -v java || true)"
if [[ -z "$JAVA_BIN" || "$(java_major "$JAVA_BIN")" -lt 21 ]]; then
  JRE_DIR="$CACHE_DIR/jre21"
  if [[ ! -x "$JRE_DIR/bin/java" ]]; then
    echo "Downloading a Temurin 21 JRE into $JRE_DIR (one time)..."
    mkdir -p "$JRE_DIR"
    arch="$(uname -m)"; [[ "$arch" == "x86_64" ]] && arch="x64"; [[ "$arch" == "arm64" ]] && arch="aarch64"
    curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/${arch}/jre/hotspot/normal/eclipse" \
      | tar -xz -C "$JRE_DIR" --strip-components=1
  fi
  export PATH="$JRE_DIR/bin:$PATH"
fi
echo "Using $(java -version 2>&1 | head -1)"

if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund
fi

# Keep firebase-tools' own config and emulator downloads out of the home directory.
export XDG_CONFIG_HOME="$CACHE_DIR/config"
export FIREBASE_EMULATORS_PATH="$CACHE_DIR/emulators"
mkdir -p "$XDG_CONFIG_HOME" "$FIREBASE_EMULATORS_PATH"

# firebase-tools only loads rules from inside its project directory, so the
# emulator runs from a throwaway project in .cache. The tests load
# ../../firestore.rules themselves (initializeTestEnvironment), so the copy only
# seeds the emulator at startup.
PROJECT_DIR="$CACHE_DIR/project"
mkdir -p "$PROJECT_DIR"
cp ../../firestore.rules "$PROJECT_DIR/firestore.rules"
cat > "$PROJECT_DIR/firebase.json" <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "emulators": {
    "firestore": { "host": "127.0.0.1", "port": 8080 },
    "ui": { "enabled": false },
    "singleProjectMode": true
  }
}
JSON

TEST_DIR="$(pwd)"
(cd "$PROJECT_DIR" && npx --yes "firebase-tools@${FIREBASE_TOOLS_VERSION}" emulators:exec \
  --project demo-bytrader --only firestore "cd '$TEST_DIR' && npx vitest run")
