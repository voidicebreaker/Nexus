#!/usr/bin/env bash
set -euo pipefail

site_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
game_root="$(cd "${1:-$site_root/../AntimatterDimensionsEndgameUpdate}" && pwd)"
output="$site_root/antimatter"

if [[ "$game_root" == "$site_root" || ! -f "$game_root/vue.config.js" ]]; then
  echo "Expected the AntimatterDimensionsEndgameUpdate checkout as the first argument." >&2
  exit 1
fi

cd "$game_root"
npm ci --no-audit --no-fund
# Build for real players with relative asset paths. Skip pre-build.js, which
# rewrites source files and optional Firebase configuration.
VUE_APP_DEV=false VUE_APP_STEAM=false ./node_modules/.bin/vue-cli-service build \
  --mode production --dest "$output"
cp LICENSE "$output/LICENSE.txt"
node - "$output/commit.json" <<'JS'
const fs = require("fs");
const { execFileSync } = require("child_process");
const git = args => execFileSync("git", args, { encoding: "utf8" }).trim();
fs.writeFileSync(process.argv[2], JSON.stringify({
  sha: git(["rev-parse", "HEAD"]),
  message: git(["log", "-1", "--pretty=%B"]),
  author: git(["log", "-1", "--pretty=format:%an"])
}));
JS
printf 'Built Antimatter for Nexus at %s\n' "$output"
