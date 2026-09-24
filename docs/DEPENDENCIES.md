# 依赖与许可

本项目的直接依赖版本锁定于 `package-lock.json`。下表按 2026-09-24 本机锁文件记录，许可列来自包元数据；发布前仍应保留各包实际许可文本并复核传递依赖。Node.js 要求 `>=24`，本机验证版本为 `26.0.0`；SQLite 使用 Node 内置的 `node:sqlite`，无需单独数据库服务。

| 用途 | 包 | 锁定版本 | 包元数据许可 |
|---|---|---:|---|
| 运行 | @modelcontextprotocol/sdk | 1.30.1 | MIT |
| 运行 | adm-zip | 0.6.1 | MIT |
| 运行 | express | 5.2.1 | MIT |
| 运行 | opencc-js | 1.4.2 | MIT AND Apache-2.0 |
| 运行 | react | 19.3.0 | MIT |
| 运行 | react-dom | 19.3.0 | MIT |
| 运行 | react-markdown | 10.1.0 | MIT |
| 运行 | remark-gfm | 4.0.1 | MIT |
| 运行 | zod | 4.6.5 | MIT |
| 开发 | @playwright/test | 1.63.0 | Apache-2.0 |
| 开发 | @types/adm-zip | 0.5.8 | MIT |
| 开发 | @types/express | 5.0.6 | MIT |
| 开发 | @types/node | 26.6.2 | MIT |
| 开发 | @types/react | 19.3.0 | MIT |
| 开发 | @types/react-dom | 19.3.0 | MIT |
| 开发 | @vitejs/plugin-react | 6.1.1 | MIT |
| 开发 | esbuild | 0.28.2 | MIT |
| 开发 | tsx | 4.23.15 | MIT |
| 开发 | typescript | 7.0.2 | Apache-2.0 |
| 开发 | prettier | 3.9.9 | MIT |
| 开发 | vite | 8.3.0 | MIT |

复现安装用 `npm ci`，然后运行 `npm run build`。完整传递依赖及准确版本见 `package-lock.json`；此表不宣称完成法律许可审计。
