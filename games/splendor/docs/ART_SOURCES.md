# 卡牌照片与显示

当前发展卡使用原版实体卡牌的公开照片，保持 PNG 原文件不变。素材并非发行方提供的高清卡面原稿。

- 照片及整理项目：[anicolao/splendor](https://github.com/anicolao/splendor)
- 原始元数据：[cards.json](https://anicolao.github.io/splendor/data/cards.json)
- 下载地址：`https://anicolao.github.io/splendor/data/cards/{id}.png`
- 原游戏：[Space Cowboys / Splendor](https://www.spacecowboys-games.com/game/splendor/)
- 原始照片名：`PXL_20260304_170043943.jpg`、`PXL_20260304_170052269.jpg`。

90 张图片位于 `public/art/cards/`，单张为 630 × 880 像素，总计约 55.4 MB。按等级、奖励颜色、声望和全部五色费用逐张匹配到游戏数据，无缺失、无重复。`src/web/card-art.json` 保存本项目卡牌 ID 与图片路径的对应；`card-photo-manifest.json` 保存用于核对的数值元数据。

照片项目标注 GPL-3.0；原游戏插画仍属于原权利人，未发现单独的发行方美术授权声明。此来源说明不将素材标注为本项目原创或官方授权资源。本项目没有复制照片项目的游戏代码或它另外生成的 AI 插画。

卡牌图片从本机加载，浏览器按需读取。卡面缺失或加载失败时，显示由当前游戏数值生成的颜色与费用布局。卡片保留完整比例，外框标识奖励颜色；宝石池、费用圆片与玩家资源使用白、蓝、绿、红、黑五色，并提供可读的辅助标签。

## 宝石筹码图标

六种图标使用 [kyle-ip/splendor 的公开 PNG 素材](https://github.com/kyle-ip/splendor/tree/main/public/assets/gems)，原文件保存在 `public/art/gems/`，没有裁切或修改。白、蓝、绿、红、黑、金分别对应 `diamond.png`、`sapphire.png`、`emerald.png`、`ruby.png`、`onyx.png`、`gold.png`。

这些是该项目整理的宝石图案筹码，并非已核实的原版游戏筹码扫描件，不应称作官方原图。来源项目的说明见 [ATTRIBUTION.md](https://github.com/kyle-ip/splendor/blob/main/public/assets/ATTRIBUTION.md)；其中未逐张说明这些 PNG 的原始作者或单独授权。本项目保留出处，不将这些素材标为原创。

图标通过统一的 `GemIcon` 组件用于公共宝石池、玩家资源、预留卡奖励、付款与归还面板。费用圆片继续以色底和数字显示，避免小尺寸图案与数字挤在一起。图片随项目本地提供，局域网玩家无需连接外部图片服务。
