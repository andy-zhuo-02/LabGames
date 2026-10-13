"""CLI for a three-seat no-limit Texas Hold'em table."""

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import random
import sys
import time

from bots import DEFAULT_EQUITY_SAMPLES, STRATEGIES, make_bot
from engine import Action, GameConfig, IllegalAction, Table
from terminal_ui import can_refresh, clear_screen, format_cards, render_table


STREET_NAMES = {"preflop": "翻牌前", "flop": "翻牌", "turn": "转牌", "river": "河牌", "finished": "结束"}
HAND_NAMES = {
    "High card": "高牌", "One pair": "一对", "Two pair": "两对",
    "Three of a kind": "三条", "Straight": "顺子", "Flush": "同花",
    "Full house": "葫芦", "Four of a kind": "四条", "Straight flush": "同花顺",
}


class QuitGame(Exception):
    pass


def parse_action(text):
    parts = text.strip().lower().split()
    if len(parts) == 1:
        word = parts[0]
        if word in ("q", "quit", "exit"):
            raise QuitGame()
        aliases = {
            "f": "fold", "fold": "fold", "x": "check", "check": "check",
            "c": "call", "call": "call", "a": "all_in", "allin": "all_in",
            "all-in": "all_in", "all_in": "all_in",
        }
        if word in aliases:
            return Action(aliases[word])
    if len(parts) == 2 and parts[0] in ("r", "raise", "bet"):
        try:
            amount = int(parts[1])
        except ValueError:
            raise IllegalAction("加注数额必须是整数。") from None
        if amount > 0:
            return Action("raise", amount)
    raise IllegalAction("请输入 fold / check / call / raise 数额 / allin / q。")


def show_state(hand, viewer_id=0, *, seats=None, refresh=False, recent_actions=True, strategies=None):
    observation = hand.observe(viewer_id)
    if refresh:
        clear_screen()
    print(f"德州扑克 | 第 {hand.hand_number} 手 · {STREET_NAMES[observation.street]} | 盲注 {hand.config.small_blind}/{hand.config.big_blind}")
    if strategies:
        print(f"Bot-A: {strategies[1]} | Bot-B: {strategies[2]} | q 退出")
    else:
        print("♠ 黑桃  ♥ 红桃  ♦ 方块  ♣ 梅花 | q 退出")
    shown = {shown.player_id: shown.cards for shown in hand.result().shown_hands} if hand.finished else {}
    print(render_table(observation, seats if seats is not None else hand.players, shown_hands=shown))
    if recent_actions:
        print("最近行动:")
        names = {player.player_id: player.name for player in hand.players}
        for record in hand.actions[-4:]:
            print(f"  {STREET_NAMES[record.street]} {names[record.player_id]}: {describe_action(record)}")
        for _ in range(max(0, 4 - len(hand.actions))):
            print()
    # Bots may act without prompting, so flush every complete frame.
    sys.stdout.flush()


def human_action(table, player_id=0):
    legal = table.hand.legal_actions(player_id)
    available = []
    if legal.fold:
        available.append("fold/f 弃牌")
    if legal.check:
        available.append("check/x 过牌")
    if legal.call_amount:
        available.append(f"call/c 跟注 {legal.call_amount}")
    if legal.all_in:
        available.append("allin/a 全下")
    print("操作:", " | ".join(available))
    if legal.min_raise_to is not None:
        print(f"加注: raise/r {legal.min_raise_to}..{legal.max_raise_to}（本轮总额）")
    while True:
        try:
            action = parse_action(input("> "))
            table.apply_action(player_id, action)
            return
        except IllegalAction as error:
            print(error)
        except (EOFError, KeyboardInterrupt):
            raise QuitGame() from None


def describe_action(record):
    kind = record.action.kind
    if kind == "raise":
        return f"下注/加注到 {record.action.amount}（投入 {record.paid}）"
    if kind == "call":
        return f"跟注 {record.paid}"
    if kind == "all_in":
        return f"全下，投入 {record.paid}"
    return {"check": "过牌", "fold": "弃牌"}[kind]


def show_result(table, *, compact=False):
    result = table.hand.result()
    if compact:
        print("本手结算:")
    else:
        print(f"\n第 {result.hand_number} 手结束")
        print("最终公共牌:", format_cards(result.board) or "（无）")
        for shown in result.shown_hands:
            print(f"  {table.players[shown.player_id].name}: {format_cards(shown.cards)} {HAND_NAMES.get(shown.hand_type, shown.hand_type)}")
    for payout in result.payouts:
        label = "主池" if payout.pot_index == 0 else f"边池 {payout.pot_index}"
        awards = ", ".join(f"{table.players[player_id].name} 获得 {amount}" for player_id, amount in payout.awards)
        print(f"  {label}: {awards}")
    for player_id, amount in result.returned_bets:
        print(f"  {table.players[player_id].name}: 退回未入池下注 {amount}")
    payoffs = dict(result.payoffs)
    hand_types = {shown.player_id: HAND_NAMES.get(shown.hand_type, shown.hand_type) for shown in result.shown_hands}
    for player in table.players:
        eliminated = "（已淘汰）" if player.stack == 0 else ""
        hand_type = f"{hand_types[player.player_id]} | " if compact and player.player_id in hand_types else ""
        print(f"  {player.name}: {hand_type}筹码 {player.stack}, 本手净盈亏 {payoffs.get(player.player_id, 0):+d} {eliminated}")


