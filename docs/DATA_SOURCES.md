# 规则与数据来源

## 规则基准

基础版规则，以发行方目前提供的 2024 英文规则书为基准：

- [Space Cowboys 游戏介绍与规则下载](https://www.spacecowboys-games.com/game/splendor/)
- [官方规则 PDF](https://cdn.svc.asmodee.net/production-spacecowboys/uploads/2025/10/SCSPL01EN_SPLENDOR_RULES_LIGHT.pdf)

实现注意：黄金可主动替代已有同色宝石；达到 15 分在回合末检查（包括贵族）；平分再比较已购卡数量；没有足够颜色时才允许拿少于三种；拿取及预留造成超限后，由玩家归还。

两项线上约定在规则弹窗中说明：先手随机决定；仅在所有正常行动均不可执行时提供跳过，避免极端资源枯竭导致永久卡死。其他玩家的所有预留卡牌只显示数量，牌库顺序始终仅保存在服务端。

## 发展卡

录入 `src/engine/data.ts` 的 90 张卡，仅包含等级、奖励颜色、声望和费用。以下两份公开数值转录归一化颜色及字段后，90 个记录完全相同：

- [bouk/splendimax — Splendor Cards.csv](https://github.com/bouk/splendimax/blob/master/Splendor%20Cards.csv)
- [seal256/splendor — assets/cards.csv](https://github.com/seal256/splendor/blob/master/assets/cards.csv)

核对日期：2026-09-10。等级分布 40 / 30 / 20，每张赋予稳定唯一 ID。没有复用上述项目的游戏引擎、界面或图像。

## 贵族

贵族使用 5 个双色四折扣、5 个三色三折扣的标准组合，每位 3 分。

- 双色：白蓝、蓝绿、绿红、红黑、黑白。
- 三色：白蓝绿、蓝绿红、绿红黑、红黑白、黑白蓝。

与 [seal256/splendor — pysplendor/splendor.py](https://github.com/seal256/splendor/blob/master/pysplendor/splendor.py) 中 `NOBLES` 常量的全部 10 项核对一致。同时参考 [bouk/splendimax — src/noble.rs](https://github.com/bouk/splendimax/blob/master/src/noble.rs) 的数值；该表只有 9 项，缺少白 4 / 蓝 4，录入时根据完整表补齐。

另外检查了 [boardgamers/splendor — data.ts](https://github.com/boardgamers/splendor/blob/main/packages/engine/src/data.ts)：其中一位贵族使用白绿红 3/3/3，与上述标准组合不一致，未采纳该项。没有依据该项目的引擎实现规则。

测试覆盖总数、唯一性、等级分布、标准组合和个别已知卡牌，后续调整数值应保留来源记录并更新测试。
