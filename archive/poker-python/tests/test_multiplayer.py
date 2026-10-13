"""Room permissions, private views, server turns, and isolated HTTP clients."""

from dataclasses import asdict
from http.client import HTTPConnection
import json
import threading
import unittest
from unittest.mock import patch

from bots import passive_action
from browser_game import BrowserGame, Conflict
from engine import Action, GameConfig, IllegalAction, Table
from multiplayer import BOT_DELAY, DISCONNECT_SECONDS, HOST_TIMEOUT, TURN_OPTIONS, TURN_SECONDS, RoomRegistry
from web_app import PokerServer


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class RoomTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.registry = RoomRegistry(clock=self.clock)
        self.registry.perform("host", "room/create", {"name": "房主", "capacity": 4, "fill_bots": False})
        self.code = self.registry.membership["host"]

    def join(self, sid):
        self.registry.perform(sid, "room/join", {"name": sid, "code": self.code})
        room = self.registry.rooms[self.code]
        if sid in room.applicants:
            self.command(room.host, "room/approve", target_id=room.applicants[sid].member_id)

    def command(self, sid, route, **payload):
        state = self.registry.snapshot(sid)
        self.registry.perform(sid, route, {"version": state["version"], "room_code": state["room_info"]["code"], "round_id": state["room_info"]["round_id"], **payload})

    def prepare_all(self, route):
        room = self.registry.rooms[self.code]
        eligible = room.readiness_members()
        for sid in list(room.members):
            if sid in eligible:
                self.command(sid, route)

    def start(self):
        self.prepare_all("room/start")

    def test_waiting_room_needs_everyones_consent(self):
        with self.assertRaises(Conflict):
            self.command("host", "room/start")
        self.join("friend")
        self.command("host", "room/start")
        self.assertEqual(self.registry.snapshot("friend")["phase"], "waiting")
        self.assertEqual(self.registry.snapshot("friend")["room_info"]["ready_count"], 1)
        self.command("friend", "room/start")
        self.assertEqual(self.registry.snapshot("friend")["phase"], "playing")
        self.join("latecomer")
        self.assertTrue(self.registry.snapshot("latecomer")["room_info"]["waiting_for_seat"])

    def test_room_capacity_duplicate_names_and_idempotent_join(self):
        self.join("friend")
        self.join("friend")
        self.assertEqual(len(self.registry.snapshot("host")["room_info"]["members"]), 2)
        with self.assertRaises(Conflict):
            self.registry.perform("impostor", "room/join", {"name": "friend", "code": self.code})
        self.join("third")
        self.join("fourth")
        with self.assertRaises(Conflict):
            self.join("fifth")
        with self.assertRaises(Conflict):
            self.registry.perform("host", "room/create", {"name": "another room"})

    def test_turn_time_defaults_and_invalid_choices_do_not_create_rooms(self):
        self.assertEqual(self.registry.snapshot("host")["room_info"]["turn_seconds"], 90)
        for value in (None, True, False, "30", 30.0, 0, -1, 10, 300, [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.registry.perform("invalid", "room/create", {"name": "无效", "turn_seconds": value})
            self.assertFalse(self.registry.contains("invalid"))
            self.assertEqual(len(self.registry.rooms), 1)

    def test_each_turn_time_is_enforced_and_survives_next_hand_and_host_transfer(self):
        for seconds in TURN_OPTIONS:
            with self.subTest(seconds=seconds):
                self.registry = RoomRegistry(clock=self.clock)
                self.registry.perform("host", "room/create", {"name": "房主", "capacity": 2, "fill_bots": False, "turn_seconds": seconds})
                self.code = self.registry.membership["host"]
                self.join("friend")
                self.start()
                room = self.registry.rooms[self.code]
                for sid in ("host", "friend"):
                    self.assertEqual(self.registry.snapshot(sid)["room_info"]["turn_seconds"], seconds)
                self.assertEqual(room.deadline - self.clock(), seconds)
                self.clock.advance(seconds - 1)
                for sid in ("host", "friend"):
                    self.registry.snapshot(sid)  # Keep both online; exercise the turn clock.
                self.registry.tick()
                self.assertFalse(room.game.table.hand.finished)
                self.assertEqual(self.registry.snapshot("friend")["room_info"]["remaining_seconds"], 1)
                self.clock.advance(1)
                self.registry.tick()
                self.assertTrue(room.game.table.hand.finished)
                self.assertEqual(room.game.table.hand.actions[-1].action.kind, "fold")
                self.assertEqual(room.game.table.hand.actions[-1].paid, 0)
                self.assertIn(f"超过 {seconds} 秒未操作", room.notice)
                self.prepare_all("next")
                self.assertEqual(room.game.table.hand_number, 2)
                self.assertEqual(room.deadline - self.clock(), seconds)
                self.command("host", "room/leave")
                self.assertTrue(self.registry.snapshot("friend")["room_info"]["is_host"])
                self.assertEqual(self.registry.snapshot("friend")["room_info"]["turn_seconds"], seconds)
                self.assertAlmostEqual(room.deadline - self.clock(), BOT_DELAY)

    def test_session_identity_cannot_be_overridden_and_versions_are_required(self):
        self.join("friend")
        self.start()
        host = self.registry.snapshot("host")
        friend = self.registry.snapshot("friend")
        self.assertEqual((host["viewer_id"], friend["viewer_id"]), (0, 1))
        self.assertEqual(host["actor_id"], 1)
        self.assertEqual(len(host["players"][0]["cards"]), 2)
        self.assertFalse(host["players"][1]["cards"])
        self.assertEqual(len(friend["players"][1]["cards"]), 2)
        self.assertFalse(friend["players"][0]["cards"])
        with self.assertRaises(IllegalAction):
            self.command("host", "action", kind="call", player_id=1)
        self.assertEqual(self.registry.snapshot("host"), host)
        payload = {"version": friend["version"], "room_code": self.code, "kind": "call"}
        self.registry.perform("friend", "action", payload)
        after = self.registry.snapshot("friend")
        with self.assertRaises(Conflict):
            self.registry.perform("friend", "action", payload)
        self.assertEqual(after, self.registry.snapshot("friend"))
        for route in ("step", "finish", "next"):
            with self.assertRaises(Conflict):
                self.command("friend", route)

    def test_other_room_cannot_control_or_read_this_table(self):
        self.join("friend")
        self.start()
        self.registry.perform("stranger", "room/create", {"name": "stranger"})
        before = self.registry.snapshot("host")
        with self.assertRaises(Conflict):
            self.registry.perform("stranger", "action", {"room_code": self.code, "version": before["version"], "kind": "all_in"})
        self.assertEqual(before, self.registry.snapshot("host"))
        self.assertEqual(self.registry.snapshot("stranger")["phase"], "waiting")
        self.assertIsNone(self.registry.snapshot("unknown"))

    def test_four_humans_finish_hand_with_private_views_and_individual_results(self):
        sessions = ["host", "friend", "third", "fourth"]
        for sid in sessions[1:]:
            self.join(sid)
        self.start()
        room = self.registry.rooms[self.code]
        self.command("third", "action", kind="fold")
        for _ in range(80):
            if room.game.table.hand.finished:
                break
            for sid in sessions:
                snapshot = self.registry.snapshot(sid)
                for player in snapshot["players"]:
                    self.assertEqual(len(player["cards"]), 2 if player["id"] == snapshot["viewer_id"] else 0)
                self.assertEqual(sum(player["stack"] for player in snapshot["players"]) + snapshot["pot"], 8000)
            actor = room.game.table.hand.actor_id
            self.command(sessions[actor], "action", **asdict(passive_action(room.game.table.hand.observe(actor))))
        else:
            self.fail("Multiplayer hand did not finish")
        profits = dict(room.game.table.hand.result().payoffs)
        for i, sid in enumerate(sessions):
            snapshot = self.registry.snapshot(sid)
            self.assertEqual(snapshot["result"]["profit"], profits[i])
            self.assertEqual(snapshot["stats"]["profit"], profits[i])
            self.assertEqual(snapshot["history"][0]["profit"], profits[i])
            self.assertEqual({hand["player_id"] for hand in snapshot["result"]["shown_hands"]}, {0, 1, 3})
            if sid != "third":
                self.assertFalse(snapshot["players"][2]["cards"])
        self.command("host", "next")
        self.assertEqual(self.registry.snapshot("friend")["hand_number"], 1)
        for sid in sessions[1:]:
            self.command(sid, "next")
        self.assertEqual(self.registry.snapshot("friend")["hand_number"], 2)

    def test_bot_moves_once_on_server_without_any_client_step(self):
        self.command("host", "room/leave")
        self.registry.perform("host", "room/create", {"name": "房主", "capacity": 3, "fill_bots": True, "turn_seconds": 120})
        self.code = self.registry.membership["host"]
        self.join("friend")
        self.start()
        before = self.registry.snapshot("host")
        self.assertEqual(before["room_info"]["turn_seconds"], 120)
        self.assertEqual(before["actor_id"], 2)
        self.registry.tick()
        self.assertEqual(self.registry.snapshot("host")["version"], before["version"])
        self.clock.advance(BOT_DELAY)
        self.registry.tick()
        room = self.registry.rooms[self.code]
        self.assertEqual(len(room.game.table.hand.actions), 1)
        self.registry.tick()
        self.assertEqual(len(room.game.table.hand.actions), 1)
        self.assertEqual(self.registry.snapshot("host")["actor_id"], 0)

    def test_timeout_folds_without_calling_and_transfers_disconnected_host(self):
        self.join("friend")
        self.start()
        room = self.registry.rooms[self.code]
        self.clock.advance(TURN_SECONDS - 1)
        self.registry.snapshot("friend")
        self.registry.tick()
        self.assertEqual(room.host, "friend")
        self.assertFalse(room.game.table.hand.finished)
        self.clock.advance(1)
        self.registry.tick()
        self.assertTrue(room.game.table.hand.finished)
        self.assertEqual(room.game.table.hand.actions[-1].action.kind, "fold")
        self.assertEqual(room.game.table.hand.actions[-1].paid, 0)
        # Reconnection retains the old host's seat, but not host authority.
        snapshot = self.registry.snapshot("host")
        self.assertEqual(snapshot["viewer_id"], 0)
        self.assertFalse(snapshot["room_info"]["is_host"])

    def test_timeout_checks_when_it_is_free(self):
        self.join("friend")
        self.start()
        self.command("friend", "action", kind="call")
        self.clock.advance(TURN_SECONDS)
        self.registry.snapshot("host")
        self.registry.tick()
        hand = self.registry.rooms[self.code].game.table.hand
        self.assertEqual(hand.actions[-1].action.kind, "check")
        self.assertEqual(hand.actions[-1].paid, 0)
        self.assertEqual(hand.street, "flop")

    def test_leaving_transfers_host_and_ai_takes_over_departed_seat(self):
        self.join("friend")
        self.start()
        self.command("host", "room/leave")
        room = self.registry.rooms[self.code]
        self.assertIsNone(self.registry.snapshot("host"))
        self.assertTrue(self.registry.snapshot("friend")["room_info"]["is_host"])
        self.assertIn(0, room.game.bots)
        self.command("friend", "action", kind="call")
        self.clock.advance(BOT_DELAY)
        self.registry.tick()
        self.assertEqual(len(room.game.table.hand.actions), 2)
        self.command("friend", "room/leave")
        self.assertNotIn(self.code, self.registry.rooms)
        self.assertFalse(self.registry.membership)

    def test_busted_player_spectates_without_receiving_another_players_cards(self):
        self.join("friend")
        self.join("third")
        self.start()
        room = self.registry.rooms[self.code]
        # Player 0 is out before this hand starts; the other humans keep playing.
        room.game.table = Table(["房主", "friend", "third"], stacks=[0, 3000, 3000], seed=12)
        room.game.table.start_hand()
        snapshot = self.registry.snapshot("host")
        self.assertEqual(snapshot["viewer_id"], 0)
        self.assertTrue(snapshot["players"][0]["eliminated"])
        self.assertTrue(all(not player["cards"] for player in snapshot["players"]))
        self.assertFalse(snapshot["legal"]["check"])
        self.assertEqual(snapshot["hand_type"], "")

    def test_simultaneous_ready_votes_accept_same_revision_but_not_old_round(self):
        self.join("friend")
        state = self.registry.snapshot("host")
        payload = {"version": state["version"], "room_code": self.code,
                   "round_id": state["room_info"]["round_id"], "ready": True}
        self.registry.perform("host", "room/start", payload)
        self.registry.perform("friend", "room/start", payload)
        room = self.registry.rooms[self.code]
        self.assertEqual(room.game.table.hand_number, 1)
        with self.assertRaises(Conflict):
            self.registry.perform("friend", "room/start", payload)
        self.assertEqual(room.game.table.hand_number, 1)

    def test_ready_can_be_cancelled_and_new_members_do_not_interrupt_votes(self):
        self.join("friend")
        self.command("host", "room/start")
        self.command("host", "room/start", ready=False)
        self.command("friend", "room/start")
        self.assertEqual(self.registry.snapshot("host")["phase"], "waiting")
        self.assertEqual(self.registry.snapshot("host")["room_info"]["ready_count"], 1)
        before = self.registry.snapshot("host")
        pending_vote = {"room_code": self.code, "version": before["version"],
                        "round_id": before["room_info"]["round_id"]}
        self.join("third")
        state = self.registry.snapshot("host")
        self.assertEqual(state["room_info"]["ready_count"], 1)
        self.assertEqual(state["room_info"]["round_id"], before["room_info"]["round_id"])
        self.assertTrue(self.registry.snapshot("friend")["room_info"]["ready"])
        self.assertFalse(self.registry.snapshot("third")["room_info"]["ready"])
        # An existing player's in-flight vote still belongs to this lobby.
        self.registry.perform("host", "room/start", pending_vote)
        self.assertEqual(self.registry.snapshot("host")["phase"], "waiting")
        self.command("third", "room/start")
        self.assertEqual(self.registry.snapshot("host")["phase"], "playing")

    def test_leaving_ready_member_keeps_others_ready_and_rejoining_starts_unready(self):
        self.join("friend")
        self.join("third")
        self.command("host", "room/start")
        self.command("friend", "room/start")
        self.command("friend", "room/leave")
        state = self.registry.snapshot("host")
        self.assertEqual(state["phase"], "waiting")
        self.assertTrue(state["room_info"]["ready"])
        self.assertEqual((state["room_info"]["ready_count"], state["room_info"]["ready_total"]), (1, 2))
        self.join("friend")
        self.assertFalse(self.registry.snapshot("friend")["room_info"]["ready"])
        self.assertTrue(self.registry.snapshot("host")["room_info"]["ready"])
        self.command("third", "room/start")
        self.assertEqual(self.registry.snapshot("host")["phase"], "waiting")
        self.command("friend", "room/start")
        self.assertEqual(self.registry.snapshot("host")["phase"], "playing")

    def test_last_unready_player_leaving_starts_next_hand_once(self):
        self.join("friend")
        self.join("third")
        self.start()
        room = self.registry.rooms[self.code]
        self.command("third", "action", kind="fold")
        self.command("host", "action", kind="fold")
        self.assertTrue(room.game.table.hand.finished)
        self.command("host", "next")
        self.command("friend", "next")
        before = self.registry.snapshot("host")
        self.command("third", "room/leave")
        after = self.registry.snapshot("host")
        self.assertEqual(after["hand_number"], 2)
        self.assertEqual(after["phase"], "playing")
        self.assertEqual(after["room_info"]["ready_count"], 0)
        self.assertIn(2, room.game.bots)
        with self.assertRaises(Conflict):
            self.registry.perform("host", "next", {"room_code": self.code, "version": before["version"], "round_id": before["room_info"]["round_id"]})
        self.assertEqual(room.game.table.hand_number, 2)

    def test_lone_ready_player_can_cancel_while_waiting_for_enough_players(self):
        self.join("friend")
        self.command("host", "room/start")
        self.command("friend", "room/leave")
        state = self.registry.snapshot("host")
        self.assertEqual(state["phase"], "waiting")
        self.assertTrue(state["room_info"]["ready"])
        self.assertTrue(state["room_info"]["can_ready"])
        self.command("host", "room/start", ready=False)
        self.assertFalse(self.registry.snapshot("host")["room_info"]["ready"])
        self.assertFalse(self.registry.snapshot("host")["room_info"]["can_start"])

    def test_disconnection_does_not_wait_for_full_turn_and_reconnection_keeps_seat(self):
        self.command("host", "room/leave")
        self.registry.perform("host", "room/create", {"name": "房主", "fill_bots": False, "turn_seconds": 120})
        self.code = self.registry.membership["host"]
        self.join("friend")
        self.start()
        room = self.registry.rooms[self.code]
        self.assertEqual(room.deadline - self.clock(), 120)
        self.clock.advance(DISCONNECT_SECONDS - 1)
        self.registry.snapshot("host")
        self.registry.tick()
        self.assertFalse(room.game.table.hand.finished)
        self.clock.advance(1)
        self.registry.tick()
        self.assertTrue(room.game.table.hand.finished)
        self.assertEqual(room.game.table.hand.actions[-1].action.kind, "fold")
        self.assertIn("离线", room.notice)
        self.assertEqual(self.registry.snapshot("friend")["viewer_id"], 1)
        self.command("host", "next")
        self.assertEqual(room.game.table.hand_number, 1)

    def test_explicit_leave_ignores_stale_version_and_immediately_releases_actor(self):
        self.join("friend")
        self.start()
        before = self.registry.snapshot("friend")
        self.registry.perform("friend", "room/leave", {"room_code": self.code, "version": before["version"] - 1})
        room = self.registry.rooms[self.code]
        self.assertIn(1, room.game.bots)
        self.assertLessEqual(room.deadline - self.clock(), BOT_DELAY)
        self.registry.perform("friend", "room/leave", {"room_code": self.code})
        self.clock.advance(BOT_DELAY)
        self.registry.tick()
        self.assertEqual(len(room.game.table.hand.actions), 1)

    def test_leaving_another_seat_does_not_restart_current_players_timer(self):
        self.join("friend")
        self.join("third")
        self.start()
        room = self.registry.rooms[self.code]
        deadline = room.deadline
        self.clock.advance(5)
        self.command("friend", "room/leave")
        self.assertEqual(room.deadline, deadline)

    def test_only_host_can_kick_and_target_cannot_act_or_rejoin(self):
        self.join("friend")
        self.start()
        before = self.registry.snapshot("host")
        target_id = next(member["id"] for member in before["room_info"]["members"] if not member["is_you"])
        host_id = next(member["id"] for member in before["room_info"]["members"] if member["is_you"])
        for target in (host_id, "not-a-member"):
            with self.assertRaises(Conflict):
                self.command("host", "room/kick", target_id=target)
        with self.assertRaises(Conflict):
            self.command("friend", "room/kick", target_id=host_id)
        self.command("host", "room/kick", target_id=target_id)
        self.assertIsNone(self.registry.snapshot("friend"))
        self.assertIn("移出", self.registry.departure("friend")["message"])
        with self.assertRaises(Conflict):
            self.registry.perform("friend", "action", {"room_code": self.code, "version": before["version"], "kind": "call"})
        with self.assertRaises(Conflict):
            self.join("friend")
        room = self.registry.rooms[self.code]
        self.assertIn(1, room.game.bots)
        self.assertLessEqual(room.deadline - self.clock(), BOT_DELAY)

    def test_kicking_last_unready_member_starts_for_remaining_ready_people(self):
        self.join("friend")
        self.join("third")
        self.command("host", "room/start")
        self.command("friend", "room/start")
        target = next(member["id"] for member in self.registry.snapshot("host")["room_info"]["members"] if member["name"] == "third")
        self.command("host", "room/kick", target_id=target)
        snapshot = self.registry.snapshot("host")
        self.assertEqual(snapshot["phase"], "playing")
        self.assertEqual(snapshot["room_info"]["ready_count"], 0)

    def test_kicking_ready_member_preserves_other_votes_and_waits_for_unready_people(self):
        self.join("friend")
        self.join("third")
        self.command("host", "room/start")
        self.command("friend", "room/start")
        target = next(member["id"] for member in self.registry.snapshot("host")["room_info"]["members"] if member["name"] == "friend")
        self.command("host", "room/kick", target_id=target)
        snapshot = self.registry.snapshot("host")
        self.assertEqual(snapshot["phase"], "waiting")
        self.assertTrue(snapshot["room_info"]["ready"])
        self.assertEqual(snapshot["room_info"]["ready_count"], 1)
        self.command("third", "room/start")
        self.assertEqual(self.registry.snapshot("host")["phase"], "playing")

    def test_public_member_ids_are_unique_after_seat_changes(self):
        self.join("friend")
        self.join("third")
        self.command("friend", "room/leave")
        self.join("fourth")
        members = self.registry.snapshot("host")["room_info"]["members"]
        self.assertEqual(len({member["id"] for member in members}), len(members))
        self.assertNotIn("host", {member["id"] for member in members})

    def test_rematch_returns_to_lobby_and_keeps_member_identities(self):
        from test_poker import fixed_deck
        self.command("host", "room/leave")
        self.registry.perform("host", "room/create", {"name": "房主", "fill_bots": False, "turn_seconds": 60})
        self.code = self.registry.membership["host"]
        self.join("friend")
        self.start()
        room = self.registry.rooms[self.code]
        room.game.table = Table(["房主", "friend"], GameConfig(starting_stack=20))
        room.game.table.start_hand(deck=fixed_deck(["AsAd", "KsKd"], "2c3h7d9sTc"))
        self.command("friend", "action", kind="all_in")
        self.assertTrue(self.registry.snapshot("host")["result"]["match_over"])
        self.command("friend", "room/rematch")
        self.assertEqual(self.registry.snapshot("friend")["phase"], "finished")
        self.command("host", "room/rematch")
        self.assertEqual(self.registry.snapshot("friend")["phase"], "waiting")
        self.assertEqual(self.registry.snapshot("friend")["room_info"]["turn_seconds"], 60)
        self.join("third")
        self.start()
        self.assertEqual(self.registry.snapshot("friend")["viewer_id"], 1)
        self.assertEqual(room.deadline - self.clock(), 60)
        self.assertEqual(sum(player["stack"] for player in self.registry.snapshot("friend")["players"]) + 30, 6000)


class Client:
    def __init__(self, port):
        self.port, self.cookie = port, None

    def request(self, path="state", payload=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
        request_headers = {"Content-Type": "application/json", "X-Poker-Client": "1"}
        if self.cookie:
            request_headers["Cookie"] = self.cookie
        request_headers.update(headers or {})
        body = json.dumps(payload) if payload is not None else None
        connection.request("POST" if payload is not None else "GET", f"/api/{path}", body, request_headers)
        response = connection.getresponse()
        if response.getheader("Set-Cookie"):
            self.cookie = response.getheader("Set-Cookie").split(";")[0]
        status, data = response.status, json.loads(response.read())
        connection.close()
        return status, data

    def command(self, route, **payload):
        _, state = self.request()
        return self.request(route, {"version": state["version"], "room_code": state.get("room_info", {}).get("code"), "round_id": state.get("room_info", {}).get("round_id"), **payload})

    def approve(self, name):
        _, state = self.request()
        target = next(m["id"] for m in state["room_info"]["applications"] if m["name"] == name)
        return self.command("room/approve", target_id=target)


class MultiplayerHTTPTests(unittest.TestCase):
    def setUp(self):
        with patch("web_app.discover_lan_ips", return_value=["192.168.1.20"]):
            self.server = PokerServer(("127.0.0.1", 0), lan=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = Client(self.server.server_port)
        self.friend = Client(self.server.server_port)
        self.stranger = Client(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_two_devices_join_play_refresh_and_leave(self):
        status, room = self.host.request("room/create", {"name": "Alice", "capacity": 2, "fill_bots": False, "turn_seconds": 30})
        self.assertEqual(status, 200)
        self.assertEqual(room["room_info"]["turn_seconds"], 30)
        code = room["room_info"]["code"]
        self.assertIn(f"192.168.1.20:{self.server.server_port}", room["room_info"]["join_url"])
        status, room = self.friend.request("room/join", {"name": "Bob", "code": code.lower()})
        self.assertEqual(status, 200)
        self.assertEqual(room["phase"], "pending")
        self.assertEqual(self.host.approve("Bob")[0], 200)
        room = self.friend.request()[1]
        self.assertEqual(room["room_info"]["turn_seconds"], 30)
        self.assertNotEqual(self.host.cookie, self.friend.cookie)
        self.assertEqual(self.host.command("room/start")[0], 200)
        self.assertEqual(self.host.request()[1]["phase"], "waiting")
        self.assertEqual(self.friend.command("room/start")[0], 200)
        self.assertEqual(self.friend.request()[1]["viewer_id"], 1)
        stranger = self.stranger.request()[1]
        self.assertEqual(stranger["phase"], "lobby")
        self.assertNotIn("players", stranger)
        self.assertEqual(self.stranger.request("room/join", {"name": "Eve", "code": code})[1]["phase"], "pending")
        self.assertEqual(self.host.approve("Eve")[0], 409)
        self.assertEqual(self.host.command("action", kind="call", player_id=1)[0], 409)
        for _ in range(30):
            views = [self.host.request()[1], self.friend.request()[1]]
            if views[0]["phase"] == "finished":
                break
            for i, view in enumerate(views):
                self.assertEqual([bool(player["cards"]) for player in view["players"]], [i == 0, i == 1])
            actor = views[0]["actor_id"]
            client = [self.host, self.friend][actor]
            kind = "check" if views[actor]["legal"]["check"] else "call"
            self.assertEqual(client.command("action", kind=kind)[0], 200)
        else:
            self.fail("HTTP game did not finish")
        self.assertEqual(views[0]["result"]["profit"], -views[1]["result"]["profit"])
        self.assertEqual(self.friend.command("next")[0], 200)
        self.assertEqual(self.host.request()[1]["hand_number"], 1)
        self.assertEqual(self.host.command("next")[0], 200)
        saved_cookie = self.friend.cookie
        refreshed = Client(self.server.server_port)
        refreshed.cookie = saved_cookie
        self.assertEqual(refreshed.request()[1]["viewer_id"], 1)
        self.assertEqual(refreshed.request()[1]["hand_number"], 2)
        self.assertEqual(self.friend.command("room/leave")[0], 200)
        self.assertEqual(self.friend.request()[1]["phase"], "lobby")
        self.assertEqual(len(self.host.request()[1]["room_info"]["members"]), 1)

    def test_lan_host_allowlist_and_cross_origin_rejection(self):
        address = f"192.168.1.20:{self.server.server_port}"
        self.assertEqual(self.host.request(headers={"Host": address})[0], 200)
        self.assertEqual(self.host.request(headers={"Host": f"evil.example:{self.server.server_port}"})[0], 403)
        self.assertEqual(self.host.request("room/create", {"name": "Alice"}, headers={"Origin": "https://evil.example"})[0], 403)

    def test_kicked_client_gets_notice_and_stale_room_request_cannot_touch_solo_game(self):
        # A previously paused solo game can share a version number with the room.
        status, solo = self.friend.command("new", name="Bob", opponents=["calling_station"])
        self.assertEqual(status, 200)
        status, room = self.host.request("room/create", {"name": "Alice", "capacity": 2, "fill_bots": False})
        self.assertEqual(status, 200)
        code = room["room_info"]["code"]
        self.assertEqual(self.friend.request("room/join", {"name": "Bob", "code": code})[0], 200)
        self.assertEqual(self.host.approve("Bob")[0], 200)
        target = next(m["id"] for m in self.host.request()[1]["room_info"]["members"] if m["name"] == "Bob")
        self.assertEqual(self.host.command("room/kick", target_id=target)[0], 200)
        status, returned = self.friend.request()
        self.assertEqual(status, 200)
        self.assertEqual(returned["room_exit"]["code"], code)
        self.assertNotIn("room_info", returned)
        self.assertEqual(returned["players"], solo["players"])
        status, rejected = self.friend.request("step", {"room_code": code, "version": solo["version"]})
        self.assertEqual(status, 409)
        self.assertEqual(rejected["state"]["players"], solo["players"])
        self.assertEqual(rejected["state"]["actions"], solo["actions"])
        self.assertEqual(self.friend.request("room/join", {"name": "Bob", "code": code})[0], 409)


if __name__ == "__main__":
    unittest.main()
