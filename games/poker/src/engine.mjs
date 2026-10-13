import { randomBytes } from "node:crypto";

export const RANKS = "23456789TJQKA";
export const DECK = [...RANKS].flatMap((r) => [..."cdhs"].map((s) => r + s));
export const LABELS = [
  "High card",
  "One pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
];
export const HAND_NAMES = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺",
];
export const STREET_NAMES = {
  preflop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  finished: "结束",
};
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const seed = () => randomBytes(4).readUInt32LE();
export class Random {
  constructor(value = seed()) {
    this.state = Number(value) >>> 0;
  }
  random() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  shuffle(values) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  next() {
    return Math.floor(this.random() * 4294967296);
  }
}

// A category followed by five base-15 ranks gives a totally ordered high hand.
function five(cards) {
  const ranks = cards.map((c) => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const straight =
    counts.size === 5 &&
    (ranks[0] - ranks[4] === 4
      ? ranks[0]
      : ranks.join() === "14,5,4,3,2"
        ? 5
        : 0);
  let category = 0,
    tie = ranks;
  if (straight && flush) {
    category = 8;
    tie = [straight];
  } else if (groups[0][1] === 4) {
    category = 7;
    tie = groups.map((g) => g[0]);
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = 6;
    tie = groups.map((g) => g[0]);
  } else if (flush) category = 5;
  else if (straight) {
    category = 4;
    tie = [straight];
  } else if (groups[0][1] === 3) {
    category = 3;
    tie = groups.map((g) => g[0]);
  } else if (groups[0][1] === 2) {
    category = groups[1][1] === 2 ? 2 : 1;
    tie = groups.map((g) => g[0]);
  }
  const score = [category, ...tie, ...Array(5 - tie.length).fill(0)].reduce(
    (a, b) => a * 15 + b,
    0,
  );
  return { score, category, tie, cards, label: LABELS[category] };
}
export function evaluate(cards) {
  if (
    cards.length < 5 ||
    cards.length > 7 ||
    new Set(cards).size !== cards.length ||
    cards.some((c) => !DECK.includes(c))
  )
    throw new Error("比牌需要 5～7 张不重复的标准牌。");
  let best;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const candidate = five([
              cards[a],
              cards[b],
              cards[c],
              cards[d],
              cards[e],
            ]);
            if (!best || candidate.score > best.score) best = candidate;
          }
  return best;
}
export class IllegalAction extends Error {}
export function config(values = {}) {
  const result = {
    small_blind: 10,
    big_blind: 20,
    starting_stack: 2000,
    ...values,
  };
  if (
    Object.values(result).some((v) => !Number.isSafeInteger(v) || v <= 0) ||
    result.small_blind > result.big_blind
  )
    throw new Error("盲注和初始筹码必须为正整数，小盲不能大于大盲。");
  return result;
}
const emptyLegal = () => ({
  fold: false,
  check: false,
  call_amount: 0,
  min_raise_to: null,
  max_raise_to: null,
  all_in: false,
});
export class Hand {
  constructor(players, settings, hand_number, hand_seed, { deck } = {}) {
    this.players = structuredClone(players);
    this.player_ids = players.map((p) => p.player_id);
    this.config = config(settings);
    this.hand_number = hand_number;
    this.seed = hand_seed;
    this._initial_deck = deck
      ? typeof deck === "string"
        ? deck.match(/../g)
        : [...deck]
      : new Random(hand_seed).shuffle(DECK);
    if (
      this._initial_deck.length !== 52 ||
      new Set(this._initial_deck).size !== 52 ||
      this._initial_deck.some((c) => !DECK.includes(c))
    )
      throw new Error("牌堆必须包含 52 张不重复的标准扑克牌。");
    this.cursor = 0;
    this.board = [];
    this.actions = [];
    this.street = "preflop";
    this.finished = false;
    this.stacks = players.map((p) => p.stack);
    this.bets = players.map(() => 0);
    this.paid = [...this.bets];
    this.active = players.map(() => true);
    this.holes = players.map(() => []);
    this.returned = [...this.bets];
    const blinds =
      players.length === 2
        ? [this.config.big_blind, this.config.small_blind]
        : [this.config.small_blind, this.config.big_blind];
    blinds.forEach((v, i) => this.pay(i, Math.min(v, this.stacks[i])));
    this.blinds = [...this.paid];
    for (let round = 0; round < 2; round++)
      for (const hole of this.holes) hole.push(this.draw());
    this.high = Math.max(...this.bets);
    this.raise_size = 0;
    this.acted = new Set();
    this.allin_increases = [];
    this.last_action_bet = players.map(() => null);
    this.pending = new Set(
      players
        .map((_, i) => i)
        .filter(
          (i) =>
            this.stacks[i] > 0 &&
            this.stacks.some(
              (s, j) => j !== i && s + this.bets[j] > this.bets[i],
            ),
        ),
    );
    if (this.pending.size === 1 && this.bets[[...this.pending][0]] >= this.high)
      this.pending.clear();
    this.advance(players.length === 2 ? 0 : 1);
  }
  draw() {
    return this._initial_deck[this.cursor++];
  }
  pay(i, amount) {
    this.stacks[i] -= amount;
    this.bets[i] += amount;
    this.paid[i] += amount;
  }
  get actor_id() {
    return this.actor == null ? null : this.player_ids[this.actor];
  }
  get pot() {
    return this.finished ? 0 : sum(this.paid);
  }
  legal_actions(id) {
    if (this.finished || id !== this.actor_id) return emptyLegal();
    const i = this.actor,
      max = this.stacks[i] + this.bets[i];
    const call = Math.min(
      this.stacks[i],
      Math.max(0, this.high - this.bets[i]),
    );
    const reopened =
      !this.allin_increases.length ||
      sum(this.allin_increases) >= this.raise_size ||
      !this.acted.has(i);
    const other = this.active.some(
      (a, j) => a && j !== i && this.stacks[j] + this.bets[j] > this.high,
    );
    const raise = max > this.high && reopened && other;
    return {
      fold: call > 0,
      check: call === 0,
      call_amount: call,
      min_raise_to: raise
        ? Math.min(
            max,
            this.high + Math.max(this.config.big_blind, this.raise_size),
          )
        : null,
      max_raise_to: raise ? max : null,
      all_in: raise || call === this.stacks[i],
    };
  }
  observe(id) {
    const index = this.player_ids.indexOf(id);
    if (index < 0) throw new Error("该玩家没有参加本手牌。");
    const players = this.players.map((p, i) =>
      Object.freeze({
        player_id: p.player_id,
        name: p.name,
        position:
          this.players.length === 2
            ? ["BB", "BTN/SB"][i]
            : i === 0
              ? "SB"
              : i === 1
                ? "BB"
                : i === this.players.length - 1
                  ? "BTN"
                  : `UTG+${i - 2}`,
        stack: this.stacks[i],
        bet: this.bets[i],
        active: this.active[i],
      }),
    );
    return Object.freeze({
      hand_number: this.hand_number,
      player_id: id,
      actor_id: this.actor_id,
      street: this.street,
      hole_cards: Object.freeze([...this.holes[index]]),
      board: Object.freeze([...this.board]),
      players: Object.freeze(players),
      pot: this.pot,
      big_blind: this.config.big_blind,
      legal: Object.freeze(this.legal_actions(id)),
    });
  }
  apply_action(id, action) {
    if (this.finished || id !== this.actor_id)
      throw new IllegalAction("当前不是该玩家的行动回合。");
    const legal = this.legal_actions(id),
      i = this.actor;
    if (!action || (action.kind !== "raise" && action.amount != null))
      throw new IllegalAction("只有 raise 可以指定数额。");
    let target = this.bets[i],
      fold = false;
    if (action.kind === "fold" && legal.fold) fold = true;
    else if (action.kind === "check" && legal.check) {
      /* no chips */
    } else if (action.kind === "call" && legal.call_amount > 0)
      target += legal.call_amount;
    else if (action.kind === "all_in" && legal.all_in) target += this.stacks[i];
    else if (
      action.kind === "raise" &&
      Number.isSafeInteger(action.amount) &&
      legal.min_raise_to !== null &&
      action.amount >= legal.min_raise_to &&
      action.amount <= legal.max_raise_to
    )
      target = action.amount;
    else
      throw new IllegalAction(
        "非法动作：请按当前提示选择过牌、跟注或合法加注数额。",
      );
    const paid = target - this.bets[i],
      street = this.street;
    if (fold) this.active[i] = false;
    else this.pay(i, paid);
    this.pending.delete(i);
    if (target > this.high) {
      const increase = target - this.high;
      if (increase >= this.raise_size) this.acted.clear();
      this.raise_size = Math.max(increase, this.raise_size);
      if (this.stacks[i]) this.allin_increases = [];
      else this.allin_increases.push(increase);
      this.high = target;
      for (let j = 0; j < this.players.length; j++)
        if (
          j !== i &&
          this.active[j] &&
          this.stacks[j] > 0 &&
          this.bets[j] < this.high
        )
          this.pending.add(j);
    }
    this.last_action_bet[i] = this.high;
    this.acted.add(i);
    this.actions.push({
      player_id: id,
      street,
      action: { kind: action.kind, amount: action.amount ?? null },
      paid,
    });
    this.advance(i);
  }
  refund() {
    const sorted = this.bets.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    const amount = sorted[0][0] - sorted[1][0],
      i = sorted[0][1];
    if (amount > 0) {
      this.stacks[i] += amount;
      this.bets[i] -= amount;
      this.paid[i] -= amount;
      this.returned[i] += amount;
    }
  }
  advance(after) {
    for (;;) {
      const alive = this.active
        .map((v, i) => (v ? i : -1))
        .filter((i) => i >= 0);
      if (alive.length === 1) {
        this.settle(false);
        return;
      }
      const funded = alive.filter((i) => this.stacks[i] > 0);
      for (const i of this.pending)
        if (!this.active[i] || this.stacks[i] === 0) this.pending.delete(i);
      if (this.pending.size) {
        for (let k = 1; k <= this.players.length; k++) {
          const i = (after + k) % this.players.length;
          if (this.pending.has(i)) {
            this.actor = i;
            this.check_chips();
            return;
          }
        }
      }
      this.refund();
      if (this.street === "river") {
        this.settle(true);
        return;
      }
      this.draw();
      const count = this.street === "preflop" ? 3 : 1;
      for (let k = 0; k < count; k++) this.board.push(this.draw());
      this.street = { preflop: "flop", flop: "turn", turn: "river" }[
        this.street
      ];
      this.bets.fill(0);
      this.high = 0;
      this.raise_size = 0;
      this.last_action_bet.fill(null);
      this.acted.clear();
      this.allin_increases = [];
      this.pending = new Set(funded.length > 1 ? funded : []);
      after = this.players.length - 1;
    }
  }
  settle(showdown) {
    const contenders = this.active
      .map((v, i) => (v ? i : -1))
      .filter((i) => i >= 0);
    const evaluated = new Map(
      showdown
        ? contenders.map((i) => [
            i,
            evaluate([...this.holes[i], ...this.board]),
          ])
        : [],
    );
    const payouts = [];
    if (!showdown) {
      const winner = contenders[0];
      // Uncollected chips in front of the fold winner are a refund, not an award.
      const refund = this.bets[winner];
      this.stacks[winner] += refund;
      this.paid[winner] -= refund;
      this.returned[winner] += refund;
      const amount = sum(this.paid);
      this.stacks[winner] += amount;
      payouts.push({
        pot_index: 0,
        awards: [[this.player_ids[winner], amount]],
        eligible: [this.player_ids[winner]],
        amount,
      });
    } else {
      let previous = 0;
      for (const level of [...new Set(this.paid.filter((v) => v > 0))].sort(
        (a, b) => a - b,
      )) {
        const amount =
          this.paid.filter((v) => v >= level).length * (level - previous);
        previous = level;
        const eligible = contenders.filter((i) => this.paid[i] >= level);
        if (!eligible.length) throw new Error("底池没有可领取的玩家。");
        const best = Math.max(...eligible.map((i) => evaluated.get(i).score));
        const winners = eligible.filter((i) => evaluated.get(i).score === best);
        const awards = winners.map((i, k) => {
          const value =
            Math.floor(amount / winners.length) +
            (k < amount % winners.length ? 1 : 0);
          this.stacks[i] += value;
          return [this.player_ids[i], value];
        });
        payouts.push({
          pot_index: payouts.length,
          awards,
          eligible: eligible.map((i) => this.player_ids[i]),
          amount,
        });
      }
    }
    this.finished = true;
    this.street = "finished";
    this.actor = null;
    this.bets.fill(0);
    this._result = {
      hand_number: this.hand_number,
      board: [...this.board],
      stacks: this.player_ids.map((id, i) => [id, this.stacks[i]]),
      payoffs: this.players.map((p, i) => [
        p.player_id,
        this.stacks[i] - p.stack,
      ]),
      payouts,
      returned_bets: this.player_ids.flatMap((id, i) =>
        this.returned[i] ? [[id, this.returned[i]]] : [],
      ),
      shown_hands: showdown
        ? contenders.map((i) => ({
            player_id: this.player_ids[i],
            cards: [...this.holes[i]],
            hand_type: evaluated.get(i).label,
          }))
        : [],
    };
    this.check_chips();
  }
  check_chips() {
    if (
      this.stacks.some((v) => !Number.isSafeInteger(v) || v < 0) ||
      sum(this.stacks) + this.pot !== sum(this.players.map((p) => p.stack))
    )
      throw new Error("筹码总量不守恒。");
  }
  result() {
    if (!this.finished) throw new Error("本手牌尚未结束。");
    return structuredClone(this._result);
  }
}

