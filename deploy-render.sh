#!/usr/bin/env bash
# deploy-render.sh — One-shot Render deployment helper.
# Requires: curl, jq, RENDER_API_KEY env var, GitHub repo URL.
#
# Usage:
#   export RENDER_API_KEY=rnd_xxx
#   export RENDER_OWNER_ID=tea-xxx     # or usr-xxx
#   export GITHUB_REPO=https://github.com/mahipal1008/mega-privacy-proxy
#   export MEGA_EMAIL=you@example.com
#   export MEGA_PASSWORD=…
#   ./deploy-render.sh

set -euo pipefail

: "${RENDER_API_KEY:?RENDER_API_KEY required}"
: "${RENDER_OWNER_ID:?RENDER_OWNER_ID required}"
: "${GITHUB_REPO:?GITHUB_REPO required}"
: "${MEGA_EMAIL:?MEGA_EMAIL required}"
: "${MEGA_PASSWORD:?MEGA_PASSWORD required}"

PERSONAL_TOKEN="${PERSONAL_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"

echo "Generated PERSONAL_TOKEN: $PERSONAL_TOKEN"
echo "Save this. You'll need it in the browser client."
echo

API=https://api.render.com/v1

create_orch() {
  curl -fsSL -X POST "$API/services" \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<JSON
{
  "type": "web_service",
  "name": "mega-orchestrator",
  "ownerId": "$RENDER_OWNER_ID",
  "repo": "$GITHUB_REPO",
  "branch": "main",
  "autoDeploy": "yes",
  "serviceDetails": {
    "env": "node",
    "plan": "starter",
    "region": "oregon",
    "rootDir": "orchestrator",
    "healthCheckPath": "/health",
    "envSpecificDetails": {
      "buildCommand": "npm install",
      "startCommand": "node index.js"
    }
  },
  "envVars": [
    {"key": "NODE_ENV", "value": "production"},
    {"key": "MIN_WORKERS", "value": "2"},
    {"key": "BW_LIMIT_BYTES", "value": "4294967296"},
    {"key": "BW_WARN_BYTES", "value": "4076863488"},
    {"key": "MEGA_EMAIL", "value": "$MEGA_EMAIL"},
    {"key": "MEGA_PASSWORD", "value": "$MEGA_PASSWORD"},
    {"key": "PERSONAL_TOKEN", "value": "$PERSONAL_TOKEN"},
    {"key": "RENDER_API_KEY", "value": "$RENDER_API_KEY"},
    {"key": "RENDER_OWNER_ID", "value": "$RENDER_OWNER_ID"},
    {"key": "RENDER_GITHUB_REPO", "value": "$GITHUB_REPO"},
    {"key": "CLIENT_ORIGIN", "value": "*"}
  ]
}
JSON
}

create_client() {
  curl -fsSL -X POST "$API/services" \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<JSON
{
  "type": "static_site",
  "name": "mega-privacy-client",
  "ownerId": "$RENDER_OWNER_ID",
  "repo": "$GITHUB_REPO",
  "branch": "main",
  "autoDeploy": "yes",
  "serviceDetails": {
    "rootDir": "client",
    "buildCommand": "",
    "publishPath": "."
  }
}
JSON
}

echo "Creating orchestrator…"
ORCH_JSON=$(create_orch)
ORCH_ID=$(echo "$ORCH_JSON" | jq -r '.service.id // .id')
echo "Orchestrator service id: $ORCH_ID"

echo "Creating client static site…"
CLIENT_JSON=$(create_client)
CLIENT_ID=$(echo "$CLIENT_JSON" | jq -r '.service.id // .id')
echo "Client static site id: $CLIENT_ID"

echo
echo "Both services created. Render will build + deploy."
echo "Once orchestrator is LIVE, set its ORCHESTRATOR_URL env var to its public URL"
echo "and trigger a redeploy so workers can call back to it."
echo
echo "After deploy: open client URL, paste orchestrator URL + PERSONAL_TOKEN."