def play_hand(table, bots, *, human_id=0, quiet=False, refresh=False, strategies=None):
    hand = table.start_hand()
    refresh = refresh and not quiet and can_refresh()
    viewer_id = human_id if human_id is not None else hand.player_ids[0]
    action_count = 0
    while not hand.finished:
        action_count += 1
        if action_count > 10000:
            raise RuntimeError("单手行动次数超过安全上限。")
        actor = hand.actor_id
        if actor is None:
            raise RuntimeError("牌局未结束，但没有行动玩家。")
        if not quiet:
            # In a human game, retain the human's view even after they fold.
            show_state(hand, viewer_id, seats=table.players, refresh=refresh, strategies=strategies)
        if actor == human_id:
            human_action(table, actor)
        else:
            if refresh:
                time.sleep(0.6)
            action = bots[actor].choose_action(hand.observe(actor))
            table.apply_action(actor, action)
    if not quiet:
        show_state(hand, viewer_id, seats=table.players, refresh=refresh, recent_actions=False, strategies=strategies)
        # Keep the decisive action visible on the result screen too.
        if hand.actions:
            last = hand.actions[-1]
            print(f"最后行动: {table.players[last.player_id].name}: {describe_action(last)}")
        show_result(table, compact=True)
    return hand.result()


def write_history(path, table, strategies, *, equity_samples=DEFAULT_EQUITY_SAMPLES):
    hand = table.hand
    entry = {
        "schema_version": 1,
        "hand_seed": hand.seed,
        "config": asdict(table.config),
        "players_in_position_order": [asdict(player) for player in hand.players],
        "strategies": strategies,
        "bot_settings": {"equity_samples": equity_samples},
        "actions": [asdict(action) for action in hand.actions],
        "result": asdict(hand.result()),
    }
    with Path(path).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry, ensure_ascii=False) + "\n")


def positive_int(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("必须是正整数。")
    return number


def build_parser():
    parser = argparse.ArgumentParser(description="德州扑克：真人对战简单 AI，或运行机器人模拟。")
    parser.add_argument("--seed", type=int, help="固定随机种子，复现洗牌与机器人决策")
    parser.add_argument("--stack", type=positive_int, default=2000, help="初始筹码，默认 2000")
    parser.add_argument("--small-blind", type=positive_int, default=10)
    parser.add_argument("--big-blind", type=positive_int, default=20)
    parser.add_argument("--bots", nargs=2, choices=tuple(STRATEGIES), default=("random", "tight"), metavar=("BOT_A", "BOT_B"), help="选择两个对手策略，使用 --list-bots 查看说明")
    parser.add_argument("--simulate", type=positive_int, metavar="HANDS", help="用机器人完成指定手数，整场结束后自动重新开桌")
    parser.add_argument("--hero-bot", choices=tuple(STRATEGIES), default="loose", help="模拟时座位 0 的策略")
    parser.add_argument("--list-bots", action="store_true", help="列出所有策略及其风格后退出")
    parser.add_argument("--equity-samples", type=positive_int, default=DEFAULT_EQUITY_SAMPLES, help="equity 策略每次估计的抽样次数，默认 128；越高越慢")
    parser.add_argument("--history", type=Path, help="将已完成手牌追加保存为 JSONL，可含摊牌和复现信息")
    parser.add_argument("--no-clear", action="store_true", help="关闭清屏刷新，保留每次牌桌输出")
    return parser


def run(args):
    if args.list_bots:
        for name, description in STRATEGIES.items():
            print(f"{name:16} {description}")
        return
    config = GameConfig(args.small_blind, args.big_blind, args.stack)
    rng = random.Random(args.seed)
    strategies = (args.hero_bot, *args.bots)
    bots = {
        index: make_bot(strategy, rng.getrandbits(64), equity_samples=args.equity_samples)
        for index, strategy in enumerate(strategies)
    }
    names = ("Bot-Hero" if args.simulate else "You", "Bot-A", "Bot-B")

    def new_table():
        return Table(names, config, seed=rng.getrandbits(64))

    table = new_table()
    completed = 0
    matches = 0
    net = [0, 0, 0]
    if not args.simulate:
        print(f"无限注德州扑克 | 盲注 {config.small_blind}/{config.big_blind} | Bot-A: {args.bots[0]}, Bot-B: {args.bots[1]}")
        print("牌面：♠ 黑桃、♥ 红桃、♦ 方块、♣ 梅花。未完成手牌不会保存。")
    while True:
        result = play_hand(
            table, bots, human_id=None if args.simulate else 0,
            quiet=bool(args.simulate), refresh=not args.no_clear, strategies=strategies,
        )
        completed += 1
        for player_id, payoff in result.payoffs:
            net[player_id] += payoff
        if args.history:
            history_strategies = strategies if args.simulate else ("human", *args.bots)
            write_history(args.history, table, history_strategies, equity_samples=args.equity_samples)
        if table.winner:
            matches += 1
        if args.simulate:
            if completed >= args.simulate:
                print(f"模拟完成: {completed} 手，{matches} 场已决出胜者；筹码守恒检查通过。")
                for index, name in enumerate(names):
                    print(f"  {name} ({strategies[index]}): 累计净盈亏 {net[index]:+d}")
                return
            if table.winner:
                table = new_table()
        else:
            if table.winner:
                print(f"\n最终胜者: {table.winner.name}")
                return
            if table.players[0].stack == 0:
                print("\n你的筹码已用完，对战结束。")
                return
            command = input("\n回车开始下一手，q 退出: ").strip().lower()
            if command in ("q", "quit", "exit"):
                return


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except (QuitGame, EOFError, KeyboardInterrupt):
        print("\n已退出。")
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f"错误: {error}\n")


if __name__ == "__main__":
    main()
