import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService, TURN_LIMIT_MS } from "../src/rooms.js";
import { makeDeck, createGame, validateSave } from "../src/game.js";

const command = (service, seat, action) =>
  service.command(seat.code, seat.token, {
    requestId: randomBytes(16).toString("hex"),
    expectedRevision: service.room(seat.code).revision,
    command: action,
  });
async function table(
  t,
  { file = null, hands = [[2], [4], [6]], draws = [7, 8, 9, 10] } = {},
) {
  let now = 100_000;
  const service = await new RoomService({ file, now: () => now }).init();
  t.after(() => service.close());
  const host = await service.create("甲");
  const seats = [
    host,
    await service.join(host.code, "乙"),
    await service.join(host.code, "丙"),
  ];
  const views = seats.map(() => []);
  const off = seats.map((seat, i) =>
    service.subscribe(host.code, seat.token, (s) => views[i].push(s)),
  );
  t.after(() => off.forEach((fn) => fn()));
  const room = structuredClone(service.room(host.code));
  const state = createGame({ players: room.members, seed: 42 });
  const pool = makeDeck();
  const take = (value) => {
    const index = pool.findIndex((c) =>
      typeof value === "number"
        ? c.kind === "number" && c.value === value
        : c.kind === value,
    );
    assert.ok(index >= 0);
    return pool.splice(index, 1)[0];
  };
  for (const [i, p] of state.players.entries()) {
    p.cards = hands[i].map(take);
    p.status = "active";
    p.score = 0;
    p.roundScore = 0;
  }
  state.deck = draws.map(take).reverse();
  state.discard = pool;
  state.queue = [];
  state.turn = 0;
  state.resume = 0;
  state.starter = 0;
  state.events = [];
  state.eventId = 0;
  state.lastDraw = null;
  state.history = [];
  state.phase = "playing";
  state.round = 1;
  room.game = state;
  room.revision++;
  await service.commit(room);
  const advance = (ms) => {
    now += ms;
  };
  const expire = (clock) =>
    service.enqueue(() => service.advanceTurn(host.code, clock));
  return { service, host, seats, views, off, advance, expire, now: () => now };
}

test("a shared 10-second deadline survives reconnects and unrelated room commands", async (t) => {
  const { service, host, seats, views, off, advance, expire, now } =
    await table(t);
  const clock = structuredClone(service.room(host.code).turnClock);
  assert.equal(clock.deadlineAt - now(), TURN_LIMIT_MS);
  for (const messages of views)
    assert.deepEqual(messages.at(-1).turnClock, { ...clock, limitMs: 10_000 });
  advance(8000);
  off[0]();
  const back = service.subscribe(host.code, host.token, () => {});
  t.after(back);
  await command(service, seats[1], { type: "reclaim" });
  assert.deepEqual(service.room(host.code).turnClock, clock);
  advance(1999);
  await expire(clock);
  assert.equal(service.room(host.code).game.revision, 0);
  advance(1);
  await expire(clock);
  const state = service.room(host.code).game;
  assert.equal(state.players[0].status, "banked");
  assert.equal(state.revision, 1);
  assert.match(state.events.find((e) => e.type === "timeout").text, /自动收手/);
  assert.equal(service.room(host.code).turnClock.deadlineAt, now() + 10_000);
  assert.ok(validateSave(state, { requireLocalPlayer: false }));
});

test("expired commands and stale timer callbacks cannot apply two actions", async (t) => {
  const { service, host, advance, expire } = await table(t);
  const clock = structuredClone(service.room(host.code).turnClock);
  advance(10_000);
  await assert.rejects(
    command(service, host, { type: "game", action: { type: "hit" } }),
    (error) => error.status === 409,
  );
  await Promise.all([expire(clock), expire(clock)]);
  assert.equal(service.room(host.code).game.revision, 1);
  assert.deepEqual(
    service.room(host.code).game.players[0].cards.map((c) => c.value),
    [2],
  );
  assert.equal(
    service.room(host.code).game.events.filter((e) => e.type === "timeout")
      .length,
    1,
  );
});

test("an accepted action near the deadline supersedes its old timer", async (t) => {
  const { service, host, advance, expire, now } = await table(t);
  const clock = structuredClone(service.room(host.code).turnClock);
  advance(9999);
  await command(service, host, { type: "game", action: { type: "hit" } });
  const nextClock = structuredClone(service.room(host.code).turnClock);
  assert.equal(nextClock.deadlineAt, now() + 10_000);
  advance(1);
  await expire(clock);
  assert.equal(service.room(host.code).game.revision, 1);
  assert.deepEqual(service.room(host.code).turnClock, nextClock);
});

