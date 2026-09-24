#!/bin/zsh
cd -- "${0:A:h}"
NODE_BIN="$HOME/homebrew/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then NODE_BIN=$(command -v node); fi
if [[ -z "$NODE_BIN" ]]; then print '找不到 Node.js，请安装 Node.js 24+ 后重试。'; read; exit 1; fi
"$NODE_BIN" scripts/start.mjs
if [[ $? -ne 0 ]]; then print '启动失败，按回车关闭。'; read; fi
