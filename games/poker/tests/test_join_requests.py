"""Host approval, safe seat changes between hands, and durable admission."""

import json
import unittest

from bots import passive_action
from browser_game import Conflict
from engine import Action, GameConfig, Table
from game_storage import dump_room, restore_room
from multiplayer import BOT_DELAY, RoomRegistry
from test_multiplayer import Client, Clock
from test_poker import fixed_deck
import test_storage as storage_tests


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.registry = RoomRegistry(clock=self.clock)
        self.registry.perform("host", "room/create", {"name": "房主", "capacity": 4, "fill_bots": False})
        self.code = self.registry.membership["host"]
        self.join("friend")

    @property
    def room(self):
        return self.registry.rooms[self.code]

    def command(self, sid, route, **payload):
        state = self.registry.snapshot(sid)
        self.registry.perform(sid, route, {"room_code": self.code, "version": state["version"],
                                          "round_id": state["room_info"].get("round_id"), **payload})

    def apply(self, sid):
        self.registry.perform(sid, "room/join", {"name": sid, "code": self.code})
        return self.room.applicants[sid].member_id

    def join(self, sid):
        target = self.apply(sid)
        self.command(self.room.host, "room/approve", target_id=target)

    def prepare(self, route):
        for sid in list(self.room.readiness_members()):
            self.command(sid, route, ready=True)

    def start(self):
        self.prepare("room/start")

    def finish(self):
        while not self.room.game.table.hand.finished:
            hand = self.room.game.table.hand
            self.room.game.table.apply_action(hand.actor_id, passive_action(hand.observe(hand.actor_id)))
            self.room.changed(self.clock())

    def restore(self):
        before = self.room
        after = restore_room(json.loads(json.dumps(dump_room(before, self.clock()))), self.clock())
        self.registry = RoomRegistry(clock=self.clock)
        self.registry.rooms[self.code] = after
        self.registry.membership = {sid: self.code for sid in [*after.members, *after.applicants]}
        return after

    def test_applicant_gets_no_table_data_and_only_host_sees_queue(self):
        self.start()
        target = self.apply("newcomer")
        state = self.registry.snapshot("newcomer")
        self.assertEqual(state["phase"], "pending")
        self.assertFalse({"players", "board", "legal", "history", "actions", "result"} & state.keys())
        self.assertNotIn("members", state["room_info"])
        self.assertEqual(self.registry.snapshot("friend")["room_info"]["applications"], [])
        self.assertEqual(self.registry.snapshot("host")["room_info"]["applications"][0]["id"], target)
        for route in ("action", "room/start", "next", "room/kick", "room/approve"):
            with self.subTest(route=route), self.assertRaises(Conflict):
                self.command("newcomer", route, kind="call", target_id=target)
        self.assertNotIn("newcomer", self.room.members)

    def test_approval_and_kick_ignore_action_revision_but_enforce_current_host(self):
        self.start()
        target = self.apply("newcomer")
        stale = self.registry.snapshot("host")["version"]
        deadline = self.room.deadline
        self.command("friend", "action", kind="call")
        for route in ("room/approve", "room/reject"):
            with self.assertRaises(Conflict):
                self.command("friend", route, target_id=target)
        self.registry.perform("host", "room/approve", {"room_code": self.code, "version": stale, "target_id": target})
        self.assertEqual(self.room.deadline, deadline)
        self.assertIsNone(self.room.members["newcomer"].player_id)
        with self.assertRaises(Conflict):
            self.command("host", "room/approve", target_id=target)
        self.registry.perform("host", "room/kick", {"room_code": self.code, "version": stale, "target_id": self.room.members["friend"].member_id})
        self.assertNotIn("friend", self.room.members)
        self.assertIn(1, self.room.game.bots)

    def test_rejection_withdrawal_and_duplicate_request_keep_ready_votes(self):
        self.command("host", "room/start")
        target = self.apply("newcomer")
        self.registry.perform("newcomer", "room/join", {"code": self.code})
        self.assertEqual(len(self.room.applicants), 1)
        self.command("newcomer", "room/leave")
        with self.assertRaises(Conflict):
            self.command("host", "room/approve", target_id=target)
        target = self.apply("newcomer")
        self.command("host", "room/reject", target_id=target)
        self.assertIsNone(self.registry.snapshot("newcomer"))
        self.assertIn("未批准", self.registry.departure("newcomer")["message"])
        self.assertEqual(self.room.ready, {"host"})
        self.join("newcomer")
        self.assertEqual(self.room.ready, {"host"})

    def test_new_player_waits_for_boundary_and_gets_fresh_chips_and_cards(self):
        self.start()
        before = self.registry.snapshot("host")
        deadline = self.room.deadline
        self.join("newcomer")
        waiting = self.registry.snapshot("newcomer")
        self.assertIsNone(waiting["viewer_id"])
        self.assertTrue(waiting["room_info"]["waiting_for_seat"])
        self.assertTrue(all(not p["cards"] for p in waiting["players"]))
        self.assertEqual(waiting["stats"], {"hands": 0, "wins": 0, "profit": 0})
        self.assertEqual(self.registry.snapshot("host")["players"], before["players"])
        self.assertEqual(self.room.deadline, deadline)
        with self.assertRaisesRegex(Conflict, "下一手"):
            self.command("newcomer", "action", kind="call")
        self.finish()
        self.command("host", "next")
        self.command("friend", "next")
        self.assertEqual(self.room.game.table.hand_number, 1)
        self.command("newcomer", "next")
        state = self.registry.snapshot("newcomer")
        seat = state["viewer_id"]
        self.assertEqual(state["hand_number"], 2)
        self.assertEqual(state["players"][seat]["stack"] + state["players"][seat]["bet"], 2000)
        self.assertEqual(len(state["players"][seat]["cards"]), 2)
        self.assertTrue(all(not p["cards"] for p in state["players"] if p["id"] != seat))
        self.assertEqual(state["history"], [])
        self.assertEqual(sum(p.stack for p in self.room.game.table.players), 6000)
        self.finish()
        self.assertEqual(self.registry.snapshot("newcomer")["stats"]["hands"], 1)

    def test_full_ai_table_replaces_bot_only_after_settlement(self):
        self.room.fill_bots = True
        self.start()
        self.join("newcomer")
        self.assertEqual(len(self.room.game.bots), 2)
        self.finish()
        plan = dict(self.room.seating_plan())
        seat = plan["newcomer"]
        old_stack = self.room.game.table.players[seat].stack
        total = sum(p.stack for p in self.room.game.table.players)
        self.prepare("next")
        self.assertEqual(len(self.room.game.table.players), 4)
        self.assertNotIn(seat, self.room.game.bots)
        self.assertEqual(self.room.game.table.players[seat].name, "newcomer")
        self.assertEqual(sum(p.stack for p in self.room.game.table.players), total - old_stack + 2000)
        self.assertEqual(self.room.game.player_wins.get(seat, 0), 0)
        self.restore()
        self.assertEqual(self.room.game.table.players[seat].name, "newcomer")
        self.assertEqual(len(self.registry.snapshot("newcomer")["players"][seat]["cards"]), 2)

    def test_full_human_table_queues_until_host_makes_space(self):
        self.room.capacity = 2
        self.start()
        target = self.apply("newcomer")
        with self.assertRaisesRegex(Conflict, "座位已满"):
            self.command("host", "room/approve", target_id=target)
        self.assertIn("newcomer", self.room.applicants)
        self.command("host", "room/kick", target_id=self.room.members["friend"].member_id)
        self.assertLessEqual(self.room.deadline - self.clock(), BOT_DELAY)
        self.command("host", "room/approve", target_id=target)
        self.assertTrue(all(not p["cards"] for p in self.registry.snapshot("newcomer")["players"]))
        self.finish()
        self.prepare("next")
        self.assertEqual(self.room.members["newcomer"].player_id, 1)
        self.assertEqual(self.room.game.strategies[1], "human")

    def test_multiple_approvals_share_revision_without_overbooking(self):
        self.room.capacity = 3
        self.start()
        first, second = self.apply("first"), self.apply("second")
        payload = {"room_code": self.code, "version": self.room.version}
        self.registry.perform("host", "room/approve", {**payload, "target_id": first})
        with self.assertRaisesRegex(Conflict, "座位已满"):
            self.registry.perform("host", "room/approve", {**payload, "target_id": second})
        self.assertEqual(len(self.room.members), 3)
        self.assertIn("second", self.room.applicants)
        self.command("first", "room/leave")
        self.registry.perform("host", "room/approve", {**payload, "target_id": second})
        self.finish()
        self.prepare("next")
        self.assertEqual(len(self.room.game.table.players), 3)
        self.assertEqual(self.room.game.table.players[2].name, "second")

    def test_multiple_waiting_players_receive_distinct_new_seats(self):
        self.start()
        self.join("first")
        self.join("second")
        self.finish()
        self.prepare("next")
        self.assertEqual({self.room.members[sid].player_id for sid in ("first", "second")}, {2, 3})
        self.assertEqual(sum(p.stack for p in self.room.game.table.players), 8000)
        self.restore()
        for sid in ("first", "second"):
            state = self.registry.snapshot(sid)
            self.assertEqual([p["id"] for p in state["players"] if p["cards"]], [state["viewer_id"]])

    def test_old_save_without_admission_fields_still_restores(self):
        self.start()
        saved = json.loads(json.dumps(dump_room(self.room, self.clock())))
        saved.pop("applicants")
        for member in saved["members"].values():
            member.pop("joined_hand")
        room = restore_room(saved, self.clock())
        self.assertEqual(room.applicants, {})
        self.assertEqual(room.members["friend"].joined_hand, 1)
        self.assertTrue(room.recovering)

    def test_removing_unseated_member_never_creates_an_ai_with_no_seat(self):
        self.start()
        self.join("newcomer")
        deadline = self.room.deadline
        self.command("host", "room/kick", target_id=self.room.members["newcomer"].member_id)
        self.assertNotIn(None, self.room.game.bots)
        self.assertEqual(self.room.deadline, deadline)
        self.finish()
        self.prepare("next")
        self.assertEqual(len(self.room.game.table.players), 2)

    def test_queue_and_waiting_seats_survive_restart_without_blocking_current_hand(self):
        self.start()
        self.join("newcomer")
        request_id = self.apply("another")
        self.restore()
        self.assertEqual(self.registry.snapshot("another")["phase"], "pending")
        self.assertEqual(self.room.applicants["another"].member_id, request_id)
        for sid in ("host", "friend"):
            self.registry.snapshot(sid)
        self.registry.tick()
        self.assertFalse(self.room.recovering, "Unseated applicants must not block an existing hand")
        self.assertIsNone(self.room.members["newcomer"].player_id)
        self.assertEqual(self.registry.snapshot("newcomer")["history"], [])

    def test_requests_follow_host_transfer_and_close_with_room(self):
        target = self.apply("newcomer")
        self.command("host", "room/leave")
        self.assertTrue(self.registry.snapshot("friend")["room_info"]["is_host"])
        self.assertEqual(self.registry.snapshot("friend")["room_info"]["applications"][0]["id"], target)
        self.command("friend", "room/leave")
        self.assertFalse(self.registry.membership)
        self.assertIn("房间已关闭", self.registry.departure("newcomer")["message"])

    def test_new_buyin_can_continue_after_previous_last_player_won(self):
        self.start()
        self.room.game.table = Table(["房主", "friend"], GameConfig(starting_stack=20))
        self.room.game.table.start_hand(deck=fixed_deck(["AsAd", "KsKd"], "2c3h7d9sTc"))
        self.command("friend", "action", kind="all_in")
        self.assertTrue(self.registry.snapshot("host")["result"]["match_over"])
        self.join("newcomer")
        self.assertFalse(self.registry.snapshot("host")["result"]["match_over"])
        self.prepare("next")
        self.assertEqual(self.room.game.table.hand_number, 2)
        self.assertEqual(self.room.members["newcomer"].player_id, 2)


