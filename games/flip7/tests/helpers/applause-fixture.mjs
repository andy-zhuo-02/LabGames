import assert from "node:assert/strict";
import { createGame, makeDeck, validateSave } from "../../src/game.js";

export function nearFlipSeven(room, { forced = false, scores = [] } = {}) {
  const state = createGame({ players: room.members, seed: 42 });
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
    state.players[index].score = scores[index] || 0;
  });
  const draws = (forced ? ["three", 6] : [6]).map(take);
  state.deck = [...pool, ...draws.reverse()];
  state.queue = [];
  state.turn = forced ? 1 : 0;
  state.resume = state.turn;
  assert.ok(validateSave(state, { requireLocalPlayer: false }));
  room.game = state;
  room.applause = null;
  room.revision++;
  return room;
}
