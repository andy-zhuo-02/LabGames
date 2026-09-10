import contextlib
from dataclasses import FrozenInstanceError, asdict, replace
import io
import json
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch

from pokerkit import Card, Deck

from bots import RuleBot, make_bot, passive_action
from engine import Action, GameConfig, Hand, IllegalAction, Table
from play_poker import QuitGame, human_action, main, parse_action, show_result, write_history


def fixed_deck(holes, board):
    """Deal known cards in positional round-robin order, including burns."""
    hole_cards = [list(Card.parse(cards)) for cards in holes]
    board_cards = list(Card.parse(board))
    used = [card for pair in hole_cards for card in pair] + board_cards
    if len(set(used)) != len(used):
        raise ValueError("Duplicate fixture cards")
    remaining = [card for card in Deck.STANDARD if card not in used]
    burns, rest = remaining[:3], remaining[3:]
    return (
        [pair[index] for index in range(2) for pair in hole_cards]
        + [burns[0]] + board_cards[:3] + [burns[1]] + board_cards[3:4]
        + [burns[2]] + board_cards[4:] + rest
    )


def check_down(table):
    for _ in range(100):
        hand = table.hand
        if hand.finished:
            return hand.result()
        table.apply_action(hand.actor_id, passive_action(hand.observe(hand.actor_id)))
    raise AssertionError("Hand did not finish")


