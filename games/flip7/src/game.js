// Serializable, platform-independent rules. All changes go through applyAction.
export const SAVE_VERSION = 1;
export const TARGET_SCORE = 200;
export const CARD_NAMES = {
  freeze: "冻结",
  three: "连翻三张",
  second: "第二次机会",
  multiply: "×2",
};

export function makeDeck() {
  const deck = [];
  const add = (kind, value, count = 1) => {
    for (let i = 0; i < count; i++)
      deck.push({
        id: `${kind}-${value ?? ""}-${i}`,
        kind,
        ...(value === undefined ? {} : { value }),
      });
  };
  for (let n = 0; n <= 12; n++) add("number", n, Math.max(1, n));
  for (const n of [2, 4, 6, 8, 10]) add("add", n);
  add("multiply");
  for (const kind of ["freeze", "three", "second"]) add(kind, undefined, 3);
  return deck;
}

function random(state) {
  let x = state.rng;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rng = x >>> 0;
  return state.rng / 4294967296;
}

function shuffle(state, cards) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export const numbers = (player) =>
  player.cards.filter((c) => c.kind === "number").map((c) => c.value);
export const hasSecond = (player) =>
  player.cards.some((c) => c.kind === "second");
export const cardLabel = (card) =>
  card.kind === "number"
    ? String(card.value)
    : card.kind === "add"
      ? `+${card.value}`
      : CARD_NAMES[card.kind];
export function roundPoints(player) {
  if (player.status === "busted") return 0;
  const values = numbers(player);
  return (
    values.reduce((a, b) => a + b, 0) *
      (player.cards.some((c) => c.kind === "multiply") ? 2 : 1) +
    player.cards
      .filter((c) => c.kind === "add")
      .reduce((sum, c) => sum + c.value, 0) +
    (values.length === 7 ? 15 : 0)
  );
}

function log(state, text, type = "info", details = {}) {
  state.events.push({
    id: ++state.eventId,
    round: state.round,
    text,
    type,
    ...details,
  });
  state.events = state.events.slice(-100);
}

export function createGame({ players, seed = Date.now() } = {}) {
  if (
    !Array.isArray(players) ||
    players.length < 3 ||
    players.length > 6 ||
    new Set(players.map((p) => p.id)).size !== players.length
  )
    throw new Error("需要 3～6 个不同席位");
  const state = {
    schema: SAVE_VERSION,
    revision: 0,
    rng: Number(seed) >>> 0 || 1,
    players: players.map((p) => ({
      id: p.id,
      name: String(p.name).slice(0, 16),
      bot: !!p.bot,
      style: p.style || "balanced",
      score: 0,
      cards: [],
      status: "active",
      roundScore: 0,
    })),
    deck: [],
    discard: [],
    queue: [],
    turn: 0,
    resume: 0,
    starter: 0,
    phase: "playing",
    round: 0,
    winner: null,
    events: [],
    eventId: 0,
    history: [],
    lastDraw: null,
  };
  state.deck = shuffle(state, makeDeck());
  log(state, "牌堆已洗好，准备轮流翻开第一张牌。", "shuffle", {
    initial: true,
  });
  startRound(state);
  return state;
}

function drawTask(owner, remaining) {
  return { kind: "draw", owner, remaining, deferred: [] };
}
function queuedCards(queue) {
  return queue.flatMap((t) =>
    t.kind === "effect" ? [t.card] : t.deferred.map((e) => e.card),
  );
}
function startRound(state) {
  for (const p of state.players) {
    state.discard.push(...p.cards);
    p.cards = [];
    p.status = "active";
    p.roundScore = 0;
  }
  if (state.round) state.starter = (state.starter + 1) % state.players.length;
  state.round++;
  state.phase = "playing";
  state.lastDraw = null;
  state.resume = state.starter;
  state.queue = state.players.map((_, i) => ({
    ...drawTask(
      state.players[(state.starter + i) % state.players.length].id,
      1,
    ),
    manual: true,
  }));
  log(
    state,
    `第 ${state.round} 轮开始，${state.players[state.starter].name} 先手。`,
    "round",
  );
  advance(state);
}

function finishRound(state, flipId = null) {
  state.discard.push(...queuedCards(state.queue));
  state.queue = [];
  const scores = state.players.map((p) => {
    p.roundScore = roundPoints(p);
    p.score += p.roundScore;
    if (p.status === "active") p.status = p.id === flipId ? "flip7" : "banked";
    return { id: p.id, points: p.roundScore, total: p.score, status: p.status };
  });
  state.history.push({ round: state.round, scores, flipId });
  state.phase = "roundEnd";
  const max = Math.max(...state.players.map((p) => p.score));
  const leaders = state.players.filter((p) => p.score === max);
  if (max >= TARGET_SCORE && leaders.length === 1) {
    state.phase = "finished";
    state.winner = leaders[0].id;
    log(state, `${leaders[0].name} 以 ${max} 分获胜！`, "win");
  } else {
    log(
      state,
      max >= TARGET_SCORE
        ? "最高分并列，全体玩家进入加赛。"
        : `第 ${state.round} 轮结算完成。`,
      "round",
    );
  }
}

