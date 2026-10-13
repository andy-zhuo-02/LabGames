import contextlib
from dataclasses import replace
import io
import unittest
from unittest.mock import patch

from bots import EquityBot, STRATEGIES, make_bot
from engine import Action, GameConfig, Table
from play_poker import main


class StrategyTests(unittest.TestCase):
    def setUp(self):
        hand = Table(seed=31).start_hand()
        self.observation = hand.observe(hand.actor_id)

    def test_styles_make_distinct_decisions_with_weak_cards(self):
        weak = replace(self.observation, hole_cards=("7s", "2d"))
        self.assertEqual(make_bot("nit", 1).choose_action(weak), Action("fold"))
        self.assertEqual(make_bot("calling_station", 1).choose_action(weak), Action("call"))
        self.assertEqual(make_bot("maniac", 1).choose_action(weak), Action("raise", 100))

    def test_calling_station_checks_even_with_premium_cards(self):
        hand = Table(seed=32).start_hand()
        hand.apply_action(2, Action("call"))
        hand.apply_action(0, Action("call"))
        observation = replace(hand.observe(1), hole_cards=("As", "Ad"))
        self.assertEqual(make_bot("calling_station").choose_action(observation), Action("check"))

    def test_calling_station_can_fold_weak_cards_to_large_bet(self):
        hand = Table(seed=33).start_hand()
        hand.apply_action(2, Action("raise", 1900))
        observation = replace(hand.observe(0), hole_cards=("7s", "2d"))
        self.assertEqual(make_bot("calling_station").choose_action(observation), Action("fold"))

    def test_short_stack_strategy_pushes_strong_hands_and_folds_weak_ones(self):
        hand = Table(config=GameConfig(starting_stack=200), seed=34).start_hand()
        observation = hand.observe(hand.actor_id)
        strong = replace(observation, hole_cards=("As", "Ad"))
        weak = replace(observation, hole_cards=("7s", "2d"))
        bot = make_bot("push_fold", 1)
        self.assertEqual(bot.choose_action(strong), Action("all_in"))
        self.assertEqual(bot.choose_action(weak), Action("fold"))

    def test_push_fold_uses_tight_strategy_with_deep_stacks(self):
        strong = replace(self.observation, hole_cards=("As", "Ad"))
        self.assertEqual(
            make_bot("push_fold", 1).choose_action(strong),
            make_bot("tight", 1).choose_action(strong),
        )

    def test_every_strategy_respects_a_short_raise_that_does_not_reopen_betting(self):
        for name in STRATEGIES:
            with self.subTest(strategy=name):
                table = Table(stacks=[55, 200, 200], seed=35)
                hand = table.start_hand()
                table.apply_action(2, Action("raise", 40))
                table.apply_action(0, Action("all_in"))
                table.apply_action(1, Action("call"))
                self.assertIsNone(hand.legal_actions(2).min_raise_to)
                action = make_bot(name, 1, equity_samples=16).choose_action(hand.observe(2))
                table.apply_action(2, action)
                self.assertIn(action.kind, ("fold", "call"))

    def test_each_strategy_completes_games_without_illegal_actions(self):
        for name in STRATEGIES:
            with self.subTest(strategy=name):
                bots = [make_bot(name, i, equity_samples=16) for i in range(3)]
                table = Table(config=GameConfig(1, 2, 30), seed=36)
                for number in range(40):
                    if table.winner:
                        table = Table(config=GameConfig(1, 2, 30), seed=36 + number)
                    hand = table.start_hand()
                    for _ in range(500):
                        if hand.finished:
                            break
                        actor = hand.actor_id
                        table.apply_action(actor, bots[actor].choose_action(hand.observe(actor)))
                    self.assertTrue(hand.finished)
                    self.assertEqual(sum(player.stack for player in table.players), 90)

    def test_cli_lists_and_selects_new_strategies(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            main(["--list-bots"])
        for name in STRATEGIES:
            self.assertIn(name, output.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as output:
            main(["--simulate", "10", "--bots", "maniac", "equity", "--hero-bot", "push_fold",
                  "--equity-samples", "16", "--seed", "37"])
        self.assertIn("模拟完成: 10 手", output.getvalue())
        self.assertIn("(equity)", output.getvalue())


class EquityTests(unittest.TestCase):
    def setUp(self):
        hand = Table(seed=38).start_hand()
        self.observation = hand.observe(hand.actor_id)

    def test_royal_flush_in_own_hand_always_wins(self):
        observation = replace(self.observation, hole_cards=("As", "Ks"), board=("Qs", "Js", "Ts", "2d", "3h"))
        self.assertEqual(EquityBot(seed=1, samples=32).estimate_equity(observation), 1)

    def test_shared_royal_flush_counts_fractional_ties_and_all_in_players(self):
        observation = replace(self.observation, hole_cards=("2d", "3h"), board=("As", "Ks", "Qs", "Js", "Ts"))
        observation = replace(observation, players=tuple(
            replace(player, stack=0) if player.player_id == 0 else player
            for player in observation.players
        ))
        bot = EquityBot(seed=1, samples=32)
        self.assertAlmostEqual(bot.estimate_equity(observation), 1 / 3)
        # A folded player no longer competes, unlike an all-in player.
        observation = replace(observation, players=tuple(
            replace(player, active=False) if player.player_id == 0 else player
            for player in observation.players
        ))
        self.assertEqual(bot.estimate_equity(observation), 0.5)

    def test_known_cards_are_not_sampled_again(self):
        observation = replace(self.observation, hole_cards=("As", "Ad"), board=("Qs", "Js", "Ts"))
        known = set(observation.hole_cards + observation.board)
        bot = EquityBot(seed=1, samples=16)
        sample = bot.rng.sample

        def checked_sample(population, count):
            self.assertFalse(known.intersection(map(repr, population)))
            cards = sample(population, count)
            self.assertEqual(len(set(cards)), count)
            return cards

        with patch.object(bot.rng, "sample", side_effect=checked_sample):
            bot.estimate_equity(observation)

    def test_seed_reproducibility_and_cache(self):
        first, second = EquityBot(42, 64), EquityBot(42, 64)
        result = first.estimate_equity(self.observation)
        self.assertEqual(result, second.estimate_equity(self.observation))
        state = first.rng.getstate()
        self.assertEqual(result, first.estimate_equity(self.observation))
        self.assertEqual(state, first.rng.getstate())

    def test_aces_have_more_equity_than_seven_deuce(self):
        aces = replace(self.observation, hole_cards=("As", "Ad"))
        weak = replace(self.observation, hole_cards=("7s", "2d"))
        self.assertGreater(
            EquityBot(42, 128).estimate_equity(aces),
            EquityBot(42, 128).estimate_equity(weak) + 0.25,
        )

    def test_equity_policy_compares_share_to_call_price(self):
        bot = EquityBot(1, 16)
        with patch.object(bot, "estimate_equity", return_value=0.1):
            self.assertEqual(bot.choose_action(self.observation), Action("fold"))
        with patch.object(bot, "estimate_equity", return_value=0.45):
            self.assertEqual(bot.choose_action(self.observation), Action("call"))
        with patch.object(bot, "estimate_equity", return_value=0.9):
            self.assertEqual(bot.choose_action(self.observation).kind, "raise")

    def test_samples_must_be_positive_integer(self):
        for samples in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                EquityBot(samples=samples)


if __name__ == "__main__":
    unittest.main()
