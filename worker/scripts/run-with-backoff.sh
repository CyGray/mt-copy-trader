#!/bin/sh

attempt=1

delays="5 15 60"

for delay in $delays; do
  echo "Starting worker (attempt ${attempt})..."
  npm run start
  exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    echo "Worker exited cleanly. Stopping."
    exit 0
  fi

  if [ "$attempt" -ge 3 ]; then
    echo "Max restart attempts reached. Exiting with code ${exit_code}."
    exit "$exit_code"
  fi

  echo "Worker exited with code ${exit_code}. Restarting in ${delay}s..."
  sleep "$delay"
  attempt=$((attempt + 1))
done
