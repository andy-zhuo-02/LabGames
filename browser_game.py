"""Browser-facing poker state shared by solo and LAN rooms."""

from dataclasses import asdict
import random
import secrets
import threading
import time

from pokerkit import StandardHighHand

from bots import STRATEGIES, make_bot
from engine import Action, GameConfig, Table
from play_poker import HAND_NAMES, STREET_NAMES, describe_action


PROFILES = {
    "random": {"name": "米粒", "avatar": "米", "style": "随性派", "color": "#b78cea", "description": "出牌随性，偶尔也会突然加注。"},
    "tight": {"name": "林克", "avatar": "林", "style": "稳健派", "color": "#78a6dd", "description": "耐心选牌，拿到好牌才会认真进攻。"},
    "loose": {"name": "小夏", "avatar": "夏", "style": "主动派", "color": "#e5a46f", "description": "喜欢参与牌局，也喜欢给对手一点压力。"},
    "nit": {"name": "石头", "avatar": "石", "style": "谨慎派", "color": "#a5b5c0", "description": "很少冒险，愿意等一手真正满意的牌。"},
    "calling_station": {"name": "阿豆", "avatar": "豆", "style": "爱跟注", "color": "#82c5a9", "description": "总想多看一张牌，是个随和的练手伙伴。"},
    "maniac": {"name": "阿烈", "avatar": "烈", "style": "进攻派", "color": "#e48387", "description": "频繁加注，手里不一定总有好牌。"},
    "push_fold": {"name": "闪电", "avatar": "闪", "style": "敢出手", "color": "#c8b472", "description": "筹码少的时候，会选择果断搏一把。"},
    "equity": {"name": "北辰", "avatar": "北", "style": "计算派", "color": "#78c4d1", "description": "会估计牌面胜率，适合想认真过招的时候。"},
}


class Conflict(ValueError):
    pass


