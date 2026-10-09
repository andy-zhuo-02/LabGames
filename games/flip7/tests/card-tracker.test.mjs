import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createGame,
  makeDeck,
  applyAction,
  pendingEffect,
  currentActor,
  publicView,
  validateSave,
} from "../src/game.js";
import { cardTracker } from "../src/card-tracker.js";
import { RoomService } from "../src/rooms.js";
import { chooseBotAction } from "../src/bot.js";

const players = ["you", "b", "c"].map((id) => ({ id, name: id }));
const entry = (tracker, kind, value) =>
  tracker.cards.find((c) => c.kind === kind && c.value === value);
function fixture(hands, draws, statuses = ["active", "active", "active"]) {
  const state = createGame({ players, seed: 42 });
  const pool = makeDeck();
  const take = (value) => {
    const i = pool.findIndex((c) =>
      typeof value === "number"
        ? c.kind === "number" && c.value === value
        : c.kind === value,
    );
    assert.ok(i >= 0);
    return pool.splice(i, 1)[0];
  };
  state.players.forEach((p, i) => {
    p.cards = hands[i].map(take);
    p.status = statuses[i];
  });
  state.deck = draws.map(take).reverse();
  state.discard = pool;
  state.queue = [];
  return state;
}

test("tracker covers all 22 card types without disclosing order or changing the game", () => {
  const state = createGame({ players, seed: 42 });
  const before = structuredClone(state);
  const tracker = cardTracker(state);
  assert.equal(tracker.remaining, 94);
  assert.equal(tracker.outside, 0);
  assert.equal(tracker.cards.length, 22);
  assert.equal(entry(tracker, "number", 0).remaining, 1);
  assert.equal(entry(tracker, "number", 12).remaining, 12);
  assert.equal(entry(tracker, "three").remaining, 3);
  assert.equal(entry(tracker, "multiply").remaining, 1);
  assert.ok(tracker.cards.every((c) => c.total === c.remaining));
  assert.deepEqual(state, before);
  assert.deepEqual(
    cardTracker({ ...state, deck: [...state.deck].reverse() }),
    tracker,
  );
  assert.ok(
    tracker.cards.every((c) =>
      Object.keys(c).every((key) =>
        ["kind", "value", "label", "total", "remaining"].includes(key),
      ),
    ),
  );
  assert.equal(publicView(state).cardTracker, undefined);
});

test("used second chances and deferred Flip Three effects remain outside the pile", () => {
  let state = fixture(
    [[12, "second"], [4], [5]],
    [12, "three", "freeze", 8, 9],
  );
  state = applyAction(state, "you", { type: "hit" });
  assert.equal(state.players[0].status, "active");
  let tracker = cardTracker(state);
  assert.equal(tracker.remaining, 4);
  assert.equal(entry(tracker, "number", 12).remaining, 0);
  assert.equal(entry(tracker, "second").remaining, 0);
  state = applyAction(state, "b", { type: "hit" });
  state = applyAction(state, "b", { type: "target", targetId: "c" });
  assert.equal(pendingEffect(state).card.kind, "freeze");
  tracker = cardTracker(state);
  assert.equal(tracker.remaining, 0);
  assert.equal(tracker.outside, 94);
  assert.equal(entry(tracker, "freeze").remaining, 0);
  assert.equal(entry(tracker, "three").remaining, 0);
  assert.ok(validateSave(state));
});

test("reshuffle restores discarded counts while keeping busted and table cards excluded", () => {
  let state = fixture([[1], [12, 12], [5]], [], ["active", "busted", "banked"]);
  assert.equal(cardTracker(state).remaining, 0);
  state = applyAction(state, "you", { type: "hit" });
  const tracker = cardTracker(state);
  assert.equal(tracker.remaining, 89);
  assert.equal(tracker.outside, 5);
  assert.equal(entry(tracker, "number", 1).remaining, 0);
  const draw = state.lastDraw.card;
  assert.equal(
    entry(tracker, "number", 12).remaining,
    10 - Number(draw.kind === "number" && draw.value === 12),
  );
  assert.equal(
    entry(tracker, "number", 5).remaining,
    4 - Number(draw.kind === "number" && draw.value === 5),
  );
  assert.ok(validateSave(state));
});

const command = (service, seat, action) =>
  service.command(seat.code, seat.token, {
    requestId: randomBytes(16).toString("hex"),
    expectedRevision: service.room(seat.code).revision,
    command: action,
  });

