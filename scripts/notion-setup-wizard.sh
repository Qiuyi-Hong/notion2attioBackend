#!/usr/bin/env bash
# Walks you through the parts of standing up the Notion source database that
# only a human can do (creating an integration, sharing a page with it), then
# runs the seeder for you.
#
#   bash scripts/notion-setup-wizard.sh
#
# Resolves: https://github.com/Qiuyi-Hong/notion2attioBackend/issues/5

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;34m[%s]\033[0m %s\n' "$1" "$2"; }
ok() { printf '\033[32m  ok\033[0m %s\n' "$1"; }
die() { printf '\033[31mstopped:\033[0m %s\n' "$1" >&2; exit 1; }

pause() { read -r -p "  press enter when done "; }

bold "Notion source database setup"
dim "Creates a 'Qualified accounts' database with 12 rows in your workspace."
dim "You do steps 1-3; the script does the rest."

# --------------------------------------------------------------------- 0. env

command -v node >/dev/null || die "node is not installed"
node -e 'process.exit(process.versions.node.split(".")[0] >= 20 ? 0 : 1)' \
  || die "node 20+ required (found $(node -v))"
[ -f "$ROOT/data/notion-source-seed.csv" ] || die "data/notion-source-seed.csv is missing"
ok "node $(node -v), fixture present"

step 1 "Create a Notion internal integration"
echo "  Open:  https://www.notion.so/profile/integrations"
echo "  - 'New integration', name it e.g. notion2attio-dev"
echo "  - Associated workspace: the one you want the demo database in"
echo "  - Type: Internal"
echo "  - Capabilities: Read content, Update content, Insert content"
pause

step 2 "Copy the integration's Internal Integration Secret"
dim "  It starts with ntn_ (older ones start with secret_). It is a password - do not commit it."
read -r -s -p "  paste token: " NOTION_TOKEN
echo
[ -n "$NOTION_TOKEN" ] || die "no token entered"

step 3 "Create a parent page and share it with the integration"
echo "  In Notion: create a normal empty page (e.g. 'notion2attio demo')."
echo "  On that page: ... menu (top right) -> Connections -> pick your integration."
dim "  Without this the API returns 404 on the page - Notion hides unshared pages entirely."
echo
echo "  Then copy the page URL from the address bar and paste it below."
read -r -p "  page URL or id: " PAGE_INPUT
[ -n "$PAGE_INPUT" ] || die "no page given"

# Pull the last 32 hex chars out of whatever was pasted, then hyphenate to a uuid.
RAW_ID="$(printf '%s' "$PAGE_INPUT" | tr -d '\n' | grep -oE '[0-9a-fA-F]{32}' | tail -n 1 || true)"
if [ -z "$RAW_ID" ]; then
  RAW_ID="$(printf '%s' "$PAGE_INPUT" | tr -d '\n-' | grep -oE '[0-9a-fA-F]{32}' | tail -n 1 || true)"
fi
[ -n "$RAW_ID" ] || die "could not find a 32-character page id in '$PAGE_INPUT'"
PAGE_ID="${RAW_ID:0:8}-${RAW_ID:8:4}-${RAW_ID:12:4}-${RAW_ID:16:4}-${RAW_ID:20:12}"
ok "parent page $PAGE_ID"

step 4 "Checking the token can actually see that page"
HTTP_STATUS="$(curl -s -o /tmp/notion-wizard-probe.json -w '%{http_code}' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H 'Notion-Version: 2026-03-11' \
  "https://api.notion.com/v1/pages/$PAGE_ID")"
if [ "$HTTP_STATUS" != "200" ]; then
  echo
  cat /tmp/notion-wizard-probe.json 2>/dev/null || true
  echo
  case "$HTTP_STATUS" in
    401) die "token rejected (401). Re-copy the Internal Integration Secret." ;;
    404) die "page not visible (404). Step 3's Connections step was probably missed." ;;
    *)   die "unexpected $HTTP_STATUS from Notion" ;;
  esac
fi
rm -f /tmp/notion-wizard-probe.json
ok "token can read the parent page"

step 5 "Writing credentials to .env"
touch "$ENV_FILE"
# Drop any previous values so re-runs do not stack duplicates.
if [ -s "$ENV_FILE" ]; then
  grep -vE '^(NOTION_TOKEN|NOTION_PARENT_PAGE_ID|NOTION_DATABASE_ID|NOTION_DATA_SOURCE_ID)=' \
    "$ENV_FILE" > "$ENV_FILE.tmp" || true
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi
printf 'NOTION_TOKEN=%s\nNOTION_PARENT_PAGE_ID=%s\n' "$NOTION_TOKEN" "$PAGE_ID" >> "$ENV_FILE"
ok ".env updated (.env is gitignored)"

step 6 "Checking the fixture before touching your workspace"
node "$ROOT/scripts/check-notion-fixture.mjs"

step 7 "Creating the database and seeding 12 rows"
node "$ROOT/scripts/seed-notion-source-db.mjs"

echo
bold "Done."
echo "Record NOTION_DATABASE_ID and NOTION_DATA_SOURCE_ID (printed above and in .env)"
echo "on issue #5, then close it:"
echo
echo "  gh issue close 5 --repo Qiuyi-Hong/notion2attioBackend --comment '...'"
