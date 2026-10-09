import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RoomService } from "../src/rooms.js";
import {
  createGame,
  currentActor,
  publicView,
  validateSave,
} from "../src/game.js";
import { chooseBotAction } from "../src/bot.js";

const requestId = () => randomBytes(16).toString("hex");
const act = (service, seat, command, extra = {}) =>
  service.command(seat.code, seat.token, {
    requestId: requestId(),
    expectedRevision: service.room(seat.code).revision,
    command,
    ...extra,
  });
const rejects = (promise, status) =>
  assert.rejects(promise, (error) => error.status === status);
async function table(t, options = {}) {
  const service = await new RoomService(options).init();
  t.after(() => service.close());
  const host = await service.create("房主");
  const seats = [
    host,
    await service.join(host.code, "朋友甲"),
    await service.join(host.code, "朋友乙"),
  ];
  const disconnect = seats.map((seat) =>
    service.subscribe(seat.code, seat.token, () => {}),
  );
  t.after(() => disconnect.forEach((fn) => fn()));
  for (const seat of seats.slice(1))
    await act(service, seat, { type: "ready", ready: true });
  return { service, host, seats, disconnect };
}

test("room credentials, readiness, capacity and host permissions are enforced", async (t) => {
  const { service, host, seats, disconnect } = await table(t);
  assert.throws(() => service.authenticate(host.code, "x".repeat(43)), {
    status: 401,
  });
  await rejects(act(service, seats[1], { type: "addBot" }), 403);
  await act(service, seats[1], { type: "ready", ready: false });
  await rejects(act(service, host, { type: "start" }), 409);
  await act(service, seats[1], { type: "ready", ready: true });
  disconnect[2]();
  await rejects(act(service, host, { type: "start" }), 409);
  await rejects(
    act(service, host, { type: "remove", memberId: seats[1].snapshot.selfId }),
    409,
  );
  await act(service, host, {
    type: "remove",
    memberId: seats[2].snapshot.selfId,
  });
  assert.throws(() => service.authenticate(host.code, seats[2].token), {
    status: 401,
  });
  for (let i = 0; i < 4; i++) await act(service, host, { type: "addBot" });
  await rejects(service.join(host.code, "第七位"), 409);
  await rejects(act(service, host, { type: "addBot" }), 409);
  await act(service, host, { type: "start" });
  await rejects(service.join(host.code, "迟到"), 409);
  await rejects(act(service, host, { type: "ready", ready: false }), 409);
  await rejects(act(service, host, { type: "lobby" }), 409);
  const snapshot = service.snapshot(host.code, host.snapshot.selfId);
  assert.equal(snapshot.members.length, 6);
  for (const hidden of [
    "tokenHash",
    '"deck":',
    '"discard":',
    '"queue":',
    '"rng":',
  ])
    assert.ok(!JSON.stringify(snapshot).includes(hidden));
  assert.ok(snapshot.game.deckCount >= 0);
  assert.ok(
    !validateSave(service.room(host.code).game),
    "LAN save must not load as a solo game",
  );
  assert.ok(
    validateSave(service.room(host.code).game, { requireLocalPlayer: false }),
  );
});

test("concurrent commands serialize; retries cannot apply an action twice", async (t) => {
  const { service, host, seats } = await table(t);
  await act(service, host, { type: "start" });
  const before = service.room(host.code);
  const actor = seats.find(
    (s) => s.snapshot.selfId === currentActor(before.game),
  );
  const other = seats.find((s) => s !== actor);
  const command = {
    type: "game",
    action: chooseBotAction(publicView(before.game), actor.snapshot.selfId),
  };
  await rejects(act(service, other, command), 409);
  const payload = {
    requestId: requestId(),
    expectedRevision: before.revision,
    command,
  };
  await Promise.all([
    service.command(host.code, actor.token, payload),
    service.command(host.code, actor.token, payload),
  ]);
  assert.equal(service.room(host.code).revision, before.revision + 1);
  await rejects(
    service.command(host.code, actor.token, {
      ...payload,
      command: { type: "leave" },
    }),
    409,
  );
  await rejects(
    service.command(host.code, actor.token, {
      ...payload,
      requestId: requestId(),
    }),
    409,
  );
  const revision = service.room(host.code).revision;
  const race = await Promise.allSettled(
    seats
      .slice(0, 2)
      .map((seat) =>
        act(service, seat, { type: "reclaim" }, { expectedRevision: revision }),
      ),
  );
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.find((r) => r.status === "rejected").reason.status, 409);
});

