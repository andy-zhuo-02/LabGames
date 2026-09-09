"""Durable checkpoints, interrupted hands, identity and reconnect behavior."""

from http.client import HTTPConnection
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from bots import STRATEGIES, make_bot, passive_action
from browser_game import BrowserGame, Conflict
from engine import Action, Table
from game_storage import SaveStore, dump_bot, dump_game, dump_room, restore_bot, restore_game, restore_room
from multiplayer import RoomRegistry
from test_multiplayer import Client, Clock
from test_poker import check_down, fixed_deck
from web_app import PokerServer


def json_copy(value):
    return json.loads(json.dumps(value))


def view(game):
    return {key: value for key, value in game.snapshot().items() if key != "version"}


class GameStorageTests(unittest.TestCase):
    def game(self, stacks=(2000, 2000, 2000), deck=None):
        game = BrowserGame()
        game.strategies = ["human"] * len(stacks)
        game.table = Table([f"P{i}" for i in range(len(stacks))], stacks=stacks, seed=42)
        game.table.start_hand(deck=deck)
        game._account_result()
        return game

    def restore(self, game):
        restored = restore_game(json_copy(dump_game(game)))
        self.assertEqual(view(restored), view(game))
        self.assertEqual(restored.version, game.version + 1)
        return restored

    def test_in_progress_fixed_deck_replays_cards_actions_and_future_runout(self):
        game = self.game(deck=fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        for _ in range(4):
            actor = game.table.hand.actor_id
            game.table.apply_action(actor, passive_action(game.table.hand.observe(actor)))
        restored = self.restore(game)
        self.assertEqual(len(restored.table.hand.actions), 4)
        for candidate in (game, restored):
            check_down(candidate.table)
            candidate._account_result()
        self.assertEqual(view(restored), view(game))
        self.assertEqual(game.table.hand.board, ("2c", "3h", "7d", "9s", "Tc"))

    def test_side_pots_and_completed_hand_are_not_settled_twice(self):
        game = self.game((50, 100, 150), fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        while not game.table.hand.finished:
            game.table.apply_action(game.table.hand.actor_id, Action("all_in"))
        game._account_result()
        restored = self.restore(game)
        for _ in range(3):
            restored._account_result()
        self.assertEqual(view(restored), view(game))
        self.assertGreater(len(game.table.hand.result().payouts), 1)
        self.assertEqual(sum(p.stack for p in restored.table.players), 300)

    def test_finished_match_and_blind_only_finish_restore(self):
        for stacks in ((20, 20), (5, 5)):
            with self.subTest(stacks=stacks):
                game = self.game(stacks, fixed_deck(["AsAd", "KsKd"], "2c3h7d9sTc"))
                check_down(game.table)
                game._account_result()
                self.assertIsNotNone(game.table.winner)
                self.restore(game)

    def test_restore_preserves_next_deal_positions_and_shuffle_rng(self):
        game = self.game()
        for _ in range(3):
            check_down(game.table)
            game._account_result()
            restored = self.restore(game)
            for candidate in (game, restored):
                candidate.table.start_hand()
            self.assertEqual(view(restored), view(game))
            self.assertEqual(restored.table.hand._initial_deck, game.table.hand._initial_deck)

    def test_eliminated_seats_survive_replay(self):
        game = self.game((0, 2000, 2000))
        check_down(game.table)
        game._account_result()
        restored = self.restore(game)
        self.assertEqual(restored.table.players[0].stack, 0)
        self.assertFalse(restored.snapshot()["players"][0]["cards"])

    def test_all_bot_rng_and_equity_cache_resume(self):
        game = self.game()
        observation = game.table.hand.observe(game.table.hand.actor_id)
        for style in STRATEGIES:
            with self.subTest(style=style):
                bot = make_bot(style, 91, equity_samples=8)
                bot.choose_action(observation)
                restored = make_bot(style, 0)
                restore_bot(restored, json_copy(dump_bot(bot)))
                for _ in range(3):
                    self.assertEqual(bot.choose_action(observation), restored.choose_action(observation))
                self.assertEqual(json_copy(dump_bot(bot)), json_copy(dump_bot(restored)))

    def test_solo_bot_game_roundtrip_and_invalid_stacks_refused(self):
        game = BrowserGame()
        game.start({"opponents": ["random", "push_fold", "equity"]})
        self.restore(game)
        data = json_copy(dump_game(game))
        data["table"]["players"][0]["stack"] += 1
        with self.assertRaisesRegex(ValueError, "筹码"):
            restore_game(data)


class SaveStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "table.sqlite3"

    def test_reopen_permissions_and_exclusive_writer(self):
        store = SaveStore(self.path)
        try:
            store.write("room", {"ABCDEF": {"name": "玩家"}})
            with self.assertRaises(OSError):
                SaveStore(self.path)
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        finally:
            store.close()
        restored = SaveStore(self.path)
        try:
            self.assertEqual(restored.read("room"), {"ABCDEF": {"name": "玩家"}})
        finally:
            restored.close()

    def test_failed_replacement_rolls_back_deletion(self):
        store = SaveStore(self.path)
        try:
            store.write("room", {"old": {"chips": 2000}})
            store.connection.execute("CREATE TRIGGER fail_save BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(FAIL, 'disk failure'); END")
            with self.assertRaises(sqlite3.Error):
                store.write("room", {"new": {"chips": 1900}}, replace=True)
            self.assertEqual(store.read("room"), {"old": {"chips": 2000}})
        finally:
            store.close()

    def test_unknown_version_and_corrupt_file_are_preserved(self):
        store = SaveStore(self.path)
        store.write("room", {"old": {"chips": 2000}})
        store.connection.execute("PRAGMA user_version=999")
        store.close()
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            SaveStore(self.path)
        self.assertEqual(self.path.read_bytes(), before)
        self.path.write_bytes(b"not a valid database")
        with self.assertRaises(sqlite3.Error):
            SaveStore(self.path)
        self.assertEqual(self.path.read_bytes(), b"not a valid database")


class ReconnectTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.registry = RoomRegistry(clock=self.clock)
        self.registry.perform("host", "room/create", {"name": "房主", "capacity": 3, "fill_bots": False, "turn_seconds": 30})
        self.code = self.registry.membership["host"]
        self.registry.perform("friend", "room/join", {"code": self.code, "name": "朋友"})

    def command(self, sid, route, **payload):
        state = self.registry.snapshot(sid)
        self.registry.perform(sid, route, {"version": state["version"], "room_code": self.code,
                                          "round_id": state["room_info"]["round_id"], **payload})

    def start(self):
        self.command("host", "room/start")
        self.command("friend", "room/start")

    def restart(self):
        saved = json_copy(dump_room(self.registry.rooms[self.code], self.clock()))
        room = restore_room(saved, self.clock())
        self.registry = RoomRegistry(clock=self.clock)
        self.registry.rooms[self.code] = room
        self.registry.membership = {sid: self.code for sid in room.members}
        return room

    def test_all_ready_but_offline_explains_wait_and_preserves_votes(self):
        self.command("friend", "room/start")
        self.clock.advance(9)
        self.command("host", "room/start")
        state = self.registry.snapshot("host")
        info = state["room_info"]
        self.assertEqual((info["ready_count"], info["ready_total"]), (2, 2))
        self.assertEqual(info["waiting_for_connection"], ["朋友"])
        self.assertEqual(info["waiting_for_ready"], [])
        self.assertEqual(info["waiting_message"], "等待 朋友 重连")
        self.assertEqual(state["phase"], "waiting")
        self.registry.snapshot("friend")
        self.registry.tick()
        self.assertEqual(self.registry.snapshot("host")["phase"], "playing")

    def test_unready_and_offline_are_separate_and_ready_survives_restart(self):
        self.command("host", "room/start")
        self.assertEqual(self.registry.snapshot("host")["room_info"]["waiting_for_ready"], ["朋友"])
        room = self.restart()
        self.assertEqual(room.ready, {"host"})
        info = self.registry.snapshot("host")["room_info"]
        self.assertEqual(info["waiting_for_connection"], ["朋友"])
        self.assertFalse(info["waiting_for_ready"])

    def test_active_restore_pauses_until_everyone_reconnects_then_full_timer(self):
        self.start()
        before = self.registry.snapshot("host")
        room = self.restart()
        self.clock.advance(150)
        self.registry.snapshot("host")
        self.registry.tick()
        self.assertTrue(room.recovering)
        self.assertEqual(self.registry.snapshot("host")["actions"], before["actions"])
        self.assertEqual(room.deadline, 0)
        with self.assertRaises(Conflict):
            self.command("host", "action", kind="call")
        self.registry.snapshot("friend")
        self.registry.tick()
        self.assertFalse(room.recovering)
        self.assertEqual(room.deadline - self.clock(), 30)
        self.clock.advance(25.3)
        for sid in room.members:
            self.registry.snapshot(sid)
        info = self.registry.snapshot("host")["room_info"]
        self.assertEqual(info["remaining_seconds"], 5)
        self.assertEqual(info["remaining_ms"], 4700)

    def test_host_can_remove_absent_member_after_restore(self):
        self.start()
        room = self.restart()
        self.command("host", "room/kick", target_id=room.members["friend"].member_id)
        self.registry.tick()
        self.assertFalse(room.recovering)
        self.assertIn(1, room.game.bots)
        again = self.restart()
        self.assertIn("friend", again.banned)
        self.assertNotIn("friend", again.members)


class PersistentHTTPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "table.sqlite3"
        self.launch(0)
        self.host, self.friend = Client(self.server.server_port), Client(self.server.server_port)
        _, state = self.host.request("room/create", {"name": "房主", "capacity": 2, "fill_bots": False, "turn_seconds": 30})
        self.code = state["room_info"]["code"]
        self.assertEqual(self.friend.request("room/join", {"name": "朋友", "code": self.code})[0], 200)

    def launch(self, port):
        self.server = PokerServer(("127.0.0.1", port), save_path=self.path)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()

    def stop(self, abrupt=False):
        self.server.shutdown()
        self.thread.join(timeout=2)
        if abrupt:
            # Simulate process loss without the final server_close checkpoint.
            self.server.store.close()
            self.server.store = None
        self.server.server_close()

    def restart(self):
        port = self.server.server_port
        self.stop(abrupt=True)
        self.launch(port)

    def tearDown(self):
        self.stop()
        self.directory.cleanup()

    def wait_resumed(self):
        self.host.request()
        self.friend.request()
        for _ in range(100):
            _, state = self.host.request()
            if not state["room_info"]["recovering"]:
                return state
            time.sleep(.01)
        self.fail("Room did not resume after both clients reconnected")

    def test_restart_same_cookies_private_hand_and_stale_request_rejected(self):
        self.assertEqual(self.host.command("room/start")[0], 200)
        self.assertEqual(self.friend.command("room/start")[0], 200)
        self.assertEqual(self.friend.command("action", kind="call")[0], 200)
        before = [self.host.request()[1], self.friend.request()[1]]
        self.assertIn(self.code, self.server.store.read("room"))
        self.restart()
        recovered = self.host.request()[1]
        self.assertTrue(recovered["room_info"]["recovering"])
        self.assertEqual(recovered["room_info"]["waiting_for_connection"], ["朋友"])
        self.assertNotEqual(recovered["server_id"], before[0]["server_id"])
        status, rejected = self.host.request("action", {"server_id": before[0]["server_id"], "version": before[0]["version"], "room_code": self.code, "kind": "check"})
        self.assertEqual(status, 409)
        self.assertEqual(rejected["state"]["actions"], before[0]["actions"])
        self.wait_resumed()
        for index, client in enumerate((self.host, self.friend)):
            current = client.request()[1]
            self.assertEqual(current["viewer_id"], index)
            self.assertEqual(current["players"], before[index]["players"])
            self.assertEqual(current["actions"], before[index]["actions"])
            self.assertEqual([bool(p["cards"]) for p in current["players"]], [index == 0, index == 1])
            self.assertNotIn("deck", json.dumps(current))
            self.assertNotIn("seed", json.dumps(current))
            self.assertTrue(current["storage"]["enabled"] and current["storage"]["ok"])
        self.assertEqual(self.host.command("action", kind="check")[0], 200)

    def test_finished_hand_ready_vote_and_history_survive_without_double_payout(self):
        self.host.command("room/start")
        self.friend.command("room/start")
        self.friend.command("action", kind="fold")
        self.host.command("next")
        before = self.host.request()[1]
        self.restart()
        after = self.host.request()[1]
        self.assertEqual(after["phase"], "finished")
        self.assertTrue(after["room_info"]["ready"])
        self.assertEqual(after["stats"], before["stats"])
        self.assertEqual(after["history"], before["history"])
        self.assertEqual(after["result"], before["result"])
        self.assertEqual(self.friend.command("next")[0], 200)
        self.assertEqual(self.host.request()[1]["hand_number"], 2)

    def test_save_failure_visible_then_retry_and_deleted_room_stays_deleted(self):
        with patch.object(self.server.store, "write", side_effect=sqlite3.OperationalError("test disk full")):
            status, state = self.host.command("room/start")
        self.assertEqual(status, 200)
        self.assertFalse(state["storage"]["ok"])
        self.assertIn("暂时不要关闭", state["storage"]["error"])
        status, state = self.host.command("room/start", ready=False)
        self.assertTrue(state["storage"]["ok"])
        self.assertEqual(self.friend.command("room/leave")[0], 200)
        self.assertEqual(self.host.command("room/leave")[0], 200)
        self.restart()
        self.assertFalse(self.server.rooms.rooms)
        self.assertEqual(self.host.request()[1]["phase"], "lobby")

    def test_solo_session_survives_server_restart(self):
        solo = Client(self.server.server_port)
        self.assertEqual(solo.command("new", opponents=["calling_station"])[0], 200)
        before = solo.request()[1]
        self.restart()
        after = solo.request()[1]
        for key in ("players", "actions", "actor_id", "board", "history", "stats", "legal"):
            self.assertEqual(after[key], before[key])

    def test_private_save_files_cannot_be_downloaded(self):
        for path in ("/.poker-data/table.sqlite3", "/game_storage.py", "/../game_storage.py"):
            connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            connection.request("GET", path)
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
            connection.close()

    def test_invalid_checkpoint_stops_startup_without_overwriting_file(self):
        self.stop()
        broken_path = Path(self.directory.name) / "broken.sqlite3"
        store = SaveStore(broken_path)
        store.write("room", {"ABCDEF": {"last_seen": time.time()}})
        store.close()
        original = broken_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "存档内容"):
            PokerServer(("127.0.0.1", 0), save_path=broken_path)
        self.assertEqual(original, broken_path.read_bytes())
        self.launch(self.host.port)


if __name__ == "__main__":
    unittest.main()
