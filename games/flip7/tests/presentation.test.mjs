import test from "node:test";
import assert from "node:assert/strict";
import { standings, presentationEvents } from "../web/presentation.js";
import {
  createGame,
  makeDeck,
  applyAction,
  publicView,
  validateSave,
} from "../src/game.js";

test("final rankings include every seat, preserve ties and compute round achievements", () => {
  const game = {
    players: [
      { id: "a", score: 190 },
      { id: "b", score: 230 },
      { id: "c", score: 190 },
      { id: "d", score: 150 },
      { id: "e", score: 100 },
      { id: "f", score: 0 },
    ],
    history: [
      {
        flipId: "b",
        scores: [
          { id: "b", points: 55 },
          { id: "a", points: 30 },
        ],
      },
      {
        flipId: "b",
        scores: [
          { id: "b", points: 42 },
          { id: "a", points: 36 },
        ],
      },
      {
        flipId: "a",
        scores: [
          { id: "a", points: 36 },
          { id: "b", points: 0 },
        ],
      },
    ],
  };
  const before = structuredClone(game);
  const ranking = standings(game);
  assert.deepEqual(
    ranking.map((p) => p.id),
    ["b", "a", "c", "d", "e", "f"],
  );
  assert.deepEqual(
    ranking.map((p) => p.rank),
    [1, 2, 2, 4, 5, 6],
  );
  assert.equal(ranking[1].tied, true);
  assert.equal(ranking[2].tied, true);
  assert.equal(ranking[0].bestRound, 55);
  assert.equal(ranking[0].flipCount, 2);
  assert.equal(ranking[1].flipCount, 1);
  assert.equal(ranking[2].flipCount, 0);
  assert.equal(ranking.at(-1).bestRound, 0);
  assert.deepEqual(game, before);
});

function nearFlipSeven(scores = [0, 0, 0], forced = false) {
  const state = createGame({
    players: ["a", "b", "c"].map((id) => ({ id, name: id })),
    seed: 42,
  });
  const pool = makeDeck();
  const take = (value) => {
    const index = pool.findIndex((card) =>
      typeof value === "number"
        ? card.kind === "number" && card.value === value
        : card.kind === value,
    );
    assert.ok(index >= 0);
    return pool.splice(index, 1)[0];
  };
  [[0, 1, 2, 3, 4, 5], [12], [9]].forEach((hand, index) => {
    state.players[index].cards = hand.map(take);
    state.players[index].score = scores[index];
  });
  const draws = (forced ? ["three", 6] : [6]).map(take);
  state.deck = [...pool, ...draws.reverse()];
  state.queue = [];
  state.turn = forced ? 1 : 0;
  state.resume = state.turn;
  assert.ok(validateSave(state, { requireLocalPlayer: false }));
  return state;
}

test("Flip 7 celebrates the seven real cards once for solo and every network viewer", () => {
  const before = nearFlipSeven();
  const after = applyAction(before, "a", { type: "hit" });
  assert.equal(after.phase, "roundEnd");
  const effects = presentationEvents(before, after);
  assert.deepEqual(
    effects.map((event) => event.type),
    ["flip7"],
  );
  assert.equal(effects[0].player.id, "a");
  assert.deepEqual(
    effects[0].player.cards.map((card) => card.value),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(effects[0].player.roundScore, 36);
  assert.deepEqual(
    presentationEvents(publicView(before), publicView(after)),
    effects,
  );
  assert.deepEqual(presentationEvents(after, structuredClone(after)), []);
  assert.deepEqual(presentationEvents(null, after), []);
  const nextRound = applyAction(after, "a", { type: "nextRound" });
  assert.deepEqual(presentationEvents(before, nextRound), []);
  // A new hand or reconnect keeps the honor; a fresh match starts without medals.
  for (const snapshot of [
    after,
    nextRound,
    JSON.parse(JSON.stringify(publicView(nextRound))),
  ]) {
    assert.equal(standings(snapshot).find((p) => p.id === "a").flipCount, 1);
  }
  assert.ok(standings(nearFlipSeven()).every((p) => p.flipCount === 0));
});

test("forced Flip 7 credits its recipient and can also celebrate a different match winner", () => {
  let before = nearFlipSeven([0, 199, 0], true);
  before = applyAction(before, "b", { type: "hit" });
  const after = applyAction(before, "b", { type: "target", targetId: "a" });
  assert.equal(after.phase, "finished");
  const effects = presentationEvents(publicView(before), publicView(after));
  assert.deepEqual(
    effects.map((event) => event.type),
    ["flip7", "victory"],
  );
  assert.equal(effects[0].player.id, "a");
  assert.equal(effects[1].winner.id, "b");
  assert.equal(effects[1].winner.score, 211);
  assert.deepEqual(presentationEvents(after, structuredClone(after)), []);
});

test("animations play once for a new shuffle or victory, never for repeated snapshots", () => {
  const initial = createGame({
    players: ["a", "b", "c"].map((id) => ({ id, name: id })),
    seed: 42,
  });
  assert.deepEqual(
    presentationEvents(null, initial).map((e) => e.type),
    ["shuffle"],
  );
  assert.deepEqual(presentationEvents(initial, structuredClone(initial)), []);
  const playing = applyAction(initial, "a", { type: "hit" });
  assert.deepEqual(presentationEvents(null, playing), []);
  const shuffled = {
    ...playing,
    revision: 2,
    eventId: playing.eventId + 1,
    events: [...playing.events, { id: playing.eventId + 1, type: "shuffle" }],
  };
  assert.deepEqual(
    presentationEvents(playing, shuffled).map((e) => e.type),
    ["shuffle"],
  );
  assert.deepEqual(presentationEvents(null, shuffled), []);
  const final = { ...shuffled, phase: "finished", winner: "b" };
  assert.deepEqual(
    presentationEvents(shuffled, final).map((e) => e.type),
    ["victory"],
  );
  assert.deepEqual(presentationEvents(final, structuredClone(final)), []);
  assert.deepEqual(presentationEvents(final, null), []);
});
