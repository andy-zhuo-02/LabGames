import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../src/rooms.js";
const cmd = (
  service,
  seat,
  command,
  revision = service.snapshot(seat.code, seat.token).revision,
) => service.command(seat.code, seat.token, { revision, command });
test("room ownership, seat credentials, revisions and turn enforcement", () => {
  const service = new RoomService(),
    a = service.create({ name: "甲" }),
    b = service.join(a.code, { name: "乙" });
  assert.throws(() => service.join(a.code, {}), /坐满/);
  assert.throws(() => service.snapshot(a.code, "bad"), /凭证/);
  const publicView = service.snapshot(a.code, a.token);
  assert.ok(!JSON.stringify(publicView).includes(a.token));
  assert.ok(!JSON.stringify(publicView).includes(b.token));
  assert.throws(() => cmd(service, b, { type: "start" }), /房主/);
  cmd(service, a, { type: "start" });
  assert.throws(() => service.join(a.code, {}), /已经开始/);
  assert.throws(
    () =>
      cmd(service, b, {
        type: "action",
        action: { type: "move", row: 1, col: 4 },
      }),
    /没轮到/,
  );
  const revision = service.snapshot(a.code, a.token).revision;
  const move = { type: "action", action: { type: "move", row: 7, col: 4 } };
  cmd(service, a, move);
  assert.throws(() => cmd(service, a, move, revision), /已更新/);
  assert.equal(service.snapshot(a.code, a.token).game.ply, 1);
  assert.deepEqual(
    service.snapshot(a.code, a.token).game,
    service.snapshot(b.code, b.token).game,
  );
});
for (const count of [3, 4])
  test(`${count}-player empty seats and leavers become bots, host transfers and rooms restart`, () => {
    let now = 1000;
    const service = new RoomService({ now: () => now }),
      a = service.create({ count }),
      b = service.join(a.code, {});
    cmd(service, a, { type: "start" });
    cmd(service, a, { type: "leave" });
    const view = service.snapshot(b.code, b.token);
    assert.equal(view.host, 1);
    assert.equal(view.game.players[0].isBot, true);
    assert.deepEqual(
      view.game.players.map((p) => p.isBot),
      Array.from({ length: count }, (_, i) => i !== 1),
    );
    now += 1000;
    service.tick();
    assert.equal(service.snapshot(b.code, b.token).game.turn, 1);
    assert.throws(() => service.snapshot(a.code, a.token), /凭证/);
    cmd(service, b, { type: "restart" });
    assert.equal(service.snapshot(b.code, b.token).game, null);
    const newcomer = service.join(b.code, { name: "新朋友" });
    assert.equal(newcomer.snapshot.self, 0);
    cmd(service, b, { type: "start" });
    assert.equal(
      service.snapshot(b.code, b.token).game.players[0].isBot,
      false,
    );
    cmd(service, newcomer, { type: "leave" });
    cmd(service, b, { type: "leave" });
    assert.equal(service.rooms.size, 0);
  });
test("restart restores board and private seats; expired rooms cannot be recovered", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "quoridor-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json");
  let now = 10000;
  const service = new RoomService({ file, now: () => now }),
    a = service.create({ name: "松", count: 3 });
  cmd(service, a, { type: "start" });
  cmd(service, a, {
    type: "action",
    action: { type: "wall", row: 3, col: 4, orientation: "h" },
  });
  const expected = service.snapshot(a.code, a.token);
  assert.equal(expected.count, 3);
  assert.equal(expected.game.players.length, 3);
  assert.equal(expected.game.players[0].walls, 5);
  const restored = new RoomService({ file, now: () => now });
  assert.deepEqual(restored.snapshot(a.code, a.token), expected);
  now += 1000;
  restored.tick();
  assert.equal(restored.snapshot(a.code, a.token).game.ply, 2);
  now += 25 * 60 * 60 * 1000;
  assert.throws(() => restored.snapshot(a.code, a.token), /过期/);
  assert.equal(new RoomService({ file, now: () => now }).rooms.size, 0);
});
