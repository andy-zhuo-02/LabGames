# 德州扑克 · 河牌俱乐部

[← 返回 LabGames 游戏总览](../../README.md) · [玩法与进阶说明](docs/GUIDE.md)

基于 PokerKit 的无限注德州扑克，支持浏览器单人练习、2～6 人局域网好友房间，以及命令行模拟。默认每人 2,000 虚拟筹码，固定盲注 10 / 20，无前注、无抽水。

## 环境依赖

只需运行服务的电脑安装依赖；其他玩家使用浏览器即可。

| 依赖               | 版本               | 用途                            |
| ------------------ | ------------------ | ------------------------------- |
| Python             | 3.11+              | 游戏引擎、HTTP 服务与命令行程序 |
| PokerKit           | 0.7.5              | 德州扑克规则与牌型计算          |
| qrcode             | 8.2                | 本地生成邀请二维码              |
| Matplotlib（可选） | 3.10.3             | 绘制机器人比赛筹码曲线          |
| Node.js（可选）    | 22+ 可用于运行检查 | 前端逻辑测试，游玩时不需要      |

运行依赖固定在 [requirements.txt](requirements.txt)，绘图依赖固定在 [requirements-plot.txt](requirements-plot.txt)。网页使用 Python 标准库 HTTP 服务和原生 JavaScript，不需要 npm、前端构建或额外 Web 框架。

## 首次安装

以下命令从仓库根目录开始，进入游戏目录后执行后续命令。

```bash
cd games/poker
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Windows 可用 `py -m venv .venv` 创建环境，然后在 PowerShell 中运行 `.\.venv\Scripts\Activate.ps1` 激活，再执行同一条安装命令。

也可以使用 Conda：

```bash
cd games/poker  # 如果已经在此目录，请跳过
conda create -n poker python=3.14 pip
conda activate poker
python -m pip install -r requirements.txt
```

已有 `poker` 环境时直接激活并安装依赖即可，无需重复创建。首次安装需要联网。

## 启动

在 `games/poker/` 目录、已激活的 Python 环境中运行：

```bash
# 仅本机游玩，启动后自动打开浏览器
python web_app.py

# 允许同一局域网的朋友加入
python web_app.py --lan
```

本机访问 [http://127.0.0.1:8765](http://127.0.0.1:8765)。联机时将启动输出中的局域网地址发给朋友。保持终端开启，按 `Ctrl+C` 停止服务。

Linux / macOS 使用名为 `poker` 的 Conda 环境时，也可从仓库根目录运行：

```bash
./games/poker/start_game.sh --lan
```

`start_game.sh` 使用已有的 `poker` 环境，不会创建环境或安装依赖；使用 `.venv` 时请直接运行 `python web_app.py`。

### 常用参数

| 参数                                  | 作用                           |
| ------------------------------------- | ------------------------------ |
| `--lan`                               | 从仅本机监听改为允许局域网访问 |
| `--port 8767`                         | 自定义端口，默认 `8765`        |
| `--no-browser`                        | 启动时不自动打开浏览器         |
| `--save-file /绝对路径/table.sqlite3` | 指定牌局存档文件               |
| `--no-save`                           | 临时游玩，既不读取也不写入存档 |

```bash
python web_app.py --lan --port 8767 --no-browser
```

## 与朋友联机

1. 主机使用 `--lan` 启动，房主点击「和朋友玩」，设置昵称、人数、行动限时和电脑补位。
2. 分享邀请链接或二维码。朋友连接同一网络后打开链接并申请加入，由房主批准。
3. 全体真人准备后开始；每手结算后共同准备下一手。

支持真人与电脑混坐、进行中申请加入后等待下一手、暂时离席和恢复原座位。详细操作、倒计时与恢复码说明见 [玩法与进阶说明](docs/GUIDE.md)。

## 存档与备份

默认存档为 `games/poker/.poker-data/table-端口号.sqlite3`。不同端口默认使用不同存档，也可用 `--save-file` 固定路径。

- 使用同一浏览器、相同主机地址与端口访问，可恢复原身份和牌局。
- 服务重启会恢复未过期的单人牌桌和好友房；超过 24 小时无人访问的房间和会话不再恢复。
- 好友房玩家可提前保存自己的座位恢复码，换设备时找回仍存在的座位。
- 备份前停止服务，再复制存档目录或自定义存档所在目录；同一个存档不要由多个进程同时使用。
- 存档包含底牌与身份信息，已被 Git 忽略。

## 命令行、模拟与测试

在游戏目录中执行：

```bash
python play_poker.py                         # 命令行游玩
python play_poker.py --list-bots             # 查看八种电脑策略
python play_poker.py --simulate 1000 --seed 42
python -m unittest discover -s tests -v      # Python 回归测试
```

如已安装 Node.js，可运行前端逻辑测试，无需额外安装 JavaScript 依赖：

```bash
node tests/test_turn_clock.js
node tests/test_web_interactions.js
```

机器人锦标赛及可选绘图：

```bash
python tournament.py --seed 42
python -m pip install -r requirements-plot.txt
python plot_tournament.py runs/你的比赛目录
```

CLI 操作、策略差异、模拟参数、输出格式和代码结构详见 [进阶文档](docs/GUIDE.md)。

## 常见问题

- **找不到 `poker` 环境：** 按首次安装创建 Conda 环境，或使用 `.venv` 并直接运行 Python 命令。
- **缺少 `pokerkit` 或 `qrcode`：** 在启动服务所用的同一个 Python 环境里执行 `python -m pip install -r requirements.txt`。
- **端口被占用：** 若已有服务在运行，先打开原地址；需要另开一桌服务时用 `--port` 指定其他端口。
- **朋友连不上：** 确认使用 `--lan`、分享的是主机局域网地址、设备在同一网络，并允许对应端口通过主机防火墙。
