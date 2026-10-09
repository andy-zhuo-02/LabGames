import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { RoomService, DANMAKU_COOLDOWN_MS } from "../src/rooms.js";

const input = (text) => ({ requestId: randomBytes(16).toString("hex"), text });
async function table(t) {
  let now = 100_000;
  const service = new RoomService({ now: () => now });
  t.after(() => service.close());
  const a = await service.create("甲");
  const b = await service.join(a.code, "乙");
  const other = await service.create("别桌");
  const messages = [[], [], []];
  [a, b, other].forEach((seat, index) => {
    const off = service.subscribe(
      seat.code,
      seat.token,
      () => {},
      (message) => messages[index].push(message),
    );
    t.after(off);
  });
  const command = (seat, command) =>
    service.command(seat.code, seat.token, {
      requestId: randomBytes(16).toString("hex"),
      expectedRevision: service.room(seat.code).revision,
      command,
    });
  return {
    service,
    a,
    b,
    other,
    messages,
    command,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("danmaku reaches only its room with the authenticated name and never changes game or deadline", async (t) => {
  const { service, a, b, messages, command } = await table(t);
  await command(a, { type: "addBot" });
  await command(b, { type: "ready", ready: true });
  await command(a, { type: "start" });
  const before = structuredClone(service.room(a.code));
  const timer = service.timers.get(a.code);
  const message = await service.sendDanmaku(a.code, b.token, {
    ...input("  再翻一张！  "),
    name: "伪造房主",
    playerId: a.snapshot.selfId,
  });
  assert.equal(message.name, "乙");
  assert.equal(message.playerId, b.snapshot.selfId);
  assert.equal(message.text, "再翻一张！");
  assert.deepEqual(messages[0], [message]);
  assert.deepEqual(messages[1], [message]);
  assert.deepEqual(messages[2], []);
  assert.deepEqual(service.room(a.code), before);
  assert.equal(service.timers.get(a.code), timer);
  // The game command prepared before the chat still succeeds with the same revision.
  await command(a, { type: "game", action: { type: "hit" } });
  assert.equal(service.room(a.code).game.deck.length, 93);
});

test("uncertain retries send only once, and per-player cooldown cannot be bypassed by another request ID", async (t) => {
  const { service, a, b, messages, advance } = await table(t);
  const payload = input("七连翻！");
  const first = await service.sendDanmaku(a.code, a.token, payload);
  assert.deepEqual(await service.sendDanmaku(a.code, a.token, payload), first);
  assert.equal(messages[0].length, 1);
  await assert.rejects(
    service.sendDanmaku(a.code, a.token, { ...payload, text: "另一句话" }),
    { status: 409 },
  );
  await assert.rejects(service.sendDanmaku(a.code, a.token, input("刷屏")), {
    status: 429,
  });
  await service.sendDanmaku(b.code, b.token, input("我也加油！"));
  advance(DANMAKU_COOLDOWN_MS);
  await service.sendDanmaku(a.code, a.token, input("可以再发了"));
  assert.equal(messages[0].length, 3);
});

test("danmaku validates Unicode length, plain text and room credentials", async (t) => {
  const { service, a, other, advance } = await table(t);
  for (const text of [
    "",
    "  ",
    "字".repeat(41),
    "🎉".repeat(41),
    "换\n行",
    "\u0000",
    null,
    7,
  ]) {
    await assert.rejects(service.sendDanmaku(a.code, a.token, input(text)), {
      status: 400,
    });
  }
  await assert.rejects(
    service.sendDanmaku(a.code, a.token, { requestId: "bad", text: "hello" }),
    { status: 400 },
  );
  await assert.rejects(
    service.sendDanmaku(a.code, other.token, input("串房")),
    { status: 401 },
  );
  await assert.rejects(service.sendDanmaku(a.code, null, input("无身份")), {
    status: 401,
  });
  assert.equal(
    (await service.sendDanmaku(a.code, a.token, input("🎉".repeat(40)))).text,
    "🎉".repeat(40),
  );
  advance(DANMAKU_COOLDOWN_MS);
  const literal = '<img src=x onerror="alert(1)">';
  assert.equal(
    (await service.sendDanmaku(a.code, a.token, input(literal))).text,
    literal,
  );
});

test("reconnecting never replays old chat and leaving revokes send access", async (t) => {
  const { service, a, b, command, advance } = await table(t);
  await service.sendDanmaku(a.code, a.token, input("刚刚的弹幕"));
  const received = [];
  const off = service.subscribe(
    b.code,
    b.token,
    () => {},
    (message) => received.push(message),
  );
  t.after(off);
  assert.deepEqual(received, []);
  assert.equal(service.snapshot(a.code, a.snapshot.selfId).danmaku, undefined);
  await command(b, { type: "leave" });
  await assert.rejects(service.sendDanmaku(a.code, b.token, input("已离开")), {
    status: 401,
  });
  advance(DANMAKU_COOLDOWN_MS);
  await service.sendDanmaku(a.code, a.token, input("离开的玩家不能继续接收"));
  assert.deepEqual(received, []);
  await command(a, { type: "leave" });
  assert.equal(service.danmakuReceipts.has(a.code), false);
});
