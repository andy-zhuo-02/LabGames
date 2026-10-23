import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { applyAction, createGame, PLAYER_COUNTS, RuleError } from "./game.js";
import { chooseBotAction, chooseTimeoutMove } from "./bot.js";
import { TURN_SECONDS } from "./clock.js";

export class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new RoomError(status, message);
};
const nameOf = (name) =>
  typeof name === "string" && name.trim()
    ? name.trim().slice(0, 16)
    : "无名棋手";
const TTL = 24 * 60 * 60 * 1000;

export class RoomService {
  constructor({ file = null, now = Date.now, botDelay = 700 } = {}) {
    this.file = file;
    this.now = now;
    this.botDelay = botDelay;
    this.rooms = new Map();
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.rooms))
        throw new Error("步步为营存档格式无效，请检查存档文件");
      this.rooms = new Map(
        data.rooms
          .filter((r) => now() - r.updated < TTL)
          .map((r) => [r.code, r]),
      );
      for (const room of this.rooms.values()) {
        // Existing rooms retain their original untimed rules.
        room.turnSeconds ??= 0;
        room.turnDeadline ??= null;
      }
    }
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      `${this.file}.tmp`,
      JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }),
      { mode: 0o600 },
    );
    renameSync(`${this.file}.tmp`, this.file);
  }
  transaction(operation) {
    const before = structuredClone(this.rooms);
    try {
      const result = operation();
      this.save();
      return result;
    } catch (error) {
      this.rooms = before;
      throw error;
    }
  }
  get(code) {
    const room = this.rooms.get(code);
    if (!room || this.now() - room.updated >= TTL)
      fail(404, "房间不存在或已过期，请重新创建");
    return room;
  }
  authenticate(code, token) {
    const room = this.get(code),
      member = room.members.find((m) => m.token === token && token);
    if (!member) fail(401, "座位凭证无效，请重新加入房间");
    return { room, member };
  }
  snapshot(code, token) {
    const { room, member } = this.authenticate(code, token);
    return {
      code,
      count: room.count,
      revision: room.revision,
      self: member.seat,
      host: room.host,
      game: room.game,
      turnSeconds: room.turnSeconds,
      clock: {
        limitMs: room.turnSeconds * 1000,
        deadline: room.turnDeadline,
        serverNow: this.now(),
      },
      members: room.members.map((m) => ({ seat: m.seat, name: m.name })),
    };
  }
  create({ name, count = 2, turnSeconds = 30 } = {}) {
    if (!PLAYER_COUNTS.includes(count)) fail(400, "请选择双人、三人或四人房间");
    if (!TURN_SECONDS.includes(turnSeconds))
      fail(400, "读秒请选择不限时、10、20、30、60 或 120 秒");
    return this.transaction(() => {
      for (const [key, room] of this.rooms)
        if (this.now() - room.updated >= TTL) this.rooms.delete(key);
      if (this.rooms.size >= 100) fail(429, "房间已满，请稍后再试");
      let code;
      do {
        code = randomBytes(3).toString("hex").toUpperCase();
      } while (this.rooms.has(code));
      const token = randomBytes(24).toString("hex");
      this.rooms.set(code, {
        code,
        count,
        host: 0,
        revision: 0,
        updated: this.now(),
        nextBotAt: 0,
        members: [{ seat: 0, name: nameOf(name), token }],
        game: null,
        turnSeconds,
        turnDeadline: null,
      });
      return { code, token, snapshot: this.snapshot(code, token) };
    });
  }
  join(code, { name } = {}) {
    return this.transaction(() => {
      const room = this.get(code);
      if (room.game) fail(409, "对局已经开始，请等房主返回准备室");
      if (room.members.length >= room.count) fail(409, "房间已经坐满了");
      let seat = 0;
      while (room.members.some((m) => m.seat === seat)) seat++;
      const token = randomBytes(24).toString("hex");
      room.members.push({ seat, name: nameOf(name), token });
      room.revision++;
      room.updated = this.now();
      return { code, token, snapshot: this.snapshot(code, token) };
    });
  }
  command(code, token, { revision, command } = {}) {
    this.authenticate(code, token);
    // Resolve an expired turn before accepting a late click, even between timer ticks.
    const room = this.get(code);
    if (this.expired(room)) this.transaction(() => this.advance(room, true));
    return this.transaction(() => {
      const { room, member } = this.authenticate(code, token);
      if (revision !== room.revision)
        fail(409, "棋盘已更新，请根据最新局面操作");
      if (!command || typeof command !== "object") fail(400, "缺少操作内容");
      if (command.type === "start") {
        if (member.seat !== room.host) fail(403, "只有房主可以开始对局");
        if (room.game) fail(409, "对局已经开始");
        const names = [],
          bots = [];
        for (let i = 0; i < room.count; i++) {
          const human = room.members.find((m) => m.seat === i);
          names[i] = human?.name || `电脑 ${i + 1}`;
          bots[i] = !human;
        }
        room.game = createGame({ count: room.count, names, bots });
        this.beginTurn(room);
      } else if (command.type === "settings") {
        if (member.seat !== room.host) fail(403, "只有房主可以设置读秒");
        if (room.game) fail(409, "对局开始后不能修改读秒规则");
        if (!TURN_SECONDS.includes(command.turnSeconds))
          fail(400, "读秒设置无效");
        room.turnSeconds = command.turnSeconds;
      } else if (command.type === "restart") {
        if (member.seat !== room.host) fail(403, "只有房主可以返回准备室");
        room.game = null;
        room.turnDeadline = null;
      } else if (command.type === "action") {
        if (!room.game) fail(409, "对局尚未开始");
        if (
          room.game.turn !== member.seat ||
          room.game.players[member.seat].isBot
        )
          fail(403, "还没轮到你");
        room.game = applyAction(room.game, command.action);
        this.beginTurn(room);
      } else if (command.type === "leave") {
        room.members = room.members.filter((m) => m.seat !== member.seat);
        if (!room.members.length) {
          this.rooms.delete(code);
          return { left: true };
        }
        if (room.host === member.seat) room.host = room.members[0].seat;
        if (room.game) {
          room.game = {
            ...room.game,
            players: room.game.players.map((p) =>
              p.id === member.seat
                ? { ...p, isBot: true, name: `${p.name.slice(0, 11)}·电脑` }
                : p,
            ),
          };
        }
      } else throw new RuleError("未知的房间操作");
      room.revision++;
      room.updated = this.now();
      room.nextBotAt = this.now() + this.botDelay;
      return command.type === "leave"
        ? { left: true }
        : this.snapshot(code, token);
    });
  }
  beginTurn(room) {
    room.turnDeadline =
      room.game && room.game.winner === null && room.turnSeconds > 0
        ? this.now() + room.turnSeconds * 1000
        : null;
  }
  expired(room) {
    return (
      room.game &&
      room.game.winner === null &&
      room.turnDeadline !== null &&
      this.now() >= room.turnDeadline
    );
  }
  advance(room, timedOut = false) {
    const action = timedOut
      ? chooseTimeoutMove(room.game)
      : chooseBotAction(room.game);
    if (!action) return;
    room.game = applyAction(room.game, action);
    if (timedOut)
      room.game.history[room.game.history.length - 1].automatic = true;
    room.revision++;
    room.updated = this.now();
    room.nextBotAt = this.now() + this.botDelay;
    this.beginTurn(room);
  }
  tick() {
    const active = [...this.rooms.values()].filter(
      (r) =>
        this.now() - r.updated < TTL &&
        r.game &&
        r.game.winner === null &&
        (this.expired(r) ||
          (r.game.players[r.game.turn].isBot && this.now() >= r.nextBotAt)),
    );
    if (!active.length) return;
    this.transaction(() => {
      for (const room of active) {
        this.advance(room, this.expired(room));
      }
    });
  }
}
