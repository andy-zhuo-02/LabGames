#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
runtime_root="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1 && [[ -x "$runtime_root/node/bin/node" ]]; then
  export PATH="$runtime_root/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或更新版本。' >&2
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("需要 Node.js 22+");process.exit(1)}'
case "${1:-}" in
  --test) exec node --test tests/*.test.mjs ;;
  --dev) exec node --watch server.mjs ;;
  '') exec node server.mjs ;;
  *) echo '用法：./start.sh [--dev | --test]；用 PORT=3007 自定义端口。' >&2; exit 1 ;;
esac
