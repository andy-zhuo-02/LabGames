"""Explanations and replay records made only from officially public information."""

from collections import Counter
from pokerkit import StandardHighHand, BlindOrStraddlePosting, HandKilling
from play_poker import HAND_NAMES, STREET_NAMES, describe_action


def best_five(cards, board):
    hand = StandardHighHand.from_game("".join(cards), "".join(board))
    best = list(map(repr, hand.cards))
    values = ["23456789TJQKA".index(card[0]) + 2 for card in best]
    counts = Counter(values)
    groups = sorted(counts, key=lambda v: (counts[v], v), reverse=True)
    label = HAND_NAMES[hand.entry.label.value]
    ranks = lambda values: "、".join(str(v) if v <= 10 else {11:"J", 12:"Q", 13:"K", 14:"A"}[v] for v in values)
    if label in ("顺子", "同花顺"):
        detail = f"{ranks([5 if set(values) == {14, 2, 3, 4, 5} else max(values)])} 高{label}"
    elif label in ("高牌", "同花"):
        detail = f"{label}，依次比较 {ranks(sorted(values, reverse=True))}"
    else:
        main = [v for v in groups if counts[v] > 1]
        kickers = [v for v in groups if counts[v] == 1]
        detail = f"{label} {ranks(main)}" + (f"；踢脚牌 {ranks(kickers)}" if kickers else "")
    return {"best_cards": best, "comparison": detail, "hand_type": label, "rank": hand.entry.index}


def public_details(hand):
    result = hand.result()
    names = {p.player_id: p.name for p in hand.players}
    evaluated = {h.player_id: best_five(h.cards, result.board) for h in result.shown_hands}
    shown = [{"player_id": h.player_id, "name": names[h.player_id], "cards": list(h.cards),
              **{k: v for k, v in evaluated[h.player_id].items() if k != "rank"}} for h in result.shown_hands]
    paid = {i: 0 for i in hand.player_ids}
    for op in hand._state.operations:
        if isinstance(op, BlindOrStraddlePosting):
            paid[hand.player_ids[op.player_index]] += op.amount
    for action in hand.actions:
        paid[action.player_id] += action.paid
    for i, amount in result.returned_bets:
        paid[i] -= amount
    folded = {a.player_id for a in hand.actions if a.action.kind == "fold"}
    contenders = [i for i in hand.player_ids if i not in folded]
    killed = {hand.player_ids[op.player_index] for op in hand._state.operations if isinstance(op, HandKilling)}
    groups, previous = [], 0
    for threshold in sorted(set(amount for amount in paid.values() if amount > 0)):
        eligible = [i for i in contenders if paid[i] >= threshold]
        survivors = [i for i in eligible if i not in killed]
        amount = sum(value >= threshold for value in paid.values()) * (threshold - previous)
        previous = threshold
        # PokerKit coalesces after killing losing hands, so several contribution
        # levels can appear in one payout. Preserve each original eligibility
        # limit while aligning the displayed groups with the actual awards.
        if not groups or groups[-1]["survivors"] != survivors:
            groups.append({"survivors": survivors, "bands": []})
        groups[-1]["bands"].append((amount, eligible))
    payouts = []
    for pot in result.payouts:
        bands = groups[pot.pot_index]["bands"] if evaluated else []
        eligible = [i for i in contenders if any(i in ids for _, ids in bands)] if evaluated else contenders
        limits = {i: sum(amount for amount, ids in bands if i in ids) for i in eligible}
        partial = bool(evaluated and len(set(limits.values())) > 1)
        winners = [i for i, amount in pot.awards if amount]
        reason = "其他玩家均弃牌，无需比牌。"
        if evaluated:
            losers = [i for i in eligible if i not in winners and i in evaluated]
            if len(winners) > 1:
                reason = "最佳五张牌的点数完全相同，平分底池；不能平分的零头按位置分配。"
            elif losers:
                winner = evaluated[winners[0]]
                runner = max((evaluated[i] for i in losers), key=lambda h: h["rank"])
                reason = ("牌型胜出：" if winner["hand_type"] != runner["hand_type"] else "同类牌型按组成点数和踢脚牌依次比较：") + winner["comparison"] + "。"
            else:
                reason = "该底池只有这位玩家仍有资格领取。"
        payouts.append({"label": "主池" if pot.pot_index == 0 else f"边池 {pot.pot_index}",
                        "participants": [names[i] for i in eligible], "reason": reason,
                        "eligibility_limits": [{"name": names[i], "amount": limits[i]} for i in eligible] if partial else [],
                        "awards": [{"name": names[i], "amount": amount} for i, amount in pot.awards]})
    return {"shown_hands": shown, "payouts": payouts,
            "actions": [{"player": names[a.player_id], "street": STREET_NAMES[a.street], "description": describe_action(a)} for a in hand.actions],
            "stacks": [{"id": p.player_id, "name": p.name, "stack": dict(result.stacks)[p.player_id], "initial": p.stack} for p in hand.players]}
