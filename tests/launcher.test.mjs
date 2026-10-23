import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const launcher = fileURLToPath(
  new URL("../scripts/labgames.mjs", import.meta.url),
);
test("shared launcher checks dependencies and rejects invalid games and ports", () => {
  for (const [args, env, expected] of [
    [["doctor"], {}, 0],
    [["start", "missing"], {}, 1],
    [["start", "all"], { POKER_PORT: "3000" }, 1],
    [["start", "poker"], { POKER_PORT: "NaN" }, 1],
    [["start", "quoridor"], { QUORIDOR_PORT: "NaN" }, 1],
    [["start", "all"], { QUORIDOR_PORT: "3007" }, 1],
  ]) {
    const r = spawnSync(process.execPath, [launcher, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, expected, r.stderr);
  }
});
for (const game of ["flip7", "quoridor"])
  test(
    `one command launches ${game} on its configured port and stops its child`,
    { timeout: 15000 },
    async (t) => {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const port = reservation.address().port;
      await new Promise((r) => reservation.close(r));
      const dir = mkdtempSync(join(tmpdir(), "labgames-launcher-"));
      const child = spawn(process.execPath, [launcher, "start", game], {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          [`${game.toUpperCase()}_PORT`]: String(port),
          FLIP7_DATA_FILE: join(dir, "rooms.json"),
          QUORIDOR_DATA_FILE: join(dir, "rooms.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (b) => {
        output += b;
      });
      child.stderr.on("data", (b) => {
        output += b;
      });
      const exited = once(child, "exit");
      t.after(() => {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      });
      let healthy = false;
      for (let i = 0; i < 80; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(250),
          });
          healthy = r.ok;
          if (healthy) break;
        } catch {
          /* starting */
        }
        if (child.exitCode !== null) break;
        await delay(50);
      }
      assert.equal(healthy, true, output);
      child.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 0, output);
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(300),
        }),
      );
    },
  );
