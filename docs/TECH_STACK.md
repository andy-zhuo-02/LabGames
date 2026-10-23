# LabGames 技术栈与迁移说明

## 统一约定

所有活跃游戏代码使用 JavaScript / TypeScript，在 Node.js 22.13+ 上运行；推荐 Node.js 24。安装 Node.js 时自带 npm，不需要再全局安装包管理器、TypeScript、数据库或其他语言环境。

- 根目录 `package.json` 管理 npm workspaces，唯一锁文件为根目录 `package-lock.json`。
- 首次 `npm install`，之后 `npm start -- 游戏名`；可直接 `npm start` 同时启动全部。
- 每个游戏提供 `start`、`dev`、`test`、`check`，编译型项目另提供 `build`。
- 新增服务端和构建工具使用 Node.js；依赖固定版本并由 npm 管理，不新增 Conda、pip 或 pnpm 步骤。
- 浏览器端允许原生 JavaScript 和 React/TypeScript。两者共用相同运行环境，现有页面无需为了统一安装体验而重写。
- 规则引擎、电脑策略、房间服务、浏览器视图分层；房间状态由服务器裁决。牌局和座位凭证不进入公共接口或版本库。
- 新增公共模块时先确认至少两个游戏需要同一行为，避免把玩法专属逻辑耦合在一起。

| 游戏     | 服务端                                  | 网页            | 存储             | 检查                              |
| -------- | --------------------------------------- | --------------- | ---------------- | --------------------------------- |
| 德州扑克 | Node.js 原生 HTTP、JavaScript           | 原生 JavaScript | Node 内置 SQLite | Node 测试，包括旧引擎固定牌局对照 |
| 璀璨宝石 | Node.js、TypeScript、Express、Socket.IO | React、Vite     | Node 内置 SQLite | Vitest、TypeScript、Vite          |
| 七连翻   | Node.js 原生 HTTP/SSE、JavaScript       | 原生 JavaScript | JSON             | Node 测试                         |
| 步步为营 | Node.js 原生 HTTP、JavaScript           | 原生 JavaScript / SVG | JSON + 浏览器本地存档 | Node 规则、电脑、房间与 HTTP 测试 |

这些差异都属于 npm 管理的项目内部实现，不要求主机安装不同环境。

## 启动行为

`npm start` 先构建璀璨宝石，再启动四项服务；任一服务意外退出，会停止本次启动的其他服务并报告错误。`Ctrl+C` 会请求各游戏保存并关闭，超时才强制结束。不会停止启动器之外的进程。

默认允许局域网访问，使用 `HOST=127.0.0.1` 可改为仅本机。用 `POKER_PORT`、`SPLENDOR_PORT`、`FLIP7_PORT`、`QUORIDOR_PORT` 分别指定端口，单个游戏也支持 `PORT`；不设置时沿用端口 8765 / 3000 / 3007 / 3009。

原有 shell 脚本仅转发到统一 npm 命令，Windows 直接使用 npm。各游戏的 `npm start` 也保留；在宝石目录直接启动前需执行 `npm run build`。

## 从旧仓库升级

1. 停止原先的三个游戏服务。
2. 安装 Node.js 22.13+（推荐 24），确认 `node --version` 和 `npm --version` 可用。
3. 如果存在由 pnpm 安装的 `games/splendor/node_modules`，将它移到仓库外或删除后重新安装。该目录只是可重新下载的依赖，不能误删 `data/`。
4. 在根目录运行 `npm install`，之后运行 `npm run doctor` 与 `npm start`。

宝石与七连翻的存档结构、访问地址和浏览器身份保持原样。用户仍需用原浏览器和原主机地址/端口访问。

扑克默认 Node 存档为 `.poker-data/table-端口.node.sqlite3`。首次启动且新版文件不存在时，若同一端口存在旧 `.poker-data/table-端口.sqlite3`，会只读导入 24 小时内仍有效的房间和会话。先重放保存的牌堆及操作并核对筹码，再写入新版文件。**原 SQLite 文件不修改、不覆盖。**

自定义旧存档可从根目录执行：

```bash
npm start -- poker --save-file /绝对路径/new.node.sqlite3 --import-save /绝对路径/old.sqlite3
```

导入目标必须不存在。后续启动只保留 `--save-file`，不再传 `--import-save`。已过期的会话沿用原来的 24 小时淘汰规则；损坏或不兼容存档会报错，不会悄悄开空桌。

当前手牌保留原牌堆、操作、筹码和席位身份。新版将未来洗牌和电脑随机策略改为 JavaScript 的独立种子随机数生成器，因此同一数值种子的未来随机序列不承诺与旧 Python 版相同。新版自己的固定种子可复现，JSONL 还保存完整牌堆供重放。

## 迁移验证与历史代码

扑克测试包含 160 组 PokerKit 0.7.5 固定牌局，逐步比较合法行动、底牌、公共牌、下注、筹码、退款和每个座位的最终奖励；另覆盖规则边界、八种策略模拟、房间审批、离席、接管、恢复码、HTTP 身份、二维码及重启恢复。

新版按原始出资层级展示主池/边池；旧 PokerKit 有时会合并由同一赢家领取的底池。单个座位的奖励与退款保持一致，底池展示的分组数量可能不同。

命令行对战、模拟和八策略锦标赛均已迁移到 Node.js。曲线工具直接生成 SVG 总览及各玩家 SVG，无需 Matplotlib；旧 PNG 示例保留，新工具不生成 PNG。

旧 Python 源码和原测试保存在 `archive/poker-python/`，仅供历史对照，不参与安装、启动或默认检查；其旧 README 命令不再适用于当前游戏。当前活跃入口全部位于 `games/`。