test("full multiplayer matches keep special-card targeting, 94 cards and scores consistent", async (t) => {
  const { service, host, seats } = await table(t);
  let targets = 0,
    rounds = 0;
  for (const seed of [7, 23, 91, 402]) {
    await act(service, host, { type: "start" });
    service.room(host.code).game = createGame({
      players: service.room(host.code).members,
      seed,
    });
    let steps = 0;
    while (service.room(host.code).game.phase !== "finished") {
      assert.ok(++steps < 5000);
      const state = service.room(host.code).game;
      const actor =
        state.phase === "roundEnd"
          ? host
          : seats.find((s) => s.snapshot.selfId === currentActor(state));
      const action =
        state.phase === "roundEnd"
          ? { type: "nextRound" }
          : chooseBotAction(publicView(state), actor.snapshot.selfId);
      if (action.type === "target") {
        targets++;
        await rejects(
          act(service, actor, {
            type: "game",
            action: { type: "target", targetId: "not-a-seat" },
          }),
          409,
        );
      }
      if (action.type === "nextRound") rounds++;
      await act(service, actor, { type: "game", action });
      const applause = service.snapshot(
        host.code,
        host.snapshot.selfId,
      ).applause;
      if (applause && !applause.complete) {
        for (const seat of seats)
          await act(service, seat, {
            type: "applaud",
            applauseId: applause.id,
          });
      }
      assert.ok(
        validateSave(service.room(host.code).game, {
          requireLocalPlayer: false,
        }),
      );
      const views = seats.map(
        (seat) => service.snapshot(host.code, seat.snapshot.selfId).game,
      );
      assert.deepEqual(views[0], views[1]);
      assert.deepEqual(views[1], views[2]);
    }
    const final = service.room(host.code).game;
    assert.ok(final.players.find((p) => p.id === final.winner).score >= 200);
    for (const player of final.players)
      assert.equal(
        player.score,
        final.history.reduce(
          (sum, r) => sum + r.scores.find((s) => s.id === player.id).points,
          0,
        ),
      );
    await rejects(act(service, seats[1], { type: "lobby" }), 403);
    await act(service, host, { type: "lobby" });
    for (const seat of seats.slice(1))
      await act(service, seat, { type: "ready", ready: true });
  }
  assert.ok(targets > 10);
  assert.ok(rounds > 10);
});

test("presence supports multiple tabs, host succession, offline takeover and reclaim", async (t) => {
  let now = 10_000;
  const { service, host, seats, disconnect } = await table(t, {
    now: () => now,
    botDelay: 60_000,
  });
  const extra = service.subscribe(host.code, host.token, () => {});
  disconnect[0]();
  assert.ok(service.online(host.snapshot.selfId));
  extra();
  await rejects(act(service, seats[1], { type: "claimHost" }), 409);
  now += 30_001;
  await act(service, seats[1], { type: "claimHost" });
  assert.equal(service.room(host.code).hostId, seats[1].snapshot.selfId);
  const reconnect = service.subscribe(host.code, host.token, () => {});
  t.after(reconnect);
  await act(service, seats[1], { type: "start" });
  reconnect();
  now += 30_001;
  await act(service, seats[1], {
    type: "takeover",
    memberId: host.snapshot.selfId,
  });
  assert.ok(
    service
      .room(host.code)
      .game.players.find((p) => p.id === host.snapshot.selfId).bot,
  );
  await rejects(
    act(service, host, { type: "game", action: { type: "hit" } }),
    409,
  );
  const back = service.subscribe(host.code, host.token, () => {});
  t.after(back);
  await act(service, host, { type: "reclaim" });
  assert.equal(
    service
      .room(host.code)
      .game.players.find((p) => p.id === host.snapshot.selfId).bot,
    false,
  );
  await act(service, seats[1], { type: "leave" });
  assert.equal(service.room(host.code).hostId, host.snapshot.selfId);
  assert.throws(() => service.authenticate(host.code, seats[1].token), {
    status: 401,
  });
  await act(service, host, { type: "leave" });
  await act(service, seats[2], { type: "leave" });
  assert.equal(service.rooms.size, 0);
});

