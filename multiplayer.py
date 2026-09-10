"""Shared LAN rooms. Session identity and all decisions stay on the server."""

from dataclasses import dataclass, field
import ipaddress
import math
import secrets
import socket
import threading
import time

from bots import STRATEGIES, make_bot
from browser_game import BrowserGame, Conflict, PROFILES
from engine import Action, GameConfig, Player, Table


TURN_SECONDS = 90
TURN_OPTIONS = (15, 30, 60, 90, 120)
ONLINE_SECONDS = 8
DISCONNECT_SECONDS = 12
HOST_TIMEOUT = 20
BOT_DELAY = 0.8


def discover_lan_ips():
    """Read local IPv4 interfaces, without probing other devices or the internet."""
    addresses = set()
    try:
        import fcntl
        import struct
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            for _, name in socket.if_nameindex():
                if name.startswith(("lo", "docker", "veth", "virbr", "br-")):
                    continue
                try:
                    data = fcntl.ioctl(sock.fileno(), 0x8915, struct.pack("256s", name.encode()[:15]))
                    addresses.add(socket.inet_ntoa(data[20:24]))
                except OSError:
                    pass
    except (ImportError, OSError):
        pass
    if not addresses:
        try:
            addresses.update(socket.gethostbyname_ex(socket.gethostname())[2])
        except OSError:
            pass
    return sorted(address for address in addresses if
                  ipaddress.ip_address(address).is_private and
                  not ipaddress.ip_address(address).is_loopback and
                  not ipaddress.ip_address(address).is_link_local)


@dataclass
class Member:
    name: str
    seen: float
    player_id: int | None = 0
    member_id: str = field(default_factory=lambda: secrets.token_urlsafe(9))
    joined_hand: int = 1


@dataclass
class Room:
    code: str
    host: str
    capacity: int
    fill_bots: bool
    bot_strategy: str
    turn_seconds: int = TURN_SECONDS
    members: dict[str, Member] = field(default_factory=dict)
    game: BrowserGame | None = None
    version: int = 1
    last_seen: float = 0
    turn_key: tuple | None = None
    deadline: float = 0
    notice: str = ""
    round_id: int = 1
    ready: set[str] = field(default_factory=set)
    banned: set[str] = field(default_factory=set)
    recovering: bool = False
    applicants: dict[str, Member] = field(default_factory=dict)

    def reset_ready(self):
        self.ready.clear()
        self.round_id += 1

    def readiness_members(self):
        if self.game and self.game.table.hand.finished and self.can_continue():
            active = {sid for sid, member in self.members.items() if member.player_id is None or self.game.table.players[member.player_id].stack > 0}
            if active:
                return active
        return set(self.members)

    def seating_plan(self):
        """Plan between-hand buy-ins without touching the current hand or its cards."""
        if not self.game:
            return []
        occupied = {m.player_id for m in self.members.values() if m.player_id is not None}
        players = self.game.table.players
        available = list(range(len(players), self.capacity))
        available += sorted((p.player_id for p in players if p.player_id not in occupied),
                            key=lambda i: (players[i].stack > 0, i))
        waiting = [sid for sid, m in self.members.items() if m.player_id is None]
        if len(waiting) > len(available):
            raise ValueError("等待入座的人数超过房间容量。")
        return list(zip(waiting, available))

    def can_continue(self):
        if not self.game:
            return False
        stacks = {p.player_id: p.stack for p in self.game.table.players}
        for _, seat in self.seating_plan():
            stacks[seat] = self.game.table.config.starting_stack
        return sum(stack > 0 for stack in stacks.values()) >= 2

    def playing_members(self):
        return {sid for sid, m in self.members.items() if m.player_id is not None}

    def arm_turn(self, now):
        if self.recovering or self.game is None or self.game.table.hand.finished:
            self.turn_key, self.deadline = None, 0
            return
        hand = self.game.table.hand
        key = (hand.hand_number, len(hand.actions), hand.actor_id)
        if key != self.turn_key:
            self.turn_key = key
            self.deadline = now + (BOT_DELAY if hand.actor_id in self.game.bots else self.turn_seconds)

    def changed(self, now):
        self.version += 1
        self.last_seen = now
        if self.game:
            self.game._account_result()
        self.arm_turn(now)


