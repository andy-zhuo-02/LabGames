"""PokerKit rules adapter and persistent table/seat management.

Player IDs are permanent seats. PokerKit indices are positions within one hand:
SB, BB, ..., BTN for 3+ players, and BB, BTN/SB for heads-up.
"""

from dataclasses import dataclass
import random
from typing import Literal

from pokerkit import (
    Automation, BlindOrStraddlePosting, Card, ChipsPushing, Deck, HoleCardsShowingOrMucking,
    NoLimitTexasHoldem, StandardHighHand,
)


STREETS = ("preflop", "flop", "turn", "river")


class IllegalAction(ValueError):
    """An action rejected before any state is changed."""


@dataclass(frozen=True)
class GameConfig:
    small_blind: int = 10
    big_blind: int = 20
    starting_stack: int = 2000

    def __post_init__(self):
        values = (self.small_blind, self.big_blind, self.starting_stack)
        if any(type(value) is not int or value <= 0 for value in values):
            raise ValueError("盲注和初始筹码必须是正整数。")
        if self.small_blind > self.big_blind:
            raise ValueError("小盲不能大于大盲。")


@dataclass(frozen=True)
class Player:
    player_id: int
    name: str
    stack: int


@dataclass(frozen=True)
class Action:
    kind: Literal["fold", "check", "call", "raise", "all_in"]
    amount: int | None = None  # raise TO the total for this betting round


@dataclass(frozen=True)
class LegalActions:
    fold: bool = False
    check: bool = False
    call_amount: int = 0
    min_raise_to: int | None = None
    max_raise_to: int | None = None
    all_in: bool = False


@dataclass(frozen=True)
class PublicPlayer:
    player_id: int
    name: str
    position: str
    stack: int
    bet: int
    active: bool


@dataclass(frozen=True)
class Observation:
    hand_number: int
    player_id: int
    actor_id: int | None
    street: str
    hole_cards: tuple[str, ...]
    board: tuple[str, ...]
    players: tuple[PublicPlayer, ...]
    pot: int
    big_blind: int
    legal: LegalActions


@dataclass(frozen=True)
class ActionRecord:
    player_id: int
    street: str
    action: Action
    paid: int


@dataclass(frozen=True)
class Payout:
    pot_index: int
    awards: tuple[tuple[int, int], ...]  # (player ID, chips received)


@dataclass(frozen=True)
class ShownHand:
    player_id: int
    cards: tuple[str, ...]
    hand_type: str


@dataclass(frozen=True)
class HandResult:
    hand_number: int
    board: tuple[str, ...]
    stacks: tuple[tuple[int, int], ...]
    payoffs: tuple[tuple[int, int], ...]
    payouts: tuple[Payout, ...]
    returned_bets: tuple[tuple[int, int], ...]
    shown_hands: tuple[ShownHand, ...]


