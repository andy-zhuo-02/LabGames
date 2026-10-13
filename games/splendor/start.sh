#!/usr/bin/env bash
set -euo pipefail
labgames_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if ! command -v npm >/dev/null 2>&1; then
  echo '请安装 Node.js 22.13+（自带 npm），然后在仓库根目录运行 npm install。' >&2
  exit 1
fi
cd "$labgames_root"
case "${1:-}" in
  --test) exec npm test --workspace games/splendor ;;
  --dev) shift; exec npm run dev -- splendor "$@" ;;
  --rebuild) shift ;;
esac
exec npm start -- splendor "$@"
