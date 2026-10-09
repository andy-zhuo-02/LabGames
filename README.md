# 局域网小游戏 LabGames

德州扑克、璀璨宝石与七连翻共用一个 Git 仓库，各个游戏独立启动和保存进度。

```text
局域网小游戏LabGames/
├── README.md
├── .git/
└── games/
    ├── poker/       # 德州扑克：Python / PokerKit
    ├── splendor/    # 璀璨宝石：Node.js / React / TypeScript
    └── flip7/       # 七连翻：Node.js / 原生 JavaScript，单人 / 局域网房间
```

## 启动

在本项目根目录打开终端，运行相应游戏的脚本。启动脚本会自动切换到各自游戏目录。

德州扑克（允许同一局域网内的朋友加入）：

```bash
./games/poker/start_game.sh --lan
```

默认端口为 `8765`，仅本机游玩时省略 `--lan`；不想自动打开浏览器可加 `--no-browser`。
使用现有的 `poker` Conda 环境。需要继续原来 `8767` 端口的牌局时，运行：

```bash
./games/poker/start_game.sh --lan --port 8767
```

璀璨宝石：

```bash
./games/splendor/start.sh
```

默认监听局域网，端口为 `3000`。需要 Node.js 22.13+ 和 pnpm 11.19.0；现有脚本也支持此工作站的 Codex 内置运行环境。
修改源码后运行 `./games/splendor/start.sh --rebuild`，开发模式为 `./games/splendor/start.sh --dev`。
各服务可以同时运行；各自在对应终端按 Ctrl+C 停止。

七连翻 Flip 7（单人 / 局域网联机）：

```bash
./games/flip7/start.sh
```

打开 `http://localhost:3007`，需要 Node.js 22+，无需安装依赖或构建。默认监听局域网。支持单人对战电脑和 3～6 人联机房间、邀请链接、真人与电脑混合、准备开局、断线重连与自动保存。

完整安装步骤、玩法和参数见 [扑克说明](games/poker/README.md)、[璀璨宝石说明](games/splendor/README.md) 与 [七连翻说明](games/flip7/README.md)。

## 存档与迁移

- 扑克存档位于 `games/poker/.poker-data/`，默认按端口区分数据库。
- 璀璨宝石存档位于 `games/splendor/data/`。
- 七连翻单人存档位于浏览器 `localStorage`；联机牌局位于 `games/flip7/data/rooms.json`，浏览器保存席位身份。需用同一浏览器、相同主机地址与端口恢复自己的席位。
- 2026-09-10 合并时，已将两个原项目的数据库用 SQLite 备份接口迁入新目录，并复制本地比赛记录及璀璨宝石的依赖、构建产物。存档和依赖继续由各自的 `.gitignore` 排除，不会提交到仓库。
- 原目录 `poker_simulator` 和 `splendor` 保留。迁移后在新目录继续开发、运行；原目录后续产生的存档或代码变化不会自动同步过来。
- 原服务仍在运行时，先在其终端停止，再从新目录启动相同端口。使用原浏览器、原主机地址和原端口，可继续使用浏览器中已有的身份凭证；牌局恢复仍受各游戏的过期和重连规则约束。

## Git 历史

两个游戏通过 `git subtree add` 导入，未压缩提交历史。整个项目只有根目录的一份 `.git`，子目录均为普通项目文件。

| 游戏 | 导入的原提交 | 原分支 |
| --- | --- | --- |
| 德州扑克 | `ca37c91cd65a443b5578529473c73043d1c74e1b` | `master` |
| 璀璨宝石 | `125da363d38fd9d7855ff50c5f13c58fde5e7137` | `master` |

原标签按游戏名加前缀保留，例如扑克的 `v0.0.0` 为 `poker/v0.0.0`。新仓库当前分支为 `codex/labgames`。
可在根目录用 `git log --all --graph --oneline` 查看完整历史。迁移前的提交保留原路径，可直接按原提交号查看。
新仓库尚未配置远程地址；原仓库的远程配置不变。

## 验证与开发

两个游戏的源码与导入时的提交逐文件一致，新增功能可继续放在对应子目录。

```bash
# 扑克：Python 回归测试
(cd games/poker && conda run --no-capture-output -n poker python -m unittest discover -s tests)

# 扑克：前端逻辑测试（Node.js 可用时）
(cd games/poker && node tests/test_turn_clock.js && node tests/test_web_interactions.js)

# 璀璨宝石：测试、类型检查与生产构建（pnpm 可用时）
(cd games/splendor && pnpm check)

# 七连翻：规则、300 局模拟与网页服务测试（无需安装依赖）
./games/flip7/start.sh --test
```
