#!/bin/zsh

# 普通 macOS 终端入口：自动切到项目根目录，再调用 Playwright 订单脚本。
# 请在 Terminal.app/iTerm2 中运行，避免从 Codex 沙箱内启动 Chrome。
script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
cd "$project_dir" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先安装 Node.js。"
  exit 1
fi

echo "在普通终端启动订单自动化：$project_dir"
npm run automation -- "$@"
