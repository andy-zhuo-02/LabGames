import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse_action } from "../cli.mjs";
import { run_tournament } from "../tournament.mjs";
import { plot_run } from "../plot-tournament.mjs";
import { config } from "../src/engine.mjs";

test("CLI parses only valid actions and simulates a full run using Node", () => {
  assert.deepEqual(parse_action("r 100"), { kind: "raise", amount: 100 });
  assert.deepEqual(parse_action("x"), { kind: "check" });
  assert.equal(parse_action("q"), null);
  for (const input of ["", "check 20", "raise -1", "raise 0", "raise nope"])
    assert.throws(() => parse_action(input));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../cli.mjs", import.meta.url)),
      "--simulate",
      "1000",
      "--seed",
      "42",
      "--stack",
      "40",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /模拟完成: 1000 手/);
});
test("tournament records all seats, reproduces results and draws without Python", async () => {
  const dir = mkdtempSync(join(tmpdir(), "labgames-tournament-"));
  try {
    const options = {
      seed: 10,
      settings: config({ small_blind: 1, big_blind: 2, starting_stack: 4 }),
      samples: 4,
    };
    const a = await run_tournament(join(dir, "a"), options),
      b = await run_tournament(join(dir, "b"), options);
    assert.equal(a.status, "complete");
    assert.deepEqual(a, b);
    assert.equal(a.players.filter((p) => p.final_stack > 0).length, 1);
    assert.equal(a.players.find((p) => p.place === 1).final_stack, 32);
    assert.deepEqual(
      readFileSync(join(dir, "a/stacks.csv")),
      readFileSync(join(dir, "b/stacks.csv")),
    );
    await assert.rejects(run_tournament(join(dir, "a"), options), /exist/);
    assert.deepEqual(plot_run(join(dir, "a")), a);
    assert.match(readFileSync(join(dir, "a/chip-curves.svg"), "utf8"), /<svg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