class Hand:
    """A single hand. Bots receive Observation, never this mutable object."""

    def __init__(self, players, config, hand_number, seed, *, deck=None):
        self.players = tuple(players)
        self.player_ids = tuple(player.player_id for player in self.players)
        self.config = config
        self.hand_number = hand_number
        self.seed = seed
        self.actions: list[ActionRecord] = []
        self._private_cards = {player_id: [] for player_id in self.player_ids}
        self._initial_total = sum(player.stack for player in self.players)
        cards = list(Deck.STANDARD) if deck is None else list(Card.clean(deck))
        if len(cards) != 52 or set(cards) != set(Deck.STANDARD):
            raise ValueError("牌堆必须包含 52 张不重复的标准扑克牌。")
        if deck is None:
            random.Random(seed).shuffle(cards)
        self._initial_deck = tuple(map(repr, cards))
        # Deal explicitly so our own seeded deck is installed before any cards
        # are consumed. Other transitions/settlement remain automated.
        self._state = NoLimitTexasHoldem.create_state(
            (
                Automation.ANTE_POSTING,
                Automation.BET_COLLECTION,
                Automation.BLIND_OR_STRADDLE_POSTING,
                Automation.RUNOUT_COUNT_SELECTION,
                Automation.HAND_KILLING,
                Automation.CHIPS_PUSHING,
                Automation.CHIPS_PULLING,
            ),
            True, 0, (config.small_blind, config.big_blind), config.big_blind,
            tuple(player.stack for player in self.players), len(self.players),
        )
        self._state.deck_cards.clear()
        self._state.deck_cards.extend(cards)
        self._advance()

    @property
    def finished(self):
        return not self._state.status

    @property
    def actor_id(self):
        index = self._state.actor_index
        return None if index is None else self.player_ids[index]

    @property
    def street(self):
        index = self._state.street_index
        return "finished" if self.finished else STREETS[index]

    @property
    def board(self):
        return tuple(repr(card) for card in self._state.get_board_cards(0))

    def _advance(self):
        # PokerKit transitions synchronously; waiting in an empty loop cannot
        # advance it. Perform pending dealing or report an unsupported state.
        for _ in range(128):
            if self.finished or self.actor_id is not None:
                self._check_chips()
                return
            if self._state.can_burn_card():
                self._state.burn_card()
            elif self._state.can_deal_hole():
                operation = self._state.deal_hole()
                player_id = self.player_ids[operation.player_index]
                self._private_cards[player_id].extend(map(repr, operation.cards))
            elif self._state.can_deal_board():
                self._state.deal_board()
            elif self._state.can_show_or_muck_hole_cards(True):
                # Our casual-game table always shows every showdown contender.
                # PokerKit's automatic default mucks already beaten hands,
                # which hides opponents even after the player calls to the river.
                # Folded players never enter the showdown queue.
                self._state.show_or_muck_hole_cards(True)
            else:
                raise RuntimeError("牌局没有可执行动作，也没有可推进的自动阶段。")
        raise RuntimeError("自动推进超过安全步数，牌局可能卡住。")

    def _check_chips(self):
        if any(stack < 0 for stack in self._state.stacks):
            raise RuntimeError("出现负筹码。")
        if sum(self._state.stacks) + self._state.total_pot_amount != self._initial_total:
            raise RuntimeError("筹码总量不守恒。")

    def legal_actions(self, player_id):
        if player_id != self.actor_id or self.finished:
            return LegalActions()
        state = self._state
        call = state.checking_or_calling_amount
        can_call = state.can_check_or_call()
        can_raise = state.can_complete_bet_or_raise_to()
        index = state.actor_index
        all_in_to = state.stacks[index] + state.bets[index]
        all_in = (
            state.can_complete_bet_or_raise_to(all_in_to)
            or (can_call and call > 0 and call == state.stacks[index])
        )
        return LegalActions(
            fold=state.can_fold(), check=can_call and call == 0,
            call_amount=call if can_call else 0,
            min_raise_to=state.min_completion_betting_or_raising_to_amount if can_raise else None,
            max_raise_to=state.max_completion_betting_or_raising_to_amount if can_raise else None,
            all_in=all_in,
        )

    def observe(self, player_id):
        if player_id not in self.player_ids:
            raise ValueError("该玩家没有参加本手牌。")
        count = len(self.players)
        if count == 2:
            positions = ("BB", "BTN/SB")
        else:
            positions = ("SB", "BB") + tuple(
                "BTN" if index == count - 1 else f"UTG+{index - 2}"
                for index in range(2, count)
            )
        return Observation(
            self.hand_number, player_id, self.actor_id, self.street,
            tuple(self._private_cards[player_id]), self.board,
            tuple(PublicPlayer(
                player.player_id, player.name, positions[index],
                self._state.stacks[index], self._state.bets[index],
                self._state.statuses[index],
            ) for index, player in enumerate(self.players)),
            self._state.total_pot_amount, self.config.big_blind,
            self.legal_actions(player_id),
        )

    def apply_action(self, player_id, action):
        if self.finished or player_id != self.actor_id:
            raise IllegalAction("当前不是该玩家的行动回合。")
        if not isinstance(action, Action):
            raise IllegalAction("动作必须是 Action。")
        if action.kind != "raise" and action.amount is not None:
            raise IllegalAction("只有 raise 可以指定数额。")
        legal = self.legal_actions(player_id)
        index = self._state.actor_index
        street = self.street
        paid = 0
        if action.kind == "fold" and legal.fold:
            self._state.fold()
        elif action.kind == "check" and legal.check:
            self._state.check_or_call()
        elif action.kind == "call" and legal.call_amount > 0:
            paid = self._state.check_or_call().amount
        elif action.kind == "raise" and type(action.amount) is int and (
            self._state.can_complete_bet_or_raise_to(action.amount)
        ):
            paid = action.amount - self._state.bets[index]
            self._state.complete_bet_or_raise_to(action.amount)
        elif action.kind == "all_in" and legal.all_in:
            paid = self._state.stacks[index]
            target = paid + self._state.bets[index]
            if self._state.can_complete_bet_or_raise_to(target):
                self._state.complete_bet_or_raise_to(target)
            else:
                self._state.check_or_call()
        else:
            raise IllegalAction("非法动作：请按当前提示选择 check、call 或合法加注数额。")
        self.actions.append(ActionRecord(player_id, street, action, paid))
        self._advance()

    def result(self):
        if not self.finished:
            raise ValueError("本手牌尚未结束。")
        payouts = []
        shown = {}
        contributed = {player_id: 0 for player_id in self.player_ids}
        won = dict(contributed)
        for record in self.actions:
            contributed[record.player_id] += record.paid
        for operation in self._state.operations:
            if isinstance(operation, BlindOrStraddlePosting):
                contributed[self.player_ids[operation.player_index]] += operation.amount
            elif isinstance(operation, ChipsPushing):
                payouts.append(Payout(operation.pot_index, tuple(
                    (self.player_ids[index], amount)
                    for index, amount in enumerate(operation.amounts) if amount
                )))
                for index, amount in enumerate(operation.amounts):
                    won[self.player_ids[index]] += amount
            elif isinstance(operation, HoleCardsShowingOrMucking) and operation.hole_cards:
                cards = tuple(map(repr, operation.hole_cards))
                label = ""
                if len(cards) + len(self.board) >= 5:
                    label = StandardHighHand.from_game("".join(cards), "".join(self.board)).entry.label.value
                player_id = self.player_ids[operation.player_index]
                shown[player_id] = ShownHand(player_id, cards, label)
        # PokerKit can return unmatched chips during collection, and can leave
        # a fold winner's own bet in front of them until chips are pulled.
        # Both are refunds, separate from the ChipsPushing pot awards.
        returned = []
        for index, player in enumerate(self.players):
            amount = (
                self._state.stacks[index] - player.stack
                + contributed[player.player_id] - won[player.player_id]
            )
            if amount < 0:
                raise RuntimeError("结算中的下注退回金额异常。")
            if amount:
                returned.append((player.player_id, amount))
        return HandResult(
            self.hand_number, self.board,
            tuple(zip(self.player_ids, self._state.stacks)),
            tuple(zip(self.player_ids, self._state.payoffs)),
            tuple(payouts), tuple(returned), tuple(shown.values()),
        )


