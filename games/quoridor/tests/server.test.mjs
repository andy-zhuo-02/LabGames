import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.mjs";

async function serve(t) {
  const server = createApp({ autoTick: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, data, token, headers = {}) => {
    const response = await fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  return { base, req };
}
test("HTTP clients join, act, refresh and see the same authoritative board", async (t) => {
  const { req, base } = await serve(t);
  const a = (await req("/api/rooms", { name: "甲" })).data,
    b = (await req(`/api/rooms/${a.code}/join`, { name: "乙" })).data;
  let state = (await req(`/api/rooms/${a.code}`, undefined, a.token)).data;
  state = (
    await req(
      `/api/rooms/${a.code}/commands`,
      { revision: state.revision, command: { type: "start" } },
      a.token,
    )
  ).data;
  const payload = {
    revision: state.revision,
    command: { type: "action", action: { type: "move", row: 7, col: 4 } },
  };
  const responses = await Promise.all([
    req(`/api/rooms/${a.code}/commands`, payload, a.token),
    req(`/api/rooms/${a.code}/commands`, payload, a.token),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const views = await Promise.all(
    [a, b].map((seat) => req(`/api/rooms/${a.code}`, undefined, seat.token)),
  );
  assert.equal(views[0].data.game.ply, 1);
  assert.deepEqual(views[0].data.game, views[1].data.game);
  assert.equal((await req(`/api/rooms/${a.code}`)).status, 401);
  assert.equal(
    (
      await req("/api/rooms", {}, undefined, {
        Origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  assert.equal((await req("/api/rooms", { count: 5 })).status, 400);
  assert.equal(
    (await req("/api/rooms", { name: "x".repeat(9000) })).status,
    413,
  );
  const invalid = await fetch(base + "/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(invalid.status, 400);
  for (const path of [
    "/",
    "/styles.css",
    "/app.js",
    "/favicon.svg",
    "/src/game.js",
    "/src/bot.js",
  ])
    assert.equal((await fetch(base + path)).status, 200);
  for (const path of ["/src/rooms.js", "/data/rooms.json", "/package.json"])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await req("/api/health")).data.ok, true);
});
test("three HTTP players fill a room and share moves, walls and a full turn cycle", async (t) => {
  const { req } = await serve(t);
  const host = (await req("/api/rooms", { name: "甲", count: 3 })).data;
  const seats = [host];
  for (const name of ["乙", "丙"])
    seats.push((await req(`/api/rooms/${host.code}/join`, { name })).data);
  assert.equal(
    (await req(`/api/rooms/${host.code}/join`, { name: "丁" })).status,
    409,
  );
  let state = (await req(`/api/rooms/${host.code}`, undefined, host.token))
    .data;
  state = (
    await req(
      `/api/rooms/${host.code}/commands`,
      { revision: state.revision, command: { type: "start" } },
      host.token,
    )
  ).data;
  assert.equal(state.game.players.length, 3);
  assert.deepEqual(
    state.game.players.map((p) => p.walls),
    [6, 6, 6],
  );
  assert.ok(state.game.players.every((p) => !p.isBot));
  const actions = [
    { type: "move", row: 7, col: 4 },
    { type: "wall", row: 3, col: 3, orientation: "h" },
    { type: "move", row: 1, col: 4 },
  ];
  for (let id = 0; id < 3; id++) {
    const response = await req(
      `/api/rooms/${host.code}/commands`,
      {
        revision: state.revision,
        command: { type: "action", action: actions[id] },
      },
      seats[id].token,
    );
    assert.equal(response.status, 200);
    state = response.data;
    const views = await Promise.all(
      seats.map((s) => req(`/api/rooms/${host.code}`, undefined, s.token)),
    );
    for (const view of views) assert.deepEqual(view.data.game, state.game);
  }
  assert.equal(state.game.turn, 0);
  assert.equal(state.game.ply, 3);
  assert.equal(state.game.players[1].walls, 5);
});
