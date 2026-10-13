"""Render recorded stacks with Matplotlib; does not import the poker engine."""

import argparse
import csv
import json
from pathlib import Path


def load_run(directory):
    directory = Path(directory)
    summary = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    if summary["status"] != "complete":
        raise ValueError("比赛尚未完整结束，不能生成最终结果图。")
    strategies = [player["strategy"] for player in summary["players"]]
    with (directory / "stacks.csv").open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ["hand", *strategies]:
            raise ValueError("筹码记录列与参赛策略不一致。")
        rows = [{key: int(value) for key, value in row.items()} for row in reader]
    if not rows or len(rows) != summary["hands_played"] + 1:
        raise ValueError("手牌记录缺失。")
    for number, row in enumerate(rows):
        if row["hand"] != number or any(row[name] < 0 for name in strategies):
            raise ValueError("手牌编号或筹码值异常。")
        if sum(row[name] for name in strategies) != summary["total_chips"]:
            raise ValueError("记录中的筹码不守恒。")
    for player in summary["players"]:
        name = player["strategy"]
        if rows[0][name] != summary["config"]["starting_stack"] or rows[-1][name] != player["final_stack"]:
            raise ValueError("初始或最终筹码不一致。")
        busted = player["eliminated_hand"]
        if busted is not None and any(row[name] != 0 for row in rows[busted:]):
            raise ValueError("淘汰玩家的后续筹码必须一直为零。")
    return summary, rows


def plot_run(directory):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager, ticker

    summary, rows = load_run(directory)
    directory = Path(directory)
    font = Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
    if font.exists():
        font_manager.fontManager.addfont(str(font))
        plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(font)).get_name()
    plt.rcParams.update({
        "font.size": 11, "axes.unicode_minus": False,
        "axes.spines.top": False, "axes.spines.right": False,
        "svg.fonttype": "none", "savefig.facecolor": "white",
    })
    hands = [row["hand"] for row in rows]
    players = summary["players"]
    total = summary["total_chips"]
    colors = ["#2878B5", "#F28E2B", "#35A16B", "#D1495B", "#8F63B8", "#8C6D31", "#159B9C", "#D85C9E"]
    styles = ["-", "--", "-.", ":", "-", "--", "-.", ":"]

    def style_axes(ax, max_stack):
        ax.set_xlim(-max(1, hands[-1] * 0.005), max(1, hands[-1]) * 1.01)
        ax.set_ylim(-max_stack * 0.018, max_stack * 1.065)
        ax.yaxis.set_major_formatter(ticker.StrMethodFormatter("{x:,.0f}"))
        ax.xaxis.set_major_locator(ticker.MaxNLocator(7, integer=True))
        ax.grid(axis="y", color="#DFE5EB", linewidth=0.65)
        ax.set_axisbelow(True)
        ax.set_xlabel("已完成手数")
        ax.set_ylabel("筹码")
        ax.spines["left"].set_color("#B0B8C1")
        ax.spines["bottom"].set_color("#B0B8C1")

    fig, ax = plt.subplots(figsize=(14, 7.6))
    for index, player in enumerate(players):
        name = player["strategy"]
        values = [row[name] for row in rows]
        ax.step(hands, values, where="post", color=colors[index], linestyle=styles[index],
                linewidth=1.8, label=name, alpha=0.95)
        if player["eliminated_hand"] is not None:
            ax.scatter([player["eliminated_hand"]], [0], color=colors[index], marker="x", s=45, zorder=4)
    style_axes(ax, total)
    fig.suptitle("八种机器人同桌 · 筹码变化", fontsize=21, x=0.08, ha="left", y=0.97)
    config = summary["config"]
    fig.text(0.08, 0.91,
             f"每人 {config['starting_stack']:,} 筹码  |  固定盲注 {config['small_blind']}/{config['big_blind']}  |  "
             f"种子 {summary['seed']}  |  共 {summary['hands_played']:,} 手  |  冠军 {summary['winner']}",
             color="#46515E")
    ax.legend(loc="upper left", ncol=4, frameon=False, bbox_to_anchor=(0, 1.14), handlelength=2.8)
    winner = next(player for player in players if player["strategy"] == summary["winner"])
    winner_color = colors[winner["player_id"]]
    ax.scatter([hands[-1]], [total], color=winner_color, s=55, zorder=5)
    ax.annotate(f"{winner['strategy']}  {total:,}", (hands[-1], total),
                xytext=(-12, -25), textcoords="offset points", ha="right", color="#222D38", fontsize=12)
    fig.text(0.08, 0.025, "每手结算后记录；第 0 手为初始状态。× 表示淘汰；淘汰后筹码持续为 0。", color="#46515E", fontsize=10)
    fig.subplots_adjust(left=0.08, right=0.97, top=0.78, bottom=0.11)
    for extension in ("png", "svg"):
        fig.savefig(directory / f"chip-curves.{extension}", dpi=180)
    plt.close(fig)

    # Separate panels keep the early eliminations visible without eight lines
    # overlapping. All panels share both axes so stack sizes stay comparable.
    fig, axes = plt.subplots(4, 2, figsize=(14, 13), sharex=True, sharey=True)
    for index, (ax, player) in enumerate(zip(axes.flat, players)):
        name = player["strategy"]
        values = [row[name] for row in rows]
        ax.step(hands, values, where="post", color=colors[index], linewidth=1.6)
        ax.fill_between(hands, values, step="post", color=colors[index], alpha=0.10)
        style_axes(ax, total)
        outcome = "冠军" if player["eliminated_hand"] is None else f"第 {player['eliminated_hand']} 手淘汰"
        ax.set_title(f"{name}  ·  {outcome}", loc="left", fontsize=12, pad=10)
        peak_row = max(rows, key=lambda row: row[name])
        ax.scatter([peak_row["hand"]], [peak_row[name]], color=colors[index], s=20, zorder=3)
        ax.annotate(f"峰值 {player['peak_stack']:,}", (peak_row["hand"], peak_row[name]),
                    xytext=(6 if peak_row['hand'] < hands[-1] * 0.7 else -6, 8),
                    textcoords="offset points", ha="left" if peak_row['hand'] < hands[-1] * 0.7 else "right", fontsize=10)
        ax.label_outer()
    fig.suptitle("每位机器人筹码轨迹（统一坐标）", fontsize=20, x=0.08, ha="left", y=0.99)
    fig.tight_layout(rect=(0, 0, 1, 0.97), h_pad=2)
    fig.savefig(directory / "chip-curves-by-bot.png", dpi=160)
    plt.close(fig)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description="将完整的单桌比赛记录绘制为 PNG / SVG 筹码曲线。")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args(argv)
    summary = plot_run(args.directory)
    print(f"已生成 {summary['hands_played']} 手、{len(summary['players'])} 名机器人的筹码曲线：{args.directory.resolve()}")


if __name__ == "__main__":
    main()