export class Table {
  constructor(
    names = ["You", "Bot-A", "Bot-B"],
    settings = {},
    { stacks, seed: value = seed() } = {},
  ) {
    this.config = config(settings);
    stacks ??= names.map(() => this.config.starting_stack);
    if (
      names.length < 2 ||
      names.length > 9 ||
      names.some((n) => typeof n !== "string" || !n.trim()) ||
      stacks.length !== names.length ||
      stacks.some((s) => !Number.isSafeInteger(s) || s < 0) ||
      stacks.filter((s) => s > 0).length < 2
    )
      throw new Error("至少需要两位有筹码的玩家和有效的昵称。");
    this.players = names.map((name, player_id) => ({
      player_id,
      name,
      stack: stacks[player_id],
    }));
    this.seed = value;
    this.rng = new Random(value);
    this.hand = null;
    this.hand_number = 0;
    this.sitting_out = new Set();
    this.button_id = this.active_ids.at(-1);
    this.previous_bb = null;
  }
  get active_ids() {
    return this.players
      .filter((p) => p.stack > 0 && !this.sitting_out.has(p.player_id))
      .map((p) => p.player_id);
  }
  get winner() {
    const funded = this.players.filter((p) => p.stack > 0);
    return funded.length === 1 ? funded[0] : null;
  }
  next_active(id) {
    for (let k = 1; k <= this.players.length; k++) {
      const i = (id + k) % this.players.length;
      if (this.active_ids.includes(i)) return i;
    }
    throw new Error("没有可参与的座位。");
  }
  start_hand({ deck } = {}) {
    if (this.hand && !this.hand.finished) throw new Error("请先完成当前手牌。");
    if (this.active_ids.length < 2)
      throw new Error("至少需要两位有筹码的玩家。");
    if (this.hand_number)
      this.button_id =
        this.active_ids.length === 2
          ? this.next_active(this.next_active(this.previous_bb))
          : this.next_active(this.button_id);
    const ids = [];
    let seat = this.button_id;
    for (const _ of this.active_ids) {
      seat = this.next_active(seat);
      ids.push(seat);
    }
    this.hand = new Hand(
      ids.map((i) => this.players[i]),
      this.config,
      this.hand_number + 1,
      this.rng.next(),
      { deck },
    );
    this.hand_number++;
    this.previous_bb = ids[ids.length === 2 ? 0 : 1];
    this.settle();
    return this.hand;
  }
  apply_action(id, action) {
    if (!this.hand) throw new Error("请先开始一手牌。");
    this.hand.apply_action(id, action);
    this.settle();
  }
  settle() {
    if (this.hand.finished)
      for (const [id, stack] of this.hand.result().stacks)
        this.players[id] = { ...this.players[id], stack };
  }
}
