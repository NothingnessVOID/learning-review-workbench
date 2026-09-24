#!/bin/zsh
cd -- "${0:A:h}"
for NODE_BIN in "$HOME/homebrew/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do
  [[ -x "$NODE_BIN" ]] && break
done
"$NODE_BIN" scripts/start.mjs --demo
if [[ $? -ne 0 ]]; then print '启动失败，按回车关闭。'; read; fi
