import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  makeDeck,
  applyAction,
  publicView,
  roundPoints,
  numbers,
  pendingEffect,
  currentActor,
  validateSave,
  canStay,
} from "../src/game.js";
import { chooseBotAction } from "../src/bot.js";

const players = [
  { id: "you", name: "你" },
  { id: "b", name: "小橘", bot: true },
  { id: "c", name: "阿栗", bot: true, style: "bold" },
];
function fixture({
  hands = [[], [], []],
  draws = [],
  scores = [0, 0, 0],
  statuses = ["active", "active", "active"],
} = {}) {
  const state = createGame({ players, seed: 42 });
  const pool = makeDeck();
  function take(value) {
    const spec =
      typeof value === "number"
        ? { kind: "number", value }
        : typeof value === "string"
          ? { kind: value }
          : value;
    const index = pool.findIndex(
      (c) => c.kind === spec.kind && c.value === spec.value,
    );
    assert.notEqual(index, -1, `Missing card ${JSON.stringify(spec)}`);
    return pool.splice(index, 1)[0];
  }
  state.players.forEach((p, i) => {
    p.cards = hands[i].map(take);
    p.score = scores[i];
    p.status = statuses[i];
    p.roundScore = 0;
  });
  state.deck = draws.map(take).reverse();
  state.discard = pool;
  state.turn = 0;
  state.resume = 0;
  state.starter = 0;
  state.queue = [];
  state.phase = "playing";
  state.winner = null;
  state.history = [];
  state.events = [];
  state.eventId = 0;
  return state;
}
const hit = (s) => applyAction(s, "you", { type: "hit" });
const target = (s, id) =>
  applyAction(s, currentActor(s), { type: "target", targetId: id });

test("standard deck: 94 unique cards with the correct number distribution", () => {
  const deck = makeDeck();
  assert.equal(deck.length, 94);
  assert.equal(new Set(deck.map((c) => c.id)).size, 94);
  for (let n = 0; n <= 12; n++)
    assert.equal(
      deck.filter((c) => c.kind === "number" && c.value === n).length,
      Math.max(1, n),
    );
  for (const kind of ["second", "freeze", "three"])
    assert.equal(deck.filter((c) => c.kind === kind).length, 3);
  assert.equal(deck.filter((c) => c.kind === "add").length, 5);
  assert.equal(deck.filter((c) => c.kind === "multiply").length, 1);
});

test("seeded games are deterministic, and initial actions resolve before later dealing", () => {
  const a = createGame({ players, seed: 3 });
  assert.deepEqual(a, createGame({ players, seed: 3 }));
  assert.ok(validateSave(a));
  let initialActionFound = false;
  for (let seed = 1; seed < 100; seed++) {
    let s = createGame({ players, seed });
    if (pendingEffect(s)) {
      initialActionFound = true;
      const actor = currentActor(s);
      assert.throws(() => applyAction(s, actor, { type: "hit" }), /有效目标/);
      s = target(s, pendingEffect(s).targets[0]);
      assert.ok(validateSave(s));
    }
  }
  assert.ok(initialActionFound);
});

test("a normal hit moves play on, and does not mutate previous state", () => {
  const original = fixture({ hands: [[4], [5], [6]], draws: [10] });
  const copy = structuredClone(original);
  const s = hit(original);
  assert.deepEqual(original, copy);
  assert.equal(currentActor(s), "b");
  assert.deepEqual(numbers(s.players[0]), [4, 10]);
});

test("duplicate busts, modifiers also score zero; busted cards stay on the table", () => {
  const s = hit(
    fixture({
      hands: [[12, { kind: "add", value: 10 }, "multiply"], [4], [5]],
      draws: [12],
    }),
  );
  assert.equal(s.players[0].status, "busted");
  assert.equal(roundPoints(s.players[0]), 0);
  assert.deepEqual(numbers(s.players[0]), [12, 12]);
  assert.ok(validateSave(s));
});