class AdmissionHTTPTests(unittest.TestCase):
    setUp = storage_tests.PersistentHTTPTests.setUp
    tearDown = storage_tests.PersistentHTTPTests.tearDown
    launch = storage_tests.PersistentHTTPTests.launch
    stop = storage_tests.PersistentHTTPTests.stop
    restart = storage_tests.PersistentHTTPTests.restart
    wait_resumed = storage_tests.PersistentHTTPTests.wait_resumed

    def test_pending_and_approved_clients_reconnect_with_same_identity_and_no_cards(self):
        self.host.command("room/start")
        self.friend.command("room/start")
        newcomer = Client(self.server.server_port)
        pending = newcomer.request("room/join", {"name": "新牌友", "code": self.code})[1]
        self.assertEqual(pending["phase"], "pending")
        self.assertNotIn("players", pending)
        self.restart()
        self.assertEqual(newcomer.request()[1]["phase"], "pending")
        self.wait_resumed()
        target = next(m["id"] for m in self.host.request()[1]["room_info"]["members"] if not m["is_you"])
        self.assertEqual(self.host.command("room/kick", target_id=target)[0], 200)
        self.assertEqual(self.host.approve("新牌友")[0], 200)
        state = newcomer.request()[1]
        self.assertIsNone(state["viewer_id"])
        self.assertTrue(all(not p["cards"] for p in state["players"]))
        self.restart()
        state = newcomer.request()[1]
        self.assertTrue(state["room_info"]["waiting_for_seat"])
        self.assertNotIn("seed", json.dumps(state))
        self.assertNotIn("deck", json.dumps(state))
        self.assertEqual(self.friend.request()[1]["phase"], "lobby")


if __name__ == "__main__":
    unittest.main()
