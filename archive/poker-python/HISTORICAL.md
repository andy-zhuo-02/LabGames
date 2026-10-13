# Python 版扑克：迁移参考

此目录保存迁移前的 Python 实现、测试和说明，仅供对照与历史研究。
它不属于 npm 工作区，正常安装、启动、测试、模拟、存档导入均不使用它。
本目录 README 与 GUIDE 中的命令描述旧版本，不是当前安装步骤。

当前实现与命令见 [Node.js 版扑克](../../games/poker/README.md)。
当前开发统一使用 Node.js + JavaScript/TypeScript + npm。

`games/poker/tests/fixtures/pokerkit-hands.json` 是迁移前用 PokerKit 0.7.5
生成的 160 组固定牌局，保存初始牌堆、逐步观察、操作和结算，用于独立校验新版。
`python-saves.json` 包含专门生成的测试存档，不包含真实玩家的存档或凭证。