test("server bots pause with all humans offline and resume when a player returns", async (t) => {
  const service = new RoomService({ botDelay: 15 });
  t.after(() => service.close());
  const host = await service.create("我");
  const off = service.subscribe(host.code, host.token, () => {});
  await act(service, host, { type: "addBot" });
  await act(service, host, { type: "addBot" });
  await act(service, host, { type: "start" });
  // Deterministic state with a bot owning the next action.
  let state = createGame({
    players: service.room(host.code).members,
    seed: 17,
  });
  const { applyAction } = await import("../src/game.js");
  while (currentActor(state) === host.snapshot.selfId)
    state = applyAction(
      state,
      host.snapshot.selfId,
      chooseBotAction(publicView(state), host.snapshot.selfId),
    );
  service.room(host.code).game = state;
  service.updateTurnClock(service.room(host.code));
  off();
  const revision = service.room(host.code).revision;
  await delay(60);
  assert.equal(service.room(host.code).revision, revision);
  const back = service.subscribe(host.code, host.token, () => {});
  t.after(back);
  await delay(70);
  assert.ok(service.room(host.code).revision > revision);
});

test("atomic persistence restores identities, pending actions and deduplication after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flip7-rooms-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json");
  const { service, host, seats } = await table(t, { file });
  await act(service, host, { type: "start" });
  const state = service.room(host.code).game;
  const actor = seats.find((s) => s.snapshot.selfId === currentActor(state));
  const payload = {
    requestId: requestId(),
    expectedRevision: service.room(host.code).revision,
    command: {
      type: "game",
      action: chooseBotAction(publicView(state), actor.snapshot.selfId),
    },
  };
  await service.command(host.code, actor.token, payload);
  await service.close();
  const restored = await new RoomService({ file }).init();
  t.after(() => restored.close());
  assert.deepEqual(restored.room(host.code), service.room(host.code));
  const revision = restored.room(host.code).revision;
  await restored.command(host.code, actor.token, payload);
  assert.equal(restored.room(host.code).revision, revision);
  const disk = await readFile(file, "utf8");
  for (const seat of seats) {
    assert.ok(!disk.includes(seat.token));
    assert.equal(
      restored.authenticate(host.code, seat.token).member.id,
      seat.snapshot.selfId,
    );
  }
  const before = structuredClone(restored.room(host.code));
  restored.file = join(file, "impossible.json");
  await assert.rejects(act(restored, host, { type: "reclaim" }));
  assert.deepEqual(
    restored.room(host.code),
    before,
    "failed durable write must not publish or advance game",
  );
  await writeFile(file, "invalid json");
  await assert.rejects(new RoomService({ file }).init(), /无法读取房间存档/);
});

test("invalid room input is rejected without changing state", async (t) => {
  const service = new RoomService();
  t.after(() => service.close());
  for (const name of ["", null, {}, "a".repeat(17), "bad\nname"])
    await rejects(service.create(name), 400);
  const host = await service.create("正常昵称");
  for (const input of [
    null,
    {},
    { requestId: "short", command: { type: "leave" } },
    {
      requestId: requestId(),
      expectedRevision: 0,
      command: { type: "unknown" },
    },
  ])
    await rejects(service.command(host.code, host.token, input), 400);
  assert.equal(service.room(host.code).revision, 0);
});

test("an unready player promoted to host can start the lobby", async (t) => {
  for (const transfer of ["leave", "disconnect"]) {
    let now = 1_000;
    const service = new RoomService({ now: () => now });
    t.after(() => service.close());
    const host = await service.create("原房主");
    const friend = await service.join(host.code, "还没准备");
    const offHost = service.subscribe(host.code, host.token, () => {});
    const offFriend = service.subscribe(host.code, friend.token, () => {});
    t.after(offHost);
    t.after(offFriend);
    await act(service, host, { type: "addBot" });
    if (transfer === "leave") {
      await act(service, host, { type: "leave" });
      await act(service, friend, { type: "addBot" });
    } else {
      offHost();
      now += 30_001;
      await act(service, friend, { type: "claimHost" });
      const back = service.subscribe(host.code, host.token, () => {});
      t.after(back);
    }
    const promoted = service.snapshot(host.code, friend.snapshot.selfId);
    assert.equal(promoted.hostId, friend.snapshot.selfId);
    assert.equal(
      promoted.members.find((m) => m.id === promoted.hostId).ready,
      true,
    );
    await act(service, friend, { type: "start" });
    assert.ok(service.room(host.code).game);
  }
});
