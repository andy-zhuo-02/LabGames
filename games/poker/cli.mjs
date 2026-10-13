import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Table, Random, config, STREET_NAMES } from "./src/engine.mjs";
import { STRATEGIES, make_bot } from "./src/bots.mjs";

export function parse_action(text) {
  const parts = text.trim().toLowerCase().split(/\s+/);
  if (parts.length === 1) {
    if (["q", "quit", "exit"].includes(parts[0])) return null;
    const kind = {
      f: "fold",
      fold: "fold",
      x: "check",
      check: "check",
      c: "call",
      call: "call",
      a: "all_in",
      allin: "all_in",
      "all-in": "all_in",
      all_in: "all_in",
    }[parts[0]];
    if (kind) return { kind };
  }
  if (
    parts.length === 2 &&
    ["r", "raise", "bet"].includes(parts[0]) &&
    /^\d+$/.test(parts[1]) &&
    Number.isSafeInteger(+parts[1]) &&
    +parts[1] > 0
  )
    return { kind: "raise", amount: +parts[1] };
  throw new Error("请输入 fold / check / call / raise 数额 / allin / q。");
}
export function write_history(path, table, strategies, equity_samples = 128) {
  const h = table.hand;
  appendFileSync(
    path,
    JSON.stringify({
      engine: "labgames-node-v1",
      config: table.config,
      hand_seed: h.seed,
      deck: h._initial_deck,
      players: h.players,
      actions: h.actions,
      strategies,
      equity_samples,
      result: h.result(),
    }) + "\n",
  );
}
export function play_bot_hand(table, bots) {
  const hand = table.start_hand();
  for (let i = 0; i < 10000 && !hand.finished; i++)
    table.apply_action(
      hand.actor_id,
      bots[hand.actor_id].choose_action(hand.observe(hand.actor_id)),
    );
  if (!hand.finished) throw new Error("本手行动超过安全步数。");
  return hand.result();
}
export function options(argv = process.argv.slice(2), tournament = false) {
  const args = [...argv];
  // Retain the original two-argument --bots spelling as well as comma-separated values.
  const pos = args.indexOf("--bots");
  if (pos >= 0 && args[pos + 2] && !args[pos + 2].startsWith("--"))
    args.splice(pos + 1, 2, `${args[pos + 1]},${args[pos + 2]}`);
  const { values } = parseArgs({
    args,
    options: {
      seed: { type: "string", default: "42" },
      stack: { type: "string", default: "2000" },
      "small-blind": { type: "string", default: "10" },
      "big-blind": { type: "string", default: "20" },
      "equity-samples": { type: "string", default: "128" },
      bots: { type: "string", default: "random,tight" },
      "hero-bot": { type: "string", default: "loose" },
      simulate: { type: "string" },
      history: { type: "string" },
      "list-bots": { type: "boolean" },
      "no-clear": { type: "boolean" },
      ...(tournament ? { output: { type: "string" } } : {}),
    },
  });
  const integer = (name, positive = true) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || (positive && value <= 0))
      throw new Error(`${name} 必须为${positive ? "正" : ""}整数。`);
    return value;
  };
  const opponents = values.bots.split(",");
  if (
    opponents.length !== 2 ||
    [...opponents, values["hero-bot"]].some(
      (s) => !Object.hasOwn(STRATEGIES, s),
    )
  )
    throw new Error("请选择两个有效的电脑策略。");
  return {
    ...values,
    seed: integer("seed", false),
    config: config({
      small_blind: integer("small-blind"),
      big_blind: integer("big-blind"),
      starting_stack: integer("stack"),
    }),
    samples: integer("equity-samples"),
    simulate: values.simulate ? integer("simulate") : null,
    strategies: [values["hero-bot"], ...opponents],
  };
}
export async function main(argv) {
  const args = options(argv);
  if (args["list-bots"]) {
    for (const [id, name] of Object.entries(STRATEGIES))
      console.log(`${id}：${name}`);
    return;
  }
  const rng = new Random(args.seed),
    bots = args.strategies.map((style) =>
      make_bot(style, rng.next(), args.samples),
    );
  let table = new Table(["你", "Bot-A", "Bot-B"], args.config, {
    seed: rng.next(),
  });
  let completed = 0,
    matches = 0;
  const profits = [0, 0, 0];
  if (args.simulate) {
    for (; completed < args.simulate; completed++) {
      if (table.winner) {
        matches++;
        table = new Table(["你", "Bot-A", "Bot-B"], args.config, {
          seed: rng.next(),
        });
      }
      const result = play_bot_hand(table, bots);
      for (const [id, payoff] of result.payoffs) profits[id] += payoff;
      if (args.history)
        write_history(args.history, table, args.strategies, args.samples);
    }
    console.log(
      `模拟完成: ${completed} 手，完成 ${matches} 场；累计净盈亏 ${profits.join(" / ")}`,
    );
    return;
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let quitting = false;
  terminal.on("SIGINT", () => {
    quitting = true;
    terminal.close();
  });
  terminal.on("close", () => {
    quitting = true;
  });
  try {
    while (!quitting && !table.winner && table.players[0].stack > 0) {
      const h = table.start_hand();
      while (!h.finished && !quitting) {
        const o = h.observe(0);
        console.log(
          `\n第 ${h.hand_number} 手 · ${STREET_NAMES[h.street]} · 底池 ${o.pot}\n公共牌 ${o.board.join(" ")} · 你的牌 ${o.hole_cards.join(" ")}\n${o.players.map((p) => `${p.name} ${p.position} 筹码 ${p.stack} 下注 ${p.bet}`).join(" | ")}`,
        );
        if (h.actor_id !== 0) {
          table.apply_action(
            h.actor_id,
            bots[h.actor_id].choose_action(h.observe(h.actor_id)),
          );
          continue;
        }
        console.log("可选操作：", h.legal_actions(0));
        try {
          const action = parse_action(
            await terminal.question("行动（q 退出）> "),
          );
          if (!action) {
            quitting = true;
            break;
          }
          table.apply_action(0, action);
        } catch (e) {
          if (quitting) break;
          console.log(e.message);
        }
      }
      if (quitting) break;
      console.log("本手净盈亏：", h.result().payoffs);
      if (args.history)
        write_history(args.history, table, args.strategies, args.samples);
      if (!table.winner && table.players[0].stack > 0)
        await terminal.question("回车继续下一手 > ");
    }
  } finally {
    terminal.close();
    console.log("已退出。");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