class RoomRegistry:
    def __init__(self, *, clock=time.monotonic, on_change=None):
        self.lock = threading.RLock()
        self.rooms = {}
        self.membership = {}
        self.departures = {}
        self.clock = clock
        self.on_change = on_change
        self._last_checkpoint = clock()

    def _room(self, sid):
        code = self.membership.get(sid)
        if code not in self.rooms:
            raise Conflict("你还没有加入好友房间。")
        return self.rooms[code]

    def _new_code(self):
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(6))
            if code not in self.rooms:
                return code

    @staticmethod
    def _name(payload):
        name = payload.get("name", "玩家")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 12:
            raise ValueError("请填写 1 至 12 个字的昵称。")
        return name.strip()

    def contains(self, sid):
        with self.lock:
            return sid in self.membership

    def departure(self, sid):
        with self.lock:
            return self.departures.get(sid)

    def snapshot(self, sid):
        with self.lock:
            if sid not in self.membership:
                return None
            now = self.clock()
            room = self._room(sid)
            if sid in room.applicants:
                applicant = room.applicants[sid]
                applicant.seen = now
                return {"version": room.version, "phase": "pending", "mode": "multiplayer", "viewer_id": None,
                        "catalog": [{"id": key, **profile} for key, profile in PROFILES.items()],
                        "room_info": {"code": room.code, "host_name": room.members[room.host].name,
                                      "is_host": False, "pending_approval": True, "applicant_name": applicant.name}}
            room.members[sid].seen = room.last_seen = now
            viewer = room.members[sid]
            if room.game:
                snapshot = room.game.snapshot(viewer.player_id, multiplayer=True)
                snapshot["history"] = [h for h in snapshot["history"] if h["hand_number"] >= viewer.joined_hand]
                snapshot["stats"]["hands"] = max(0, room.game.completed - viewer.joined_hand + 1)
                if snapshot["result"]:
                    snapshot["result"]["match_over"] = not room.can_continue()
                humans = {member.player_id: (token, member) for token, member in room.members.items()}
                for player in snapshot["players"]:
                    human = humans.get(player["id"])
                    player["online"] = bool(human and now - human[1].seen <= ONLINE_SECONDS)
                    if player["strategy"] == "human":
                        player["style"] = "房主" if human and human[0] == room.host else "真人牌友"
            else:
                snapshot = {"phase": "waiting", "mode": "multiplayer", "viewer_id": viewer.player_id,
                            "catalog": [{"id": key, **profile} for key, profile in PROFILES.items()]}
            snapshot["version"] = room.version
            eligible = room.readiness_members()
            between_hands = room.game is None or room.game.table.hand.finished
            connection_members = room.playing_members() if room.recovering else eligible
            waiting_connection = [member.name for token, member in room.members.items()
                                  if token in connection_members and now - member.seen > ONLINE_SECONDS]
            waiting_ready = [member.name for token, member in room.members.items()
                             if token in eligible and token not in room.ready and now - member.seen <= ONLINE_SECONDS]
            messages = []
            if between_hands or room.recovering:
                if waiting_connection:
                    messages.append("等待 " + "、".join(waiting_connection) + " 重连")
                if between_hands and waiting_ready:
                    messages.append("等待 " + "、".join(waiting_ready) + " 准备")
                if room.game is None and len(room.members) < 2 and not room.fill_bots:
                    messages.append("至少两位玩家才能开局")
                if not messages:
                    messages.append("重连完成，即将恢复本手" if room.recovering else "大家已准备好，即将继续")
            can_ready = between_hands and sid in eligible and (sid in room.ready or room.game is not None or len(room.members) >= 2 or room.fill_bots)
            remaining = room.deadline
            if room.game and not room.game.table.hand.finished:
                actor = room.game.table.hand.actor_id
                human = next((member for member in room.members.values() if member.player_id == actor), None)
                if human and now - human.seen > ONLINE_SECONDS:
                    remaining = min(remaining, human.seen + DISCONNECT_SECONDS)
            snapshot["room_info"] = {
                "code": room.code, "capacity": room.capacity, "fill_bots": room.fill_bots,
                "bot_style": PROFILES[room.bot_strategy]["style"],
                "is_host": room.host == sid, "host_name": room.members[room.host].name,
                "can_start": room.game is None and can_ready,
                "round_id": room.round_id, "can_ready": can_ready, "ready": sid in room.ready,
                "ready_count": len(room.ready & eligible), "ready_total": len(eligible),
                "recovering": room.recovering, "waiting_message": "；".join(messages),
                "pending_approval": False, "waiting_for_seat": viewer.player_id is None,
                "starting_stack": room.game.table.config.starting_stack if room.game else 2000,
                "applications": [{"id": m.member_id, "name": m.name, "online": now - m.seen <= ONLINE_SECONDS,
                                  "can_approve": len(room.members) < room.capacity}
                                 for m in room.applicants.values()] if sid == room.host else [],
                "waiting_for_connection": waiting_connection, "waiting_for_ready": waiting_ready if between_hands else [],
                "members": [{"id": member.member_id, "player_id": member.player_id, "name": member.name, "is_you": token == sid, "is_host": token == room.host,
                             "online": now - member.seen <= ONLINE_SECONDS,
                             "ready": token in room.ready, "needs_ready": token in eligible,
                             "waiting_for_seat": member.player_id is None,
                             "can_kick": sid == room.host and token != sid}
                            for token, member in room.members.items()],
                "turn_seconds": room.turn_seconds,
                "disconnect_seconds": DISCONNECT_SECONDS,
                "remaining_seconds": max(0, math.ceil(remaining - now)) if remaining else 0,
                "remaining_ms": max(0, round((remaining - now) * 1000)) if remaining else 0,
                "notice": room.notice,
            }
            return snapshot

    def perform(self, sid, route, payload):
        with self.lock:
            self._perform(sid, route, payload)
            if self.on_change:
                self.on_change(self)

    def _perform(self, sid, route, payload):
        with self.lock:
            now = self.clock()
            if route == "room/create":
                if sid in self.membership:
                    raise Conflict("请先退出当前好友房间。")
                name = self._name(payload)
                capacity = payload.get("capacity", 4)
                fill = payload.get("fill_bots", True)
                style = payload.get("bot_strategy", "calling_station")
                turn_seconds = payload.get("turn_seconds", TURN_SECONDS)
                if type(capacity) is not int or not 2 <= capacity <= 6:
                    raise ValueError("好友房支持 2 至 6 个座位。")
                if type(fill) is not bool or not isinstance(style, str) or style not in STRATEGIES:
                    raise ValueError("请选择有效的 AI 补位设置。")
                if type(turn_seconds) is not int or turn_seconds not in TURN_OPTIONS:
                    raise ValueError("思考时间请选择 15、30、60、90 或 120 秒。")
                if len(self.rooms) >= 64:
                    raise Conflict("当前房间太多，请稍后再试。")
                code = self._new_code()
                room = Room(code, sid, capacity, fill, style, turn_seconds=turn_seconds, last_seen=now)
                room.members[sid] = Member(name, now)
                self.rooms[code], self.membership[sid] = room, code
                self.departures.pop(sid, None)
                return
            if route == "room/join":
                code = payload.get("code", "")
                if not isinstance(code, str):
                    raise ValueError("请输入六位房间码。")
                code = code.strip().upper()
                if len(code) != 6 or code not in self.rooms:
                    raise Conflict("没有找到房间，请核对房间码和访问地址。")
                if sid in self.membership:
                    if self.membership[sid] == code:
                        return
                    raise Conflict("请先退出当前好友房间。")
                room = self.rooms[code]
                if sid in room.banned:
                    raise Conflict("你已被房主移出这个房间，暂不能重新加入。")
                name = self._name(payload)
                if any(member.name == name for member in [*room.members.values(), *room.applicants.values()]):
                    raise Conflict("房间里已有同名牌友，请换个昵称。")
                if len(room.applicants) >= 12:
                    raise Conflict("等待审批的人数较多，请稍后再申请。")
                room.applicants[sid] = Member(name, now, None)
                self.membership[sid] = code
                self.departures.pop(sid, None)
                room.changed(now)
                return
            if route == "room/leave" and sid not in self.membership:
                return
            room = self._room(sid)
            if payload.get("room_code") != room.code:
                raise Conflict("房间已更新，请按当前画面操作。")
            if sid in room.applicants:
                if route != "room/leave":
                    raise Conflict("请等待房主批准入桌申请。")
                del room.applicants[sid]
                del self.membership[sid]
                room.changed(now)
                return
            if route in {"room/start", "next", "room/rematch"}:
                # Votes may share a version, but must belong to the same hand/lobby.
                if type(payload.get("round_id")) is not int or payload["round_id"] != room.round_id:
                    raise Conflict("准备阶段已更新，请确认当前牌局后再操作。")
            elif route not in {"room/leave", "room/kick", "room/approve", "room/reject"} and (type(payload.get("version")) is not int or payload["version"] != room.version):
                raise Conflict("房间已更新，请按当前画面操作。")
            room.members[sid].seen = room.last_seen = now
            if route == "room/leave":
                self._remove_member(room, sid, now)
                return
            if route in {"room/approve", "room/reject"}:
                if sid != room.host:
                    raise Conflict("只有房主可以审批入桌申请。")
                target = next((token for token, m in room.applicants.items() if m.member_id == payload.get("target_id")), None)
                if target is None:
                    raise Conflict("这份入桌申请已处理或已撤回。")
                if route == "room/approve":
                    if len(room.members) >= room.capacity:
                        raise Conflict("真人座位已满，请先移出一位玩家再批准。")
                    member = room.applicants.pop(target)
                    member.player_id = None if room.game else len(room.members)
                    member.joined_hand = room.game.table.hand_number + 1 if room.game else 1
                    room.members[target] = member
                    room.notice = f"房主已批准 {member.name} 入桌。" + ("从下一手开始参与。" if room.game else "请准备后开局。")
                else:
                    room.applicants.pop(target)
                    self.membership.pop(target, None)
                    self.departures[target] = {"code": room.code, "message": "房主未批准本次入桌申请。"}
                room.changed(now)
                return
            if route == "room/kick":
                if sid != room.host:
                    raise Conflict("只有房主可以移出玩家。")
                target = next((token for token, member in room.members.items() if member.member_id == payload.get("target_id")), None)
                if target is None or target == sid:
                    raise Conflict("请选择房间中的其他玩家。")
                room.banned.add(target)
                self._remove_member(room, target, now, kicked=True)
                return
            if route in {"room/start", "next", "room/rematch"}:
                if route == "room/start" and room.game is not None:
                    raise Conflict("当前不在开局等候室。")
                if route == "next" and (room.game is None or not room.game.table.hand.finished or not room.can_continue()):
                    raise Conflict("当前不能准备下一手。")
                if route == "room/rematch" and (room.game is None or not room.game.table.hand.finished or room.can_continue()):
                    raise Conflict("整桌结束后才能共同确认重新组桌。")
                if sid not in room.readiness_members():
                    raise Conflict("你的筹码已用尽，可以继续观战，无需准备下一手。")
                ready = payload.get("ready", True)
                if type(ready) is not bool:
                    raise ValueError("准备状态必须是 true 或 false。")
                if ready and room.game is None and len(room.members) < 2 and not room.fill_bots:
                    raise Conflict("至少需要两位玩家，或者开启 AI 补位。")
                if ready:
                    room.ready.add(sid)
                else:
                    room.ready.discard(sid)
                room.notice = "等待所有参与玩家确认；准备后也可以取消。"
                self._advance_if_ready(room, now)
            elif route == "action":
                if room.game is None:
                    raise Conflict("大家还没有全部准备好。")
                if room.recovering:
                    raise Conflict("本手已恢复，等待玩家重连后继续。")
                player_id = room.members[sid].player_id
                if player_id is None:
                    raise Conflict("你将从下一手入座，本手请先观战。")
                room.game.table.apply_action(player_id, Action(payload.get("kind"), payload.get("amount")))
            else:
                raise Conflict("好友房的 AI 由服务器统一推进，请等待当前玩家行动。")
            room.changed(now)

    def _remove_member(self, room, sid, now, *, kicked=False):
        member = room.members.pop(sid)
        room.ready.discard(sid)
        del self.membership[sid]
        if kicked:
            self.departures[sid] = {"code": room.code, "message": "你已被房主移出房间。"}
        if not room.members:
            for applicant in room.applicants:
                self.membership.pop(applicant, None)
                self.departures[applicant] = {"code": room.code, "message": "房间已关闭，入桌申请已取消。"}
            del self.rooms[room.code]
            return
        if room.host == sid:
            room.host = next(iter(room.members))
        label = "被房主移出" if kicked else "已离开"
        room.notice = f"{member.name} {label}房间。"
        if room.game and member.player_id is not None:
            player_id = member.player_id
            room.game.strategies[player_id] = "calling_station"
            room.game.bots[player_id] = make_bot("calling_station", secrets.randbits(64))
            if room.game.table.hand.actor_id == player_id:
                room.turn_key = None
            room.notice += "该座位由 AI 接替。"
        # Membership changes preserve everyone else's consent for this same hand.
        self._advance_if_ready(room, now)
        room.changed(now)

    def _advance_if_ready(self, room, now):
        eligible = room.readiness_members()
        if (not eligible or not eligible <= room.ready or
                any(now - room.members[sid].seen > ONLINE_SECONDS for sid in eligible)):
            return False
        if room.game is None:
            if len(room.members) < 2 and not room.fill_bots:
                return False
            names = [member.name for member in room.members.values()]
            styles = ["human"] * len(names)
            if room.fill_bots:
                for i in range(room.capacity - len(names)):
                    names.append(f"{PROFILES[room.bot_strategy]['name']} AI{i + 1}")
                    styles.append(room.bot_strategy)
            game = BrowserGame()
            game.strategies, game.room = styles, "好友同桌"
            game.table = Table(names, GameConfig(), seed=secrets.randbits(64))
            game.bots = {i: make_bot(style, secrets.randbits(64)) for i, style in enumerate(styles) if style != "human"}
            game.table.start_hand()
            for i, member in enumerate(room.members.values()):
                member.player_id = i
                member.joined_hand = 1
            room.game, room.notice = game, "大家都准备好了，开始第一手。"
        elif room.game.table.hand.finished:
            if not room.can_continue():
                room.game = None
                for i, member in enumerate(room.members.values()):
                    member.player_id, member.joined_hand = i, 1
                room.notice = "大家同意重新组桌，已返回等候室。"
            else:
                game = room.game
                for sid, seat in room.seating_plan():
                    member = room.members[sid]
                    player = Player(seat, member.name, game.table.config.starting_stack)
                    if seat == len(game.table.players):
                        game.table.players.append(player)
                        game.strategies.append("human")
                    else:
                        game.table.players[seat] = player
                        game.strategies[seat] = "human"
                    game.bots.pop(seat, None)
                    game.player_wins.pop(seat, None)
                    member.player_id, member.joined_hand = seat, game.table.hand_number + 1
                room.game.table.start_hand()
                room.notice = "全员准备，新一手开始。"
        else:
            return False
        room.reset_ready()
        return True

    def tick(self):
        with self.lock:
            versions = {code: room.version for code, room in self.rooms.items()}
            self._tick()
            if self.on_change and (versions != {code: room.version for code, room in self.rooms.items()} or self.clock() - self._last_checkpoint >= 10):
                self.on_change(self)
                self._last_checkpoint = self.clock()

    def _tick(self):
        """Called by the server, never dependent on any one player's browser."""
        with self.lock:
            now = self.clock()
            for code, room in list(self.rooms.items()):
                if now - room.last_seen > 86400:
                    for sid in [*room.members, *room.applicants]:
                        self.membership.pop(sid, None)
                    del self.rooms[code]
                    continue
                if now - room.members[room.host].seen > HOST_TIMEOUT:
                    replacement = next((sid for sid, member in room.members.items()
                                        if now - member.seen <= ONLINE_SECONDS), None)
                    if replacement:
                        room.host = replacement
                        room.notice = f"原房主暂时离线，{room.members[replacement].name} 接任房主。"
                        room.changed(now)
                if room.recovering:
                    if any(now - room.members[sid].seen > ONLINE_SECONDS for sid in room.playing_members()):
                        continue
                    room.recovering = False
                    room.turn_key = None
                    room.notice = "玩家已重连，继续恢复的这一手。"
                    room.changed(now)
                if self._advance_if_ready(room, now):
                    room.changed(now)
                if room.game is None or room.game.table.hand.finished:
                    continue
                room.arm_turn(now)
                hand = room.game.table.hand
                actor = hand.actor_id
                member = next((member for member in room.members.values() if member.player_id == actor), None)
                disconnected = actor not in room.game.bots and member and now - member.seen >= DISCONNECT_SECONDS
                if now < room.deadline and not disconnected:
                    continue
                observation = hand.observe(actor)
                if actor in room.game.bots:
                    try:
                        action = room.game.bots[actor].choose_action(observation)
                    except Exception:
                        # Keep the shared table playable if an optional strategy fails.
                        action = Action("check" if observation.legal.check else "fold")
                    room.game.table.apply_action(actor, action)
                else:
                    action = Action("check" if observation.legal.check else "fold")
                    room.game.table.apply_action(actor, action)
                    label = "过牌" if action.kind == "check" else "弃牌"
                    reason = f"离线超过 {DISCONNECT_SECONDS} 秒" if disconnected else f"超过 {room.turn_seconds} 秒未操作"
                    room.notice = f"{room.game.table.players[actor].name} {reason}，自动{label}。"
                room.changed(now)
