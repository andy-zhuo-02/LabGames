import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hand, Table, DECK, evaluate } from "../src/engine.mjs";
import { make_bot, passive_action, STRATEGIES } from "../src/bots.mjs";

const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/pokerkit-hands.json", import.meta.url)),
);
for (const fixture of oracle)
  test(`PokerKit reference hand ${fixture.seed}`, () => {
    const hand = new Hand(fixture.players, {}, 1, fixture.seed, {
      deck: fixture.deck,
    });
    for (const [i, step] of fixture.steps.entries()) {
      assert.deepEqual(
        hand.observe(hand.actor_id),
        step.observation,
        `step ${i}`,
      );
      hand.apply_action(hand.actor_id, step.action);
    }
    const actual = hand.result(),
      expected = fixture.result;
    for (const key of ["board", "stacks", "payoffs", "returned_bets"])
      assert.deepEqual(actual[key], expected[key], key);
    const sort = (xs) => xs.toSorted((a, b) => a.player_id - b.player_id);
    assert.deepEqual(sort(actual.shown_hands), sort(expected.shown_hands));
    // Equivalent contribution bands can be combined by PokerKit. Compare total awards per seat.
    const awards = (result) =>
      result.payouts
        .flatMap((p) => p.awards)
        .reduce(
          (out, [id, amount]) => ({ ...out, [id]: (out[id] || 0) + amount }),
          {},
        );
    assert.deepEqual(awards(actual), awards(expected));
  });
test("rejects illegal actions without mutating the hand", () => {
  const hand = new Table().start_hand(),
    before = hand.observe(hand.actor_id);
  for (const action of [
    { kind: "check" },
    { kind: "raise", amount: 21 },
    { kind: "raise", amount: true },
    { kind: "fold", amount: 4 },
  ]) {
    assert.throws(() => hand.apply_action(hand.actor_id, action));
    assert.deepEqual(hand.observe(hand.actor_id), before);
  }
});
test("all eight policies play legal games and conserve chips", () => {
  const styles = Object.keys(STRATEGIES);
  for (let s = 0; s < 80; s++) {
    const table = new Table(
      styles,
      { small_blind: 1, big_blind: 2, starting_stack: 40 },
      { seed: s },
    );
    const bots = styles.map((style, i) => make_bot(style, s + i, 4));
    for (let round = 0; round < 15 && !table.winner; round++) {
      const hand = table.start_hand();
      for (let k = 0; !hand.finished && k < 1000; k++)
        table.apply_action(
          hand.actor_id,
          bots[hand.actor_id].choose_action(hand.observe(hand.actor_id)),
        );
      assert.equal(hand.finished, true);
      assert.equal(
        table.players.reduce((n, p) => n + p.stack, 0),
        320,
      );
    }
  }
});
test("a short all-in raise does not reopen betting for a previous actor", () => {
  const table = new Table(undefined, {}, { stacks: [55, 200, 200] });
  const h = table.start_hand();
  table.apply_action(2, { kind: "raise", amount: 40 });
  table.apply_action(0, { kind: "all_in" });
  table.apply_action(1, { kind: "call" });
  assert.equal(h.legal_actions(2).min_raise_to, null);
  assert.equal(h.legal_actions(2).call_amount, 15);
  while (!h.finished)
    table.apply_action(h.actor_id, passive_action(h.observe(h.actor_id)));
});
test("hand ranking handles wheel, board ties, kickers and duplicate cards", () => {
  const cards = (s) => s.match(/../g);
  assert.equal(evaluate(cards("Ac2c3c4c5cKdQd")).category, 8);
  assert.ok(
    evaluate(cards("AsAdKsKdQd")).score > evaluate(cards("AhAcKhKcJd")).score,
  );
  assert.equal(
    evaluate(cards("2s3dTcJcQcKcAc")).score,
    evaluate(cards("4h5dTcJcQcKcAc")).score,
  );
  assert.throws(() => evaluate(Array(5).fill(DECK[0])));
});
