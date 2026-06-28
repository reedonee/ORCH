#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

echo "=== 1. Setting GH_TOKEN ==="
read -s -p "Paste your GitHub token: " TOKEN
echo ""
export GH_TOKEN="$TOKEN"

echo "=== 2. Stage and commit ==="
git add -A
git commit -m "chore: release v0.1.0 — Visual Theme Engine, Cinematic Boot, update system, typography overhaul"

echo "=== 3. Push ==="
git push origin master

echo "=== 4. Verify build ==="
npm run build

echo "=== 5. Release ==="
npm run release

echo ""
echo "Done! Check https://github.com/reedonee/ORCH/releases"
