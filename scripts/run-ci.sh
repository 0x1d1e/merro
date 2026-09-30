#!/usr/bin/env bash
# Local replica of .github/workflows/ci.yml.
#
#   scripts/run-ci.sh                 # install dependencies, then run full CI
#   scripts/run-ci.sh --skip-install  # run checks using existing node_modules
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_INSTALL=false
for arg in "$@"; do
  case "$arg" in
    --skip-install)
      SKIP_INSTALL=true
      ;;
    -h|--help)
      printf 'Usage: %s [--skip-install]\n\n' "$0"
      printf 'Runs the same verification gate as GitHub Actions:\n'
      printf '  install     npm install --ignore-scripts --no-audit --no-fund\n'
      printf '  lint        npm run lint\n'
      printf '  typecheck   npm run typecheck\n'
      printf '  test        npm test\n\n'
      printf '  --skip-install  Reuse existing node_modules.\n'
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

run_step() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@"
}

command -v node >/dev/null 2>&1 || { printf 'node is required\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'npm is required\n' >&2; exit 1; }

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Node >=22.5.0 required, found ${process.versions.node}`);
  process.exit(1);
}
'

printf 'Local CI\n'
printf 'Repo: %s\n' "$ROOT_DIR"
printf 'Node: %s\n' "$(node --version)"

if [[ "$SKIP_INSTALL" == false ]]; then
  run_step "install dependencies" npm install --ignore-scripts --no-audit --no-fund
fi

run_step "lint" npm run lint
run_step "typecheck" npm run typecheck
run_step "test" npm test

printf '\n✓ CI passed\n'
