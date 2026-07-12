#!/usr/bin/env bash
# Databricks App entrypoint. The React frontend is built HERE, on the app
# container (Node 22 + npm ship with the Apps runtime) — never locally. The
# build runs in the background while uvicorn binds the port immediately;
# app.py checks frontend/dist per request, so the SPA goes live the moment
# the build lands and /api/* is served throughout.
set -uo pipefail

if [ ! -f frontend/dist/index.html ]; then
  if command -v npm >/dev/null 2>&1; then
    (
      cd frontend || exit 1
      echo "[start.sh] building the SPA on the app container (node $(node --version 2>/dev/null), npm $(npm --version 2>/dev/null))…"
      if npm install --no-audit --no-fund --loglevel=error; then
        # `npm run build` = tsc -b && vite build. If tsc trips, still ship the
        # SPA with vite alone (esbuild transpiles TS without type-checking).
        npm run build \
          || { echo "[start.sh] tsc failed — retrying with vite only"; ./node_modules/.bin/vite build; }
        [ -f dist/index.html ] \
          && echo "[start.sh] frontend build complete — SPA is live." \
          || echo "[start.sh] ERROR: build produced no dist/index.html — placeholder stays up; /api/* unaffected."
      else
        echo "[start.sh] ERROR: npm install failed — placeholder stays up; /api/* unaffected."
      fi
    ) &
  else
    echo "[start.sh] WARNING: npm not found in this container — SPA unavailable; /api/* still served."
  fi
fi

exec uvicorn app:app --host 0.0.0.0 --port "${DATABRICKS_APP_PORT:-8000}"
