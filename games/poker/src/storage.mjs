import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Hand, Table } from "./engine.mjs";
import { make_bot } from "./bots.mjs";
import { BrowserGame, now } from "./browser-game.mjs";
import { Room, Member, DISCONNECT_SECONDS } from "./rooms.mjs";

const fields = [
  "version",
  "completed",
  "wins",
  "player_wins",
  "player_hands",
  "history",
  "room",
  "strategies",
];
export function dump_game(game) {
  const data = Object.fromEntries(fields.map((k) => [k, game[k]]));
  data.bots = Object.fromEntries(
    Object.entries(game.bots).map(([id, b]) => [
      id,
      { rng: b.rng.state, samples: b.samples },
    ]),
  );
  const t = game.table,
    h = t?.hand;
  data.table = t
    ? {
        config: t.config,
        players: t.players,
        seed: t.seed,
        rng: t.rng.state,
        button: t.button_id,
        previous_bb: t.previous_bb,
        hand_number: t.hand_number,
        sitting_out: [...t.sitting_out],
        hand: {
          players: h.players,
          seed: h.seed,
          deck: h._initial_deck,
          actions: h.actions.map((a) => ({
            player_id: a.player_id,
            action: a.action,
          })),
          finished: h.finished,
        },
      }
    : null;
  return structuredClone(data);
}
export function restore_game(data) {
  const game = new BrowserGame();
  for (const k of fields)
    if (data[k] !== undefined) game[k] = structuredClone(data[k]);
  if (
    !Number.isInteger(game.version) ||
    !Array.isArray(game.history) ||
    !Array.isArray(game.strategies)
  )
    throw new Error("存档内容不完整。");
  game.version++;
  if (!data.player_hands)
    game.player_hands = Object.fromEntries(
      game.strategies.map((_, i) => [i, game.completed]),
    );
  const saved = data.table;
  if (saved) {
    const initial = new Map(saved.hand.players.map((p) => [p.player_id, p]));
    const base = saved.players.map((p) => initial.get(p.player_id) || p);
    const t = new Table(
      base.map((p) => p.name),
      saved.config,
      { stacks: base.map((p) => p.stack), seed: saved.seed },
    );
    t.hand_number = saved.hand_number;
    t.button_id = saved.button;
    t.previous_bb = saved.previous_bb;
    // Old Python MT states are not used for future shuffles; the current deck is replayed exactly.
    if (Number.isInteger(saved.rng)) t.rng.state = saved.rng >>> 0;
    t.sitting_out = new Set(saved.sitting_out || []);
    t.hand = new Hand(
      saved.hand.players,
      saved.config,
      t.hand_number,
      saved.hand.seed,
      { deck: saved.hand.deck },
    );
    t.settle();
    for (const a of saved.hand.actions) t.apply_action(a.player_id, a.action);
    if (
      t.players.length !== saved.players.length ||
      t.players.some((p, i) =>
        ["player_id", "name", "stack"].some(
          (key) => p[key] !== saved.players[i][key],
        ),
      ) ||
      t.hand.finished !== saved.hand.finished
    )
      throw new Error("存档重建后的筹码或结算状态不一致，已保留原文件。");
    game.table = t;
    for (const [id, b] of Object.entries(data.bots)) {
      const bot = make_bot(game.strategies[id], 0, b.samples ?? 128);
      if (Number.isInteger(b.rng)) bot.rng.state = b.rng >>> 0;
      game.bots[id] = bot;
    }
  }
  return game;
}
export function dump_room(r) {
  return {
    ...Object.fromEntries(
      [
        "code",
        "host",
        "capacity",
        "fill_bots",
        "bot_strategy",
        "turn_seconds",
        "version",
        "round_id",
        "notice",
        "last_seen",
      ].map((k) => [k, r[k]]),
    ),
    ready: [...r.ready],
    banned: [...r.banned],
    members: structuredClone(r.members),
    applicants: structuredClone(r.applicants),
    game: r.game ? dump_game(r.game) : null,
  };
}
export function restore_room(data, time = now()) {
  const r = Object.assign(
    new Room(
      data.code,
      data.host,
      data.capacity,
      data.fill_bots,
      data.bot_strategy,
      data.turn_seconds,
    ),
    structuredClone(data),
  );
  r.version++;
  r.ready = new Set(data.ready);
  r.banned = new Set(data.banned);
  for (const key of ["members", "applicants"])
    r[key] = Object.fromEntries(
      Object.entries(data[key] || {}).map(([s, m]) => [
        s,
        Object.assign(
          new Member(m.name, time - DISCONNECT_SECONDS - 1, m.player_id),
          m,
          { seen: time - DISCONNECT_SECONDS - 1 },
        ),
      ]),
    );
  if (
    !r.members[r.host] ||
    [...r.ready].some((s) => !r.members[s]) ||
    Object.keys(r.members).some((s) => r.applicants[s])
  )
    throw new Error("存档中的房间成员不一致。");
  r.game = data.game ? restore_game(data.game) : null;
  r.recovering = !!r.game && !r.game.table.hand.finished;
  r.turn_key = null;
  r.deadline = 0;
  r.notice =
    "牌局已从存档恢复。" +
    (r.recovering ? "等待玩家重连后继续本手。" : "已保留筹码和准备状态。");
  return r;
}
export class SaveStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      // An OS-managed SQLite lock is released even on a crash, on all supported platforms.
      this.guard = new DatabaseSync(path + ".lock.sqlite3");
      this.guard.exec("BEGIN EXCLUSIVE");
      this.db = new DatabaseSync(path);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 2].includes(version))
        throw new Error(
          "这是旧版或不兼容的存档，请通过 --import-save 导入到新的文件。",
        );
      this.db.exec(
        "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoints (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=2",
      );
      chmodSync(path, 0o600);
      chmodSync(path + ".lock.sqlite3", 0o600);
    } catch (e) {
      this.close();
      throw e;
    }
  }
  read(kind) {
    return Object.fromEntries(
      this.db
        .prepare("SELECT id,payload FROM checkpoints WHERE kind=?")
        .all(kind)
        .map((r) => [r.id, JSON.parse(r.payload)]),
    );
  }
  write(kind, records, replace = false) {
    const values = Object.entries(records).map(([id, payload]) => [
      kind,
      id,
      JSON.stringify(payload),
    ]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (replace)
        this.db.prepare("DELETE FROM checkpoints WHERE kind=?").run(kind);
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO checkpoints VALUES (?,?,?)",
      );
      for (const row of values) insert.run(...row);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  delete(kind, id) {
    this.db
      .prepare("DELETE FROM checkpoints WHERE kind=? AND id=?")
      .run(kind, id);
  }
  close() {
    this.db?.close();
    this.db = null;
    this.guard?.close();
    this.guard = null;
  }
}
export function read_legacy(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("PRAGMA user_version").get().user_version !== 1)
      throw new Error("导入文件不是 Python 版扑克存档。");
    const rows = db.prepare("SELECT kind,id,payload FROM checkpoints").all();
    const sessions = {},
      rooms = {},
      time = now();
    for (const row of rows) {
      const data = JSON.parse(row.payload);
      if (time - data.last_seen > 86400) continue;
      if (row.kind === "session")
        sessions[row.id] = {
          last_seen: data.last_seen,
          game: dump_game(restore_game(data.game)),
        };
      if (row.kind === "room")
        rooms[row.id] = dump_room(restore_room(data, time));
    }
    return { sessions, rooms };
  } finally {
    db.close();
  }
}
