import { mkdirSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Table, Random, config } from "./src/engine.mjs";
import { STRATEGIES, make_bot } from "./src/bots.mjs";
import { options, play_bot_hand, write_history } from "./cli.mjs";

export async function run_tournament(
  output,
  { seed = 42, settings = config(), samples = 128, signal } = {},
) {
  const styles = Object.keys(STRATEGIES),
    rng = new Random(seed),
    botSeeds = styles.map(() => rng.next()),
    tableSeed = rng.next();
  const bots = styles.map((s, i) => make_bot(s, botSeeds[i], samples)),
    table = new Table(styles, settings, { seed: tableSeed });
  mkdirSync(output, { recursive: false });
  const peaks = styles.map(() => settings.starting_stack),
    eliminated = {},
    places = {};
  let completed = 0;
  const checkpoint = (status, error) => {
    const summary = {
      status,
      engine: "labgames-node-v1",
      seed,
      table_seed: tableSeed,
      bot_seeds: Object.fromEntries(styles.map((s, i) => [s, botSeeds[i]])),
      config: settings,
      equity_samples: samples,
      hands_played: completed,
      total_chips: settings.starting_stack * styles.length,
      winner: table.winner?.name ?? null,
      players: table.players.map((p) => ({
        player_id: p.player_id,
        strategy: p.name,
        final_stack: p.stack,
        peak_stack: peaks[p.player_id],
        eliminated_hand: eliminated[p.player_id] ?? null,
        place: places[p.player_id] ?? null,
      })),
      ...(error ? { error } : {}),
    };
    writeFileSync(
      join(output, "summary.json.tmp"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    renameSync(join(output, "summary.json.tmp"), join(output, "summary.json"));
    return summary;
  };
  writeFileSync(
    join(output, "stacks.csv"),
    `hand,${styles.join(",")}\n0,${peaks.join(",")}\n`,
  );
  checkpoint("running");
  try {
    while (!table.winner) {
      if (signal?.aborted) return checkpoint("interrupted");
      const before = table.active_ids;
      play_bot_hand(table, bots);
      completed++;
      table.players.forEach((p, i) => {
        peaks[i] = Math.max(peaks[i], p.stack);
        if (!p.stack && before.includes(i)) {
          eliminated[i] = completed;
          places[i] = table.active_ids.length + 1;
        }
      });
      if (table.winner) places[table.winner.player_id] = 1;
      appendFileSync(
        join(output, "stacks.csv"),
        `${completed},${table.players.map((p) => p.stack).join(",")}\n`,
      );
      write_history(join(output, "hands.jsonl"), table, styles, samples);
      checkpoint(table.winner ? "complete" : "running");
      await new Promise((resolve) => setImmediate(resolve));
    }
    return checkpoint("complete");
  } catch (e) {
    checkpoint("failed", e.message);
    throw e;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = options(undefined, true),
      output = args.output || `runs/all-bots-${Date.now()}-seed${args.seed}`;
    mkdirSync(resolve(output, ".."), { recursive: true });
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    const result = await run_tournament(output, {
      seed: args.seed,
      settings: args.config,
      samples: args.samples,
      signal: controller.signal,
    });
    console.log(
      `${result.status} · ${result.hands_played} 手 · 冠军 ${result.winner ?? "尚未产生"}\n${resolve(output)}`,
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
