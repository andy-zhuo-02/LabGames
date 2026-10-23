import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAction,
  atGoal,
  boardGraph,
  createGame,
  legalMoves,
  shortestPath,
  wallError,
} from "../src/game.js";
import { chooseBotAction } from "../src/bot.js";

const positions = (game) =>
  legalMoves(game)
    .map((p) => `${p.row},${p.col}`)
    .sort();
const wall = (row, col, orientation = "h") => ({
  type: "wall",
  row,
  col,
  orientation,
});
test("two/four-player setup, starting moves and immutable turns", () => {
  const game = createGame();
  assert.deepEqual(positions(game), ["7,4", "8,3", "8,5"]);
  assert.equal(shortestPath(game, 0).length, 9);
  const next = applyAction(game, { type: "move", row: 7, col: 4 });
  assert.equal(game.players[0].row, 8);
  assert.equal(next.players[0].row, 7);
  assert.equal(next.turn, 1);
  assert.equal(next.ply, 1);
  assert.equal(next.history[0].fromRow, 8);
  const four = createGame({ count: 4 });
  assert.deepEqual(
    four.players.map((p) => p.walls),
    [5, 5, 5, 5],
  );
  assert.deepEqual(
    four.players.map((p) => p.goal),
    ["north", "east", "south", "west"],
  );
  for (const count of [0, 1, 5, "3", 3.5])
    assert.throws(() => createGame({ count }));
  for (const action of [
    null,
    {},
    { type: "move", row: 6, col: 4 },
    { type: "move", row: 7, col: 3 },
    { type: "move", row: "7", col: 4 },
  ])
    assert.throws(() => applyAction(game, action));
});
test("three players have three goals, six walls each and cycle back after three turns", () => {
  let game = createGame({ count: 3, bots: [false, true, true] });
  assert.equal(game.players.length, 3);
  assert.deepEqual(
    game.players.map((p) => [p.row, p.col, p.goal, p.walls]),
    [
      [8, 4, "north", 6],
      [4, 0, "east", 6],
      [0, 4, "south", 6],
    ],
  );
  for (const p of game.players)
    assert.equal(shortestPath(game, p.id).length, 9);
  const moves = [
    { row: 7, col: 4 },
    { row: 4, col: 1 },
    { row: 1, col: 4 },
  ];
  for (const move of moves) game = applyAction(game, { type: "move", ...move });
  assert.equal(game.turn, 0);
  assert.equal(game.ply, 3);
  game = applyAction(JSON.parse(JSON.stringify(game)), wall(3, 3));
  assert.equal(game.players[0].walls, 5);
  assert.equal(game.turn, 1);
  const third = createGame({ count: 3 });
  Object.assign(third.players[2], { row: 0, col: 0 });
  third.walls = [wall(0, 0)];
  assert.match(wallError(third, wall(0, 1, "v")), /通路/);
  const crowded = createGame({ count: 3 });
  Object.assign(crowded.players[0], { row: 4, col: 4 });
  Object.assign(crowded.players[1], { row: 3, col: 4 });
  Object.assign(crowded.players[2], { row: 2, col: 4 });
  assert.ok(positions(crowded).includes("3,3"));
  assert.ok(!positions(crowded).includes("1,4"));
});
test("each of the three players can win on their own goal edge", () => {
  const starts = [
    { row: 1, col: 3 },
    { row: 3, col: 7 },
    { row: 7, col: 3 },
  ];
  const targets = [
    { row: 0, col: 3 },
    { row: 3, col: 8 },
    { row: 8, col: 3 },
  ];
  for (let id = 0; id < 3; id++) {
    const game = createGame({ count: 3 });
    game.turn = id;
    Object.assign(game.players[id], starts[id]);
    const won = applyAction(game, { type: "move", ...targets[id] });
    assert.equal(won.winner, id);
    assert.throws(() => applyAction(won, wall(1, 1)), /结束/);
  }
});
test("face-to-face straight jumps and sideways jumps at fences, edges and a third pawn", () => {
  const game = createGame();
  game.players[0].row = 4;
  game.players[1].row = 3;
  assert.deepEqual(positions(game), ["2,4", "4,3", "4,5", "5,4"]);
  game.walls = [wall(2, 4)];
  assert.deepEqual(positions(game), ["3,3", "3,5", "4,3", "4,5", "5,4"]);
  game.walls = [wall(2, 4), wall(2, 3, "v")];
  assert.ok(!positions(game).includes("3,3"));
  game.walls = [wall(3, 4)];
  assert.ok(
    !positions(game).some((p) => p.startsWith("2,") || p.startsWith("3,")),
  );
  game.walls = [];
  game.players[0].row = 1;
  game.players[1].row = 0;
  assert.ok(positions(game).includes("0,3") && positions(game).includes("0,5"));
  const four = createGame({ count: 4 });
  Object.assign(four.players[0], { row: 4, col: 4 });
  Object.assign(four.players[1], { row: 3, col: 4 });
  Object.assign(four.players[2], { row: 2, col: 4 });
  assert.ok(positions(four).includes("3,3") && positions(four).includes("3,5"));
  assert.ok(
    !positions(four).includes("1,4") && !positions(four).includes("2,4"),
  );
});
test("walls block exactly two edges; touching is legal, crossing/overlap/outside is not", () => {
  const game = createGame();
  const next = applyAction(game, wall(7, 4));
  assert.equal(next.players[0].walls, 9);
  assert.equal(next.walls.length, 1);
  assert.ok(!legalMoves(next, 0).some((p) => p.row === 7 && p.col === 4));
  const graph = boardGraph(next.walls);
  assert.ok(!graph[7 * 9 + 5].includes(8 * 9 + 5));
  assert.ok(graph[7 * 9 + 3].includes(8 * 9 + 3));
  assert.equal(wallError(next, wall(7, 6)), null);
  for (const w of [
    wall(7, 4),
    wall(7, 3),
    wall(7, 5),
    wall(7, 4, "v"),
    wall(8, 0),
    wall(-1, 2),
    wall(1.5, 2),
    wall(2, 2, "x"),
  ])
    assert.ok(wallError(next, w));
  const vertical = applyAction(game, wall(6, 4, "v"));
  assert.ok(wallError(vertical, wall(7, 4, "v")));
  assert.ok(wallError(vertical, wall(5, 4, "v")));
  assert.equal(wallError(vertical, wall(4, 4, "v")), null);
  game.players[0].walls = 0;
  assert.throws(() => applyAction(game, wall(0, 0)), /用完/);
});
test("a wall cannot seal either player's route, including a remote four-player goal", () => {
  const game = createGame();
  game.players[0].col = 0;
  game.walls = [wall(7, 0)];
  assert.match(wallError(game, wall(7, 1, "v")), /通路/);
  game.players[0].col = 4;
  game.players[1].col = 0;
  game.walls = [wall(0, 0)];
  assert.match(wallError(game, wall(0, 1, "v")), /通路/);
  const four = createGame({ count: 4 });
  Object.assign(four.players[3], { row: 0, col: 8 });
  four.walls = [wall(0, 6, "v")];
  assert.match(wallError(four, wall(1, 7)), /通路/);
  assert.ok(shortestPath(four, 3).length > 0);
});
test("all goal edges win immediately and further actions are rejected", () => {
  for (const id of [0, 1, 2, 3]) {
    const game = createGame({ count: 4 });
    game.turn = id;
    const target = [
      { row: 0, col: 3 },
      { row: 3, col: 8 },
      { row: 8, col: 3 },
      { row: 3, col: 0 },
    ][id];
    const start = [
      { row: 1, col: 3 },
      { row: 3, col: 7 },
      { row: 7, col: 3 },
      { row: 3, col: 1 },
    ][id];
    Object.assign(game.players[id], start);
    const won = applyAction(game, { type: "move", ...target });
    assert.equal(won.winner, id);
    assert.equal(atGoal(won.players[id]), true);
    assert.deepEqual(legalMoves(won), []);
    assert.throws(() => applyAction(won, wall(1, 1)));
  }
});
test("bots take an immediate win and block an imminent opposing win", () => {
  const game = createGame();
  Object.assign(game.players[0], { row: 1, col: 2 });
  assert.deepEqual(chooseBotAction(game), { type: "move", row: 0, col: 2 });
  Object.assign(game.players[0], { row: 6, col: 4 });
  Object.assign(game.players[1], { row: 7, col: 1 });
  const action = chooseBotAction(game);
  assert.equal(action.type, "wall");
  const next = applyAction(game, action);
  assert.equal(
    legalMoves(next).some((p) => atGoal(next.players[1], p)),
    false,
  );
});
test(
  "complete two/three/four-player AI games preserve paths, wall inventory and distinct squares",
  { timeout: 30000 },
  () => {
    for (const count of [2, 3, 4]) {
      let game = createGame({ count });
      for (let i = 0; i < 240 && game.winner === null; i++) {
        const action = chooseBotAction(game, { random: () => 0.5 });
        assert.ok(action);
        game = applyAction(game, action);
        assert.equal(
          new Set(game.players.map((p) => `${p.row},${p.col}`)).size,
          count,
        );
        assert.equal(
          game.players.reduce((sum, p) => sum + p.walls, 0) + game.walls.length,
          count === 3 ? 18 : 20,
        );
        for (const p of game.players)
          assert.ok(shortestPath(game, p.id).length > 0);
      }
      assert.notEqual(game.winner, null, `AI game for ${count} must finish`);
    }
  },
);