test("drawing and targeting Flip Three notify every seat immediately, with a new target deadline", async (t) => {
  const { service, host, views, advance, expire, now } = await table(t, {
    draws: ["three", 8, 9, 10],
  });
  advance(7500);
  await command(service, host, { type: "game", action: { type: "hit" } });
  const pending = service.room(host.code);
  assert.equal(pending.turnClock.actorId, host.snapshot.selfId);
  assert.equal(pending.turnClock.deadlineAt, now() + 10_000);
  for (const messages of views) {
    const snapshot = messages.at(-1);
    assert.equal(snapshot.game.pending.card.kind, "three");
    assert.equal(snapshot.notices.at(-1).type, "draw");
    assert.match(snapshot.notices.at(-1).text, /甲 翻出 连翻三张/);
  }
  const clock = structuredClone(pending.turnClock);
  advance(10_000);
  await expire(clock);
  for (const messages of views) {
    const snapshot = messages.at(-1);
    assert.equal(snapshot.notices.at(-1).type, "action");
    assert.ok(snapshot.notices.at(-1).targetId);
    assert.match(snapshot.notices.at(-1).text, /使用连翻三张/);
    assert.ok(
      snapshot.game.events.some(
        (e) => e.type === "timeout" && e.text.includes("自动选择"),
      ),
    );
  }
  assert.ok(
    validateSave(service.room(host.code).game, { requireLocalPlayer: false }),
  );
});

test("Flip Three alerts survive subsequent forced draws that overwrite lastDraw", async (t) => {
  const { service, host, views } = await table(t, {
    draws: ["three", "three", 8, 9],
  });
  await command(service, host, { type: "game", action: { type: "hit" } });
  await command(service, host, {
    type: "game",
    action: { type: "target", targetId: host.snapshot.selfId },
  });
  for (const messages of views) {
    const snapshot = messages.at(-1);
    assert.equal(snapshot.game.lastDraw.card.kind, "number");
    assert.equal(snapshot.game.pending.card.kind, "three");
    assert.equal(snapshot.notices.filter((n) => n.type === "draw").length, 2);
  }
});

test("an empty hand times out into a legal draw and all-offline tables pause", async (t) => {
  const { service, host, off, advance, expire } = await table(t, {
    hands: [[], [4], [6]],
  });
  const clock = structuredClone(service.room(host.code).turnClock);
  off.forEach((fn) => fn());
  advance(10_000);
  await expire(clock);
  assert.equal(service.room(host.code).game.revision, 0);
  const back = service.subscribe(host.code, host.token, () => {});
  t.after(back);
  await expire(clock);
  assert.equal(service.room(host.code).game.players[0].cards[0].value, 7);
  assert.match(
    service.room(host.code).game.events.find((e) => e.type === "timeout").text,
    /自动翻牌/,
  );
});

test("opening seats get 10 seconds, and timeout flips even after receiving forced cards", async (t) => {
  const { service, host, seats, views, advance, expire } = await table(t, {
    hands: [[10, 11, 12], [], []],
    draws: [9, 8, 7],
  });
  const room = structuredClone(service.room(host.code));
  room.game.queue = createGame({ players: room.members, seed: 42 }).queue;
  await service.commit(room);
  assert.ok(views.every((messages) => messages.at(-1).game.opening));
  const clock = structuredClone(service.room(host.code).turnClock);
  advance(10_000);
  await expire(clock);
  const snapshot = service.snapshot(host.code, host.snapshot.selfId);
  assert.deepEqual(
    snapshot.game.players[0].cards.map((card) => card.value),
    [10, 11, 12, 9],
  );
  assert.equal(snapshot.game.players[0].status, "active");
  assert.equal(snapshot.game.actorId, seats[1].snapshot.selfId);
  assert.ok(snapshot.game.opening);
  assert.equal(snapshot.turnClock.deadlineAt - snapshot.serverNow, 10_000);
  assert.ok(snapshot.game.players.slice(1).every((p) => !p.cards.length));
});

test("server restart preserves the deadline instead of granting another 10 seconds", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flip7-clock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json");
  const { service, host, advance, now } = await table(t, { file });
  const clock = structuredClone(service.room(host.code).turnClock);
  await service.close();
  advance(9000);
  const restored = await new RoomService({ file, now }).init();
  t.after(() => restored.close());
  assert.deepEqual(restored.room(host.code).turnClock, clock);
  assert.equal(
    restored.snapshot(host.code, host.snapshot.selfId).turnClock.deadlineAt -
      now(),
    1000,
  );
});

test("a scheduled server timer advances an offline actor while another human is present", async (t) => {
  const { service, host, seats, off } = await table(t);
  off[0]();
  // Real timers, with server time already at the persisted deadline.
  const deadlineAt = service.room(host.code).turnClock.deadlineAt;
  service.now = () => deadlineAt;
  const result = new Promise((resolve) => {
    const stop = service.subscribe(host.code, seats[1].token, (snapshot) => {
      if (snapshot.game.revision > 0) resolve(snapshot);
    });
    t.after(stop);
  });
  const deadline = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(deadline));
  const snapshot = await result;
  assert.equal(snapshot.game.players[0].status, "banked");
});
