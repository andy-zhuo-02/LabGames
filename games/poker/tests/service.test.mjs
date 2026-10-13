import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server.mjs";
import { RoomRegistry } from "../src/rooms.mjs";
import { BrowserGame } from "../src/browser-game.mjs";
import {
  restore_game,
  dump_game,
  restore_room,
  dump_room,
  SaveStore,
  read_legacy,
} from "../src/storage.mjs";
import { passive_action } from "../src/bots.mjs";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/python-saves.json", import.meta.url)),
);
function roomFixture() {
  let time = 1000;
  const registry = new RoomRegistry({ clock: () => time });
  registry.perform("host", "room/create", {
    name: "房主",
    capacity: 3,
    fill_bots: true,
    turn_seconds: 15,
  });
  const room = Object.values(registry.rooms)[0];
  const command = (sid, route, payload = {}) =>
    registry.perform(sid, route, {
      room_code: room.code,
      version: room.version,
      round_id: room.round_id,
      ...payload,
    });
  const joinFriend = (sid = "friend") => {
    registry.perform(sid, "room/join", { code: room.code, name: sid });
    command("host", "room/approve", {
      target_id: room.applicants[sid].member_id,
    });
  };
  const start = () => {
    command("host", "room/start");
    command("friend", "room/start");
  };
  return {
    registry,
    room,
    command,
    joinFriend,
    start,
    advance: (n) => {
      time += n;
    },
  };
}
function finish(room) {
  const h = room.game.table.hand;
  while (!h.finished)
    room.game.table.apply_action(
      h.actor_id,
      passive_action(h.observe(h.actor_id)),
    );
  room.changed(room.last_seen);
}
test("admission, authorization, readiness and private cards", () => {
  const { registry: r, room, command, joinFriend, start } = roomFixture();
  r.perform("friend", "room/join", { code: room.code, name: "friend" });
  assert.equal(r.snapshot("friend").phase, "pending");
  assert.throws(() => command("friend", "room/start"), /批准/);
  assert.throws(
    () =>
      command("friend", "room/approve", {
        target_id: room.applicants.friend.member_id,
      }),
    /批准/,
  );
  command("host", "room/approve", {
    target_id: room.applicants.friend.member_id,
  });
  command("host", "room/start");
  assert.equal(room.game, null);
  command("friend", "room/start");
  const state = r.snapshot("friend");
  assert.equal(state.phase, "playing");
  assert.equal(
    state.players.find((p) => p.id === state.viewer_id).cards.length,
    2,
  );
  assert.ok(
    state.players
      .filter((p) => p.id !== state.viewer_id)
      .every((p) => !p.cards.length),
  );
  assert.equal("recovery_code" in state.room_info.members[0], false);
  assert.throws(
    () => command("host", "action", { version: -1, kind: "call" }),
    /更新/,
  );
  assert.throws(
    () =>
      command("friend", "room/kick", {
        target_id: room.members.host.member_id,
      }),
    /房主/,
  );
});
test("late admission waits for next hand and only resets its seat", () => {
  const { registry, room, command, joinFriend, start } = roomFixture();
  joinFriend();
  start();
  joinFriend("third");
  assert.equal(room.members.third.player_id, null);
  assert.equal(
    registry.snapshot("third").players.every((p) => !p.cards.length),
    true,
  );
  finish(room);
  command("host", "next");
  command("friend", "next");
  command("third", "next");
  assert.equal(room.game.table.hand_number, 2);
  assert.equal(room.members.third.player_id, 2);
  assert.equal(room.game.strategies[2], "human");
  assert.equal(registry.snapshot("third").stats.hands, 0);
  assert.equal(registry.snapshot("third").history.length, 0);
});
test("away and disconnected players take only free actions; host transfers", () => {
  const {
    registry: r,
    room,
    command,
    joinFriend,
    start,
    advance,
  } = roomFixture();
  joinFriend();
  start();
  const h = room.game.table.hand;
  room.game.table.apply_action(
    h.actor_id,
    passive_action(h.observe(h.actor_id)),
  );
  room.changed(1000);
  assert.equal(h.actor_id, 0);
  command("host", "room/away", { away: true });
  advance(1);
  r.tick();
  assert.equal(h.actions.at(-1).action.kind, "fold");
  advance(21);
  r.snapshot("friend");
  r.tick();
  assert.equal(room.host, "friend");
  finish(room);
  command("friend", "next");
  assert.equal(room.game.table.hand_number, 2);
  assert.ok(!room.game.table.hand.player_ids.includes(0));
});
test("leave, kick and recovery rotate credentials and preserve consent", () => {
  const { registry: r, room, command, joinFriend, start } = roomFixture();
  joinFriend();
  start();
  const key = room.members.friend.recovery_code;
  r.perform("replacement", "room/recover", {
    code: room.code,
    recovery_code: key,
  });
  assert.equal(r.contains("friend"), false);
  assert.equal(room.members.replacement.player_id, 1);
  assert.notEqual(room.members.replacement.recovery_code, key);
  assert.ok(r.departure("friend"));
  assert.throws(
    () =>
      r.perform("intruder", "room/recover", {
        code: room.code,
        recovery_code: key,
      }),
    /不正确/,
  );
  command("host", "room/kick", {
    target_id: room.members.replacement.member_id,
  });
  assert.equal(room.game.strategies[1], "calling_station");
  assert.equal(r.contains("replacement"), false);
  assert.throws(
    () =>
      r.perform("replacement", "room/join", { code: room.code, name: "again" }),
    /移出/,
  );
});
test("Python checkpoints replay current cards, actions and stacks; Node saves round trip", () => {
  for (const source of [fixtures.playing, fixtures.finished]) {
    const reordered = structuredClone(source);
    reordered.table.players = source.table.players.map(
      ({ stack, name, player_id }) => ({ stack, name, player_id }),
    );
    assert.deepEqual(
      restore_game(reordered).table.players,
      source.table.players,
    );
    const game = restore_game(source),
      again = restore_game(dump_game(game));
    assert.deepEqual(game.table.players, source.table.players);
    const a = game.snapshot(),
      b = again.snapshot();
    delete a.version;
    delete b.version;
    assert.deepEqual(a, b);
  }
  const room = restore_room(fixtures.room, 2000);
  assert.equal(room.recovering, true);
  const registry = new RoomRegistry({ clock: () => 2000 });
  registry.rooms[room.code] = room;
  for (const s of Object.keys(room.members)) registry.membership[s] = room.code;
  const actions = room.game.table.hand.actions.length;
  registry.tick();
  assert.equal(room.game.table.hand.actions.length, actions);
  for (const s of Object.keys(room.members)) registry.snapshot(s);
  registry.tick();
  assert.equal(room.recovering, false);
  assert.equal(restore_room(dump_room(room), 2000).recovering, true);
});
test("SQLite excludes concurrent writers and imports Python data without modifying it", () => {
  const dir = mkdtempSync(join(tmpdir(), "labgames-storage-"));
  try {
    const path = join(dir, "save.sqlite3"),
      store = new SaveStore(path);
    assert.throws(() => new SaveStore(path), /locked/);
    store.write("session", {
      s: {
        game: dump_game(restore_game(fixtures.playing)),
        last_seen: Date.now() / 1000,
      },
    });
    store.close();
    const reopened = new SaveStore(path);
    assert.equal(Object.keys(reopened.read("session")).length, 1);
    reopened.close();
    const legacy = join(dir, "old.sqlite3"),
      db = new DatabaseSync(legacy);
    db.exec(
      "CREATE TABLE checkpoints(kind TEXT,id TEXT,payload TEXT); PRAGMA user_version=1",
    );
    db.prepare("INSERT INTO checkpoints VALUES (?,?,?)").run(
      "session",
      "old-session",
      JSON.stringify({ last_seen: Date.now() / 1000, game: fixtures.playing }),
    );
    db.close();
    const before = readFileSync(legacy),
      imported = read_legacy(legacy);
    assert.ok(imported.sessions["old-session"]);
    assert.deepEqual(readFileSync(legacy), before);
    assert.throws(() => new SaveStore(legacy), /旧版/);
    assert.deepEqual(readFileSync(legacy), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
async function serverFixture(t, options = {}, port = 0) {
  const server = createApp(options);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (cookie) => ({
    cookie: cookie || "",
    state: null,
    async request(route = "state", payload) {
      const response = await fetch(`${base}/api/${route}`, {
        method: payload ? "POST" : "GET",
        headers: {
          Cookie: this.cookie,
          "X-Poker-Client": "1",
          "Content-Type": "application/json",
        },
        body: payload
          ? JSON.stringify({
              server_id: this.state?.server_id,
              version: this.state?.version,
              room_code: this.state?.room_info?.code,
              round_id: this.state?.room_info?.round_id,
              ...payload,
            })
          : undefined,
      });
      if (response.headers.has("set-cookie"))
        this.cookie = response.headers.get("set-cookie").split(";")[0];
      const value = await response.json();
      if (response.ok) this.state = value;
      return { response, value };
    },
  });
  return { server, base, client };
}
test("HTTP sessions, full solo hand, static allowlist and origin protection", async (t) => {
  const { server, base, client } = await serverFixture(t),
    alice = client(),
    bob = client();
  await alice.request();
  await bob.request();
  assert.notEqual(alice.cookie, bob.cookie);
  assert.equal(
    (
      await alice.request("new", {
        name: "Alice",
        opponents: ["calling_station", "random"],
      })
    ).response.status,
    200,
  );
  for (let i = 0; alice.state.phase !== "finished" && i < 100; i++) {
    const s = alice.state;
    assert.equal(
      (
        await alice.request(
          s.actor_id === 0 ? "action" : "step",
          s.actor_id === 0 ? { kind: s.legal.check ? "check" : "call" } : {},
        )
      ).response.status,
      200,
    );
  }
  assert.equal(alice.state.phase, "finished");
  assert.ok(alice.state.result.shown_hands.length);
  assert.equal((await bob.request()).value.phase, "lobby");
  for (const path of [
    "/server.mjs",
    "/src/storage.mjs",
    "/.poker-data/test.sqlite3",
    "/../package.json",
  ])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal(
    (
      await fetch(base + "/api/new", {
        method: "POST",
        headers: { Origin: "http://evil.test", "X-Poker-Client": "1" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
});
test("HTTP invitation, admission, QR and restart restore the same cookie identity", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "labgames-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const savePath = join(dir, "save.sqlite3"),
    first = await serverFixture(t, { savePath });
  const host = first.client(),
    friend = first.client();
  await host.request();
  await friend.request();
  await host.request("room/create", {
    name: "host",
    capacity: 2,
    fill_bots: false,
  });
  const code = host.state.room_info.code;
  await friend.request("room/join", { name: "friend", code });
  assert.equal(friend.state.phase, "pending");
  await host.request();
  await host.request("room/approve", {
    target_id: host.state.room_info.applications[0].id,
  });
  await friend.request();
  await host.request("room/start", { ready: true });
  await friend.request("room/start", { ready: true });
  await host.request();
  const cards = host.state.players[host.state.viewer_id].cards;
  const qr = await fetch(first.base + "/api/invite-qr", {
    headers: { Cookie: host.cookie },
  });
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /<svg/);
  const port = first.server.address().port;
  await first.server.stop();
  const second = await serverFixture(t, { savePath }, port),
    restored = second.client(host.cookie);
  const response = await restored.request();
  assert.equal(response.value.room_info.code, code);
  assert.deepEqual(
    response.value.players[response.value.viewer_id].cards,
    cards,
  );
  assert.equal(response.value.room_info.recovering, true);
  const stale = await restored.request("action", {
    server_id: host.state.server_id,
    kind: "call",
  });
  assert.equal(stale.response.status, 409);
  await second.server.stop();
});
