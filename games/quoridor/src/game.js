export const SIZE = 9;
export const PLAYER_COUNTS = [2, 3, 4];
export const wallsPerPlayer = (count) => Math.floor(20 / count);
const DIRECTIONS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];
const inside = (row, col) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;
const cell = (row, col) => row * SIZE + col;
const edge = (a, b) => Math.min(a, b) * 81 + Math.max(a, b);

export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function createGame({
  count = 2,
  names = [],
  bots = [],
  first = 0,
} = {}) {
  if (!PLAYER_COUNTS.includes(count))
    throw new RuleError("请选择双人、三人或四人对局");
  if (!Number.isInteger(first) || first < 0 || first >= count)
    throw new RuleError("先手无效");
  // Three players use the first three clockwise seats, with six walls each.
  const starts =
    count === 2
      ? [
          [8, 4, "north"],
          [0, 4, "south"],
        ]
      : [
          [8, 4, "north"],
          [4, 0, "east"],
          [0, 4, "south"],
          [4, 8, "west"],
        ];
  return {
    version: 1,
    players: starts.slice(0, count).map(([row, col, goal], id) => ({
      id,
      name: String(names[id] || `棋手 ${id + 1}`).slice(0, 16),
      row,
      col,
      goal,
      walls: wallsPerPlayer(count),
      isBot: !!bots[id],
    })),
    walls: [],
    turn: first,
    winner: null,
    ply: 0,
    history: [],
  };
}

export function atGoal(player, position = player) {
  return player.goal === "north"
    ? position.row === 0
    : player.goal === "south"
      ? position.row === 8
      : player.goal === "east"
        ? position.col === 8
        : position.col === 0;
}

export function boardGraph(walls) {
  const blocked = new Set();
  for (const w of walls) {
    for (let k = 0; k < 2; k++) {
      const a =
        w.orientation === "h" ? cell(w.row, w.col + k) : cell(w.row + k, w.col);
      blocked.add(edge(a, a + (w.orientation === "h" ? SIZE : 1)));
    }
  }
  return Array.from({ length: 81 }, (_, a) => {
    const row = Math.floor(a / SIZE),
      col = a % SIZE;
    return DIRECTIONS.flatMap(([dr, dc]) => {
      const r = row + dr,
        c = col + dc,
        b = cell(r, c);
      return inside(r, c) && !blocked.has(edge(a, b)) ? [b] : [];
    });
  });
}

// Reachability ignores temporary pawn positions: walls must leave every goal accessible.
export function shortestPath(game, playerId, graph = boardGraph(game.walls)) {
  const p = game.players[playerId],
    start = cell(p.row, p.col);
  const previous = new Int16Array(81).fill(-1),
    queue = [start];
  previous[start] = start;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i],
      point = { row: Math.floor(current / SIZE), col: current % SIZE };
    if (atGoal(p, point)) {
      const path = [point];
      for (let j = current; j !== start; ) {
        j = previous[j];
        path.unshift({ row: Math.floor(j / SIZE), col: j % SIZE });
      }
      return path;
    }
    for (const next of graph[current]) {
      if (previous[next] !== -1) continue;
      previous[next] = current;
      queue.push(next);
    }
  }
  return [];
}

export function legalMoves(
  game,
  playerId = game.turn,
  graph = boardGraph(game.walls),
) {
  if (game.winner !== null) return [];
  const p = game.players[playerId],
    start = cell(p.row, p.col);
  const occupied = new Set(
    game.players
      .filter((other) => other.id !== playerId)
      .map((other) => cell(other.row, other.col)),
  );
  const targets = new Set();
  for (const next of graph[start]) {
    if (!occupied.has(next)) {
      targets.add(next);
      continue;
    }
    const row = Math.floor(next / SIZE),
      col = next % SIZE;
    const dr = row - p.row,
      dc = col - p.col;
    const behind = cell(row + dr, col + dc);
    if (
      inside(row + dr, col + dc) &&
      graph[next].includes(behind) &&
      !occupied.has(behind)
    ) {
      targets.add(behind);
    } else {
      // A wall, edge, or third pawn prevents the straight jump; sidestep one pawn.
      for (const [sr, sc] of [
        [dc, dr],
        [-dc, -dr],
      ]) {
        const target = cell(row + sr, col + sc);
        if (
          inside(row + sr, col + sc) &&
          graph[next].includes(target) &&
          !occupied.has(target)
        )
          targets.add(target);
      }
    }
  }
  return [...targets].map((i) => ({
    row: Math.floor(i / SIZE),
    col: i % SIZE,
  }));
}

export function wallError(game, wall, playerId = game.turn) {
  if (game.winner !== null) return "本局已经结束";
  if (game.players[playerId].walls <= 0) return "围墙已用完，请移动棋子";
  if (
    !wall ||
    !Number.isInteger(wall.row) ||
    !Number.isInteger(wall.col) ||
    wall.row < 0 ||
    wall.row > 7 ||
    wall.col < 0 ||
    wall.col > 7 ||
    !["h", "v"].includes(wall.orientation)
  )
    return "围墙需要放在棋盘的两格之间";
  for (const w of game.walls) {
    if (w.orientation !== wall.orientation) {
      if (w.row === wall.row && w.col === wall.col) return "围墙不能交叉";
    } else if (
      wall.orientation === "h"
        ? w.row === wall.row && Math.abs(w.col - wall.col) < 2
        : w.col === wall.col && Math.abs(w.row - wall.row) < 2
    )
      return "围墙不能重叠";
  }
  const graph = boardGraph([...game.walls, wall]);
  if (game.players.some((p) => shortestPath(game, p.id, graph).length === 0))
    return "不能封死道路，请给每位棋手留一条通路";
  return null;
}

export function applyAction(game, action) {
  if (game.winner !== null) throw new RuleError("本局已经结束，开一局新的吧");
  if (!action || typeof action !== "object")
    throw new RuleError("请选择走子或放墙");
  const next = {
    ...game,
    players: game.players.map((p) => ({ ...p })),
    walls: [...game.walls],
    history: [...game.history],
  };
  const player = next.players[game.turn];
  let record;
  if (action.type === "move") {
    if (
      !legalMoves(game).some(
        (p) => p.row === action.row && p.col === action.col,
      )
    )
      throw new RuleError("这里无法到达，请选择亮起的格子");
    record = {
      type: "move",
      player: player.id,
      row: action.row,
      col: action.col,
      fromRow: player.row,
      fromCol: player.col,
    };
    player.row = action.row;
    player.col = action.col;
    if (atGoal(player)) next.winner = player.id;
  } else if (action.type === "wall") {
    const error = wallError(game, action);
    if (error) throw new RuleError(error);
    const wall = {
      row: action.row,
      col: action.col,
      orientation: action.orientation,
      owner: player.id,
    };
    next.walls.push(wall);
    player.walls--;
    record = { type: "wall", player: player.id, ...wall };
  } else throw new RuleError("未知的行动");
  next.ply++;
  next.history.push({ ...record, number: next.ply });
  if (next.history.length > 200) next.history.shift();
  next.turn =
    next.winner === null ? (game.turn + 1) % game.players.length : game.turn;
  return next;
}

export const coordinate = ({ row, col }) =>
  `${String.fromCharCode(65 + col)}${9 - row}`;
