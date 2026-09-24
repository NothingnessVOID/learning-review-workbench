#!/bin/zsh
cd -- "${0:A:h}"
NODE_BIN="$HOME/homebrew/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then NODE_BIN=$(command -v node); fi
"$NODE_BIN" scripts/start.mjs --demo
if [[ $? -ne 0 ]]; then print '启动失败，按回车关闭。'; read; fi
