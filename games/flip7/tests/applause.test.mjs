import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../src/rooms.js";
import { updateApplause, applauseView } from "../src/applause.js";
import { applyAction } from "../src/game.js";
import { nearFlipSeven } from "./helpers/applause-fixture.mjs";
const id = () => randomBytes(16).toString("hex");
const act = (service, seat, command, extra = {}) =>
  service.command(seat.code, seat.token, {
    requestId: id(),
    expectedRevision: service.room(seat.code).revision,
    command,
    ...extra,
  });
async function table(t, { allHuman = false, file = null, ...fixture } = {}) {
  let now = 100_000;
  const service = await new RoomService({
    file,
    now: () => now,
    botDelay: 100_000,
  }).init();
  t.after(() => service.close());
  const host = await service.create("甲");
  const seats = [host, await service.join(host.code, "乙")];
  if (allHuman) seats.push(await service.join(host.code, "丙"));
  else await act(service, host, { type: "addBot" });
  const views = seats.map(() => []);
  const disconnect = seats.map((seat, index) =>
    service.subscribe(seat.code, seat.token, (snapshot) =>
      views[index].push(snapshot),
    ),
  );
  t.after(() => disconnect.forEach((off) => off()));
  await service.commit(
    nearFlipSeven(structuredClone(service.room(host.code)), fixture),
  );
  if (fixture.forced) {
    await act(service, seats[1], { type: "game", action: { type: "hit" } });
    await act(service, seats[1], {
      type: "game",
      action: { type: "target", targetId: host.snapshot.selfId },
    });
  } else await act(service, host, { type: "game", action: { type: "hit" } });
  const receipt = service.room(host.code).applause;
  return {
    service,
    host,
    seats,
    views,
    receipt,
    disconnect,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("Flip 7 waits for every human, bots auto-applaud, and early next-round requests are blocked", async (t) => {
  const { service, host, seats, views, receipt } = await table(t);
  const game = structuredClone(service.room(host.code).game);
  assert.equal(receipt.playerId, host.snapshot.selfId);
  assert.equal(receipt.acknowledgedIds.length, 1);
  assert.equal(views[0].at(-1).applause.complete, false);
  await assert.rejects(
    act(service, host, { type: "game", action: { type: "nextRound" } }),
    { status: 409 },
  );
  const applause = { type: "applaud", applauseId: receipt.id };
  await act(service, host, applause);
  for (const view of views)
    assert.equal(view.at(-1).applause.acknowledgedIds.length, 2);
  await act(service, host, applause);
  assert.equal(service.room(host.code).applause.acknowledgedIds.length, 2);
  await assert.rejects(
    act(service, host, { type: "game", action: { type: "nextRound" } }),
    { status: 409 },
  );
  await act(service, seats[1], applause);
  for (const view of views) assert.equal(view.at(-1).applause.complete, true);
  assert.deepEqual(service.room(host.code).game, game);
  await act(service, host, { type: "game", action: { type: "nextRound" } });
  assert.equal(service.room(host.code).applause, null);
  await assert.rejects(act(service, host, applause), { status: 409 });
});

test("simultaneous applause merges despite stale room revisions and retries cannot add another vote", async (t) => {
  const { service, host, seats, receipt } = await table(t, { allHuman: true });
  const revision = service.room(host.code).revision;
  const payloads = seats.map(() => ({
    requestId: id(),
    expectedRevision: revision,
    command: { type: "applaud", applauseId: receipt.id },
  }));
  await Promise.all(
    seats.map((seat, index) =>
      service.command(seat.code, seat.token, payloads[index]),
    ),
  );
  assert.equal(
    service.snapshot(host.code, host.snapshot.selfId).applause.complete,
    true,
  );
  await service.command(host.code, host.token, payloads[0]);
  assert.equal(service.room(host.code).applause.acknowledgedIds.length, 3);
  assert.equal(service.room(host.code).revision, revision + 3);
  await assert.rejects(
    act(service, host, { type: "applaud", applauseId: "an-old-celebration" }),
    { status: 409 },
  );
});

test("offline and automated human seats still need their own applause", async (t) => {
  const { service, host, seats, receipt, disconnect, advance } = await table(t);
  disconnect[1]();
  advance(31_000);
  await act(service, host, {
    type: "takeover",
    memberId: seats[1].snapshot.selfId,
  });
  await act(service, host, { type: "applaud", applauseId: receipt.id });
  assert.equal(
    service.snapshot(host.code, host.snapshot.selfId).applause.complete,
    false,
  );
  const off = service.subscribe(host.code, seats[1].token, () => {});
  t.after(off);
  await act(service, seats[1], { type: "applaud", applauseId: receipt.id });
  assert.equal(
    service.snapshot(host.code, host.snapshot.selfId).applause.complete,
    true,
  );
});

test("explicitly leaving transfers the seat to a bot and resolves its pending applause", async (t) => {
  const { service, host, seats, receipt } = await table(t);
  await act(service, host, { type: "applaud", applauseId: receipt.id });
  await act(service, seats[1], { type: "leave" });
  assert.equal(
    service.snapshot(host.code, host.snapshot.selfId).applause.complete,
    true,
  );
});

test("partial and completed applause survive a server restart with the same celebration ID", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flip7-applause-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json");
  const { service, host, seats, receipt } = await table(t, { file });
  await act(service, host, { type: "applaud", applauseId: receipt.id });
  await service.close();
  const restored = await new RoomService({ file, now: () => 100_000 }).init();
  t.after(() => restored.close());
  assert.deepEqual(
    restored.room(host.code).applause,
    service.room(host.code).applause,
  );
  assert.equal(
    restored.snapshot(host.code, host.snapshot.selfId).applause.complete,
    false,
  );
  await act(restored, seats[1], { type: "applaud", applauseId: receipt.id });
  await restored.close();
  const completed = await new RoomService({ file, now: () => 100_000 }).init();
  t.after(() => completed.close());
  assert.equal(
    completed.snapshot(host.code, host.snapshot.selfId).applause.complete,
    true,
  );
  assert.equal(completed.room(host.code).applause.id, receipt.id);
});

test("forced Flip 7 credits the recipient and gates a rematch even if a different player wins", async (t) => {
  const { service, host, seats, receipt } = await table(t, {
    forced: true,
    scores: [0, 199, 0],
  });
  assert.equal(service.room(host.code).game.phase, "finished");
  assert.equal(service.room(host.code).game.winner, seats[1].snapshot.selfId);
  assert.equal(receipt.playerId, host.snapshot.selfId);
  await assert.rejects(act(service, host, { type: "lobby" }), { status: 409 });
  for (const seat of seats)
    await act(service, seat, { type: "applaud", applauseId: receipt.id });
  await act(service, host, { type: "lobby" });
  assert.equal(service.room(host.code).applause, null);
});

test("solo applause is stored with the save, auto-credits computers, and resets next round", () => {
  const players = [
    { id: "you", name: "你" },
    { id: "b", name: "乙", bot: true },
    { id: "c", name: "丙", bot: true },
  ];
  const before = nearFlipSeven({ members: players, revision: 0 }).game;
  const after = applyAction(before, "you", { type: "hit" });
  after.applause = updateApplause(after, after.players, null, () => "solo-one");
  assert.equal(applauseView(after.applause, after.players).complete, false);
  after.applause.acknowledgedIds.push("you");
  const restored = JSON.parse(JSON.stringify(after));
  assert.equal(
    applauseView(
      updateApplause(
        restored,
        restored.players,
        restored.applause,
        () => "wrong",
      ),
      restored.players,
    ).complete,
    true,
  );
  const next = applyAction(restored, "you", { type: "nextRound" });
  assert.equal(
    updateApplause(next, next.players, restored.applause, () => "new"),
    null,
  );
});