class EngineTests(unittest.TestCase):
    def test_pot_survives_bet_collection(self):
        table = Table(seed=1)
        hand = table.start_hand()
        self.assertEqual(hand.observe(0).pot, 30)
        for _ in range(3):
            table.apply_action(hand.actor_id, passive_action(hand.observe(hand.actor_id)))
        observation = hand.observe(0)
        self.assertEqual(observation.street, "flop")
        self.assertEqual(observation.pot, 60)
        self.assertEqual(sum(player.bet for player in observation.players), 0)
        self.assertEqual(len(observation.board), 3)

    def test_illegal_actions_leave_state_unchanged(self):
        table = Table(seed=2)
        hand = table.start_hand()
        before = hand.observe(2)
        for action in (Action("check"), Action("raise", 21), Action("raise", -1),
                       Action("raise", 2001), Action("raise", True), Action("fold", 50)):
            with self.subTest(action=action), self.assertRaises(IllegalAction):
                table.apply_action(2, action)
            self.assertEqual(before, hand.observe(2))
        with self.assertRaises(IllegalAction):
            table.apply_action(0, Action("fold"))
        self.assertEqual(hand.actions, [])

    def test_raise_means_total_not_additional(self):
        table = Table(seed=3)
        hand = table.start_hand()
        table.apply_action(2, Action("call"))
        table.apply_action(0, Action("raise", 100))
        player = hand.observe(0).players[0]
        self.assertEqual((player.bet, player.stack), (100, 1900))
        self.assertEqual(hand.actions[-1].paid, 90)

    def test_all_fold_returns_uncalled_bet_and_hides_cards(self):
        table = Table(seed=4)
        hand = table.start_hand()
        table.apply_action(2, Action("fold"))
        table.apply_action(0, Action("fold"))
        self.assertTrue(hand.finished)
        self.assertEqual([player.stack for player in table.players], [1990, 2010, 2000])
        result = hand.result()
        self.assertEqual(result.shown_hands, ())
        self.assertEqual(result.board, ())
        self.assertEqual(result.payouts[0].awards, ((1, 10),))
        self.assertEqual(result.returned_bets, ((1, 20),))

    def test_regular_showdown_shows_losing_hands_too(self):
        table = Table()
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        result = check_down(table)
        self.assertEqual({shown.player_id: shown.cards for shown in result.shown_hands}, {
            0: ("As", "Ad"), 1: ("Ks", "Kd"), 2: ("Qs", "Qd"),
        })
        self.assertEqual(dict(result.payoffs), {0: 40, 1: -20, 2: -20})

    def test_showdown_does_not_reveal_previously_folded_hand(self):
        table = Table()
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        table.apply_action(2, Action("fold"))
        result = check_down(table)
        self.assertEqual({shown.player_id for shown in result.shown_hands}, {0, 1})
        self.assertEqual(dict(result.payoffs), {0: 20, 1: -20, 2: 0})

    def test_five_board_cards_do_not_imply_showdown(self):
        table = Table()
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        while hand.street != "river":
            table.apply_action(hand.actor_id, passive_action(hand.observe(hand.actor_id)))
        table.apply_action(0, Action("raise", 100))
        table.apply_action(1, Action("fold"))
        table.apply_action(2, Action("fold"))
        self.assertTrue(hand.finished)
        self.assertEqual(len(hand.board), 5)
        self.assertEqual(hand.result().shown_hands, ())
        self.assertEqual(dict(hand.result().payoffs), {0: 40, 1: -20, 2: -20})

    def test_short_all_in_does_not_reopen_raising(self):
        table = Table(stacks=[55, 200, 200], seed=5)
        hand = table.start_hand()
        table.apply_action(2, Action("raise", 40))
        table.apply_action(0, Action("all_in"))
        table.apply_action(1, Action("call"))
        legal = hand.legal_actions(2)
        self.assertEqual(legal.call_amount, 15)
        self.assertIsNone(legal.min_raise_to)
        self.assertFalse(legal.all_in)
        with self.assertRaises(IllegalAction):
            table.apply_action(2, Action("raise", 100))
        check_down(table)

    def test_short_call_can_use_all_in_command(self):
        table = Table(stacks=[30, 100, 100], seed=6)
        hand = table.start_hand()
        table.apply_action(2, Action("raise", 60))
        self.assertTrue(hand.legal_actions(0).all_in)
        self.assertEqual(hand.legal_actions(0).call_amount, 20)
        table.apply_action(0, Action("all_in"))
        self.assertEqual(hand.actions[-1].paid, 20)
        self.assertEqual(hand.observe(0).players[0].stack, 0)
        check_down(table)

    def test_side_pot_goes_to_different_winner(self):
        table = Table(stacks=[100, 200, 300], seed=7)
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd", "QsQd"], "2c3h7d9sTc"))
        table.apply_action(2, Action("all_in"))
        table.apply_action(0, Action("all_in"))
        table.apply_action(1, Action("all_in"))
        self.assertTrue(hand.finished)
        self.assertEqual([player.stack for player in table.players], [300, 200, 100])
        self.assertEqual(dict(hand.result().payoffs), {0: 200, 1: 0, 2: -200})
        self.assertEqual([payout.awards for payout in hand.result().payouts], [((0, 300),), ((1, 200),)])
        self.assertEqual(hand.result().returned_bets, ((2, 100),))
        self.assertEqual(len(hand.board), 5)
        self.assertEqual({shown.player_id for shown in hand.result().shown_hands}, {0, 1, 2})

    def test_board_plays_split_pot(self):
        table = Table(config=GameConfig(1, 2, 101), seed=8)
        hand = table.start_hand(deck=fixed_deck(["2s3d", "4s5d", "6s7d"], "TcJcQcKcAc"))
        while not hand.finished:
            table.apply_action(hand.actor_id, Action("all_in"))
        self.assertEqual([player.stack for player in table.players], [101, 101, 101])
        self.assertEqual(hand.result().payouts[0].awards, ((0, 101), (1, 101), (2, 101)))

    def test_odd_chip_awarded_by_position(self):
        table = Table(config=GameConfig(1, 2, 5), seed=9)
        hand = table.start_hand(deck=fixed_deck(["AsKd", "AhKs", "QdJc"], "2c3d7h8s9c"))
        while not hand.finished:
            table.apply_action(hand.actor_id, Action("all_in"))
        self.assertEqual([player.stack for player in table.players], [8, 7, 0])

    def test_three_player_button_rotation_preserves_identity(self):
        table = Table(seed=10)
        for order in ((0, 1, 2), (1, 2, 0), (2, 0, 1), (0, 1, 2)):
            hand = table.start_hand()
            self.assertEqual(hand.player_ids, order)
            self.assertEqual(hand.actor_id, order[-1])
            self.assertEqual([p.position for p in hand.observe(0).players], ["SB", "BB", "BTN"])
            for _ in range(2):
                table.apply_action(hand.actor_id, Action("fold"))
            self.assertEqual(sum(player.stack for player in table.players), 6000)
            self.assertEqual(table.players[0].name, "You")

    def test_heads_up_button_acts_first_preflop_last_postflop(self):
        table = Table(("A", "B"), seed=11)
        for expected_button in (1, 0, 1):
            hand = table.start_hand()
            self.assertEqual(hand.actor_id, expected_button)
            observation = hand.observe(expected_button)
            self.assertEqual([(p.position, p.bet) for p in observation.players], [("BB", 20), ("BTN/SB", 10)])
            for _ in range(2):
                table.apply_action(hand.actor_id, passive_action(hand.observe(hand.actor_id)))
            self.assertEqual(hand.street, "flop")
            self.assertEqual(hand.actor_id, 1 - expected_button)
            check_down(table)

    def test_each_eliminated_position_transitions_to_heads_up(self):
        for eliminated in range(3):
            with self.subTest(eliminated=eliminated):
                stacks = [100, 100, 100]
                stacks[eliminated] = 20
                holes = ["KsKd"] * 3
                holes[eliminated] = "QsQd"
                holes[(eliminated + 1) % 3] = "AsAd"
                table = Table(stacks=stacks, seed=12)
                table.start_hand(deck=fixed_deck(holes, "2c3h7d9sTc"))
                check_down(table)
                self.assertEqual(table.players[eliminated].stack, 0)
                hand = table.start_hand()
                self.assertNotIn(eliminated, hand.player_ids)
                expected_bb = next(seat for seat in (2, 0, 1) if seat != eliminated)
                self.assertEqual(hand.player_ids[0], expected_bb)
                self.assertEqual(hand.actor_id, hand.player_ids[1])
                self.assertEqual(sum(p.stack for p in table.players), 220)

    def test_blinds_can_end_hand_without_any_player_action(self):
        table = Table(("A", "B"), stacks=[1, 1], seed=13)
        hand = table.start_hand(deck=fixed_deck(["AsAd", "KsKd"], "2c3h7d9sTc"))
        self.assertTrue(hand.finished)
        self.assertEqual(hand.actions, [])
        self.assertEqual([p.stack for p in table.players], [2, 0])
        self.assertEqual(table.winner.player_id, 0)
        with self.assertRaises(ValueError):
            table.start_hand()

    def test_observation_is_immutable_and_contains_no_opponent_cards(self):
        observations = []
        for holes in (["AsAd", "KsKd", "QsQd"], ["AsAd", "JsJd", "TsTd"]):
            table = Table(seed=14)
            hand = table.start_hand(deck=fixed_deck(holes, "2c3h7d9s8c"))
            observations.append(hand.observe(0))
        self.assertEqual(observations[0], observations[1])
        self.assertEqual(observations[0].hole_cards, ("As", "Ad"))
        self.assertNotIn("hole_cards", asdict(observations[0].players[1]))
        self.assertNotIn("seed", asdict(observations[0]))
        with self.assertRaises(FrozenInstanceError):
            observations[0].pot = 1

    def test_reproducible_deck_and_replay(self):
        tables = [Table(seed=15), Table(seed=15)]
        first = tables[0].start_hand()
        random.seed(12345)
        for _ in range(100):
            random.random()
        second = tables[1].start_hand()
        self.assertEqual(first.observe(0), second.observe(0))
        result = check_down(tables[0])
        replay = Hand(first.players, first.config, first.hand_number, first.seed)
        for record in first.actions:
            replay.apply_action(record.player_id, record.action)
        self.assertEqual(replay.result(), result)

    def test_invalid_configuration_and_overlapping_hands(self):
        for kwargs in ({"small_blind": 0}, {"big_blind": 1}, {"starting_stack": -1}):
            with self.assertRaises(ValueError):
                GameConfig(**kwargs)
        for stacks in ([0, 0, 10], [1, 2], [1, -1, 2]):
            with self.assertRaises(ValueError):
                Table(stacks=stacks)
        table = Table(seed=16)
        table.start_hand()
        with self.assertRaises(ValueError):
            table.start_hand()
        with self.assertRaises(ValueError):
            table.hand.result()