class Table:
    """A fixed seating order, eliminating broke players between hands.

Uses a moving button for 3+ players. On entering heads-up, the next surviving
seat after the previous BB pays the BB; the other player is BTN/SB.
"""

    def __init__(self, names=("You", "Bot-A", "Bot-B"), config=None, *, stacks=None, seed=None):
        self.config = config or GameConfig()
        names = tuple(names)
        if not 2 <= len(names) <= 9:
            raise ValueError("支持 2 至 9 名玩家。")
        if any(not isinstance(name, str) or not name.strip() for name in names):
            raise ValueError("玩家名称不能为空。")
        stacks = tuple(stacks) if stacks is not None else (self.config.starting_stack,) * len(names)
        if len(stacks) != len(names) or any(type(s) is not int or s < 0 for s in stacks):
            raise ValueError("每位玩家需要一个非负整数筹码值。")
        if sum(stack > 0 for stack in stacks) < 2:
            raise ValueError("至少两名玩家需要有筹码。")
        self.players = [Player(index, name, stacks[index]) for index, name in enumerate(names)]
        self._rng = random.Random(seed)
        self.seed = seed
        self.hand: Hand | None = None
        self.hand_number = 0
        self.button_id = self.active_ids[-1]
        self._previous_bb = None

    @property
    def active_ids(self):
        return tuple(player.player_id for player in self.players if player.stack > 0)

    @property
    def winner(self):
        return self.players[self.active_ids[0]] if len(self.active_ids) == 1 else None

    def _next_active(self, player_id):
        for offset in range(1, len(self.players) + 1):
            candidate = (player_id + offset) % len(self.players)
            if candidate in self.active_ids:
                return candidate
        raise RuntimeError("牌桌没有存活玩家。")

    def start_hand(self, *, deck=None):
        if self.hand is not None and not self.hand.finished:
            raise ValueError("请先完成当前手牌。")
        if len(self.active_ids) < 2:
            raise ValueError("对局已结束。")
        if self.hand_number:
            if len(self.active_ids) == 2:
                next_bb = self._next_active(self._previous_bb)
                self.button_id = self._next_active(next_bb)
            else:
                self.button_id = self._next_active(self.button_id)
        ordered_ids = []
        seat = self.button_id
        for _ in self.active_ids:
            seat = self._next_active(seat)
            ordered_ids.append(seat)
        next_number = self.hand_number + 1
        hand = Hand(
            [self.players[index] for index in ordered_ids], self.config,
            next_number, self._rng.getrandbits(64), deck=deck,
        )
        self.hand = hand
        self.hand_number = next_number
        self._previous_bb = ordered_ids[0 if len(ordered_ids) == 2 else 1]
        self._settle()
        return hand

    def apply_action(self, player_id, action):
        if self.hand is None:
            raise ValueError("请先开始一手牌。")
        self.hand.apply_action(player_id, action)
        self._settle()

    def _settle(self):
        if self.hand.finished:
            for player_id, stack in self.hand.result().stacks:
                previous = self.players[player_id]
                self.players[player_id] = Player(player_id, previous.name, stack)
