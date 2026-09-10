"""Private, versioned SQLite checkpoints. Never serve this data to a browser."""

from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import threading
import time

from bots import make_bot
from browser_game import BrowserGame
from engine import Action, GameConfig, Hand, Player, Table
from multiplayer import DISCONNECT_SECONDS, Member, Room


def tuples(value):
    return tuple(map(tuples, value)) if isinstance(value, list) else value


def dump_bot(bot):
    data = {}
    for key in ("rng", "deep_stack_bot", "samples", "_cache_key", "_cached_equity"):
        if hasattr(bot, key):
            value = getattr(bot, key)
            data[key] = value.getstate() if key == "rng" else dump_bot(value) if key == "deep_stack_bot" else value
    return data


def restore_bot(bot, data):
    for key, value in data.items():
        if key == "rng":
            bot.rng.setstate(tuples(value))
        elif key == "deep_stack_bot":
            restore_bot(bot.deep_stack_bot, value)
        elif key in ("samples", "_cache_key", "_cached_equity"):
            setattr(bot, key, tuples(value))


def dump_game(game):
    data = {key: getattr(game, key) for key in ("version", "completed", "wins", "player_wins", "history", "room", "strategies")}
    data["bots"] = {i: dump_bot(bot) for i, bot in game.bots.items()}
    data["table"] = None
    if game.table:
        table, hand = game.table, game.table.hand
        data["table"] = {
            "config": asdict(table.config), "players": [asdict(p) for p in table.players],
            "seed": table.seed, "rng": table._rng.getstate(), "button": table.button_id,
            "previous_bb": table._previous_bb, "hand_number": table.hand_number,
            "hand": {"players": [asdict(p) for p in hand.players], "seed": hand.seed,
                     "deck": hand._initial_deck, "actions": [{"player_id": a.player_id, "action": asdict(a.action)} for a in hand.actions],
                     "finished": hand.finished},
        }
    return data


def restore_game(data):
    game = BrowserGame()
    for key in ("version", "completed", "wins", "history", "room", "strategies"):
        setattr(game, key, data[key])
    game.version += 1  # Reject requests sent before this restart.
    game.player_wins = {int(i): count for i, count in data["player_wins"].items()}
    game.history = [{**row, "payoffs": {int(i): amount for i, amount in row["payoffs"].items()}} for row in game.history]
    saved = data["table"]
    if saved:
        hand_data = saved["hand"]
        players = [Player(**p) for p in saved["players"]]
        initial = {p["player_id"]: Player(**p) for p in hand_data["players"]}
        base = [initial.get(p.player_id, p) for p in players]
        config = GameConfig(**saved["config"])
        table = Table([p.name for p in base], config, stacks=[p.stack for p in base], seed=saved["seed"])
        table.hand_number, table.button_id, table._previous_bb = saved["hand_number"], saved["button"], saved["previous_bb"]
        table._rng.setstate(tuples(saved["rng"]))
        table.hand = Hand(list(initial.values()), config, table.hand_number, hand_data["seed"], deck="".join(hand_data["deck"]))
        table._settle()
        for record in hand_data["actions"]:
            table.apply_action(record["player_id"], Action(**record["action"]))
        if table.players != players or table.hand.finished != hand_data["finished"]:
            raise ValueError("存档重建后的筹码或结算状态不一致。")
        game.table = table
        game.bots = {int(i): make_bot(game.strategies[int(i)], 0) for i in data["bots"]}
        for i, bot in game.bots.items():
            restore_bot(bot, data["bots"].get(str(i), data["bots"].get(i)))
    return game


def dump_room(room, now):
    data = {key: getattr(room, key) for key in ("code", "host", "capacity", "fill_bots", "bot_strategy", "turn_seconds", "version", "round_id", "notice")}
    data.update(ready=sorted(room.ready), banned=sorted(room.banned), last_seen=time.time() - (now - room.last_seen))
    for key in ("members", "applicants"):
        data[key] = {sid: {"name": m.name, "player_id": m.player_id, "member_id": m.member_id, "joined_hand": m.joined_hand}
                     for sid, m in getattr(room, key).items()}
    data["game"] = dump_game(room.game) if room.game else None
    return data


def restore_room(data, now):
    room = Room(**{key: data[key] for key in ("code", "host", "capacity", "fill_bots", "bot_strategy", "turn_seconds", "version", "round_id", "notice")})
    room.version += 1
    room.last_seen = now - max(0, time.time() - data["last_seen"])
    room.members = {sid: Member(**member, seen=now - DISCONNECT_SECONDS - 1) for sid, member in data["members"].items()}
    room.applicants = {sid: Member(**member, seen=now - DISCONNECT_SECONDS - 1) for sid, member in data.get("applicants", {}).items()}
    if room.members.keys() & room.applicants.keys():
        raise ValueError("存档中的申请者与成员重复。")
    room.ready, room.banned = set(data["ready"]), set(data["banned"])
    if room.host not in room.members or not room.ready <= room.members.keys():
        raise ValueError("存档中的房间成员不一致。")
    room.game = restore_game(data["game"]) if data["game"] else None
    room.recovering = bool(room.game and not room.game.table.hand.finished)
    room.notice = "牌局已从存档恢复。" + ("等待玩家重连后继续本手。" if room.recovering else "已保留筹码和准备状态。")
    return room


class SaveStore:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.path = path
        self.guard = open(str(path) + ".lock", "a")
        os.chmod(str(path) + ".lock", 0o600)
        try:
            fcntl.flock(self.guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.connection = sqlite3.connect(path, check_same_thread=False)
            os.chmod(path, 0o600)
            version = self.connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("存档版本不兼容，已保留原文件。")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("CREATE TABLE IF NOT EXISTS checkpoints (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id))")
            if version == 0:
                self.connection.execute("PRAGMA user_version=1")
            self.connection.commit()
        except Exception:
            if hasattr(self, "connection"):
                self.connection.close()
            self.guard.close()
            raise

    def read(self, kind):
        with self.lock:
            return {key: json.loads(value) for key, value in self.connection.execute("SELECT id,payload FROM checkpoints WHERE kind=?", (kind,))}

    def write(self, kind, records, *, replace=False):
        rows = [(kind, key, json.dumps(value, ensure_ascii=False, allow_nan=False)) for key, value in records.items()]
        with self.lock, self.connection:
            if replace:
                self.connection.execute("DELETE FROM checkpoints WHERE kind=?", (kind,))
            self.connection.executemany("INSERT OR REPLACE INTO checkpoints VALUES (?,?,?)", rows)

    def delete(self, kind, key):
        with self.lock, self.connection:
            self.connection.execute("DELETE FROM checkpoints WHERE kind=? AND id=?", (kind, key))

    def close(self):
        with self.lock:
            self.connection.close()
            self.guard.close()