class BotAndCliTests(unittest.TestCase):
    def test_parser_has_distinct_check_call_and_all_in(self):
        for text, action in ((" x ", Action("check")), ("c", Action("call")),
                             ("bet 100", Action("raise", 100)), ("A", Action("all_in"))):
            self.assertEqual(parse_action(text), action)
        for text in ("", "check 20", "raise abc", "raise -1", "raise 0", "call extra"):
            with self.assertRaises(IllegalAction):
                parse_action(text)
        with self.assertRaises(QuitGame):
            parse_action("q")

    def test_human_check_does_not_silently_call(self):
        table = Table(seed=20)
        hand = table.start_hand()
        output = io.StringIO()
        with patch("builtins.input", side_effect=["check", "raise nope", "call"]), contextlib.redirect_stdout(output):
            human_action(table, 2)
        self.assertIn("非法动作", output.getvalue())
        self.assertEqual(len(hand.actions), 1)
        self.assertEqual(hand.actions[0].action.kind, "call")
        self.assertEqual(hand.actions[0].paid, 20)

    def test_rule_bot_values_premium_hands_more(self):
        hand = Table(seed=21).start_hand()
        observation = hand.observe(hand.actor_id)
        premium = replace(observation, hole_cards=("As", "Ad"))
        trash = replace(observation, hole_cards=("7s", "2d"))
        self.assertGreater(RuleBot.strength(premium), RuleBot.strength(trash))
        self.assertEqual(make_bot("tight", 1).choose_action(trash), Action("fold"))
        self.assertEqual(make_bot("tight", 1).choose_action(premium).kind, "raise")

    def test_board_hand_is_not_treated_as_private_strength(self):
        hand = Table(seed=22).start_hand()
        observation = replace(hand.observe(2), hole_cards=("2s", "3d"), board=("Tc", "Jc", "Qc", "Kc", "Ac"))
        self.assertEqual(RuleBot.strength(observation), 0.25)

    def test_history_records_finished_hand_and_can_replay(self):
        table = Table(seed=23)
        table.start_hand()
        result = check_down(table)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hands.jsonl"
            write_history(path, table, ("loose", "random", "tight"))
            entry = json.loads(path.read_text())
        self.assertEqual(entry["result"]["hand_number"], 1)
        self.assertEqual(len(entry["actions"]), len(table.hand.actions))
        replay = Hand(table.hand.players, table.config, 1, entry["hand_seed"])
        for record in entry["actions"]:
            replay.apply_action(record["player_id"], Action(**record["action"]))
        self.assertEqual(replay.result(), result)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            show_result(table)
        self.assertIn("净盈亏", output.getvalue())
        self.assertIn("主池", output.getvalue())

    def test_cli_simulation_and_clean_exit(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            main(["--simulate", "30", "--stack", "40", "--seed", "24"])
        self.assertIn("模拟完成: 30 手", output.getvalue())
        for exception in (EOFError, KeyboardInterrupt):
            with patch("builtins.input", side_effect=exception), contextlib.redirect_stdout(io.StringIO()) as output:
                main(["--seed", "24"])
            self.assertIn("已退出", output.getvalue())

    def test_1000_seeded_bot_hands_are_legal_and_conserve_chips(self):
        config = GameConfig(1, 2, 40)
        bots = {i: make_bot(style, 100 + i) for i, style in enumerate(("random", "tight", "loose"))}
        table = Table(config=config, seed=25)
        matches = 0
        saw_heads_up = False
        for number in range(1000):
            if table.winner:
                matches += 1
                table = Table(config=config, seed=25 + number)
            hand = table.start_hand()
            saw_heads_up |= len(hand.players) == 2
            for _ in range(1000):
                if hand.finished:
                    break
                actor = hand.actor_id
                observation = hand.observe(actor)
                self.assertEqual(sum(p.stack for p in observation.players) + observation.pot, 120)
                table.apply_action(actor, bots[actor].choose_action(observation))
            self.assertTrue(hand.finished)
            self.assertEqual(sum(p.stack for p in table.players), 120)
            self.assertEqual(sum(payoff for _, payoff in hand.result().payoffs), 0)
        self.assertGreater(matches, 0)
        self.assertTrue(saw_heads_up)


if __name__ == "__main__":
    unittest.main()
