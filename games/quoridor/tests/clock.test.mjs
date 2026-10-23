import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomService } from "../src/rooms.js";
import { chooseTimeoutMove } from "../src/bot.js";
import { createGame } from "../src/game.js";

function fixture(options = {}) {
  let time = 1000;
  const service = new RoomService({ ...options, now: () => time });
  const host = service.create({ name: "甲", count: 3, turnSeconds: 10 });
  const view = () => service.snapshot(host.code, host.token);
  const command = (
    command,
    seat = host,
    revision = service.snapshot(seat.code, seat.token).revision,
  ) => service.command(seat.code, seat.token, { revision, command });
  return {
    service,
    host,
    view,
    command,
    setTime: (value) => {
      time = value;
    },
  };
}
test("clock settings are validated, visible to all seats and editable only by the lobby host", () => {
  const f = fixture();
  const friend = f.service.join(f.host.code, { name: "乙" });
  assert.equal(f.view().turnSeconds, 10);
  assert.equal(f.view().clock.deadline, null);
  for (const value of [-1, 5, 11, "30", null, 1.5, Infinity]) {
    assert.throws(() => f.service.create({ turnSeconds: value }), /读秒/);
    assert.throws(
      () => f.command({ type: "settings", turnSeconds: value }),
      /读秒/,
    );
  }
  assert.throws(
    () => f.command({ type: "settings", turnSeconds: 60 }, friend),
    /房主/,
  );
  f.command({ type: "settings", turnSeconds: 60 });
  assert.equal(f.service.snapshot(friend.code, friend.token).turnSeconds, 60);
  f.command({ type: "start" });
  assert.equal(f.view().clock.deadline, 61000);
  assert.throws(
    () => f.command({ type: "settings", turnSeconds: 0 }),
    /开始后/,
  );
});
test("timeout at the exact deadline advances once, moves legally and does not consume a wall", () => {
  const f = fixture();
  f.command({ type: "start" });
  f.setTime(10999);
  f.service.tick();
  assert.equal(f.view().game.ply, 0);
  f.setTime(11000);
  f.service.tick();
  const after = f.view();
  assert.equal(after.game.ply, 1);
  assert.equal(after.game.turn, 1);
  assert.equal(after.game.history[0].automatic, true);
  assert.equal(after.game.history[0].type, "move");
  assert.equal(after.game.walls.length, 0);
  assert.equal(after.game.players[0].walls, 6);
  assert.equal(after.clock.deadline, 21000);
  f.service.tick();
  assert.equal(f.view().game.ply, 1);
});
test("a late client action resolves the timeout first and cannot apply a second action", () => {
  const f = fixture();
  f.command({ type: "start" });
  const revision = f.view().revision;
  f.setTime(11000);
  assert.throws(
    () =>
      f.command(
        {
          type: "action",
          action: { type: "wall", row: 3, col: 3, orientation: "h" },
        },
        f.host,
        revision,
      ),
    /已更新/,
  );
  assert.equal(f.view().game.ply, 1);
  assert.equal(f.view().game.walls.length, 0);
  f.service.tick();
  assert.equal(f.view().game.ply, 1);
});
test("snapshot, refresh and unrelated departures never extend the current deadline", () => {
  const f = fixture();
  const friend = f.service.join(f.host.code, { name: "乙" });
  f.command({ type: "start" });
  const deadline = f.view().clock.deadline;
  f.setTime(5500);
  assert.equal(f.view().clock.serverNow, 5500);
  assert.equal(f.view().clock.deadline, deadline);
  f.command({ type: "leave" }, friend);
  assert.equal(f.view().clock.deadline, deadline);
  f.command({ type: "action", action: { type: "move", row: 7, col: 4 } });
  assert.equal(f.view().clock.deadline, 15500);
});
test("untimed rooms never auto-move human seats and returning to lobby clears the clock", () => {
  const f = fixture();
  f.command({ type: "settings", turnSeconds: 0 });
  f.command({ type: "start" });
  f.setTime(100000);
  f.service.tick();
  assert.equal(f.view().game.ply, 0);
  assert.equal(f.view().clock.deadline, null);
  f.command({ type: "restart" });
  f.command({ type: "settings", turnSeconds: 20 });
  f.command({ type: "start" });
  assert.equal(f.view().clock.deadline, 120000);
  f.command({ type: "restart" });
  assert.equal(f.view().clock.deadline, null);
  assert.equal(f.view().turnSeconds, 20);
});
test("three timed human turns cycle correctly and a timed winning move stops the clock", () => {
  const f = fixture();
  f.service.join(f.host.code, { name: "乙" });
  f.service.join(f.host.code, { name: "丙" });
  f.command({ type: "start" });
  for (const time of [11000, 21000, 31000]) {
    f.setTime(time);
    f.service.tick();
  }
  assert.equal(f.view().game.turn, 0);
  assert.equal(f.view().game.ply, 3);
  const room = f.service.get(f.host.code);
  Object.assign(room.game.players[0], { row: 1, col: 2 });
  f.setTime(41000);
  f.service.tick();
  assert.equal(f.view().game.winner, 0);
  assert.equal(f.view().clock.deadline, null);
});
test("restart preserves the original deadline; legacy rooms remain untimed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "quoridor-clock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json"),
    f = fixture({ file });
  f.command({ type: "start" });
  const restored = new RoomService({ file, now: () => 11000 });
  assert.equal(
    restored.snapshot(f.host.code, f.host.token).clock.deadline,
    11000,
  );
  restored.tick();
  assert.equal(restored.snapshot(f.host.code, f.host.token).game.ply, 1);
  const old = JSON.parse(readFileSync(file, "utf8"));
  delete old.rooms[0].turnSeconds;
  delete old.rooms[0].turnDeadline;
  writeFileSync(file, JSON.stringify(old));
  const legacy = new RoomService({ file, now: () => 60000 });
  assert.equal(legacy.snapshot(f.host.code, f.host.token).turnSeconds, 0);
  assert.equal(legacy.snapshot(f.host.code, f.host.token).clock.deadline, null);
});
test("automatic moves obey jump rules and take an available goal", () => {
  const game = createGame();
  Object.assign(game.players[0], { row: 2, col: 4 });
  Object.assign(game.players[1], { row: 1, col: 4 });
  assert.deepEqual(chooseTimeoutMove(game), { type: "move", row: 0, col: 4 });
  game.winner = 0;
  assert.equal(chooseTimeoutMove(game), null);
});
