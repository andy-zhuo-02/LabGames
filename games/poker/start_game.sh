#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ "${CONDA_DEFAULT_ENV:-}" == "poker" ]]; then
    exec python web_app.py "$@"
fi
if command -v conda >/dev/null 2>&1; then
    exec conda run --no-capture-output -n poker python web_app.py "$@"
fi
printf '%s\n' '请先在终端激活 poker 环境：conda activate poker' '然后运行：python web_app.py' >&2
exit 1