test("second chance discards only itself and the duplicate, then passes the turn", () => {
  const s = hit(fixture({ hands: [[12, "second"], [4], [5]], draws: [12] }));
  assert.equal(s.players[0].status, "active");
  assert.equal(s.players[0].cards.length, 1);
  assert.equal(roundPoints(s.players[0]), 12);
  assert.equal(currentActor(s), "b");
  assert.ok(validateSave(s));
});

test("second chance cannot protect against freeze", () => {
  let s = hit(
    fixture({ hands: [[12, "second"], [4], [5]], draws: ["freeze"] }),
  );
  s = target(s, "you");
  assert.equal(s.players[0].status, "frozen");
  assert.equal(roundPoints(s.players[0]), 12);
});

test("second chance surplus must go to another eligible active player", () => {
  let s = hit(
    fixture({ hands: [["second"], ["second"], [5]], draws: ["second"] }),
  );
  assert.deepEqual(pendingEffect(s).targets, ["c"]);
  assert.throws(() => target(s, "you"), /有效目标/);
  s = target(s, "c");
  assert.ok(s.players[2].cards.some((c) => c.kind === "second"));
  assert.ok(validateSave(s));
});

test("surplus second chance is discarded when all other players are inactive", () => {
  const s = hit(
    fixture({
      hands: [["second"], [4], [5]],
      statuses: ["active", "banked", "busted"],
      draws: ["second"],
    }),
  );
  assert.equal(pendingEffect(s), null);
  assert.equal(s.players[0].cards.length, 1);
  assert.ok(validateSave(s));
});

test("multipliers affect number points only, then additions and flip7 bonus", () => {
  const s = fixture({
    hands: [
      [0, 1, 2, 3, 4, 5, 6, "multiply", { kind: "add", value: 10 }],
      [],
      [],
    ],
  });
  assert.equal(roundPoints(s.players[0]), 21 * 2 + 10 + 15);
  assert.equal(
    roundPoints(
      fixture({ hands: [[{ kind: "add", value: 8 }, "multiply"], [], []] })
        .players[0],
    ),
    8,
  );
});

test("flip7 including zero immediately banks all survivors and ends the round", () => {
  const s = hit(
    fixture({ hands: [[0, 1, 2, 3, 4, 5], [12, 8], [9]], draws: [6] }),
  );
  assert.equal(s.phase, "roundEnd");
  assert.equal(s.players[0].score, 36);
  assert.equal(s.players[1].score, 20);
  assert.equal(s.players[2].score, 9);
  assert.equal(s.history[0].flipId, "you");
  assert.ok(validateSave(s));
});

test("cannot bank with no card, but a zero or modifier permits staying", () => {
  assert.throws(
    () => applyAction(fixture(), "you", { type: "stay" }),
    /不能执行/,
  );
  for (const card of [0, "second", { kind: "add", value: 2 }])
    assert.ok(canStay(fixture({ hands: [[card], [], []] }).players[0]));
});

test("freeze targets only active players, including self; no extra turn for recipient", () => {
  let s = hit(
    fixture({
      hands: [[3], [4], [5]],
      statuses: ["active", "active", "banked"],
      draws: ["freeze"],
    }),
  );
  assert.deepEqual(pendingEffect(s).targets, ["you", "b"]);
  s = target(s, "b");
  assert.equal(s.players[1].status, "frozen");
  assert.equal(currentActor(s), "you");
});

test("last active player must use action on self, freezing ends the round", () => {
  let s = hit(
    fixture({
      hands: [[3], [4], [5]],
      statuses: ["active", "banked", "busted"],
      draws: ["freeze"],
    }),
  );
  assert.deepEqual(pendingEffect(s).targets, ["you"]);
  s = target(s, "you");
  assert.equal(s.phase, "roundEnd");
  assert.deepEqual(
    s.players.map((p) => p.score),
    [3, 4, 0],
  );
});

