"""Sit-out, seat credentials and public showdown/replay regression coverage."""

from http.client import HTTPConnection
import json
import random
import unittest
from unittest.mock import patch
from xml.etree import ElementTree

import qrcode
from browser_game import Conflict
from engine import Action, Table
from game_storage import dump_room, restore_room
from hand_details import best_five, public_details
from multiplayer import BOT_DELAY
from test_multiplayer import Client
from test_poker import check_down, fixed_deck
import test_join_requests as admission
import test_storage as storage


class RoomExperienceTests(unittest.TestCase):
    # Reuse only fixture helpers, without inheriting and rerunning existing tests.
    setUp = admission.AdmissionTests.setUp
    room = admission.AdmissionTests.room
    command = admission.AdmissionTests.command
    apply = admission.AdmissionTests.apply
    join = admission.AdmissionTests.join
    prepare = admission.AdmissionTests.prepare
    start = admission.AdmissionTests.start
    finish = admission.AdmissionTests.finish
    restore = admission.AdmissionTests.restore

    def test_away_auto_folds_but_retains_seat_and_next_hand_skips_blinds(self):
        self.join("third")
        self.start()
        hand = self.room.game.table.hand
        actor = next(s for s, m in self.room.members.items() if m.player_id == hand.actor_id)
        seat = self.room.members[actor].player_id
        self.command(actor, "room/away", away=True)
        with self.assertRaisesRegex(Conflict, "暂离"):
            self.command(actor, "action", kind="call")
        self.clock.advance(BOT_DELAY + .01)
        self.registry.tick()
        self.assertEqual((hand.actions[-1].player_id, hand.actions[-1].action.kind), (seat, "fold"))
        self.assertNotIn(seat, self.room.game.bots)
        self.finish()
        stack = self.room.game.table.players[seat].stack
        self.prepare("next")
        self.assertNotIn(seat, self.room.game.table.hand.player_ids)
        self.assertEqual(self.room.game.table.players[seat].stack, stack)
        self.assertEqual(self.registry.snapshot(actor)["players"][seat]["cards"], [])
        self.finish()
        self.assertEqual(self.room.game.table.players[seat].stack, stack)
        self.assertEqual(self.registry.snapshot(actor)["stats"]["hands"], 1)
        point = next(p for p in self.room.game.history[0]["details"]["stacks"] if p["id"] == seat)
        self.assertEqual(point["stack"], stack)
        self.command(actor, "room/away", away=False)
        self.prepare("next")
        self.assertIn(seat, self.room.game.table.hand.player_ids)
        self.assertEqual(len(self.registry.snapshot(actor)["players"][seat]["cards"]), 2)

    def test_away_checks_for_free_and_does_not_call_later_bets(self):
        self.start()
        self.command("friend", "action", kind="call")
        self.command("host", "room/away", away=True)
        self.clock.advance(BOT_DELAY + .01)
        self.registry.tick()
        self.assertEqual(self.room.game.table.hand.actions[-1].action.kind, "check")
        self.assertEqual(self.room.game.table.hand.street, "flop")
        # Big blind acts first on the flop as well.
        self.clock.advance(BOT_DELAY + .01)
        self.registry.tick()
        self.assertEqual(self.room.game.table.hand.actions[-1].action.kind, "check")
        self.command("friend", "action", kind="raise", amount=100)
        self.clock.advance(BOT_DELAY + .01)
        self.registry.tick()
        self.assertTrue(self.room.game.table.hand.finished)
        self.assertEqual(self.room.game.table.hand.actions[-1].action.kind, "fold")
        self.assertEqual(self.room.game.table.players[0].stack, 1980)

    def test_heads_up_waits_for_return_without_declaring_a_champion(self):
        self.start()
        self.finish()
        before = [p.stack for p in self.room.game.table.players]
        self.command("friend", "room/away", away=True)
        self.command("host", "next")
        self.registry.tick()
        state = self.registry.snapshot("host")
        self.assertEqual(state["phase"], "finished")
        self.assertFalse(state["result"]["match_over"])
        self.assertIn("等待暂离玩家返回", state["room_info"]["waiting_message"])
        self.assertEqual([p.stack for p in self.room.game.table.players], before)
        self.command("friend", "room/away", away=False)
        self.assertTrue(self.registry.snapshot("host")["room_info"]["ready"])
        self.command("friend", "next")
        self.assertEqual(self.room.game.table.hand_number, 2)

    def test_away_in_lobby_and_everyone_away_never_starts_one_player_hand(self):
        self.command("friend", "room/away", away=True)
        self.command("host", "room/start")
        self.registry.tick()
        self.assertIsNone(self.room.game)
        self.assertIn("至少两位", self.registry.snapshot("host")["room_info"]["waiting_message"])
        self.command("host", "room/away", away=True)
        self.registry.tick()
        self.assertIsNone(self.room.game)
        self.assertFalse(self.room.ready)

    def test_away_pending_member_and_kicked_seat_do_not_block(self):
        self.start()
        self.join("third")
        self.command("third", "room/away", away=True)
        self.finish()
        self.prepare("next")
        self.assertIsNone(self.room.members["third"].player_id)
        self.command("friend", "room/away", away=True)
        self.command("host", "room/kick", target_id=self.room.members["friend"].member_id)
        self.finish()
        self.prepare("next")
        self.assertIn(1, self.room.game.table.hand.player_ids)
        self.assertIn(1, self.room.game.bots)

    def test_return_midhand_waits_for_next_deal_with_no_false_elimination(self):
        self.join("third")
        self.command("friend", "room/away", away=True)
        self.start()
        self.command("friend", "room/away", away=False)
        player = self.registry.snapshot("friend")["players"][1]
        self.assertFalse(player["eliminated"])
        self.assertTrue(player["waiting_for_hand"])
        self.assertEqual(player["stack"], 2000)
        self.assertFalse(player["cards"])
        self.finish()
        self.prepare("next")
        self.assertIn(1, self.room.game.table.hand.player_ids)

    def test_restore_retains_away_chips_secret_and_does_not_wait_for_away_browser(self):
        self.join("third")
        self.command("friend", "room/away", away=True)
        self.start()
        key = self.room.members["friend"].recovery_code
        self.restore()
        self.assertEqual(self.room.game.table.sitting_out, {1})
        self.assertEqual(self.room.members["friend"].recovery_code, key)
        self.registry.snapshot("host")
        self.registry.snapshot("third")
        self.registry.tick()
        self.assertFalse(self.room.recovering)
        self.assertEqual(self.room.game.table.players[1].stack, 2000)

    def test_legacy_room_without_experience_fields_restores_and_migrates_statistics(self):
        self.start()
        self.finish()
        saved = json.loads(json.dumps(dump_room(self.room, self.clock())))
        saved["game"].pop("player_hands")
        saved["game"]["table"].pop("sitting_out")
        for member in saved["members"].values():
            member.pop("away")
            member.pop("recovery_code")
        for row in saved["game"]["history"]:
            row.pop("details")
        restored = restore_room(saved, self.clock())
        self.assertEqual(restored.game.player_hands, {0:1, 1:1})
        self.assertEqual(restored.game.table.sitting_out, set())
        self.assertTrue(all(not m.away and len(m.recovery_code) == 32 for m in restored.members.values()))
        self.assertEqual(restored.game.snapshot()["result"]["payouts"], self.room.game.snapshot()["result"]["payouts"])

    def test_recovery_transfers_host_identity_cards_and_revokes_old_credential(self):
        self.start()
        before = self.registry.snapshot("host")
        old = self.room.members["host"]
        identity, key = old.member_id, old.recovery_code
        self.registry.perform("replacement", "room/recover", {"code": self.code.lower(), "recovery_code": key})
        after = self.registry.snapshot("replacement")
        self.assertEqual(after["players"], before["players"])
        self.assertEqual(after["actions"], before["actions"])
        self.assertEqual(after["viewer_id"], before["viewer_id"])
        self.assertEqual(self.room.members["replacement"].member_id, identity)
        self.assertEqual(self.room.host, "replacement")
        self.assertIsNone(self.registry.snapshot("host"))
        self.assertIn("另一浏览器", self.registry.departure("host")["message"])
        self.assertNotEqual(after["room_info"]["recovery_code"], key)
        for sid in ("host", "attacker"):
            with self.assertRaises(Conflict):
                self.registry.perform(sid, "room/recover", {"code": self.code, "recovery_code": key})
        with self.assertRaises(Conflict):
            self.registry.perform("host", "action", {"room_code": self.code, "kind": "check", "version": self.room.version})

    def test_recovery_preserves_ready_away_and_membership_order(self):
        self.command("host", "room/start")
        key = self.room.members["host"].recovery_code
        self.registry.perform("newhost", "room/recover", {"code": self.code, "recovery_code": key})
        self.assertEqual(self.room.ready, {"newhost"})
        self.assertEqual(list(self.room.members), ["newhost", "friend"])
        self.command("friend", "room/away", away=True)
        key = self.room.members["friend"].recovery_code
        self.registry.perform("newfriend", "room/recover", {"code": self.code, "recovery_code": key})
        self.assertTrue(self.room.members["newfriend"].away)
        self.assertEqual(self.room.ready, {"newhost"})

    def test_secrets_are_per_member_and_malformed_recovery_is_rejected(self):
        host_key = self.registry.snapshot("host")["room_info"]["recovery_code"]
        friend = self.registry.snapshot("friend")
        self.assertNotIn(host_key, json.dumps(friend))
        self.apply("applicant")
        self.assertNotIn("recovery_code", json.dumps(self.registry.snapshot("applicant")))
        for key in (None, "x", "中" * 32, "?" * 32):
            with self.subTest(key=key), self.assertRaises(Conflict):
                self.registry.perform("stranger", "room/recover", {"code": self.code, "recovery_code": key})
        with self.assertRaises(Conflict):
            self.registry.perform("friend", "room/recover", {"code": self.code, "recovery_code": host_key})
        with self.assertRaises(Conflict):
            self.command("applicant", "room/away", away=True)
        with self.assertRaises(ValueError):
            self.command("host", "room/away", away="yes")


