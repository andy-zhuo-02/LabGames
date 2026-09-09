"""Browser service tests, including real HTTP sessions and complete games."""

from dataclasses import asdict
from http.client import HTTPConnection
import json
import threading
import unittest
from unittest.mock import patch

from bots import make_bot, passive_action
from engine import GameConfig, IllegalAction, Table
from web_app import BrowserGame, Conflict, PokerServer, PROFILES


class PassiveBot:
    def choose_action(self, observation):
        return passive_action(observation)


def command(game, route, **payload):
    game.command(route, {"version": game.version, **payload})


def play_to_end(game):
    for _ in range(1000):
        if game.table.hand.finished:
            return game.snapshot()
        if game.table.hand.actor_id == 0:
            action = passive_action(game.table.hand.observe(0))
            command(game, "action", **asdict(action))
        else:
            command(game, "step")
    raise AssertionError("Game did not reach a result")


class BrowserGameTests(unittest.TestCase):
    def setUp(self):
        self.game = BrowserGame()
        with patch("web_app.secrets.randbits", return_value=42):
            self.game.start({"name": "玩家", "opponents": ["calling_station", "random"]})
        self.game.bots = {1: PassiveBot(), 2: PassiveBot()}

    def test_catalog_and_setup_validation(self):
        game = BrowserGame()
        self.assertEqual(len(game.snapshot()["catalog"]), 8)
        for payload in ({"name": 42}, {"name": "长" * 13}, {"opponents": []},
                        {"opponents": ["invalid"]}, {"opponents": [{}]},
                        {"opponents": ["tight"] * 6}, {"room": []}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                game.start(payload)
            self.assertIsNone(game.table)
        game.start({"opponents": ["tight"] * 5})
        self.assertEqual(len(set(player.name for player in game.table.players)), 6)

    def test_private_cards_only_and_read_does_not_advance(self):
        before = self.game.snapshot()
        self.assertEqual(len(before["players"][0]["cards"]), 2)
        self.assertTrue(all(not player["cards"] for player in before["players"][1:]))
        self.assertNotIn("seed", json.dumps(before))
        self.assertNotIn("deck", json.dumps(before))
        self.assertEqual(before, self.game.snapshot())
        command(self.game, "step")
        self.assertEqual(self.game.table.hand.actor_id, 0)
        self.assertEqual(len(self.game.table.hand.actions), 1)
        self.assertTrue(all(not player["cards"] for player in self.game.snapshot()["players"][1:]))

    def test_rejects_wrong_actor_stale_or_invalid_action_without_mutation(self):
        before = self.game.snapshot()
        for route in ("action", "next", "finish"):
            with self.assertRaises(Conflict):
                command(self.game, route, kind="call")
            self.assertEqual(before, self.game.snapshot())
        old_version = self.game.version
        command(self.game, "step")
        before = self.game.snapshot()
        with self.assertRaises(Conflict):
            self.game.command("action", {"version": old_version, "kind": "call"})
        with self.assertRaises(Conflict):
            command(self.game, "step")
        for payload in ({"kind": "check"}, {"kind": "raise", "amount": 21},
                        {"kind": "raise", "amount": True}, {"kind": "all_in", "amount": 100},
                        {"kind": []}, {"kind": "raise", "amount": "100"}):
            with self.subTest(payload=payload), self.assertRaises(IllegalAction):
                command(self.game, "action", **payload)
            self.assertEqual(before, self.game.snapshot())

    def test_raise_to_and_duplicate_click(self):
        command(self.game, "step")
        version = self.game.version
        self.game.command("action", {"version": version, "kind": "raise", "amount": 100})
        hero = self.game.snapshot()["players"][0]
        self.assertEqual((hero["stack"], hero["bet"]), (1900, 100))
        self.assertEqual(self.game.table.hand.actions[-1].paid, 90)
        before = self.game.snapshot()
        with self.assertRaises(Conflict):
            self.game.command("action", {"version": version, "kind": "raise", "amount": 100})
        self.assertEqual(before, self.game.snapshot())

    def test_fold_and_fast_forward_then_next_preserves_stacks(self):
        command(self.game, "step")
        command(self.game, "action", kind="fold")
        command(self.game, "finish")
        result = self.game.snapshot()
        self.assertEqual(result["phase"], "finished")
        self.assertEqual(result["stats"]["hands"], 1)
        self.assertEqual(result["result"]["profit"], -10)
        self.assertEqual(result["result"]["end_reason"], "showdown")
        self.assertEqual({hand["player_id"] for hand in result["result"]["shown_hands"]}, {1, 2})
        self.assertEqual(len(result["players"][0]["cards"]), 2)
        self.assertEqual(sum(player["stack"] for player in result["players"]), 6000)
        stacks = [player.stack for player in self.game.table.players]
        command(self.game, "next")
        self.assertEqual([player.stack for player in self.game.table.players], stacks)
        self.assertEqual(self.game.snapshot()["hand_number"], 2)
        self.assertEqual(self.game.snapshot()["actions"], [])
        self.assertTrue(all(not player["cards"] for player in self.game.snapshot()["players"][1:]))

    def test_showdown_reveals_all_contenders_including_losers(self):
        snapshot = play_to_end(self.game)
        self.assertEqual(len(snapshot["board"]), 5)
        self.assertTrue(snapshot["hand_type"])
        official = {hand.player_id: list(hand.cards) for hand in self.game.table.hand.result().shown_hands}
        self.assertEqual(set(official), {0, 1, 2})
        self.assertEqual(snapshot["result"]["end_reason"], "showdown")
        self.assertEqual({hand["player_id"] for hand in snapshot["result"]["shown_hands"]}, {0, 1, 2})
        self.assertTrue(all(len(hand["cards"]) == 2 for hand in snapshot["result"]["shown_hands"]))
        for player in snapshot["players"][1:]:
            self.assertEqual(player["cards"], official.get(player["id"], []))
        self.assertEqual(snapshot["stats"]["profit"], snapshot["result"]["profit"])
        self.assertEqual(snapshot["result"]["pot"], 60)
        self.assertEqual(len(snapshot["history"]), 1)
        self.game._account_result()
        self.assertEqual(self.game.snapshot(), snapshot)

    def test_all_in_finishes_table_without_auto_rebuy(self):
        command(self.game, "step")
        command(self.game, "action", kind="all_in")
        self.assertTrue(self.game.snapshot()["players"][0]["all_in"])
        self.assertTrue(all(not player["cards"] for player in self.game.snapshot()["players"][1:]))
        command(self.game, "finish")
        snapshot = self.game.snapshot()
        self.assertTrue(snapshot["result"]["match_over"])
        self.assertEqual({hand["player_id"] for hand in snapshot["result"]["shown_hands"]}, {0, 1, 2})
        self.assertEqual(sum(player["stack"] for player in snapshot["players"]), 6000)
        before = snapshot
        with self.assertRaises(Conflict):
            command(self.game, "next")
        self.assertEqual(self.game.snapshot(), before)

    def test_all_fold_keeps_opponent_cards_hidden_and_explains_refund(self):
        command(self.game, "step")
        command(self.game, "action", kind="raise", amount=100)
        # Test the engine adapter against actual folded actions, not invented results.
        from engine import Action
        while not self.game.table.hand.finished:
            self.game.table.apply_action(self.game.table.hand.actor_id, Action("fold"))
        self.game._account_result()
        snapshot = self.game.snapshot()
        self.assertTrue(all(not player["cards"] for player in snapshot["players"][1:]))
        self.assertEqual(snapshot["result"]["end_reason"], "folds")
        self.assertIn("无需亮牌", snapshot["result"]["explanation"])
        self.assertTrue(snapshot["result"]["returned_bets"])
        self.assertGreater(snapshot["result"]["profit"], 0)

    def test_full_games_for_each_strategy_keep_chip_totals_and_end(self):
        # Short stacks exercise elimination, all-ins and the match-over boundary quickly.
        for style in PROFILES:
            with self.subTest(style=style):
                game = BrowserGame()
                game.strategies = ["human", style]
                game.table = Table(["你", "AI"], GameConfig(starting_stack=100), seed=32)
                game.bots = {1: make_bot(style, 19, equity_samples=32)}
                game.table.start_hand()
                human = make_bot("maniac", 21)
                for _ in range(3000):
                    snapshot = game.snapshot()
                    self.assertEqual(sum(p["stack"] for p in snapshot["players"]) + snapshot["pot"], 200)
                    if game.table.hand.finished:
                        if snapshot["result"]["match_over"]:
                            break
                        command(game, "next")
                    elif game.table.hand.actor_id == 0:
                        command(game, "action", **asdict(human.choose_action(game.table.hand.observe(0))))
                    else:
                        command(game, "step")
                else:
                    self.fail(f"{style} did not reach a table winner")


class BrowserHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = PokerServer(("127.0.0.1", 0))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.cookie = None

    def http(self, route="/api/state", data=None, *, raw=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        request_headers = {"Content-Type": "application/json", "X-Poker-Client": "1"}
        if self.cookie:
            request_headers["Cookie"] = self.cookie
        request_headers.update(headers or {})
        body = raw if raw is not None else json.dumps(data) if data is not None else None
        connection.request("POST" if body is not None else "GET", route, body, request_headers)
        response = connection.getresponse()
        content = response.read()
        if response.getheader("Set-Cookie"):
            self.cookie = response.getheader("Set-Cookie").split(";")[0]
        result = (response.status, content, dict(response.getheaders()))
        connection.close()
        return result

    def test_refresh_and_independent_browser_sessions(self):
        status, body, headers = self.http()
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertEqual(json.loads(body)["phase"], "lobby")
        status, body, _ = self.http("/api/new", {"version": 0, "opponents": ["random"]})
        self.assertEqual(status, 200)
        state = json.loads(body)
        saved_cookie = self.cookie
        self.assertEqual(json.loads(self.http()[1]), state)
        self.cookie = None
        self.assertEqual(json.loads(self.http()[1])["phase"], "lobby")
        self.cookie = saved_cookie
        self.assertEqual(json.loads(self.http()[1]), state)

    def test_http_complete_hand_next_and_stale_reset(self):
        self.http()
        status, body, _ = self.http("/api/new", {"version": 0})
        self.assertEqual(status, 200)
        snapshot = json.loads(body)
        game = self.server.games[self.cookie.split("=", 1)[1]]
        game.bots = {1: PassiveBot(), 2: PassiveBot()}
        for _ in range(40):
            if snapshot["phase"] == "finished":
                break
            route = "action" if snapshot["actor_id"] == 0 else "step"
            payload = {"version": snapshot["version"]}
            if route == "action":
                payload["kind"] = "check" if snapshot["legal"]["check"] else "call"
            status, body, _ = self.http(f"/api/{route}", payload)
            self.assertEqual(status, 200, body)
            snapshot = json.loads(body)
        self.assertEqual(snapshot["phase"], "finished")
        self.assertEqual(snapshot["result"]["end_reason"], "showdown")
        self.assertTrue(all(len(player["cards"]) == 2 for player in snapshot["players"]))
        status, body, _ = self.http("/api/next", {"version": snapshot["version"]})
        self.assertEqual(status, 200)
        next_state = json.loads(body)
        self.assertEqual(next_state["hand_number"], 2)
        status, body, _ = self.http("/api/new", {"version": 0})
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["state"], next_state)

    def test_rejects_malformed_requests_and_external_origins(self):
        for body in ("[]", "not json", "x" * 8193):
            with self.subTest(body=body[:15]):
                self.assertEqual(self.http("/api/new", raw=body)[0], 400)
        for headers in ({"Origin": "https://example.com"}, {"Host": "example.com"}, {"X-Poker-Client": "0"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.http("/api/new", {"version": 0}, headers=headers)[0], 403)
        self.assertEqual(self.http(headers={"Host": "example.com"})[0], 403)
        self.assertEqual(self.http("/api/unknown", {})[0], 404)

    def test_static_assets_and_no_arbitrary_file_access(self):
        for path, content_type in (("/", "text/html"), ("/app.js", "application/javascript"),
                                   ("/style.css", "text/css"), ("/favicon.svg", "image/svg+xml")):
            status, content, headers = self.http(path)
            self.assertEqual(status, 200)
            self.assertTrue(content)
            self.assertTrue(headers["Content-Type"].startswith(content_type))
            self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        for path in ("/../engine.py", "/engine.py", "/web_app.py", "/%2e%2e/engine.py"):
            self.assertEqual(self.http(path)[0], 404)


if __name__ == "__main__":
    unittest.main()