test("flip three counts modifiers and restores turn after the original drawer", () => {
  let s = hit(
    fixture({
      hands: [[3], [4], [5]],
      draws: ["three", 10, { kind: "add", value: 6 }, 9],
    }),
  );
  s = target(s, "c");
  assert.deepEqual(numbers(s.players[2]), [5, 10, 9]);
  assert.equal(roundPoints(s.players[2]), 30);
  assert.equal(currentActor(s), "b");
  assert.ok(validateSave(s));
});

test("flip three stops at bust and discards deferred freeze without executing it", () => {
  let s = hit(
    fixture({ hands: [[3], [4], [5]], draws: ["three", "freeze", 5, 9] }),
  );
  s = target(s, "c");
  assert.equal(s.players[2].status, "busted");
  assert.equal(s.deck.at(-1).value, 9);
  assert.equal(pendingEffect(s), null);
  assert.ok(validateSave(s));
});

test("flip three defers freeze, then surviving recipient chooses a target", () => {
  let s = hit(
    fixture({ hands: [[3], [4], [5]], draws: ["three", "freeze", 10, 9] }),
  );
  s = target(s, "c");
  assert.equal(pendingEffect(s).owner, "c");
  assert.deepEqual(numbers(s.players[2]), [5, 10, 9]);
  s = target(s, "you");
  assert.equal(s.players[0].status, "frozen");
  assert.equal(currentActor(s), "b");
  assert.ok(validateSave(s));
});

test("nested flip three resolves after the initial three cards", () => {
  let s = hit(
    fixture({
      hands: [[3], [4], [5]],
      draws: ["three", "three", 10, 9, 8, 7, 6],
    }),
  );
  s = target(s, "c");
  assert.deepEqual(numbers(s.players[2]), [5, 10, 9]);
  assert.equal(pendingEffect(s).owner, "c");
  s = target(s, "b");
  assert.deepEqual(numbers(s.players[1]), [4, 8, 7, 6]);
  assert.equal(currentActor(s), "b");
  assert.ok(validateSave(s));
});

test("second chance acquired in flip three works immediately and forced draws continue", () => {
  let s = hit(
    fixture({ hands: [[3], [4], [5]], draws: ["three", "second", 5, 9] }),
  );
  s = target(s, "c");
  assert.equal(s.players[2].status, "active");
  assert.deepEqual(numbers(s.players[2]), [5, 9]);
  assert.ok(validateSave(s));
});

test("surplus second chance interrupts flip three, then resumes remaining cards", () => {
  let s = hit(
    fixture({
      hands: [[3], [4], [5, "second"]],
      draws: ["three", "second", 5, 9],
    }),
  );
  s = target(s, "c");
  assert.equal(pendingEffect(s).card.kind, "second");
  s = target(s, "you");
  assert.ok(s.players[0].cards.some((c) => c.kind === "second"));
  assert.deepEqual(numbers(s.players[2]), [5, 9]);
  assert.equal(currentActor(s), "b");
  assert.ok(validateSave(s));
});

test("flip7 during forced draws ends round, discarding deferred actions and leaving remaining deck", () => {
  let s = hit(
    fixture({
      hands: [[3], [4], [0, 1, 2, 5, 6, 7]],
      draws: ["three", "freeze", 10, 9],
    }),
  );
  s = target(s, "c");
  assert.equal(s.phase, "roundEnd");
  assert.equal(s.deck.at(-1).value, 9);
  assert.equal(s.players[2].status, "flip7");
  assert.ok(validateSave(s));
});

test("highest score reaching 200 wins only at round end", () => {
  let s = fixture({ hands: [[12], [10], [5]], scores: [199, 199, 180] });
  s = applyAction(s, "you", { type: "stay" });
  assert.equal(s.phase, "playing");
  s = applyAction(s, "b", { type: "stay" });
  s = applyAction(s, "c", { type: "stay" });
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "you");
  assert.throws(() => applyAction(s, "you", { type: "nextRound" }), /不能开始/);
});