class ExplanationTests(unittest.TestCase):
    def test_varied_stack_and_fold_patterns_produce_correct_public_pot_winners(self):
        rng = random.Random(711)
        for seed in range(160):
            count = rng.randint(2, 6)
            table = Table([f"P{i}" for i in range(count)], stacks=[rng.randint(5, 400) for _ in range(count)], seed=seed)
            hand = table.start_hand()
            while not hand.finished:
                legal = hand.legal_actions(hand.actor_id)
                actions = [Action("check" if legal.check else "call")]
                if legal.fold:
                    actions.append(Action("fold"))
                if legal.all_in:
                    actions.append(Action("all_in"))
                if legal.min_raise_to is not None:
                    actions.append(Action("raise", legal.min_raise_to))
                table.apply_action(hand.actor_id, rng.choice(actions))
            details = public_details(hand)
            ranks = {h["name"]: best_five(h["cards"], hand.board)["rank"] for h in details["shown_hands"]}
            for pot in details["payouts"]:
                winners = [a["name"] for a in pot["awards"]]
                self.assertTrue(set(winners) <= set(pot["participants"]))
                if ranks:
                    best = max(ranks[p] for p in pot["participants"])
                    self.assertTrue(all(ranks[w] == best for w in winners), (seed, pot))

    def test_pair_kickers_wheel_and_board_only_best_five(self):
        high = best_five(["As", "Kd"], ["Ah", "2d", "7c", "8c", "9h"])
        low = best_five(["Ac", "Qd"], ["Ah", "2d", "7c", "8c", "9h"])
        self.assertGreater(high["rank"], low["rank"])
        self.assertIn("踢脚牌 K、9、8", high["comparison"])
        wheel = best_five(["As", "2d"], ["3s", "4d", "5c", "Jh", "Kh"])
        self.assertEqual(wheel["comparison"], "5 高顺子")
        board = ["Tc", "Jc", "Qc", "Kc", "Ac"]
        self.assertEqual(set(best_five(["2s", "3d"], board)["best_cards"]), set(board))

    def test_unequal_allins_side_pot_eligibility_and_refund(self):
        table = Table(["A", "B", "C"], stacks=[100, 200, 300])
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        while not hand.finished:
            table.apply_action(hand.actor_id, Action("all_in"))
        details = public_details(hand)
        self.assertEqual([p["participants"] for p in details["payouts"]], [["A", "B", "C"], ["B", "C"]])
        self.assertIn("一对 K", details["payouts"][1]["reason"])
        self.assertEqual(hand.result().returned_bets, ((2, 100),))
        self.assertEqual([p["stack"] for p in details["stacks"]], [300, 200, 100])

    def test_folded_contribution_levels_merge_without_wrong_side_pot_eligibility(self):
        table = Table(["A", "B", "C", "D"], stacks=[50, 100, 150, 200])
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd", "QsQd", "JsJd"], "2c3h7d9sTc"))
        for action in (Action("call"), Action("call"), Action("all_in"), Action("all_in"), Action("call"), Action("fold")):
            table.apply_action(hand.actor_id, action)
        self.assertTrue(hand.finished)
        details = public_details(hand)
        self.assertEqual([p["participants"] for p in details["payouts"]], [["A", "B", "C"], ["B", "C"]])
        self.assertEqual([p["awards"][0]["amount"] for p in details["payouts"]], [170, 100])
        self.assertNotIn("Js", json.dumps(details))
        self.assertNotIn("Jd", json.dumps(details))

    def test_merged_losing_allin_levels_retain_limits_and_exclude_short_winner_from_sidepot(self):
        table = Table([f"P{i}" for i in range(6)], stacks=[246,154,76,242,109,293])
        hand = table.start_hand(deck=fixed_deck(["AsKs", "Jd6c", "AcKc", "3h7h", "8cJh", "3d5c"], "6d2s6h2d5d"))
        actions = [Action("fold"), Action("call"), Action("raise",40), Action("call"), Action("raise",60),
                   Action("call"), Action("all_in"), Action("call"), Action("call"), Action("fold"), Action("all_in")]
        for action in actions:
            table.apply_action(hand.actor_id, action)
        main, side = public_details(hand)["payouts"]
        self.assertEqual(main["awards"], [{"name":"P1", "amount":631}])
        self.assertEqual({p["name"]:p["amount"] for p in main["eligibility_limits"]}, {"P1":631,"P3":631,"P4":496,"P5":631})
        self.assertEqual(side["participants"], ["P3", "P5"])
        self.assertEqual(side["awards"], [{"name":"P5", "amount":176}])
        self.assertIn("两对 6、5", side["reason"])

    def test_fold_winner_and_split_explanations_never_disclose_unshown_cards(self):
        table = Table(["A", "B", "C"])
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        for _ in range(2):
            table.apply_action(hand.actor_id, Action("fold"))
        details = public_details(hand)
        self.assertEqual(details["payouts"][0]["participants"], ["B"])
        self.assertIn("无需比牌", details["payouts"][0]["reason"])
        self.assertEqual(details["shown_hands"], [])
        for private in ("As", "Ks", "Qs", "deck", "seed"):
            self.assertNotIn(private, json.dumps(details))
        table = Table(["A", "B", "C"])
        hand = table.start_hand(deck=fixed_deck(["2s3d", "4s5d", "6s7d"], "TcJcQcKcAc"))
        check_down(table)
        self.assertIn("平分底池", public_details(hand)["payouts"][0]["reason"])


