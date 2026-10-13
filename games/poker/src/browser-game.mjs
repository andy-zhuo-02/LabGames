import {
  Table,
  evaluate,
  HAND_NAMES,
  STREET_NAMES,
  LABELS,
  sum,
} from "./engine.mjs";
import { PROFILES, catalog, make_bot } from "./bots.mjs";

export class Conflict extends Error {}
export const now = () => Date.now() / 1000;
export function describe_action(record) {
  const { kind, amount } = record.action;
  return kind === "raise"
    ? `下注/加注到 ${amount}（投入 ${record.paid}）`
    : kind === "call"
      ? `跟注 ${record.paid}`
      : kind === "all_in"
        ? `全下，投入 ${record.paid}`
        : { check: "过牌", fold: "弃牌" }[kind];
}
export function best_five(cards, board) {
  const hand = evaluate([...cards, ...board]),
    label = HAND_NAMES[hand.category];
  const ranks = (values) =>
    values
      .map((v) => (v <= 10 ? v : { 11: "J", 12: "Q", 13: "K", 14: "A" }[v]))
      .join("、");
  return {
    best_cards: hand.cards,
    comparison: [4, 8].includes(hand.category)
      ? `${ranks([hand.tie[0]])} 高${label}`
      : `${label}，依次比较 ${ranks(hand.tie)}`,
    hand_type: label,
  };
}
export function public_details(hand) {
  const result = hand.result(),
    names = Object.fromEntries(hand.players.map((p) => [p.player_id, p.name]));
  const shown_hands = result.shown_hands.map((h) => ({
    ...h,
    name: names[h.player_id],
    ...best_five(h.cards, result.board),
  }));
  return {
    shown_hands,
    payouts: result.payouts.map((p) => ({
      label: p.pot_index ? `边池 ${p.pot_index}` : "主池",
      participants: p.eligible.map((id) => names[id]),
      eligibility_limits: [],
      reason: !shown_hands.length
        ? "其他玩家均弃牌，无需比牌。"
        : p.awards.length > 1
          ? "最佳五张牌完全相同，平分底池；零头按位置分配。"
          : `按最佳五张牌比较：${shown_hands.find((h) => h.player_id === p.awards[0][0]).comparison}。`,
      awards: p.awards.map(([id, amount]) => ({ name: names[id], amount })),
    })),
    actions: hand.actions.map((a) => ({
      player: names[a.player_id],
      street: STREET_NAMES[a.street],
      description: describe_action(a),
    })),
    stacks: hand.players.map((p) => ({
      id: p.player_id,
      name: p.name,
      stack: result.stacks.find(([id]) => id === p.player_id)[1],
      initial: p.stack,
    })),
  };
}
export class BrowserGame {
  constructor() {
    this.table = null;
    this.bots = {};
    this.strategies = [];
    this.version = 0;
    this.last_seen = now();
    this.completed = 0;
    this.wins = 0;
    this.player_wins = {};
    this.player_hands = {};
    this.history = [];
    this.room = "轻松练手";
  }
  start(payload) {
    const name = payload.name ?? "你",
      opponents = payload.opponents ?? ["calling_station", "random"],
      room = payload.room ?? "自由组桌";
    if (typeof name !== "string" || [...name.trim()].length > 12)
      throw new Error("昵称最多 12 个字。");
    if (
      !Array.isArray(opponents) ||
      opponents.length < 1 ||
      opponents.length > 5 ||
      opponents.some((s) => !Object.hasOwn(PROFILES, s))
    )
      throw new Error("请选择 1 至 5 位列表中的电脑牌友。");
    if (typeof room !== "string" || [...room].length > 20)
      throw new Error("牌桌名称不正确。");
    const names = [
      name.trim() || "你",
      ...opponents.map(
        (s, i) =>
          PROFILES[s].name +
          (opponents.filter((v) => v === s).length > 1
            ? opponents.slice(0, i + 1).filter((v) => v === s).length
            : ""),
      ),
    ];
    const table = new Table(names);
    table.start_hand();
    this.table = table;
    this.bots = Object.fromEntries(
      opponents.map((s, i) => [i + 1, make_bot(s)]),
    );
    this.strategies = ["human", ...opponents];
    this.room = room;
    this.completed = this.wins = 0;
    this.player_wins = {};
    this.player_hands = {};
    this.history = [];
    this.version++;
    this.account_result();
  }
  command(route, payload) {
    if (!this.table) throw new Conflict("请先选择牌桌。");
    if (!Number.isInteger(payload.version) || payload.version !== this.version)
      throw new Conflict("牌桌已经更新，请按当前画面操作。");
    const hand = this.table.hand;
    if (route === "action") {
      if (hand.finished || hand.actor_id !== 0)
        throw new Conflict("还没轮到你，请稍等。");
      this.table.apply_action(0, {
        kind: payload.kind,
        amount: payload.amount,
      });
    } else if (route === "step") {
      if (hand.finished || hand.actor_id === 0)
        throw new Conflict("当前没有等待行动的电脑。");
      this.table.apply_action(
        hand.actor_id,
        this.bots[hand.actor_id].choose_action(hand.observe(hand.actor_id)),
      );
    } else if (route === "next") {
      if (
        !hand.finished ||
        this.table.winner ||
        this.table.players[0].stack === 0
      )
        throw new Conflict("当前不能开始下一手。");
      this.table.start_hand();
    } else if (route === "finish") {
      const hero = hand.observe(0).players.find((p) => p.player_id === 0);
      if (hand.finished || (hero.active && hero.stack > 0))
        throw new Conflict("你仍在参与本手，请亲自选择动作。");
      for (let i = 0; i < 10000 && !hand.finished; i++)
        this.table.apply_action(
          hand.actor_id,
          this.bots[hand.actor_id].choose_action(hand.observe(hand.actor_id)),
        );
      if (!hand.finished) throw new Error("本手推进异常。");
    } else throw new Error("未知操作。");
    this.version++;
    this.account_result();
  }
  account_result() {
    const hand = this.table?.hand;
    if (!hand?.finished || this.completed === hand.hand_number) return;
    const result = hand.result(),
      payoffs = Object.fromEntries(result.payoffs);
    this.completed = hand.hand_number;
    this.wins += payoffs[0] > 0 ? 1 : 0;
    for (const [id, profit] of result.payoffs) {
      this.player_wins[id] = (this.player_wins[id] || 0) + (profit > 0 ? 1 : 0);
      this.player_hands[id] = (this.player_hands[id] || 0) + 1;
    }
    const details = public_details(hand);
    details.stacks.push(
      ...this.table.players
        .filter((p) => !hand.player_ids.includes(p.player_id))
        .map((p) => ({
          id: p.player_id,
          name: p.name,
          stack: p.stack,
          initial: p.stack,
        })),
    );
    this.history.unshift({
      hand_number: hand.hand_number,
      profit: payoffs[0] || 0,
      payoffs,
      board: result.board,
      winners: [
        ...new Set(result.payouts.flatMap((p) => p.awards.map(([id]) => id))),
      ]
        .sort((a, b) => a - b)
        .map((id) => this.table.players[id].name),
      details,
    });
    this.history = this.history.slice(0, 30);
  }
  snapshot(viewer_id = 0, { multiplayer = false } = {}) {
    if (!this.table)
      return {
        version: this.version,
        phase: "lobby",
        catalog: catalog(),
        mode: "solo",
        viewer_id: 0,
      };
    const table = this.table,
      hand = table.hand,
      participating = hand.player_ids.includes(viewer_id);
    const observation = hand.observe(
      participating ? viewer_id : hand.player_ids[0],
    );
    const own = participating ? observation.hole_cards : [],
      result = hand.finished ? hand.result() : null;
    const awards = {};
    if (result)
      for (const pot of result.payouts)
        for (const [id, amount] of pot.awards)
          awards[id] = (awards[id] || 0) + amount;
    const shown = Object.fromEntries(
      (result?.shown_hands || []).map((h) => [h.player_id, h.cards]),
    );
    const folded = new Set(
      hand.actions
        .filter((a) => a.action.kind === "fold")
        .map((a) => a.player_id),
    );
    const latest = Object.fromEntries(
      hand.actions.map((a) => [a.player_id, a]),
    );
    const players = table.players.map((seat) => {
      const id = seat.player_id,
        p = observation.players.find((p) => p.player_id === id),
        profile = PROFILES[this.strategies[id]] || {};
      return {
        id,
        name: seat.name,
        strategy: this.strategies[id],
        avatar: profile.avatar || (id === viewer_id ? "你" : [...seat.name][0]),
        style: profile.style || "真人",
        color: profile.color || "#e6c479",
        stack: p?.stack ?? seat.stack,
        bet: p?.bet || 0,
        position: p?.position || "",
        folded: folded.has(id),
        eliminated: seat.stack === 0,
        waiting_for_hand: !p && seat.stack > 0,
        all_in: !!p && p.active && p.stack === 0 && !hand.finished,
        cards: [...(id === viewer_id ? own : shown[id] || [])],
        last_action: latest[id] ? describe_action(latest[id]) : "",
        is_winner: Object.hasOwn(awards, id),
        won_amount: awards[id] || 0,
      };
    });
    let summary = null;
    if (result) {
      const profit = Object.fromEntries(result.payoffs)[viewer_id] || 0;
      const details =
        this.history[0]?.hand_number === hand.hand_number
          ? this.history[0].details
          : public_details(hand);
      summary = {
        winner_ids: Object.keys(awards)
          .map(Number)
          .sort((a, b) => a - b),
        end_reason: result.shown_hands.length ? "showdown" : "folds",
        explanation: result.shown_hands.length
          ? "本手进入摊牌，未弃牌的玩家全部亮出底牌。"
          : "其他玩家均已弃牌，最后留下的玩家直接收下底池，无需亮牌。",
        profit,
        pot: sum(Object.values(awards)),
        title:
          profit > 0
            ? "漂亮，赢下这一手"
            : folded.has(viewer_id)
              ? "下一手，再找机会"
              : "这一手结束了",
        match_over:
          !!table.winner ||
          (!multiplayer && table.players[viewer_id]?.stack === 0),
        champion: table.winner?.name || null,
        hero_won_table: !!table.winner && table.winner.player_id === viewer_id,
        returned_bets: result.returned_bets.map(([id, amount]) => ({
          name: table.players[id].name,
          amount,
        })),
        shown_hands: details.shown_hands,
        payouts: details.payouts,
      };
    }
    return {
      mode: multiplayer ? "multiplayer" : "solo",
      viewer_id,
      version: this.version,
      phase: hand.finished ? "finished" : "playing",
      room: this.room,
      hand_number: hand.hand_number,
      street: hand.street,
      street_name: STREET_NAMES[hand.street],
      action_number: hand.actions.length,
      actor_id: hand.actor_id,
      board: [...hand.board],
      pot: hand.pot,
      small_blind: table.config.small_blind,
      big_blind: table.config.big_blind,
      players,
      legal: hand.legal_actions(viewer_id),
      hand_type:
        own.length && hand.board.length >= 3
          ? HAND_NAMES[evaluate([...own, ...hand.board]).category]
          : "",
      actions: hand.actions
        .slice(-30)
        .map((a) => ({
          player: table.players[a.player_id].name,
          street: STREET_NAMES[a.street],
          description: describe_action(a),
        })),
      stats: {
        hands: this.player_hands[viewer_id] || 0,
        wins: this.player_wins[viewer_id] || 0,
        profit:
          viewer_id == null
            ? 0
            : table.players[viewer_id].stack - table.config.starting_stack,
      },
      result: summary,
      history: this.history.map(({ payoffs, ...h }) => ({
        ...h,
        profit: payoffs[viewer_id] || 0,
      })),
      catalog: catalog(),
    };
  }
}
