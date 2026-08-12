#!/bin/zsh
set -eu

SCRIPT_DIRECTORY="${0:A:h}"
PROJECT_DIRECTORY="${SCRIPT_DIRECTORY:h}"

fail_startup() {
  print ""
  print "无法启动：$1"
  print ""
  print "按任意键关闭此窗口。"
  read -k 1
  exit 1
}

cd "${PROJECT_DIRECTORY}"

command -v node >/dev/null 2>&1 || fail_startup "没有找到 Node.js；需要 Node 24 或更新版本。"
NODE_MAJOR_VERSION="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR_VERSION >= 24 )) || fail_startup "当前 Node.js 版本过旧；需要 Node 24 或更新版本。"

[[ -d node_modules ]] || fail_startup "本地依赖尚未准备好。请先在项目目录执行 npm ci。"

npm run build || fail_startup "网页构建失败，请查看上方提示。"

print "正在启动赛博大师·八字与紫微排盘计算器……"
exec npm start
