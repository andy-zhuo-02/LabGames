import { DECK, RANKS, Random, evaluate, seed } from "./engine.mjs";

export const STRATEGIES = {
  random: "随机",
  tight: "紧手",
  loose: "松手",
  nit: "极紧",
  calling_station: "跟注站",
  maniac: "狂野",
  push_fold: "短码推弃",
  equity: "胜率",
};
export const PROFILES = Object.fromEntries(
  [
    [
      "random",
      "米粒",
      "米",
      "随性派",
      "#b78cea",
      "出牌随性，偶尔也会突然加注。",
    ],
    [
      "tight",
      "林克",
      "林",
      "稳健派",
      "#78a6dd",
      "耐心选牌，拿到好牌才会认真进攻。",
    ],
    [
      "loose",
      "小夏",
      "夏",
      "主动派",
      "#e5a46f",
      "喜欢参与牌局，也喜欢给对手一点压力。",
    ],
    [
      "nit",
      "石头",
      "石",
      "谨慎派",
      "#a5b5c0",
      "很少冒险，愿意等一手真正满意的牌。",
    ],
    [
      "calling_station",
      "阿豆",
      "豆",
      "爱跟注",
      "#82c5a9",
      "总想多看一张牌，是个随和的练手伙伴。",
    ],
    [
      "maniac",
      "阿烈",
      "烈",
      "进攻派",
      "#e48387",
      "频繁加注，手里不一定总有好牌。",
    ],
    [
      "push_fold",
      "闪电",
      "闪",
      "敢出手",
      "#c8b472",
      "筹码少的时候，会选择果断搏一把。",
    ],
    [
      "equity",
      "北辰",
      "北",
      "计算派",
      "#78c4d1",
      "会估计牌面胜率，适合想认真过招的时候。",
    ],
  ].map(([id, name, avatar, style, color, description]) => [
    id,
    { name, avatar, style, color, description },
  ]),
);
export const catalog = () =>
  Object.entries(PROFILES).map(([id, profile]) => ({ id, ...profile }));
