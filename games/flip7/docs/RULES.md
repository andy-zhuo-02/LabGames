# 规则依据

核对日期：2026-10-08。实现基础版 Flip 7，采用发行方维护的 Dized 现行规则及 The Op FAQ。

| 主题       | 实现约定                                                                                                    | 一手来源                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 牌组       | 0 一张，1～12 各 N 张；+2/+4/+6/+8/+10、×2 各一张；冻结/连翻三张/第二次机会各三张，共 94 张                 | [The Deck](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/23a1QGS6ShGMaP3DhPSd_w/the-deck)                                                                              |
| 发牌       | 每轮按顺序各发一张，遇到动作牌先处理；有至少一张牌才可主动收手                                              | [How to Play](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/wGXhPMBFQ2i1ymgjH16VkA/how-to-play)                                                                        |
| 计分       | 数字之和先乘倍率，再加加分牌，最后加七连翻的 15 分；爆牌全部为零                                            | [Calculate Scores](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/-UTTEBFOTuyjbeZOlRQPUA/calculate-scores)、[The Op FAQ](https://theop.games/pages/flip-7-corner-pizza) |
| 连翻三张   | 逐张接受，所有牌型均计入三张；爆牌或七连翻提前结束。冻结/连翻牌延迟到三张完成后处理，爆牌则弃掉这些待处理牌 | [Flip Three](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/au24_PEbSGOx0k7WybVJoQ/flip-three)                                                                          |
| 第二次机会 | 第一张保留，可立即防护连翻中的重复；多余牌交给尚无机会牌的其他活跃玩家，无有效目标则弃置                    | [Second Chance](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/jxfRCwMWS7yZ2fZYtY2yPg/second-chance)                                                                    |
| 洗牌       | 每轮保留剩余牌堆；耗尽才洗弃牌；当轮所有桌面牌，包括爆牌者的牌，均不洗回                                    | [Starting the Next Round](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/wzjlmw8LSdeycfWo_EvxOg/starting-the-next-round)                                                |
| 胜负       | 轮末最高分达到 200 时获胜；最高分并列则全体继续加赛                                                         | [End of the Game](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/3ttrgsvYQru7TBa4hFWuzw/end-of-the-game)                                                                |

部分早期纸质规则对于「连翻三张中爆牌后是否仍处理动作牌」存在差异。本实现明确选择上述现行 Dized 规则：爆牌后弃掉该次连翻尚未处理的冻结/连翻牌。完成动作链后，回到最初翻出动作牌的玩家的下一席继续；不是跟随动作目标改变正常轮转。

数字与功能牌始终有唯一标识。动作分配前暂存在序列化的任务队列；分配后置于目标桌面。被第二次机会抵消的重复数字与机会牌立即进入弃牌堆；没有被抵消的爆牌重复数字仍留在桌面，直到本轮结束。

数字版由程序发牌，第一轮用户先手，以便教学，后续每轮轮换先手。电脑策略和首局先手属于数字版交互选择，不改变分数、牌组和动作结算规则。
