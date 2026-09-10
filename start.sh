#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# The desktop app bundles Node; regular installations use the system runtime.
runtime_root="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1 && [[ -x "$runtime_root/node/bin/node" ]]; then
  export PATH="$runtime_root/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 24 LTS 和 pnpm，然后再次运行 ./start.sh。' >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<13)){console.error("需要 Node.js 22.13+，推荐 24 LTS");process.exit(1)}'

if command -v pnpm >/dev/null 2>&1; then
  package_manager=(pnpm)
elif [[ -x "$runtime_root/bin/fallback/pnpm" ]]; then
  package_manager=("$runtime_root/bin/fallback/pnpm")
elif command -v corepack >/dev/null 2>&1; then
  package_manager=(corepack pnpm)
else
  echo '请先安装 pnpm：npm install -g pnpm@11.19.0' >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  "${package_manager[@]}" install --frozen-lockfile
fi
case "${1:-}" in
  --dev) exec "${package_manager[@]}" dev ;;
  --rebuild|'') ;;
  *) echo '用法：./start.sh [--dev | --rebuild]' >&2; exit 1 ;;
esac
if [[ "${1:-}" == '--rebuild' || ! -f dist/index.html || ! -f dist-server/server/index.js ]]; then
  "${package_manager[@]}" build
fi
exec node dist-server/server/index.js
