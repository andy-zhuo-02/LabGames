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
from engine import Action, GameConfig, Table


TURN_SECONDS = 90
ONLINE_SECONDS = 8
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
    player_id: int = 0


@dataclass
class Room:
    code: str
    host: str
    capacity: int
    fill_bots: bool
    bot_strategy: str
    members: dict[str, Member] = field(default_factory=dict)
    game: BrowserGame | None = None
    version: int = 1
    last_seen: float = 0
    turn_key: tuple | None = None
    deadline: float = 0
    notice: str = ""

    def arm_turn(self, now):
        if self.game is None or self.game.table.hand.finished:
            self.turn_key, self.deadline = None, 0
            return
        hand = self.game.table.hand
        key = (hand.hand_number, len(hand.actions), hand.actor_id)
        if key != self.turn_key:
            self.turn_key = key
            self.deadline = now + (BOT_DELAY if hand.actor_id in self.game.bots else TURN_SECONDS)

    def changed(self, now):
        self.version += 1
        self.last_seen = now
        if self.game:
            self.game._account_result()
        self.arm_turn(now)


class RoomRegistry:
    def __init__(self, *, clock=time.monotonic):
        self.lock = threading.RLock()
        self.rooms = {}
        self.membership = {}
        self.clock = clock

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

    def snapshot(self, sid):
        with self.lock:
            if sid not in self.membership:
                return None
            now = self.clock()
            room = self._room(sid)
            room.members[sid].seen = room.last_seen = now
            viewer = room.members[sid]
            if room.game:
                snapshot = room.game.snapshot(viewer.player_id, multiplayer=True)
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
            can_start = room.game is None and (len(room.members) >= 2 or room.fill_bots)
            snapshot["room_info"] = {
                "code": room.code, "capacity": room.capacity, "fill_bots": room.fill_bots,
                "bot_style": PROFILES[room.bot_strategy]["style"],
                "is_host": room.host == sid, "host_name": room.members[room.host].name,
                "can_start": can_start and room.host == sid,
                "members": [{"name": member.name, "is_you": token == sid, "is_host": token == room.host,
                             "online": now - member.seen <= ONLINE_SECONDS}
                            for token, member in room.members.items()],
                "turn_seconds": TURN_SECONDS,
                "remaining_seconds": max(0, math.ceil(room.deadline - now)) if room.deadline else 0,
                "notice": room.notice,
            }
            return snapshot

    def perform(self, sid, route, payload):
        with self.lock:
            now = self.clock()
            if route == "room/create":
                if sid in self.membership:
                    raise Conflict("请先退出当前好友房间。")
                name = self._name(payload)
                capacity = payload.get("capacity", 4)
                fill = payload.get("fill_bots", True)
                style = payload.get("bot_strategy", "calling_station")
                if type(capacity) is not int or not 2 <= capacity <= 6:
                    raise ValueError("好友房支持 2 至 6 个座位。")
                if type(fill) is not bool or not isinstance(style, str) or style not in STRATEGIES:
                    raise ValueError("请选择有效的 AI 补位设置。")
                if len(self.rooms) >= 64:
                    raise Conflict("当前房间太多，请稍后再试。")
                code = self._new_code()
                room = Room(code, sid, capacity, fill, style, last_seen=now)
                room.members[sid] = Member(name, now)
                self.rooms[code], self.membership[sid] = room, code
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
                if room.game:
                    raise Conflict("这桌已经开局，请等房主返回等候室后再加入。")
                if len(room.members) >= room.capacity:
                    raise Conflict("这间房已满。")
                name = self._name(payload)
                if any(member.name == name for member in room.members.values()):
                    raise Conflict("房间里已有同名牌友，请换个昵称。")
                room.members[sid] = Member(name, now, len(room.members))
                self.membership[sid] = code
                room.changed(now)
                return
            room = self._room(sid)
            if (payload.get("room_code") != room.code or type(payload.get("version")) is not int
                    or payload["version"] != room.version):
                raise Conflict("房间已更新，请按当前画面操作。")
            room.members[sid].seen = room.last_seen = now
            if route == "room/leave":
                member = room.members.pop(sid)
                del self.membership[sid]
                if not room.members:
                    del self.rooms[room.code]
                    return
                if room.host == sid:
                    room.host = next(iter(room.members))
                if room.game:
                    player_id = member.player_id
                    room.game.strategies[player_id] = "calling_station"
                    room.game.bots[player_id] = make_bot("calling_station", secrets.randbits(64))
                    room.turn_key = None
                    room.notice = f"{member.name} 已离开，由 AI 接替该座位。"
                else:
                    room.notice = f"{member.name} 已离开房间。"
                room.changed(now)
                return
            if route == "room/start":
                if sid != room.host or room.game is not None:
                    raise Conflict("只有房主可以在等候室开始游戏。")
                names = [member.name for member in room.members.values()]
                if not room.fill_bots and len(names) < 2:
                    raise Conflict("至少需要两位玩家，或者开启 AI 补位。")
                styles = ["human"] * len(names)
                if room.fill_bots:
                    for i in range(room.capacity - len(names)):
                        names.append(f"{PROFILES[room.bot_strategy]['name']} AI{i + 1}")
                        styles.append(room.bot_strategy)
                game = BrowserGame()
                game.strategies = styles
                game.room = "好友同桌"
                game.table = Table(names, GameConfig(), seed=secrets.randbits(64))
                game.bots = {i: make_bot(style, secrets.randbits(64)) for i, style in enumerate(styles) if style != "human"}
                game.table.start_hand()
                for i, member in enumerate(room.members.values()):
                    member.player_id = i
                room.game, room.notice = game, "朋友到齐，开始第一手。"
            elif route == "action":
                if room.game is None:
                    raise Conflict("房主还没有开始发牌。")
                player_id = room.members[sid].player_id
                room.game.table.apply_action(player_id, Action(payload.get("kind"), payload.get("amount")))
            elif route == "next":
                if sid != room.host:
                    raise Conflict("请等待房主发下一手牌。")
                if room.game is None or not room.game.table.hand.finished or room.game.table.winner:
                    raise Conflict("当前不能开始下一手。")
                room.game.table.start_hand()
                room.notice = "新一手开始。"
            elif route == "room/rematch":
                if sid != room.host or room.game is None or room.game.table.winner is None:
                    raise Conflict("整桌结束后，房主可以返回等候室。")
                room.game = None
                room.notice = "已返回等候室，可以邀请新朋友。下一局每人恢复 2,000 筹码。"
            else:
                raise Conflict("好友房的 AI 由服务器统一推进，请等待当前玩家行动。")
            room.changed(now)

    def tick(self):
        """Called by the server, never dependent on any one player's browser."""
        with self.lock:
            now = self.clock()
            for code, room in list(self.rooms.items()):
                if now - room.last_seen > 86400:
                    for sid in room.members:
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
                if room.game is None or room.game.table.hand.finished:
                    continue
                room.arm_turn(now)
                if now < room.deadline:
                    continue
                hand = room.game.table.hand
                actor = hand.actor_id
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
                    room.notice = f"{room.game.table.players[actor].name} 超过 {TURN_SECONDS} 秒未操作，自动{label}。"
                room.changed(now)