test("room option and counts survive a restart, rematch and change of host", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flip7-tracker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json");
  const now = () => 100_000;
  const service = await new RoomService({ file, now }).init();
  t.after(() => service.close());
  const host = await service.create("房主");
  const seats = [
    host,
    await service.join(host.code, "乙"),
    await service.join(host.code, "丙"),
  ];
  for (const seat of seats)
    t.after(service.subscribe(seat.code, seat.token, () => {}));
  await command(service, host, { type: "setCardTracker", cardTracker: true });
  for (const seat of seats.slice(1))
    await command(service, seat, { type: "ready", ready: true });
  await command(service, host, { type: "start" });
  await assert.rejects(
    command(service, host, { type: "setCardTracker", cardTracker: false }),
    (error) => error.status === 409,
  );
  await command(service, host, { type: "game", action: { type: "hit" } });
  const before = service.snapshot(host.code, host.snapshot.selfId).cardTracker;
  assert.equal(before.remaining, 93);
  await service.close();
  const restored = await new RoomService({ file, now }).init();
  t.after(() => restored.close());
  for (const seat of seats) {
    t.after(restored.subscribe(seat.code, seat.token, () => {}));
    const snapshot = restored.snapshot(host.code, seat.snapshot.selfId);
    assert.deepEqual(snapshot.settings, { cardTracker: true });
    assert.deepEqual(snapshot.cardTracker, before);
  }
  let steps = 0;
  let checkedRoundEnd = false;
  while (restored.room(host.code).game.phase !== "finished") {
    assert.ok(++steps < 3000);
    const game = restored.room(host.code).game;
    if (game.phase === "roundEnd" && !checkedRoundEnd) {
      await assert.rejects(
        command(restored, host, { type: "setCardTracker", cardTracker: false }),
        (error) => error.status === 409,
      );
      checkedRoundEnd = true;
    }
    const actor =
      game.phase === "roundEnd"
        ? host
        : seats.find((seat) => seat.snapshot.selfId === currentActor(game));
    await command(restored, actor, {
      type: "game",
      action:
        game.phase === "roundEnd"
          ? { type: "nextRound" }
          : chooseBotAction(publicView(game), actor.snapshot.selfId),
    });
    const applause = restored.snapshot(
      host.code,
      host.snapshot.selfId,
    ).applause;
    if (applause && !applause.complete) {
      for (const seat of seats)
        await command(restored, seat, {
          type: "applaud",
          applauseId: applause.id,
        });
    }
  }
  assert.ok(checkedRoundEnd);
  await assert.rejects(
    command(restored, host, { type: "setCardTracker", cardTracker: false }),
    (error) => error.status === 409,
  );
  await command(restored, host, { type: "lobby" });
  await command(restored, host, { type: "setCardTracker", cardTracker: false });
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).rooms[0].cardTracker,
    false,
  );
  await command(restored, host, { type: "leave" });
  const lobby = restored.snapshot(host.code, seats[1].snapshot.selfId);
  assert.equal(lobby.hostId, seats[1].snapshot.selfId);
  assert.equal(lobby.settings.cardTracker, false);
  assert.equal(lobby.cardTracker, null);
  await command(restored, seats[1], { type: "addBot" });
  await command(restored, seats[1], {
    type: "setCardTracker",
    cardTracker: true,
  });
  await command(restored, seats[2], { type: "ready", ready: true });
  await command(restored, seats[1], { type: "start" });
  assert.equal(
    restored.snapshot(host.code, seats[1].snapshot.selfId).cardTracker
      .remaining,
    94,
  );
});

test("only the lobby host can change tracker settings and actual changes require players to ready again", async (t) => {
  const service = new RoomService({ now: () => 100_000 });
  t.after(() => service.close());
  const host = await service.create("房主");
  const friend = await service.join(host.code, "朋友");
  for (const seat of [host, friend])
    t.after(service.subscribe(seat.code, seat.token, () => {}));
  await command(service, host, { type: "addBot" });
  await command(service, friend, { type: "ready", ready: true });
  const before = structuredClone(service.room(host.code));
  await assert.rejects(
    command(service, friend, { type: "setCardTracker", cardTracker: true }),
    (error) => error.status === 403,
  );
  for (const value of [undefined, null, "true", 1, {}])
    await assert.rejects(
      command(service, host, { type: "setCardTracker", cardTracker: value }),
      (error) => error.status === 400,
    );
  assert.deepEqual(service.room(host.code), before);
  const changed = await command(service, host, {
    type: "setCardTracker",
    cardTracker: true,
  });
  assert.equal(changed.code, host.code);
  assert.deepEqual(
    changed.members.map((m) => m.id),
    before.members.map((m) => m.id),
  );
  assert.deepEqual(
    changed.members.map((m) => m.ready),
    [true, false, true],
  );
  assert.equal(changed.settings.cardTracker, true);
  assert.equal(changed.cardTracker, null);
  await assert.rejects(
    command(service, host, { type: "start" }),
    (error) => error.status === 409,
  );
  await command(service, friend, { type: "ready", ready: true });
  const unchanged = await command(service, host, {
    type: "setCardTracker",
    cardTracker: true,
  });
  assert.ok(unchanged.members.every((m) => m.ready));
  const started = await command(service, host, { type: "start" });
  assert.equal(started.cardTracker.remaining, 94);
});

test("legacy rooms default to disabled and malformed creation options are rejected", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flip7-tracker-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "rooms.json");
  const service = await new RoomService({ file }).init();
  t.after(() => service.close());
  const host = await service.create("旧房间");
  assert.equal(host.snapshot.settings.cardTracker, false);
  for (const options of [
    null,
    [],
    { cardTracker: "true" },
    { cardTracker: 1 },
    { cardTracker: null },
  ])
    await assert.rejects(
      service.create("无效", options),
      (error) => error.status === 400,
    );
  assert.equal(service.rooms.size, 1);
  await service.close();
  const data = JSON.parse(await readFile(file, "utf8"));
  delete data.rooms[0].cardTracker;
  await writeFile(file, JSON.stringify(data));
  const restored = await new RoomService({ file }).init();
  t.after(() => restored.close());
  const snapshot = restored.snapshot(host.code, host.snapshot.selfId);
  assert.equal(snapshot.settings.cardTracker, false);
  assert.equal(snapshot.cardTracker, null);
});