function eligible(state, effect) {
  return state.players
    .filter(
      (p) =>
        p.status === "active" &&
        (effect.card.kind !== "second" ||
          (!hasSecond(p) && p.id !== effect.owner)),
    )
    .map((p) => p.id);
}

export function pendingEffect(state) {
  const task = state.queue[0];
  return task?.kind === "effect"
    ? { owner: task.owner, card: task.card, targets: eligible(state, task) }
    : null;
}
export function currentActor(state) {
  if (state.phase !== "playing") return null;
  return pendingEffect(state)?.owner ?? state.players[state.turn].id;
}
export function canStay(player) {
  return player.status === "active" && player.cards.length > 0;
}
export function isOpeningTurn(state) {
  return (
    state.phase === "playing" &&
    state.queue[0]?.kind === "draw" &&
    state.queue[0].manual === true
  );
}

function takeCard(state) {
  if (!state.deck.length) {
    if (!state.discard.length) throw new Error("牌堆已空且没有可洗回的弃牌");
    state.deck = shuffle(state, state.discard);
    state.discard = [];
    log(state, "牌堆用尽，洗入弃牌；本轮桌面上的牌保留。", "shuffle");
  }
  return state.deck.pop();
}

function receive(state, task, card) {
  const p = state.players.find((p) => p.id === task.owner);
  state.lastDraw = { playerId: p.id, card, eventId: state.eventId + 1 };
  log(state, `${p.name} 翻出 ${cardLabel(card)}。`, "draw", {
    playerId: p.id,
    cardKind: card.kind,
    cardId: card.id,
  });
  if (card.kind === "number") {
    if (numbers(p).includes(card.value)) {
      const secondIndex = p.cards.findIndex((c) => c.kind === "second");
      if (secondIndex >= 0) {
        state.discard.push(...p.cards.splice(secondIndex, 1), card);
        log(state, `${p.name} 用第二次机会抵消重复的 ${card.value}。`, "saved");
      } else {
        p.cards.push(card);
        p.status = "busted";
        log(
          state,
          `${p.name} 重复翻出 ${card.value}，爆牌！本轮 0 分。`,
          "bust",
        );
      }
    } else {
      p.cards.push(card);
      if (numbers(p).length === 7) {
        log(
          state,
          `${p.name} 达成 FLIP 7！额外 +15 分，本轮立即结束。`,
          "flip7",
        );
        finishRound(state, p.id);
      }
    }
  } else if (card.kind === "second") {
    if (!hasSecond(p)) p.cards.push(card);
    else state.queue.unshift({ kind: "effect", owner: p.id, card });
  } else if (card.kind === "freeze" || card.kind === "three") {
    // Resolve actions only after all forced draws, and only if their owner survives.
    task.deferred.push({ kind: "effect", owner: p.id, card });
  } else p.cards.push(card);
}

function advance(state) {
  while (state.phase === "playing") {
    if (!state.players.some((p) => p.status === "active")) {
      finishRound(state);
      return;
    }
    const task = state.queue[0];
    if (!task) {
      for (let step = 0; step < state.players.length; step++) {
        const index = (state.resume + step) % state.players.length;
        if (state.players[index].status === "active") {
          state.turn = index;
          return;
        }
      }
    } else if (task.kind === "effect") {
      if (!eligible(state, task).length) {
        state.discard.push(task.card);
        state.queue.shift();
      } else return;
    } else {
      const player = state.players.find((p) => p.id === task.owner);
      if (player.status !== "active" || task.remaining === 0) {
        state.queue.shift();
        if (player.status === "active") state.queue.unshift(...task.deferred);
        else state.discard.push(...task.deferred.map((t) => t.card));
      } else if (task.manual) {
        state.turn = state.players.indexOf(player);
        return;
      } else {
        task.remaining--;
        receive(state, task, takeCard(state));
      }
    }
  }
}

