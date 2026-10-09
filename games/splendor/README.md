# 璀璨宝石 · Splendor

[← 返回 LabGames 游戏总览](../../README.md)

基础版璀璨宝石网页游戏，支持 2～4 个席位、真人与电脑混合，也可单人对战最多三位电脑。一台电脑运行服务，其余玩家通过同一局域网内的浏览器加入。

## 环境依赖

| 依赖    | 版本                         | 用途                          |
| ------- | ---------------------------- | ----------------------------- |
| Node.js | 22.13+，也可使用 24 系列     | HTTP、Socket.IO 与内置 SQLite |
| pnpm    | 11.19.0                      | 安装锁定依赖、开发与构建      |
| 浏览器  | 支持现代 JavaScript 的浏览器 | 游戏客户端                    |

运行依赖包括 React / React DOM 19.1.1、Express 5.1.0、Socket.IO / Socket.IO Client 4.8.1、Zod 4.1.5、qrcode 1.5.4 和 lucide-react 0.468.0。开发工具包括 TypeScript、Vite、tsx、Vitest 和 Prettier。

具体版本见 [package.json](package.json)，完整依赖锁定在 [pnpm-lock.yaml](pnpm-lock.yaml)。服务使用 Node 内置的 `node:sqlite`，不需要安装独立数据库。电脑策略在本机运行，无需 API Key。

## 首次安装

先安装所需版本的 Node.js，再准备 pnpm。以下命令从仓库根目录开始：

```bash
npm install -g pnpm@11.19.0
cd games/splendor
pnpm install --frozen-lockfile
pnpm build
```

已有对应版本 pnpm 时可跳过全局安装。首次下载依赖需要联网；安装并构建完成后，游戏运行不依赖互联网。

## 启动

在 `games/splendor/` 目录运行：

```bash
pnpm start
```

本机访问 [http://localhost:3000](http://localhost:3000)。默认监听 `0.0.0.0:3000`，允许局域网设备连接。将终端输出的局域网地址发给朋友，保持主机和终端运行；按 `Ctrl+C` 停止。

Linux / macOS 也可以从仓库根目录使用启动脚本：

```bash
./games/splendor/start.sh
```

脚本会在缺少 `node_modules/` 时安装依赖，在缺少构建产物时构建。已安装依赖但修改了依赖声明或锁文件后，应重新执行 `pnpm install --frozen-lockfile`。修改源码后使用 `--rebuild` 更新产物。

### 常用配置

| 配置                    | 默认值 | 作用                           |
| ----------------------- | ------ | ------------------------------ |
| `PORT`                  | `3000` | 服务端口                       |
| `DATA_DIR`              | `data` | 数据目录，相对路径基于游戏目录 |
| `--rebuild`（启动脚本） | 关闭   | 重新构建后启动                 |
| `--dev`（启动脚本）     | 关闭   | 开发模式，前后端共用一个端口   |

以下命令从仓库根目录执行：

```bash
PORT=3010 DATA_DIR=/绝对路径/splendor-data ./games/splendor/start.sh
./games/splendor/start.sh --rebuild
./games/splendor/start.sh --dev
```

脚本在本工作站未全局安装 Node.js 时，也可识别 Codex 内置运行环境；普通电脑按上述步骤安装 Node.js 和 pnpm 即可。

## 与朋友联机

1. 房主输入昵称并创建房间，通过「分享链接与二维码」邀请朋友。
2. 朋友连接同一网络，打开链接或输入房间码加入。
3. 人数不足时由房主添加 AI；全体真人准备后，房主点击「开始对局」。
4. 有人达到 15 分后完成当前轮，再按规则结算；房主可回到房间继续下一局。

对局包含 90 张发展卡、10 位贵族、永久折扣、黄金支付、预留及资源归还。市场与手牌支持点击操作，卡面资源均从本机加载。规则来源见 [数据与规则说明](docs/DATA_SOURCES.md)。

## 存档与备份

默认数据库为 `games/splendor/data/splendor.sqlite`，可用 `DATA_DIR` 更改目录。

- 房间、牌局和已处理操作随有效动作写入数据库，支持刷新、断线重连和服务器重启恢复。
- 座位凭证保存在浏览器本地；请使用原浏览器、相同主机地址与端口。当前不支持跨设备转移座位。
- 同一浏览器的多个标签页共用座位，新标签页接管后旧标签页停止操作。测试多人时使用不同浏览器或独立会话。
- 所有真人离线时，电脑暂停；真人恢复连接后继续。
- 备份前停止服务，再复制整个数据目录，包括存在的 WAL 文件。恢复时使用同一目录；每个运行实例使用独立的数据目录。

## 开发与检查

在游戏目录中执行：

```bash
pnpm dev               # 开发服务器
pnpm test              # 规则、模拟与 Socket.IO 联机测试
pnpm build             # 类型检查、网页构建与服务端编译
pnpm check             # 测试与构建
```

构建输出为 `dist/`（网页）和 `dist-server/`（服务端）。生产服务同时提供网页与联机接口，无需额外启动静态服务器。

如需验证正在运行的服务，可使用项目自带的冒烟脚本；脚本会创建测试房间并在结束后清理：

```bash
node scripts/smoke.mjs
# 自定义服务地址
BASE_URL=http://localhost:3010 node scripts/smoke.mjs
```

源码按 `src/engine/`、`src/shared/`、`src/server/` 和 `src/web/` 分层。更多验收步骤见 [验证说明](docs/VALIDATION.md)。

## 常见问题

- **Node 版本不满足要求：** 升级到 22.13 或更高版本；本项目依赖内置 SQLite。
- **提示缺少构建文件或修改未生效：** 运行 `pnpm build`，或使用启动脚本的 `--rebuild`。
- **朋友连不上：** 分享主机局域网 IP，确保同一网络未开启访客隔离，并允许服务端口通过主机防火墙。有多块网卡时选择实际使用的 Wi-Fi 或有线地址。
- **刷新后没有回到原座位：** 检查浏览器、访问地址、端口和数据目录是否与之前一致。

## 素材

本项目为非官方实现。Splendor 名称与原版卡牌美术归相应权利人所有；卡面来源与映射见 [素材说明](docs/ART_SOURCES.md)，背景说明见 [背景素材](docs/BACKGROUND_ART.md)。
