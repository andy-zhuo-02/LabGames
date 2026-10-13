# 德州扑克 · 河牌俱乐部

[← 返回 LabGames](../../README.md) · [玩法与命令行](docs/GUIDE.md) · [技术栈与迁移](../../docs/TECH_STACK.md)

Node.js 实现的无限注德州扑克，支持单人练习、2～6 人局域网好友房和命令行模拟。默认每人 2,000 虚拟筹码，盲注 10 / 20，无前注、无抽水。八种电脑策略只使用自己的底牌和公开信息。

## 统一安装与启动

与其他两个游戏共用 **Node.js 22.13+（推荐 24）和 npm**。无需 Python、Conda、pip 或独立数据库。在仓库根目录执行：

```bash
npm install                   # 首次安装整个仓库
npm start -- poker            # 启动扑克
npm run dev -- poker          # 开发模式
```

本机访问 [http://localhost:8765](http://localhost:8765)。默认允许局域网连接，终端会显示朋友可访问的地址。按 `Ctrl+C` 停止。Windows、macOS、Linux 使用相同命令。

网页使用原生 JavaScript，无需构建。服务和 SQLite 均使用 Node 内置模块；邀请二维码使用 npm 安装的 `qrcode`，与宝石共用同一依赖版本。首次安装需要联网，游戏运行无需外部服务。

旧 `./games/poker/start_game.sh` 现转发到 npm，不再激活 Conda。也可在游戏目录执行 `npm start` 或 `node server.mjs`。

## 配置

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `POKER_PORT` | `8765` | 统一启动器中的端口 |
| `PORT` / `--port` | `8765` | 单独启动时指定端口 |
| `HOST` / `--host` | `0.0.0.0` | `127.0.0.1` 限制为仅本机 |
| `POKER_DATA_FILE` / `--save-file` | `.poker-data/table-端口.node.sqlite3` | 存档文件 |
| `--no-save` | 关闭 | 临时游玩，不读写存档 |
| `--import-save` | 未指定 | 从旧 Python 存档复制导入到新文件 |

根目录示例：

```bash
npm start -- poker --port 8767 --no-save
npm start -- poker --host 127.0.0.1
```

保留兼容参数 `--lan` 与 `--no-browser`；默认不自动打开浏览器。

## 与朋友联机

1. 房主打开「和朋友玩」，设置昵称、人数、行动限时和电脑补位。
2. 分享邀请链接或二维码。朋友在同一网络打开链接并申请加入，由房主批准。
3. 全体真人准备后开局，每手结束后共同准备下一手。

支持局中申请、下一手入座、暂时离席、房主转交、座位恢复码、逐手复盘和筹码曲线。底牌只在规则允许时公开，等待审批者看不到牌桌私有信息。

## 存档和旧版升级

默认 Node 存档位于 `games/poker/.poker-data/table-端口.node.sqlite3`。同一存档不能由两个服务同时写入；备份前停止服务，再复制存档目录。继续牌局请使用原浏览器、相同主机地址与端口。

首次启动且新版文件不存在时，会检查同端口旧 `.poker-data/table-端口.sqlite3`，只读导入 24 小时内仍有效的会话和房间，**原文件保留**。导入会重放牌堆与操作并核对筹码；损坏或不兼容的存档会报错，不会默默清空。先停止旧 Python 服务，避免同时继续两个版本的牌局。

自定义存档：

```bash
npm start -- poker --save-file /绝对路径/new.node.sqlite3 --import-save /绝对路径/old.sqlite3
```

导入目标必须不存在。后续启动仅传 `--save-file`。恢复中的真人房间会等待玩家重连后再行动。已过期房间沿用原先的 24 小时淘汰规则。

## 测试与辅助工具

仓库根目录：

```bash
npm test --workspace games/poker
npm run check --workspace games/poker
```

在游戏目录中：

```bash
node cli.mjs                                   # 命令行游玩
node cli.mjs --list-bots
node cli.mjs --simulate 1000 --seed 42
node tournament.mjs --seed 42                  # 八策略同桌比赛
node plot-tournament.mjs runs/你的比赛目录       # SVG 曲线，无额外绘图库
```

测试包括 160 组旧 PokerKit 固定牌局对照、八策略模拟、房间权限、HTTP 身份、二维码、旧存档导入和服务器重启恢复。更改后的随机数序列与旧 Python 版不同，新版自己的固定种子与保存的完整牌堆可用于复现。

旧 Python 源码与测试仅作为历史参考保存在 `archive/poker-python/`，不参与当前安装、启动与测试。所有当前入口均为 Node.js。
