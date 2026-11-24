#!/bin/sh
# Apply database migrations (idempotent, rerun-safe), then start the server as
# PID 1 (via exec, so signals from tini reach Node). Requires DATABASE_URL and,
# in production, a strong APP_SECRET — both provided via the environment.
set -e

echo "[entrypoint] applying database migrations…"
npm run migrate

echo "[entrypoint] starting Universal Opt-Out Hub…"
exec npm start
