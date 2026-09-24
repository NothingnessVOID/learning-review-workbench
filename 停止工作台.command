#!/bin/zsh
cd -- "${0:A:h}"
NODE_BIN="$HOME/homebrew/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then NODE_BIN=$(command -v node); fi
"$NODE_BIN" scripts/stop.mjs
