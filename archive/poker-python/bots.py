"""Simple legal-action policies. No policy has access to opponents' cards."""

from collections import Counter
import random

from pokerkit import Card, Deck, StandardHighHand

from engine import Action, Observation


RANKS = "23456789TJQKA"
DEFAULT_EQUITY_SAMPLES = 128
STRATEGIES = {
    "random": "随机：随机弃牌、跟注和最小加注，作为基线",
    "tight": "紧手：选择较强的牌，适度主动下注",
    "loose": "松手：入池范围较宽，更积极下注",
    "nit": "极紧：更挑起手牌，面对高成本跟注更加谨慎",
    "calling_station": "跟注站：偏爱过牌和跟注，弱牌面对大额下注会弃牌",
    "maniac": "狂野：频繁大额下注和加注，包含弱牌诈唬",
    "push_fold": "短码推弃：不超过 12 个大盲时主要全下或弃牌，深筹码时使用紧手策略",
    "equity": "胜率：抽样未知牌，按预计分池份额和跟注成本决策",
}


def raise_action(observation, *, pot_fraction=0.5, preflop_blinds=3):
    """Size a raise TO a legal total, including chips already posted."""
    legal = observation.legal
    if legal.min_raise_to is None:
        return passive_action(observation)
    me = next(player for player in observation.players if player.player_id == observation.player_id)
    if observation.street == "preflop":
        target = max(observation.big_blind * preflop_blinds, legal.min_raise_to)
    else:
        target = me.bet + legal.call_amount + max(
            observation.big_blind, int((observation.pot + legal.call_amount) * pot_fraction),
        )
    return Action("raise", min(legal.max_raise_to, max(legal.min_raise_to, target)))


def passive_action(observation):
    if observation.legal.check:
        return Action("check")
    if observation.legal.call_amount:
        return Action("call")
    if observation.legal.fold:
        return Action("fold")
    raise ValueError("没有可执行的被动动作。")


class RandomBot:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)

    def choose_action(self, observation: Observation):
        legal = observation.legal
        roll = self.rng.random()
        if legal.call_amount and roll < 0.20 and legal.fold:
            return Action("fold")
        if legal.min_raise_to is not None and roll > (0.70 if legal.check else 0.80):
            return Action("raise", legal.min_raise_to)
        return passive_action(observation)


class RuleBot:
    """Heuristic strength score, not an equity estimate or an optimal strategy."""

    def __init__(self, style="tight", seed=None):
        if style not in ("tight", "loose"):
            raise ValueError("策略风格必须是 tight 或 loose。")
        self.style = style
        self.rng = random.Random(seed)

    @staticmethod
    def strength(observation):
        hole = observation.hole_cards
        ranks = sorted((RANKS.index(card[0]) + 2 for card in hole), reverse=True)
        if len(ranks) != 2:
            raise ValueError("机器人需要两张底牌。")
        if not observation.board:
            high, low = ranks
            if high == low:
                return 0.48 + high / 28
            score = (high + low) / 40
            score += 0.07 if hole[0][1] == hole[1][1] else 0
            score += 0.05 if high - low == 1 else 0
            score -= 0.08 if high - low > 4 else 0
            return min(0.95, max(0.10, score))

        hand = StandardHighHand.from_game("".join(hole), "".join(observation.board))
        scores = {
            "High card": 0.18, "One pair": 0.44, "Two pair": 0.62,
            "Three of a kind": 0.73, "Straight": 0.82, "Flush": 0.87,
            "Full house": 0.94, "Four of a kind": 0.98, "Straight flush": 1.0,
        }
        score = scores[hand.entry.label.value]
        if len(observation.board) == 5:
            board_hand = StandardHighHand.from_game((), "".join(observation.board))
            if hand == board_hand:
                # A strong public board does not mean we beat the opponents.
                score = 0.25
        if len(observation.board) < 5:
            cards = hole + observation.board
            suits = Counter(card[1] for card in cards)
            flush_draw = any(count == 4 for count in suits.values())
            unique = {RANKS.index(card[0]) + 2 for card in cards}
            if 14 in unique:
                unique.add(1)
            straight_draw = any(
                len(unique.intersection(range(start, start + 5))) == 4
                for start in range(1, 11)
            )
            score += 0.10 if flush_draw else 0
            score += 0.06 if straight_draw else 0
        return min(score, 1.0)

    def choose_action(self, observation: Observation):
        legal = observation.legal
        me = next(player for player in observation.players if player.player_id == observation.player_id)
        score = self.strength(observation)
        score += 0.07 if self.style == "loose" else 0
        score += 0.03 if "BTN" in me.position else 0
        price = legal.call_amount / max(1, observation.pot + legal.call_amount)
        commitment = legal.call_amount / max(1, me.stack)
        threshold = 0.25 + price * 0.65 + commitment * 0.20
        if legal.call_amount and score < threshold and legal.fold:
            return Action("fold")
        aggression = 0.75 if self.style == "loose" else 0.55
        if legal.min_raise_to is not None and score >= 0.62 and self.rng.random() < aggression:
            return raise_action(observation)
        return passive_action(observation)


class NitBot:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)

    def choose_action(self, observation: Observation):
        legal = observation.legal
        me = next(player for player in observation.players if player.player_id == observation.player_id)
        score = RuleBot.strength(observation)
        price = legal.call_amount / max(1, observation.pot + legal.call_amount)
        commitment = legal.call_amount / max(1, me.stack)
        threshold = (0.66 if observation.street == "preflop" else 0.48) + price * 0.20 + commitment * 0.12
        if "BTN" in me.position:
            threshold -= 0.03
        if legal.call_amount and score < threshold and legal.fold:
            return Action("fold")
        if legal.min_raise_to is not None and score >= 0.78 and self.rng.random() < 0.70:
            return raise_action(observation)
        return passive_action(observation)