export const passive_action = (o) => {
  if (o.legal.check) return { kind: "check" };
  if (o.legal.call_amount) return { kind: "call" };
  if (o.legal.fold) return { kind: "fold" };
  throw new Error("没有可执行的被动动作。");
};
export function raise_action(o, fraction = 0.5, blinds = 3) {
  if (o.legal.min_raise_to == null) return passive_action(o);
  const me = o.players.find((p) => p.player_id === o.player_id);
  const target =
    o.street === "preflop"
      ? o.big_blind * blinds
      : me.bet +
        o.legal.call_amount +
        Math.max(
          o.big_blind,
          Math.floor((o.pot + o.legal.call_amount) * fraction),
        );
  return {
    kind: "raise",
    amount: Math.min(
      o.legal.max_raise_to,
      Math.max(o.legal.min_raise_to, target),
    ),
  };
}
export function strength(o) {
  const ranks = o.hole_cards
    .map((c) => RANKS.indexOf(c[0]) + 2)
    .sort((a, b) => b - a);
  if (ranks.length !== 2) throw new Error("机器人需要两张底牌。");
  const [high, low] = ranks;
  if (!o.board.length)
    return high === low
      ? 0.48 + high / 28
      : Math.min(
          0.95,
          Math.max(
            0.1,
            (high + low) / 40 +
              (o.hole_cards[0][1] === o.hole_cards[1][1] ? 0.07 : 0) +
              (high - low === 1 ? 0.05 : 0) -
              (high - low > 4 ? 0.08 : 0),
          ),
        );
  const hand = evaluate([...o.hole_cards, ...o.board]);
  let score = [0.18, 0.44, 0.62, 0.73, 0.82, 0.87, 0.94, 0.98, 1][
    hand.category
  ];
  if (o.board.length === 5 && hand.score === evaluate(o.board).score)
    score = 0.25;
  if (o.board.length < 5) {
    const cards = [...o.hole_cards, ...o.board],
      suits = cards.map((c) => c[1]);
    if ([..."cdhs"].some((s) => suits.filter((v) => v === s).length === 4))
      score += 0.1;
    const values = new Set(cards.map((c) => RANKS.indexOf(c[0]) + 2));
    if (values.has(14)) values.add(1);
    if (
      Array.from({ length: 10 }, (_, i) => i + 1).some(
        (start) =>
          Array.from({ length: 5 }, (_, i) => start + i).filter((v) =>
            values.has(v),
          ).length === 4,
      )
    )
      score += 0.06;
  }
  return Math.min(score, 1);
}
export class Bot {
  constructor(style, value = seed(), samples = 128) {
    if (
      !Object.hasOwn(STRATEGIES, style) ||
      !Number.isInteger(samples) ||
      samples < 1 ||
      samples > 10000
    )
      throw new Error("未知电脑策略或抽样数无效。");
    this.style = style;
    this.rng = new Random(value);
    this.samples = samples;
  }
  estimate_equity(o) {
    const opponents = o.players.filter(
      (p) => p.active && p.player_id !== o.player_id,
    ).length;
    if (!opponents) return 1;
    const key = JSON.stringify([o.hole_cards, o.board, opponents]);
    if (key === this.cache_key) return this.cached_equity;
    const known = [...o.hole_cards, ...o.board];
    if (
      o.hole_cards.length !== 2 ||
      o.board.length > 5 ||
      new Set(known).size !== known.length ||
      known.some((c) => !DECK.includes(c))
    )
      throw new Error("胜率估计需要两张底牌及不重复的公共牌。");
    const unseen = DECK.filter((c) => !known.includes(c)),
      missing = 5 - o.board.length;
    let share = 0;
    for (let sample = 0; sample < this.samples; sample++) {
      const drawn = this.rng.shuffle(unseen),
        board = [...o.board, ...drawn.slice(0, missing)];
      const hands = [evaluate([...o.hole_cards, ...board]).score];
      for (let i = 0; i < opponents; i++)
        hands.push(
          evaluate([
            ...drawn.slice(missing + i * 2, missing + i * 2 + 2),
            ...board,
          ]).score,
        );
      if (hands[0] === Math.max(...hands))
        share += 1 / hands.filter((h) => h === hands[0]).length;
    }
    this.cache_key = key;
    return (this.cached_equity = share / this.samples);
  }
  choose_action(o) {
    const legal = o.legal,
      me = o.players.find((p) => p.player_id === o.player_id),
      style = this.style;
    const price = legal.call_amount / Math.max(1, o.pot + legal.call_amount),
      commitment = legal.call_amount / Math.max(1, me.stack);
    const fold = () => ({ kind: "fold" });
    if (style === "random") {
      const roll = this.rng.random();
      if (legal.call_amount && roll < 0.2 && legal.fold) return fold();
      if (legal.min_raise_to != null && roll > (legal.check ? 0.7 : 0.8))
        return { kind: "raise", amount: legal.min_raise_to };
      return passive_action(o);
    }
    if (style === "equity") {
      const equity = this.estimate_equity(o);
      if (legal.call_amount && equity < price + 0.04 && legal.fold)
        return fold();
      if (
        legal.min_raise_to != null &&
        equity >=
          Math.max(0.52, 1 / o.players.filter((p) => p.active).length + 0.18)
      )
        return raise_action(o, equity >= 0.75 ? 0.75 : 0.5);
      return passive_action(o);
    }
    let score = strength(o);
    if (style === "calling_station") {
      if (
        !legal.check &&
        legal.fold &&
        legal.call_amount &&
        score < 0.4 &&
        ((price > 0.38 && legal.call_amount > 4 * o.big_blind) ||
          commitment > 0.6)
      )
        return fold();
      return passive_action(o);
    }
    if (style === "maniac") {
      if (legal.fold && legal.call_amount > me.stack * 0.75 && score < 0.3)
        return fold();
      if (legal.min_raise_to != null && this.rng.random() < 0.8)
        return raise_action(o, 1, 5);
      return passive_action(o);
    }
    if (style === "push_fold" && me.stack + me.bet <= 12 * o.big_blind) {
      const threshold =
        0.6 +
        Math.max(
          0,
          o.players.filter((p) => p.active && p.player_id !== me.player_id)
            .length - 1,
        ) *
          0.04 -
        (me.position.includes("BTN") ? 0.05 : 0);
      if (score >= threshold)
        return legal.all_in ? { kind: "all_in" } : passive_action(o);
      return legal.check
        ? { kind: "check" }
        : legal.fold
          ? fold()
          : passive_action(o);
    }
    if (style === "nit") {
      const threshold =
        (o.street === "preflop" ? 0.66 : 0.48) +
        price * 0.2 +
        commitment * 0.12 -
        (me.position.includes("BTN") ? 0.03 : 0);
      if (legal.call_amount && score < threshold && legal.fold) return fold();
      if (
        legal.min_raise_to != null &&
        score >= 0.78 &&
        this.rng.random() < 0.7
      )
        return raise_action(o);
      return passive_action(o);
    }
    score +=
      (style === "loose" ? 0.07 : 0) + (me.position.includes("BTN") ? 0.03 : 0);
    if (
      legal.call_amount &&
      score < 0.25 + price * 0.65 + commitment * 0.2 &&
      legal.fold
    )
      return fold();
    if (
      legal.min_raise_to != null &&
      score >= 0.62 &&
      this.rng.random() < (style === "loose" ? 0.75 : 0.55)
    )
      return raise_action(o);
    return passive_action(o);
  }
}
export const make_bot = (style, value, samples) =>
  new Bot(style, value, samples);
