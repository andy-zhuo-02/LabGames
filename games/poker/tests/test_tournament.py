import json
from pathlib import Path
import tempfile
import unittest

from bots import STRATEGIES
from engine import GameConfig
from plot_tournament import load_run
from tournament import run_tournament


class TournamentTests(unittest.TestCase):
    def test_all_bots_share_one_table_until_one_winner(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "match"
            summary = run_tournament(output, seed=10, config=GameConfig(1, 2, 4), equity_samples=4)
            checked, rows = load_run(output)
            self.assertEqual(summary, checked)
            self.assertEqual(summary["status"], "complete")
            self.assertEqual(list(rows[0]), ["hand", *STRATEGIES])
            self.assertEqual(len(rows), summary["hands_played"] + 1)
            self.assertEqual(sum(player["final_stack"] > 0 for player in summary["players"]), 1)
            self.assertEqual(rows[-1][summary["winner"]], 32)
            self.assertTrue(all(sum(row[name] for name in STRATEGIES) == 32 for row in rows))
            logs = [json.loads(line) for line in (output / "hands.jsonl").read_text().splitlines()]
            self.assertEqual([log["result"]["hand_number"] for log in logs], list(range(1, len(rows))))
            for player in summary["players"]:
                name = player["strategy"]
                self.assertEqual(player["peak_stack"], max(row[name] for row in rows))
                hand = player["eliminated_hand"]
                if hand is not None:
                    self.assertGreater(rows[hand - 1][name], 0)
                    self.assertTrue(all(row[name] == 0 for row in rows[hand:]))
                    self.assertGreater(player["place"], 1)
                else:
                    self.assertEqual(player["place"], 1)
            # Reusing a path must not mix another match into the existing history.
            with self.assertRaises(FileExistsError):
                run_tournament(output, config=GameConfig(1, 2, 4), equity_samples=4)

    def test_same_seed_reproduces_the_whole_tournament(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("a", "b"):
                run_tournament(root / name, seed=11, config=GameConfig(1, 2, 4), equity_samples=4)
            self.assertEqual((root / "a/stacks.csv").read_bytes(), (root / "b/stacks.csv").read_bytes())
            self.assertEqual((root / "a/summary.json").read_bytes(), (root / "b/summary.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