class BrowserGame:
    def __init__(self):
        self.lock = threading.Lock()
        self.table = None
        self.bots = {}
        self.strategies = []
        self.version = 0
        self.last_seen = time.monotonic()
        self.completed = 0
        self.wins = 0
        self.player_wins = {}
        self.history = []
        self.room = "轻松练手"

    def start(self, payload):
        name = payload.get("name", "你")
        opponents = payload.get("opponents", ["calling_station", "random"])
        if not isinstance(name, str) or len(name.strip()) > 12:
            raise ValueError("昵称最多 12 个字。")
        if not isinstance(opponents, list) or not 1 <= len(opponents) <= 5:
            raise ValueError("请选择 1 至 5 位 AI 牌友。")
        if any(not isinstance(style, str) or style not in STRATEGIES for style in opponents):
            raise ValueError("请选择列表中的 AI 牌友。")
        room = payload.get("room", "自由组桌")
        if not isinstance(room, str) or len(room) > 20:
            raise ValueError("牌桌名称不正确。")
        rng = random.Random(secrets.randbits(64))
        names = [name.strip() or "你"]
        for index, style in enumerate(opponents):
            display_name = PROFILES[style]["name"]
            if opponents.count(style) > 1:
                display_name += str(opponents[:index + 1].count(style))
            names.append(display_name)
        table = Table(names, GameConfig(), seed=rng.getrandbits(64))
        bots = {index + 1: make_bot(style, rng.getrandbits(64)) for index, style in enumerate(opponents)}
        table.start_hand()
        self.table, self.bots = table, bots
        self.strategies = ["human", *opponents]
        self.room = room
        self.completed = self.wins = 0
        self.player_wins = {}
        self.history = []
        self.version += 1
        self._account_result()

    def command(self, route, payload):
        if self.table is None:
            raise Conflict("请先选择牌桌。")
        if type(payload.get("version")) is not int or payload["version"] != self.version:
            raise Conflict("牌桌已经更新，请按当前画面操作。")
        hand = self.table.hand
        if route == "action":
            if hand.finished or hand.actor_id != 0:
                raise Conflict("还没轮到你，请稍等。")
            self.table.apply_action(0, Action(payload.get("kind"), payload.get("amount")))
        elif route == "step":
            if hand.finished or hand.actor_id == 0:
                raise Conflict("当前没有等待行动的 AI。")
            actor = hand.actor_id
            self.table.apply_action(actor, self.bots[actor].choose_action(hand.observe(actor)))
        elif route == "next":
            if not hand.finished or self.table.winner or self.table.players[0].stack == 0:
                raise Conflict("当前不能开始下一手。")
            self.table.start_hand()
        elif route == "finish":
            if hand.finished:
                raise Conflict("本手已经结束。")
            hero = next(player for player in hand.observe(0).players if player.player_id == 0)
            if hero.active and hero.stack > 0:
                raise Conflict("你仍在参与本手，请亲自选择动作。")
            for _ in range(10000):
                if hand.finished:
                    break
                actor = hand.actor_id
                self.table.apply_action(actor, self.bots[actor].choose_action(hand.observe(actor)))
            if not hand.finished:
                raise RuntimeError("本手推进异常，请重新开桌。")
        else:
            raise ValueError("未知操作。")
        self.version += 1
        self._account_result()

    def _account_result(self):
        hand = self.table.hand
        if not hand.finished or self.completed == hand.hand_number:
            return
        result = hand.result()
        payoff = dict(result.payoffs).get(0, 0)
        self.completed = hand.hand_number
        self.wins += payoff > 0
        for player_id, profit in result.payoffs:
            self.player_wins[player_id] = self.player_wins.get(player_id, 0) + (profit > 0)
        winners = sorted({i for pot in result.payouts for i, amount in pot.awards if amount})
        self.history.insert(0, {
            "hand_number": hand.hand_number, "profit": payoff,
            "payoffs": dict(result.payoffs),
            "board": list(result.board), "winners": [self.table.players[i].name for i in winners],
        })
        self.history = self.history[:30]

    def snapshot(self, viewer_id=0, *, multiplayer=False):
        catalog = [{"id": key, **profile} for key, profile in PROFILES.items()]
        if self.table is None:
            return {"version": self.version, "phase": "lobby", "catalog": catalog, "mode": "solo", "viewer_id": 0}
        table, hand = self.table, self.table.hand
        participating = viewer_id in hand.player_ids
        observation = hand.observe(viewer_id if participating else hand.player_ids[0])
        own_cards = observation.hole_cards if participating else ()
        public = {player.player_id: player for player in observation.players}
        result = hand.result() if hand.finished else None
        awards = {}
        if result:
            for pot in result.payouts:
                for player_id, amount in pot.awards:
                    if amount:
                        awards[player_id] = awards.get(player_id, 0) + amount
        shown = {item.player_id: item.cards for item in result.shown_hands} if result else {}
        folded = {record.player_id for record in hand.actions if record.action.kind == "fold"}
        latest = {record.player_id: record for record in hand.actions}
        players = []
        for seat in table.players:
            player = public.get(seat.player_id)
            profile = PROFILES.get(self.strategies[seat.player_id], {})
            players.append({
                "id": seat.player_id, "name": seat.name,
                "strategy": self.strategies[seat.player_id],
                "avatar": profile.get("avatar", "你" if seat.player_id == viewer_id else seat.name[:1]), "style": profile.get("style", "真人"),
                "color": profile.get("color", "#e6c479"),
                "stack": player.stack if player else seat.stack,
                "bet": player.bet if player else 0,
                "position": player.position if player else "",
                "folded": seat.player_id in folded,
                "eliminated": player is None or (hand.finished and seat.stack == 0),
                "all_in": bool(player and player.active and player.stack == 0 and not hand.finished),
                "cards": list(own_cards) if seat.player_id == viewer_id else list(shown.get(seat.player_id, ())),
                "last_action": describe_action(latest[seat.player_id]) if seat.player_id in latest else "",
                "is_winner": seat.player_id in awards, "won_amount": awards.get(seat.player_id, 0),
            })
        current_type = ""
        if own_cards and len(observation.board) >= 3:
            current_type = HAND_NAMES[StandardHighHand.from_game(
                "".join(own_cards), "".join(observation.board),
            ).entry.label.value]
        done = hand.finished and (table.winner is not None or (not multiplayer and table.players[viewer_id].stack == 0))
        summary = None
        if result:
            payoff = dict(result.payoffs).get(viewer_id, 0)
            summary = {
                "winner_ids": sorted(awards),
                "end_reason": "showdown" if result.shown_hands else "folds",
                "explanation": ("本手进入摊牌，未弃牌的玩家全部亮出底牌。" if result.shown_hands
                                else "其他玩家均已弃牌，最后留下的玩家直接收下底池，无需亮牌。"),
                "profit": payoff,
                "pot": sum(amount for pot in result.payouts for _, amount in pot.awards),
                "title": "漂亮，赢下这一手" if payoff > 0 else "下一手，再找机会" if viewer_id in folded else "这一手结束了",
                "match_over": done,
                "champion": table.winner.name if table.winner else None,
                "hero_won_table": bool(table.winner and table.winner.player_id == viewer_id),
                "returned_bets": [{"name": table.players[i].name, "amount": amount}
                                  for i, amount in result.returned_bets],
                "payouts": [{"label": "主池" if pot.pot_index == 0 else f"边池 {pot.pot_index}",
                             "awards": [{"name": table.players[i].name, "amount": amount} for i, amount in pot.awards]}
                            for pot in result.payouts],
                "shown_hands": [{"player_id": item.player_id, "name": table.players[item.player_id].name, "cards": list(item.cards),
                                 "hand_type": HAND_NAMES.get(item.hand_type, item.hand_type)}
                                for item in result.shown_hands],
            }
        return {
            "mode": "multiplayer" if multiplayer else "solo", "viewer_id": viewer_id,
            "version": self.version, "phase": "finished" if hand.finished else "playing",
            "room": self.room, "hand_number": hand.hand_number,
            "street": observation.street, "street_name": STREET_NAMES[observation.street],
            "actor_id": hand.actor_id, "board": list(observation.board), "pot": observation.pot,
            "small_blind": table.config.small_blind, "big_blind": table.config.big_blind,
            "players": players, "legal": asdict(hand.legal_actions(viewer_id)), "hand_type": current_type,
            "actions": [{"player": table.players[item.player_id].name, "street": STREET_NAMES[item.street],
                         "description": describe_action(item)} for item in hand.actions[-30:]],
            "stats": {"hands": self.completed, "wins": self.player_wins.get(viewer_id, 0),
                      "profit": table.players[viewer_id].stack - table.config.starting_stack},
            "result": summary,
            "history": [{**{key: value for key, value in item.items() if key != "payoffs"},
                         "profit": item["payoffs"].get(viewer_id, 0)} for item in self.history],
            "catalog": catalog,
        }
