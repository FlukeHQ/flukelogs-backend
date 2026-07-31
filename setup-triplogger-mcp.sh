#!/usr/bin/env bash
# Adds Trip Logger's Supabase + Vercel MCP servers at LOCAL scope, pinned to this repo.
# Tokens are read from .mcp.env (gitignored) and expanded by the shell at add-time,
# so no secret ever lands in your shell history. Trip Logger accounts ONLY.
set -euo pipefail

cd "$(dirname "$0")"

# Step 1: confirm we're in the repo root (local scope keys to this exact path).
if [ "$(basename "$PWD")" != "trip-logger-backend" ]; then
  echo "ERROR: run this from the trip-logger-backend repo root. pwd=$PWD" >&2
  exit 1
fi

# shellcheck disable=SC1091
source ./.mcp.env
: "${TRIPLOGGER_PROJECT_REF:?set TRIPLOGGER_PROJECT_REF in .mcp.env}"
: "${TRIPLOGGER_SUPABASE_TOKEN:?set TRIPLOGGER_SUPABASE_TOKEN in .mcp.env}"
: "${TRIPLOGGER_VERCEL_TOKEN:?set TRIPLOGGER_VERCEL_TOKEN in .mcp.env}"
if [ "$TRIPLOGGER_PROJECT_REF" = "PASTE_PROJECT_REF_HERE" ]; then
  echo "ERROR: edit .mcp.env and set the real TRIPLOGGER_PROJECT_REF first." >&2
  exit 1
fi

# Idempotent: drop any prior local-scope entries before re-adding.
claude mcp remove supabase --scope local 2>/dev/null || true
claude mcp remove vercel   --scope local 2>/dev/null || true

# Step 2: Supabase (pinned to the Trip Logger project via project_ref).
claude mcp add --scope local --transport http supabase \
  "https://mcp.supabase.com/mcp?project_ref=${TRIPLOGGER_PROJECT_REF}" \
  --header "Authorization: Bearer ${TRIPLOGGER_SUPABASE_TOKEN}"

# Step 3: Vercel.
claude mcp add --scope local --transport http vercel \
  "https://mcp.vercel.com" \
  --header "Authorization: Bearer ${TRIPLOGGER_VERCEL_TOKEN}"

# Step 5: show connection status.
echo
claude mcp list
