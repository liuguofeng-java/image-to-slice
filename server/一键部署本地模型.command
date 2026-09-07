#!/bin/bash

set -u
cd "$(dirname "$0")" || exit 1

echo "Image To Slice - 一键部署本地模型"
echo "-----------------------------------"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先运行“一键部署环境.command”。"
  read -r -p "按回车键退出..."
  exit 1
fi

npm run local-models:setup
status=$?
if [ "$status" -ne 0 ]; then
  echo
  echo "本地模型部署失败，请检查上方错误信息。"
  read -r -p "按回车键退出..."
  exit "$status"
fi

echo
echo "本地模型已准备好。"
read -r -p "按回车键退出..."
