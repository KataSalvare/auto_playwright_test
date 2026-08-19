#!/bin/zsh

# macOS 终端入口：启动、重启或停止快速测试页面服务。
script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
cd "$project_dir" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js。"
  exit 1
fi

node scripts/quick-test-server.mjs "$@"
