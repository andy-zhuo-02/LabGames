# 原版牌面与视觉来源

更新日期：2026-10-08。Flip 7 名称、标志和卡牌美术的相关权利归 The Op / USAopoly 等原权利人所有；本项目是非官方实现。

## 原始素材

卡面来自发行方维护的 [Dized《Flip 7》牌组说明](https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/23a1QGS6ShGMaP3DhPSd_w/the-deck)。五张原始插图涵盖全部 22 种牌面：数字 0～12、加分 +2 / +4 / +6 / +8 / +10、×2，以及 Freeze、Flip Three、Second Chance。

| 本地文件                 | 内容                              |
| ------------------------ | --------------------------------- |
| `web/art/numbers-a.png`  | 12、11、10、9、8                  |
| `web/art/numbers-b.png`  | 7、6、5、4、3                     |
| `web/art/numbers-c.png`  | 2、1、0                           |
| `web/art/modifiers.png`  | 五种加分牌、×2                    |
| `web/art/actions.png`    | Freeze、Flip Three、Second Chance |
| `web/art/flip7-logo.png` | 原版 Flip 7 标志                  |

标志来自发行方产品页链接的 [Flip 7 计分应用](https://flip7-46611.web.app/)。原始文件下载地址、尺寸、文件大小与 SHA-256 均记录在 [art-manifest.json](art-manifest.json)。所有图片保留下载时的文件字节，在本地提供，不依赖运行时外链。

## 网页显示方式

`web/card-art.js` 使用 SVG 的 `viewBox` 从原始插图中显示各张卡牌。没有重新绘制卡面、替换卡面文字或改变卡面颜色。卡片下方及放大弹窗补充中文名称与效果解释。

原规则插图中的单张卡牌约为 165 × 257 像素，标志为 197 × 120 像素；放大查看沿用原图，因此清晰度受这些原始尺寸限制。

网站视觉参考 [The Op 原版产品页面及照片](https://theop.games/products/flip-7)：奶油黄纸面、靛蓝线框、亮黄和珊瑚红强调色，配合卡面的几何装饰、双线边框和印刷感阴影。牌堆背面为配合此风格制作的装饰图形和原版标志组合，并非实体卡背扫描图。