class ExperienceHTTPTests(unittest.TestCase):
    setUp = storage.PersistentHTTPTests.setUp
    launch = storage.PersistentHTTPTests.launch
    stop = storage.PersistentHTTPTests.stop
    restart = storage.PersistentHTTPTests.restart
    tearDown = storage.PersistentHTTPTests.tearDown

    def qr(self, client):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("GET", "/api/invite-qr", headers={"Cookie": client.cookie or ""})
        response = connection.getresponse()
        output = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return output

    def test_local_qr_encodes_invite_only_and_rejects_pending_or_anonymous(self):
        state = self.host.request()[1]
        with patch("qrcode.make", wraps=qrcode.make) as encode:
            status, headers, svg = self.qr(self.host)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(ElementTree.fromstring(svg).tag, "{http://www.w3.org/2000/svg}svg")
        self.assertEqual(encode.call_args.args, (state["room_info"]["join_url"],))
        self.assertNotIn(state["room_info"]["recovery_code"].encode(), svg)
        stranger = Client(self.server.server_port)
        self.assertEqual(self.qr(stranger)[0], 409)
        stranger.request("room/join", {"name": "申请者", "code": self.code})
        self.assertEqual(self.qr(stranger)[0], 409)

    def test_new_browser_recovers_persisted_away_seat_and_old_cookie_loses_access(self):
        self.host.command("room/start")
        self.friend.command("room/start")
        self.friend.command("room/away", away=True)
        before = self.friend.request()[1]
        self.restart()
        new = Client(self.server.server_port)
        status, after = new.request("room/recover", {"code": self.code, "recovery_code": before["room_info"]["recovery_code"]})
        self.assertEqual(status, 200)
        self.assertTrue(after["room_info"]["away"])
        self.assertEqual(after["viewer_id"], 1)
        self.assertEqual(after["players"][1]["cards"], before["players"][1]["cards"])
        old = self.friend.request()[1]
        self.assertEqual(old["phase"], "lobby")
        self.assertNotIn("players", old)
        self.assertIn("另一浏览器", old["room_exit"]["message"])
        self.assertTrue(after["storage"]["ok"])
        self.assertEqual(new.command("room/away", away=False)[0], 200)


if __name__ == "__main__":
    unittest.main()
