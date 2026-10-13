"""Run every registered bot at one table until only one player has chips."""

import argparse
import csv
from dataclasses import asdict
from datetime import datetime
from importlib.metadata import version
import json
from pathlib import Path
import random

from bots import DEFAULT_EQUITY_SAMPLES, STRATEGIES, make_bot
from engine import GameConfig, Table
from play_poker import play_hand, positive_int, write_history


def run_tournament(output, *, seed=42, config=None,
                   equity_samples=DEFAULT_EQUITY_SAMPLES, progress=None):
    config = config or GameConfig()
    strategies = tuple(STRATEGIES)
    if not 2 <= len(strategies) <= 9:
        raise ValueError("单桌需要 2 至 9 种策略。")
    rng = random.Random(seed)
    bot_seeds = [rng.getrandbits(64) for _ in strategies]
    bots = {
        index: make_bot(strategy, bot_seeds[index], equity_samples=equity_samples)
        for index, strategy in enumerate(strategies)
    }
    table_seed = rng.getrandbits(64)
    table = Table(strategies, config, seed=table_seed)
    output = Path(output)
    # Each directory holds exactly one match; never append a new match to old data.
    output.mkdir(parents=True, exist_ok=False)
    completed = 0
    peaks = [config.starting_stack] * len(strategies)
    eliminated = {}
    places = {}
    total_chips = config.starting_stack * len(strategies)

    def checkpoint(status, error=None):
        summary = {
            "status": status,
            "seed": seed,
            "table_seed": table_seed,
            "bot_seeds": dict(zip(strategies, bot_seeds)),
            "pokerkit_version": version("pokerkit"),
            "config": asdict(config),
            "equity_samples": equity_samples,
            "hands_played": completed,
            "total_chips": total_chips,
            "winner": table.winner.name if table.winner else None,
            "ranking_rule": "同手淘汰并列，按仍存活人数加一记名次。",
            "recording": "第 0 行为初始筹码，之后每手结算后记录；淘汰玩家持续记 0。",
            "players": [{
                "player_id": player.player_id,
                "strategy": player.name,
                "final_stack": player.stack,
                "peak_stack": peaks[player.player_id],
                "eliminated_hand": eliminated.get(player.player_id),
                "place": places.get(player.player_id),
            } for player in table.players],
        }
        if error:
            summary["error"] = error
        path = output / "summary.json"
        temporary = output / "summary.json.tmp"
        temporary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
        return summary

    checkpoint("running")
    with (output / "stacks.csv").open("x", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(("hand", *strategies))
        writer.writerow((0, *(player.stack for player in table.players)))
        stream.flush()
        try:
            while table.winner is None:
                before = set(table.active_ids)
                play_hand(table, bots, human_id=None, quiet=True)
                completed += 1
                stacks = [player.stack for player in table.players]
                if sum(stacks) != total_chips or any(stack < 0 for stack in stacks):
                    raise RuntimeError("全桌筹码总量不守恒或出现负数。")
                peaks[:] = [max(peak, stack) for peak, stack in zip(peaks, stacks)]
                busted = before - set(table.active_ids)
                for player_id in busted:
                    eliminated[player_id] = completed
                    places[player_id] = len(table.active_ids) + 1
                writer.writerow((completed, *stacks))
                stream.flush()
                write_history(output / "hands.jsonl", table, strategies, equity_samples=equity_samples)
                if table.winner:
                    places[table.winner.player_id] = 1
                if busted or completed % 50 == 0 or table.winner:
                    checkpoint("complete" if table.winner else "running")
                    if progress:
                        names = ", ".join(strategies[index] for index in sorted(busted))
                        message = f"第 {completed} 手 | 剩余 {len(table.active_ids)} 人"
                        if names:
                            message += f" | 淘汰: {names}"
                        message += " | " + ", ".join(
                            f"{player.name}={player.stack}" for player in table.players if player.stack
                        )
                        progress(message)
        except (Exception, KeyboardInterrupt) as error:
            checkpoint("interrupted" if isinstance(error, KeyboardInterrupt) else "failed", str(error))
            raise
    return checkpoint("complete")


def main(argv=None):
    parser = argparse.ArgumentParser(description="全部八种机器人同桌，持续对战到最终胜者并记录筹码。")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--stack", type=positive_int, default=2000)
    parser.add_argument("--small-blind", type=positive_int, default=10)
    parser.add_argument("--big-blind", type=positive_int, default=20)
    parser.add_argument("--equity-samples", type=positive_int, default=DEFAULT_EQUITY_SAMPLES)
    parser.add_argument("--output", type=Path, help="新的输出目录；省略时自动创建带时间戳的 runs 子目录")
    args = parser.parse_args(argv)
    output = args.output or Path("runs") / f"all-bots-{datetime.now():%Y%m%d-%H%M%S-%f}-seed{args.seed}"
    try:
        summary = run_tournament(
            output, seed=args.seed,
            config=GameConfig(args.small_blind, args.big_blind, args.stack),
            equity_samples=args.equity_samples, progress=lambda text: print(text, flush=True),
        )
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f"错误: {error}\n")
    except KeyboardInterrupt:
        parser.exit(130, f"已中断；已完成的手牌保存在 {output}\n")
    print(f"\n比赛结束：{summary['hands_played']} 手，冠军 {summary['winner']}，总筹码 {summary['total_chips']}。")
    print(f"数据目录：{output.resolve()}")


if __name__ == "__main__":
    main()