class CallingStationBot:
    def choose_action(self, observation: Observation):
        legal = observation.legal
        if legal.check:
            return Action("check")
        me = next(player for player in observation.players if player.player_id == observation.player_id)
        score = RuleBot.strength(observation)
        price = legal.call_amount / max(1, observation.pot + legal.call_amount)
        commitment = legal.call_amount / max(1, me.stack)
        expensive = (price > 0.38 and legal.call_amount > 4 * observation.big_blind) or commitment > 0.60
        if legal.fold and legal.call_amount and score < 0.40 and expensive:
            return Action("fold")
        return passive_action(observation)


class ManiacBot:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)

    def choose_action(self, observation: Observation):
        legal = observation.legal
        me = next(player for player in observation.players if player.player_id == observation.player_id)
        score = RuleBot.strength(observation)
        # Even this loose policy sometimes gives up terrible hands to a shove.
        if legal.fold and legal.call_amount > me.stack * 0.75 and score < 0.30:
            return Action("fold")
        if legal.min_raise_to is not None and self.rng.random() < 0.80:
            return raise_action(observation, pot_fraction=1.0, preflop_blinds=5)
        return passive_action(observation)


class PushFoldBot:
    def __init__(self, seed=None):
        self.deep_stack_bot = RuleBot("tight", seed)

    def choose_action(self, observation: Observation):
        me = next(player for player in observation.players if player.player_id == observation.player_id)
        if me.stack + me.bet > 12 * observation.big_blind:
            return self.deep_stack_bot.choose_action(observation)
        score = RuleBot.strength(observation)
        active_opponents = sum(player.active and player.player_id != me.player_id for player in observation.players)
        threshold = 0.60 + max(0, active_opponents - 1) * 0.04
        if "BTN" in me.position:
            threshold -= 0.05
        if score >= threshold:
            if observation.legal.all_in:
                return Action("all_in")
            # A short raise may not reopen betting; never force an illegal shove.
            return passive_action(observation)
        if observation.legal.check:
            return Action("check")
        if observation.legal.fold:
            return Action("fold")
        return passive_action(observation)


class EquityBot:
    """Monte Carlo pot-share estimate against uniformly random active hands.

Folded players' unknown cards remain unknown. All-in opponents still compete
at showdown. This does not model betting ranges, fold equity, or side-pot EV.
"""

    def __init__(self, seed=None, samples=DEFAULT_EQUITY_SAMPLES):
        if type(samples) is not int or samples <= 0:
            raise ValueError("胜率抽样次数必须是正整数。")
        self.samples = samples
        self.rng = random.Random(seed)
        self._cache_key = None
        self._cached_equity = None

    def estimate_equity(self, observation: Observation):
        opponents = sum(
            player.active and player.player_id != observation.player_id
            for player in observation.players
        )
        if opponents == 0:
            return 1.0
        key = (observation.hand_number, observation.hole_cards, observation.board, opponents)
        if key == self._cache_key:
            return self._cached_equity
        hole = tuple(Card.parse("".join(observation.hole_cards)))
        board = tuple(Card.parse("".join(observation.board)))
        known = set(hole + board)
        if len(hole) != 2 or len(board) > 5 or len(known) != len(hole + board):
            raise ValueError("胜率估计需要两张底牌及不重复的公共牌。")
        unseen = tuple(card for card in Deck.STANDARD if card not in known)
        missing_board = 5 - len(board)
        total_share = 0.0
        for _ in range(self.samples):
            sampled = self.rng.sample(unseen, missing_board + opponents * 2)
            completed_board = board + tuple(sampled[:missing_board])
            hero = StandardHighHand.from_game(hole, completed_board)
            hands = [hero]
            for index in range(opponents):
                start = missing_board + index * 2
                hands.append(StandardHighHand.from_game(sampled[start:start + 2], completed_board))
            best = max(hands)
            if hero == best:
                total_share += 1 / sum(hand == best for hand in hands)
        equity = total_share / self.samples
        self._cache_key, self._cached_equity = key, equity
        return equity

    def choose_action(self, observation: Observation):
        legal = observation.legal
        equity = self.estimate_equity(observation)
        price = legal.call_amount / max(1, observation.pot + legal.call_amount)
        if legal.call_amount and equity < price + 0.04 and legal.fold:
            return Action("fold")
        contenders = sum(player.active for player in observation.players)
        value_threshold = max(0.52, 1 / max(1, contenders) + 0.18)
        if legal.min_raise_to is not None and equity >= value_threshold:
            return raise_action(observation, pot_fraction=0.75 if equity >= 0.75 else 0.5)
        return passive_action(observation)


def make_bot(strategy, seed=None, *, equity_samples=DEFAULT_EQUITY_SAMPLES):
    if strategy == "random":
        return RandomBot(seed)
    if strategy in ("tight", "loose"):
        return RuleBot(strategy, seed)
    if strategy == "nit":
        return NitBot(seed)
    if strategy == "calling_station":
        return CallingStationBot()
    if strategy == "maniac":
        return ManiacBot(seed)
    if strategy == "push_fold":
        return PushFoldBot(seed)
    if strategy == "equity":
        return EquityBot(seed, equity_samples)
    raise ValueError(f"未知机器人策略：{strategy}")
