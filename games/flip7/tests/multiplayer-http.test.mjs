import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { chooseBotAction } from "../src/bot.js";
import { nearFlipSeven } from "./helpers/applause-fixture.mjs";

async function serve(t) {
  const server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, data, token, extra = {}) {
    const response = await fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      ...extra,
    });
    return { status: response.status, data: await response.json() };
  }
  async function stream(seat, danmaku = false) {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(
      `${base}/api/rooms/${seat.code}/events${danmaku ? "?danmaku=1" : ""}`,
      {
        headers: { Authorization: `Bearer ${seat.token}` },
        signal: controller.signal,
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    async function next(predicate = () => true) {
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        while (true) {
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = event.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              const snapshot = JSON.parse(line.slice(6));
              const type =
                event
                  .split("\n")
                  .find((line) => line.startsWith("event: "))
                  ?.slice(7) || "message";
              if (predicate(snapshot, type)) return snapshot;
            }
          }
          const { value, done } = await reader.read();
          assert.equal(done, false);
          buffer += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    return { next, close: () => controller.abort() };
  }
  async function command(seat, command) {
    const snapshot = await request(
      `/api/rooms/${seat.code}`,
      undefined,
      seat.token,
    );
    return request(
      `/api/rooms/${seat.code}/commands`,
      {
        requestId: randomBytes(16).toString("hex"),
        expectedRevision: snapshot.data.revision,
        command,
      },
      seat.token,
    );
  }
  return { request, stream, command, server };
}

test("three HTTP clients receive the same game, reconnect and restore their seat", async (t) => {
  const { request, stream, command } = await serve(t);
  const host = (await request("/api/rooms", { name: "甲" })).data;
  const second = (await request(`/api/rooms/${host.code}/join`, { name: "乙" }))
    .data;
  const third = (await request(`/api/rooms/${host.code}/join`, { name: "丙" }))
    .data;
  const seats = [host, second, third];
  const streams = await Promise.all(seats.map(stream));
  for (const s of streams) await s.next();
  for (const seat of seats.slice(1))
    assert.equal(
      (await command(seat, { type: "ready", ready: true })).status,
      200,
    );
  const start = await command(host, { type: "start" });
  assert.equal(start.status, 200);
  const views = await Promise.all(streams.map((s) => s.next((v) => !!v.game)));
  assert.deepEqual(views[0].game, views[1].game);
  assert.deepEqual(views[1].game, views[2].game);
  for (const view of views) {
    assert.equal(view.game.opening, true);
    assert.equal(view.game.deckCount, 94);
    assert.ok(view.game.players.every((p) => !p.cards.length));
    assert.equal(view.turnClock.limitMs, 10_000);
  }
  const actor = seats.find(
    (s) => s.snapshot.selfId === start.data.game.actorId,
  );
  const action = chooseBotAction(start.data.game, actor.snapshot.selfId);
  const result = await command(actor, { type: "game", action });
  assert.equal(result.status, 200);
  const updated = await Promise.all(
    streams.map((s) => s.next((v) => v.revision === result.data.revision)),
  );
  for (const view of updated) assert.deepEqual(view.game, result.data.game);
  assert.equal(result.data.game.deckCount, 93);
  assert.ok(
    result.data.game.players
      .filter((p) => p.id !== actor.snapshot.selfId)
      .every((p) => !p.cards.length),
  );
  streams[1].close();
  await streams[0].next(
    (v) => !v.members.find((m) => m.id === second.snapshot.selfId).online,
  );
  const restored = await stream(second);
  const snapshot = await restored.next();
  assert.equal(snapshot.selfId, second.snapshot.selfId);
  assert.deepEqual(snapshot.game, result.data.game);
  assert.equal(snapshot.members.length, 3);
  assert.equal((await command(second, { type: "leave" })).status, 200);
  assert.equal((await restored.next((v) => v.removed)).removed, true);
  assert.equal(
    (await request(`/api/rooms/${host.code}`, undefined, second.token)).status,
    401,
  );
});

test("HTTP danmaku broadcasts through a separate opt-in SSE event and deduplicates retries", async (t) => {
  const { request, stream, command } = await serve(t);
  const host = (await request("/api/rooms", { name: "甲" })).data;
  const friend = (await request(`/api/rooms/${host.code}/join`, { name: "乙" }))
    .data;
  const sender = await stream(host, true);
  const viewer = await stream(friend, true);
  const legacy = await stream(friend);
  const payload = {
    requestId: randomBytes(16).toString("hex"),
    text: "再翻一张！",
  };
  const path = `/api/rooms/${host.code}/danmaku`;
  assert.equal((await request(path, payload)).status, 401);
  const sent = await request(path, payload, host.token);
  assert.equal(sent.status, 200);
  for (const connection of [sender, viewer]) {
    const event = await connection.next((message, type) => type === "danmaku");
    assert.deepEqual(event, sent.data);
    assert.equal(event.name, "甲");
  }
  assert.deepEqual((await request(path, payload, host.token)).data, sent.data);
  assert.equal(
    (
      await request(
        path,
        { ...payload, requestId: randomBytes(16).toString("hex") },
        host.token,
      )
    ).status,
    429,
  );
  const board = await command(host, { type: "addBot" });
  for (const connection of [sender, viewer, legacy]) {
    const snapshot = await connection.next((message, type) => {
      assert.equal(type, "message");
      assert.ok(Array.isArray(message.members));
      return message.revision === board.data.revision;
    });
    assert.equal(snapshot.members.length, 3);
  }
});

test("all HTTP viewers retain the Flip 7 celebration until the last human applauds, including reconnects", async (t) => {
  const { server, request, stream, command } = await serve(t);
  const host = (await request("/api/rooms", { name: "甲" })).data;
  const friend = (await request(`/api/rooms/${host.code}/join`, { name: "乙" }))
    .data;
  const streams = await Promise.all([stream(host), stream(friend)]);
  await command(host, { type: "addBot" });
  await server.rooms.enqueue(() =>
    server.rooms.commit(
      nearFlipSeven(structuredClone(server.rooms.room(host.code))),
    ),
  );
  const hit = await command(host, { type: "game", action: { type: "hit" } });
  const applause = hit.data.applause;
  assert.equal(applause.complete, false);
  for (const connection of streams)
    assert.deepEqual(
      (await connection.next((s) => s.applause?.id === applause.id)).applause,
      applause,
    );
  assert.equal(
    (await command(host, { type: "game", action: { type: "nextRound" } }))
      .status,
    409,
  );
  await command(host, { type: "applaud", applauseId: applause.id });
  streams[1].close();
  const back = await stream(friend);
  const restored = await back.next();
  assert.equal(restored.applause.id, applause.id);
  assert.equal(restored.applause.acknowledgedIds.length, 2);
  assert.equal(restored.applause.complete, false);
  await command(friend, { type: "applaud", applauseId: applause.id });
  for (const connection of [streams[0], back])
    assert.equal(
      (await connection.next((s) => s.applause?.complete)).applause.id,
      applause.id,
    );
  assert.equal(
    (await command(host, { type: "game", action: { type: "nextRound" } }))
      .status,
    200,
  );
});

test("HTTP validates credentials, origin, JSON and request limits", async (t) => {
  const { request } = await serve(t);
  const host = (await request("/api/rooms", { name: "测试" })).data;
  assert.equal((await request(`/api/rooms/${host.code}`)).status, 401);
  assert.equal((await request(`/api/rooms/${host.code}/events`)).status, 401);
  assert.equal(
    (
      await request("/api/rooms", { name: "跨站" }, null, {
        headers: {
          "Content-Type": "application/json",
          Origin: "http://other.example",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/rooms", { name: "过大", padding: "x".repeat(17000) }))
      .status,
    413,
  );
  assert.equal((await request("/api/rooms", [], null)).status, 400);
  assert.equal(
    (await request("/api/rooms", {}, null, { body: "{bad-json" })).status,
    400,
  );
  assert.equal(
    (
      await request("/api/rooms", {}, null, {
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await request(
        `/api/rooms/${host.code}/commands`,
        { requestId: "bad" },
        host.token,
      )
    ).status,
    400,
  );
});

test("host lobby tracker changes reach every HTTP/SSE client and remain fixed during a match", async (t) => {
  const { request, stream, command } = await serve(t);
  for (const value of ["true", 1, null, {}])
    assert.equal(
      (await request("/api/rooms", { name: "无效", cardTracker: value }))
        .status,
      400,
    );
  for (const enabled of [false, true]) {
    const host = (
      await request("/api/rooms", { name: "甲", cardTracker: enabled })
    ).data;
    const friend = (
      await request(`/api/rooms/${host.code}/join`, {
        name: "乙",
        cardTracker: !enabled,
      })
    ).data;
    assert.equal(friend.snapshot.settings.cardTracker, enabled);
    const streams = await Promise.all([stream(host), stream(friend)]);
    for (const connection of streams) await connection.next();
    await command(host, { type: "addBot" });
    await command(friend, { type: "ready", ready: true });
    assert.equal(
      (await command(friend, { type: "setCardTracker", cardTracker: !enabled }))
        .status,
      403,
    );
    const setting = await command(host, {
      type: "setCardTracker",
      cardTracker: !enabled,
    });
    assert.equal(setting.status, 200);
    for (const connection of streams) {
      const snapshot = await connection.next(
        (s) => s.revision === setting.data.revision,
      );
      assert.equal(snapshot.settings.cardTracker, !enabled);
      assert.equal(
        snapshot.members.find((m) => m.id === friend.snapshot.selfId).ready,
        false,
      );
    }
    await command(friend, {
      type: "ready",
      ready: true,
      cardTracker: enabled,
    });
    await command(host, { type: "start", cardTracker: enabled });
    assert.equal(
      (await command(host, { type: "setCardTracker", cardTracker: enabled }))
        .status,
      409,
    );
    const initial = await Promise.all(
      streams.map((connection) => connection.next((s) => !!s.game)),
    );
    assert.deepEqual(initial[0].cardTracker, initial[1].cardTracker);
    assert.equal(initial[0].settings.cardTracker, !enabled);
    if (!enabled) assert.equal(initial[0].cardTracker.remaining, 94);
    else assert.equal(initial[0].cardTracker, null);
    const hit = await command(host, { type: "game", action: { type: "hit" } });
    const updated = await Promise.all(
      streams.map((connection) =>
        connection.next((s) => s.revision === hit.data.revision),
      ),
    );
    for (const snapshot of updated) {
      assert.deepEqual(snapshot.cardTracker, hit.data.cardTracker);
      if (!enabled) assert.equal(snapshot.cardTracker.remaining, 93);
      else assert.equal(snapshot.cardTracker, null);
    }
    streams[1].close();
    const back = await stream(friend);
    assert.deepEqual((await back.next()).cardTracker, hit.data.cardTracker);
  }
});