export function applyAction(previous, actorId, action) {
  if (!action || typeof action.type !== "string") throw new Error("无效操作");
  const state = structuredClone(previous);
  if (action.type === "nextRound") {
    if (
      state.phase !== "roundEnd" ||
      !state.players.some((p) => p.id === actorId)
    )
      throw new Error("现在不能开始下一轮");
    startRound(state);
  } else {
    if (state.phase !== "playing" || actorId !== currentActor(state))
      throw new Error("还没轮到你");
    const effect = pendingEffect(state);
    if (effect) {
      if (action.type !== "target" || !effect.targets.includes(action.targetId))
        throw new Error("请选择仍在本轮的有效目标");
      const target = state.players.find((p) => p.id === action.targetId);
      state.queue.shift();
      target.cards.push(effect.card);
      log(
        state,
        `${state.players.find((p) => p.id === actorId).name} 对 ${target.name} 使用${cardLabel(effect.card)}。`,
        "action",
        {
          playerId: actorId,
          targetId: target.id,
          cardKind: effect.card.kind,
          cardId: effect.card.id,
        },
      );
      if (effect.card.kind === "freeze") target.status = "frozen";
      if (effect.card.kind === "three")
        state.queue.unshift(drawTask(target.id, 3));
      advance(state);
    } else if (isOpeningTurn(state)) {
      if (action.type !== "hit") throw new Error("开场请先翻自己的第一张牌");
      state.queue[0].manual = false;
      advance(state);
    } else {
      const p = state.players[state.turn];
      state.resume = (state.turn + 1) % state.players.length;
      if (action.type === "hit") state.queue = [drawTask(p.id, 1)];
      else if (action.type === "stay" && canStay(p)) {
        p.status = "banked";
        log(state, `${p.name} 收手，锁定 ${roundPoints(p)} 分。`, "bank");
      } else throw new Error("现在不能执行此操作");
      advance(state);
    }
  }
  state.revision++;
  return state;
}

// Bots and future network clients only receive public information, never deck order or RNG.
export function publicView(state) {
  const copy = structuredClone(state);
  const { deck, discard, queue, rng, ...publicState } = copy;
  return {
    ...publicState,
    deckCount: deck.length,
    discardCount: discard.length,
    pending: pendingEffect(copy),
    actorId: currentActor(copy),
    opening: isOpeningTurn(copy),
  };
}

export function validateSave(state, { requireLocalPlayer = true } = {}) {
  try {
    if (
      state?.schema !== SAVE_VERSION ||
      !Number.isInteger(state.rng) ||
      state.rng <= 0 ||
      !Array.isArray(state.players) ||
      state.players.length < 3 ||
      state.players.length > 6 ||
      !["playing", "roundEnd", "finished"].includes(state.phase) ||
      !Number.isInteger(state.round) ||
      state.round < 1 ||
      !Number.isInteger(state.revision) ||
      !Array.isArray(state.history) ||
      !Array.isArray(state.events) ||
      (requireLocalPlayer &&
        !state.players.some((p) => p.id === "you" && !p.bot)) ||
      new Set(state.players.map((p) => p.id)).size !== state.players.length
    )
      return false;
    const ids = new Set(state.players.map((p) => p.id));
    if (
      ![state.turn, state.resume, state.starter].every(
        (n) => Number.isInteger(n) && n >= 0 && n < state.players.length,
      )
    )
      return false;
    if (
      !state.players.every(
        (p) =>
          typeof p.name === "string" &&
          Number.isFinite(p.score) &&
          p.score >= 0 &&
          ["active", "busted", "banked", "frozen", "flip7"].includes(
            p.status,
          ) &&
          Array.isArray(p.cards),
      )
    )
      return false;
    if (
      !state.queue.every(
        (t) =>
          ids.has(t.owner) &&
          (t.kind === "effect" ||
            (t.kind === "draw" &&
              Number.isInteger(t.remaining) &&
              t.remaining >= 0 &&
              t.remaining <= 3 &&
              (t.manual === undefined || typeof t.manual === "boolean") &&
              (!t.manual || t.remaining === 1) &&
              Array.isArray(t.deferred))),
      )
    )
      return false;
    const cards = [
      ...state.deck,
      ...state.discard,
      ...state.players.flatMap((p) => p.cards),
      ...queuedCards(state.queue),
    ];
    const expected = new Map(makeDeck().map((c) => [c.id, c]));
    if (
      cards.length !== expected.size ||
      new Set(cards.map((c) => c.id)).size !== expected.size
    )
      return false;
    if (
      !cards.every(
        (c) =>
          expected.get(c.id)?.kind === c.kind &&
          expected.get(c.id)?.value === c.value,
      )
    )
      return false;
    if (
      state.phase === "playing" &&
      !state.players.some((p) => p.status === "active")
    )
      return false;
    if (state.phase === "finished" && !ids.has(state.winner)) return false;
    return true;
  } catch {
    return false;
  }
}
