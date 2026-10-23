import {
  atGoal,
  boardGraph,
  legalMoves,
  shortestPath,
  wallError,
} from "./game.js";

export function chooseTimeoutMove(game) {
  if (game.winner !== null) return null;
  const player = game.turn,
    graph = boardGraph(game.walls);
  const moves = legalMoves(game, player, graph);
  const win = moves.find((move) => atGoal(game.players[player], move));
  if (win) return { type: "move", ...win };
  let best = null,
    distance = Infinity;
  for (const move of moves) {
    const next = {
      ...game,
      players: game.players.map((p) =>
        p.id === player ? { ...p, ...move } : p,
      ),
    };
    const length = shortestPath(next, player, graph).length;
    if (length < distance) {
      best = move;
      distance = length;
    }
  }
  return best ? { type: "move", ...best } : null;
}

export function chooseBotAction(
  game,
  { level = "standard", random = Math.random } = {},
) {
  if (game.winner !== null) return null;
  const me = game.turn,
    graph = boardGraph(game.walls),
    moves = legalMoves(game, me, graph);
  const winning = moves.find((p) => atGoal(game.players[me], p));
  if (winning) return { type: "move", ...winning };
  const distance = (state, id, g) => shortestPath(state, id, g).length - 1;
  const opponents = game.players.filter((p) => p.id !== me);
  const score = (state, g) => {
    const ours = distance(state, me, g);
    const closest = Math.min(...opponents.map((p) => distance(state, p.id, g)));
    const threats = opponents.filter((p) =>
      legalMoves(state, p.id, g).some((move) => atGoal(p, move)),
    ).length;
    return closest - ours - threats * 30;
  };
  let best = null,
    bestScore = -Infinity;
  for (const move of moves) {
    const state = {
      ...game,
      players: game.players.map((p) => (p.id === me ? { ...p, ...move } : p)),
    };
    const value =
      score(state, graph) +
      (4 - Math.abs(move.col - 4)) * 0.001 +
      random() * 0.0001;
    if (value > bestScore) {
      bestScore = value;
      best = { type: "move", ...move };
    }
  }
  if (game.players[me].walls === 0 || (level === "relaxed" && random() < 0.7))
    return best;
  for (const orientation of ["h", "v"]) {
    for (let row = 0; row < 8; row++)
      for (let col = 0; col < 8; col++) {
        const wall = { type: "wall", orientation, row, col };
        if (wallError(game, wall)) continue;
        const state = { ...game, walls: [...game.walls, wall] };
        // Spend a wall only when it beats advancing. Preserve walls on equal scores.
        const value = score(state, boardGraph(state.walls)) - 0.2;
        if (value > bestScore) {
          bestScore = value;
          best = wall;
        }
      }
  }
  return best;
}
