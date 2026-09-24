#!/bin/zsh
cd -- "${0:A:h}"
for NODE_BIN in "$HOME/homebrew/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do
  [[ -x "$NODE_BIN" ]] && break
done
if [[ ! -x "$NODE_BIN" ]]; then print '找不到 Node.js，请安装 Node.js 24+ 后重试。'; read; exit 1; fi
"$NODE_BIN" scripts/start.mjs --update
if [[ $? -ne 0 ]]; then print '更新失败，按回车关闭。'; read; fi