test("tie at 200 continues with every player, remaining deck preserved and starter rotated", () => {
  let s = fixture({
    hands: [[12], [12], [5]],
    scores: [188, 188, 100],
    draws: [1, 2, 3, 4],
  });
  for (const p of players) s = applyAction(s, p.id, { type: "stay" });
  assert.equal(s.phase, "roundEnd");
  assert.equal(s.winner, null);
  s = applyAction(s, "you", { type: "nextRound" });
  assert.equal(s.starter, 1);
  assert.equal(currentActor(s), "b");
  assert.equal(s.deck.length, 1);
  assert.deepEqual(
    s.players.map((p) => numbers(p)),
    [[3], [1], [2]],
  );
  assert.ok(validateSave(s));
});

test("mid-round reshuffle keeps every table card, even busted duplicates, out of the deck", () => {
  const s = hit(
    fixture({
      hands: [[1], [12, 12], [5]],
      statuses: ["active", "busted", "banked"],
    }),
  );
  const tableIds = s.players.flatMap((p) => p.cards.map((c) => c.id));
  assert.ok(s.deck.every((c) => !tableIds.includes(c.id)));
  assert.ok(validateSave(s));
});

test("public view hides deck order, RNG, discard content, and internal queue", () => {
  const view = publicView(createGame({ players, seed: 20 }));
  for (const key of ["deck", "discard", "queue", "rng"])
    assert.equal(key in view, false);
  assert.ok(Number.isInteger(view.deckCount));
  const pending = hit(fixture({ hands: [[3], [4], [5]], draws: ["freeze"] }));
  publicView(pending).pending.card.kind = "three";
  assert.equal(pendingEffect(pending).card.kind, "freeze");
});

test("illegal and out-of-turn actions cannot change the game", () => {
  const s = fixture({ hands: [[1], [2], [3]], draws: [4] });
  assert.throws(() => applyAction(s, "c", { type: "hit" }), /轮到/);
  assert.throws(
    () => applyAction(s, "you", { type: "target", targetId: "b" }),
    /不能执行/,
  );
  assert.throws(() => applyAction(s, "you", null), /无效/);
});

test("save validation rejects corrupted versions, duplicate/missing cards and invalid seats", () => {
  const s = createGame({ players, seed: 4 });
  assert.ok(validateSave(JSON.parse(JSON.stringify(s))));
  assert.equal(validateSave({ ...s, schema: 999 }), false);
  assert.equal(validateSave({ ...s, turn: -1 }), false);
  assert.equal(validateSave({ ...s, deck: s.deck.slice(1) }), false);
  assert.equal(validateSave({ ...s, deck: [...s.deck, s.deck[0]] }), false);
  assert.equal(validateSave(null), false);
});

test("300 complete seeded matches preserve all 94 cards, resume from JSON, and terminate", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const seats = [...players];
    for (let i = 0; i < seed % 4; i++)
      seats.push({
        id: `extra-${i}`,
        name: `电脑 ${i}`,
        bot: true,
        style: ["careful", "balanced", "bold"][i],
      });
    let s = createGame({ players: seats, seed });
    let moves = 0;
    while (s.phase !== "finished" && moves++ < 3000) {
      const before = s.players.map((p) => p.score);
      if (s.phase === "roundEnd")
        s = applyAction(s, "you", { type: "nextRound" });
      else
        s = applyAction(
          s,
          currentActor(s),
          chooseBotAction(publicView(s), currentActor(s)),
        );
      assert.ok(
        validateSave(s),
        `Invalid state at seed ${seed}, move ${moves}`,
      );
      assert.ok(s.players.every((p, i) => p.score >= before[i]));
      s = JSON.parse(JSON.stringify(s));
    }
    assert.equal(s.phase, "finished", `Seed ${seed} did not finish`);
    const winner = s.players.find((p) => p.id === s.winner);
    assert.ok(winner.score >= 200);
    assert.ok(
      s.players.every((p) => p.id === winner.id || p.score < winner.score),
    );
  }
});
