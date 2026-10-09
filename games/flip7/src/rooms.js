import { randomBytes, randomInt, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createGame,
  applyAction,
  currentActor,
  publicView,
  validateSave,
  canStay,
  isOpeningTurn,
  pendingEffect,
} from "./game.js";
import { chooseBotAction } from "./bot.js";
import { cardTracker } from "./card-tracker.js";
import { updateApplause, applauseView } from "./applause.js";

export class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new RoomError(status, message);
};
const hash = (token) => createHash("sha256").update(token).digest("hex");
const id = () => randomBytes(12).toString("hex");
const token = () => randomBytes(32).toString("base64url");
const normalizeName = (name) => {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    [...name.trim()].length > 16 ||
    /[\u0000-\u001f\u007f]/u.test(name)
  )
    fail(400, "昵称需要 1～16 个字符");
  return name.trim();
};
const BOT_NAMES = ["小橘", "阿栗", "薄荷", "小蓝", "桃子"];
export const TURN_LIMIT_MS = 10_000;
export const NOTICE_DURATION_MS = 6_000;
export const DANMAKU_COOLDOWN_MS = 2_000;
export const DANMAKU_MAX_LENGTH = 40;

// All mutations (including bots) share one commit queue. Publish only after durable writes.
export class RoomService {
  constructor({
    file = null,
    botDelay = 800,
    offlineGrace = 30_000,
    now = Date.now,
    onError = console.error,
  } = {}) {
    this.file = file;
    this.botDelay = botDelay;
    this.offlineGrace = offlineGrace;
    this.now = now;
    this.onError = onError;
    this.rooms = new Map();
    this.connections = new Map();
    this.offlineSince = new Map();
    this.timers = new Map();
    this.danmakuReceipts = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }
  async init() {
    if (!this.file) return this;
    let data;
    try {
      data = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return this;
      throw new Error(`无法读取房间存档：${error.message}`);
    }
    if (data.schema !== 1 || !Array.isArray(data.rooms))
      throw new Error("房间存档格式不兼容");
    for (const room of data.rooms) {
      if (
        !/^[A-Z2-9]{6}$/.test(room.code) ||
        !Number.isInteger(room.revision) ||
        !Array.isArray(room.members) ||
        room.members.length < 1 ||
        room.members.length > 6 ||
        !room.members.some((m) => m.id === room.hostId && !m.bot) ||
        !Array.isArray(room.operations) ||
        (room.cardTracker !== undefined &&
          typeof room.cardTracker !== "boolean") ||
        (room.game && !validateSave(room.game, { requireLocalPlayer: false }))
      )
        throw new Error("房间存档损坏，请保留文件检查");
      if (this.now() - room.updatedAt > 7 * 86400_000) continue;
      room.cardTracker = room.cardTracker === true;
      room.applause = updateApplause(
        room.game,
        room.members,
        room.applause,
        id,
      );
      this.updateTurnClock(room);
      this.rooms.set(room.code, room);
      for (const m of room.members) this.offlineSince.set(m.id, this.now());
    }
    return this;
  }
  enqueue(work) {
    const result = this.queue.then(() => {
      if (this.closed) fail(503, "房间服务已停止");
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async commit(room) {
    const previous = this.rooms.get(room.code);
    room.applause = updateApplause(room.game, room.members, room.applause, id);
    this.updateTurnClock(room);
    if (!room.game) room.notices = [];
    else {
      const afterEvent = previous?.game?.eventId ?? 0;
      const notices = room.game.events
        .filter(
          (e) =>
            e.id > afterEvent &&
            e.cardKind === "three" &&
            ["draw", "action"].includes(e.type),
        )
        .map((e) => ({
          id: `${room.revision}:${e.id}`,
          type: e.type,
          playerId: e.playerId,
          targetId: e.targetId ?? null,
          text: e.text,
          createdAt: this.now(),
        }));
      room.notices = [...(room.notices || []), ...notices].slice(-6);
    }
    const next = new Map(this.rooms);
    if (room.members.some((m) => !m.bot)) next.set(room.code, room);
    else next.delete(room.code);
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ schema: 1, rooms: [...next.values()] }),
        { mode: 0o600 },
      );
      await rename(temporary, this.file);
    }
    this.rooms = next;
    if (!next.has(room.code)) this.danmakuReceipts.delete(room.code);
    this.publish(room.code);
    this.scheduleTurn(room.code);
  }
  room(code) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) fail(404, "房间不存在或已关闭");
    return room;
  }
  authenticate(code, credential) {
    const room = this.room(code);
    if (
      typeof credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(credential)
    )
      fail(401, "房间身份已失效，请重新加入");
    const member = room.members.find(
      (m) => !m.bot && m.tokenHash === hash(credential),
    );
    if (!member) fail(401, "房间身份已失效，请重新加入");
    return { room, member };
  }
  online(memberId) {
    return (this.connections.get(memberId)?.size || 0) > 0;
  }
  snapshot(code, memberId) {
    const room = this.rooms.get(code);
    if (!room || !room.members.some((m) => m.id === memberId && !m.bot))
      return { code, removed: true };
    return {
      code,
      revision: room.revision,
      hostId: room.hostId,
      selfId: memberId,
      settings: { cardTracker: room.cardTracker === true },
      cardTracker:
        room.cardTracker && room.game ? cardTracker(room.game) : null,
      members: room.members.map(({ tokenHash, ...m }) => ({
        ...m,
        online: m.bot || this.online(m.id),
        offlineSince:
          this.online(m.id) || m.bot
            ? null
            : (this.offlineSince.get(m.id) ?? this.now()),
      })),
      game: room.game ? publicView(room.game) : null,
      applause: applauseView(room.applause, room.members),
      offlineGrace: this.offlineGrace,
      serverNow: this.now(),
      turnClock: room.turnClock
        ? { ...room.turnClock, limitMs: TURN_LIMIT_MS }
        : null,
      notices: (room.notices || []).filter(
        (n) => this.now() - n.createdAt < NOTICE_DURATION_MS,
      ),
    };
  }
  publish(code) {
    for (const [memberId, listeners] of this.connections) {
      for (const subscription of listeners)
        if (subscription.code === code) {
          try {
            subscription.send(this.snapshot(code, memberId));
          } catch {
            /* Socket cleanup owns disconnection. */
          }
        }
    }
  }
  subscribe(code, credential, send, sendDanmaku = () => {}) {
    const { room, member } = this.authenticate(code, credential);
    const listeners = this.connections.get(member.id) || new Set();
    const subscription = { code: room.code, send, sendDanmaku };
    listeners.add(subscription);
    this.connections.set(member.id, listeners);
    this.offlineSince.delete(member.id);
    this.publish(room.code);
    this.scheduleTurn(room.code);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      listeners.delete(subscription);
      if (!listeners.size) {
        this.connections.delete(member.id);
        this.offlineSince.set(member.id, this.now());
      }
      this.publish(room.code);
      this.scheduleTurn(room.code);
    };
  }
  sendDanmaku(code, credential, input) {
    return this.enqueue(() => {
      const { room, member } = this.authenticate(code, credential);
      const { requestId, text } = input || {};
      if (
        typeof requestId !== "string" ||
        !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId) ||
        typeof text !== "string" ||
        !text.trim() ||
        [...text.trim()].length > DANMAKU_MAX_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(text)
      )
        fail(400, "弹幕需要 1～40 个字符，请发送单行文字");
      const now = this.now();
      const receipts = (this.danmakuReceipts.get(room.code) || []).filter(
        (entry) => now - entry.message.createdAt < 60_000,
      );
      const previous = receipts.find(
        (entry) =>
          entry.memberId === member.id && entry.requestId === requestId,
      );
      if (previous) {
        if (previous.message.text !== text.trim())
          fail(409, "弹幕编号不能重复用于不同内容");
        return previous.message;
      }
      const last = receipts.findLast((entry) => entry.memberId === member.id);
      if (last && now - last.message.createdAt < DANMAKU_COOLDOWN_MS)
        fail(429, "发送太快了，每 2 秒可以发送一条弹幕");
      const message = {
        id: id(),
        code: room.code,
        playerId: member.id,
        name: member.name,
        text: text.trim(),
        createdAt: now,
      };
      receipts.push({ memberId: member.id, requestId, message });
      this.danmakuReceipts.set(room.code, receipts.slice(-256));
      // Chat is ephemeral: it never writes saves, advances revisions or restarts turn timers.
      for (const [memberId, listeners] of this.connections) {
        if (!room.members.some((m) => m.id === memberId && !m.bot)) continue;
        for (const subscription of listeners) {
          if (subscription.code !== room.code) continue;
          try {
            subscription.sendDanmaku(message);
          } catch {
            /* A disconnected viewer must not interrupt delivery to the table. */
          }
        }
      }
      return message;
    });
  }
  create(name, options = {}) {
    return this.enqueue(async () => {
      if (
        !options ||
        typeof options !== "object" ||
        Array.isArray(options) ||
        (options.cardTracker !== undefined &&
          typeof options.cardTracker !== "boolean")
      )
        fail(400, "记牌器选项需要为开启或关闭");
      if (this.rooms.size >= 100) fail(429, "房间数量已达上限");
      const credential = token();
      const host = {
        id: id(),
        name: normalizeName(name),
        bot: false,
        automated: false,
        ready: true,
        tokenHash: hash(credential),
      };
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code;
      do {
        code = Array.from(
          { length: 6 },
          () => alphabet[randomInt(alphabet.length)],
        ).join("");
      } while (this.rooms.has(code));
      const room = {
        code,
        hostId: host.id,
        revision: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
        members: [host],
        game: null,
        cardTracker: options.cardTracker === true,
        operations: [],
      };
      this.offlineSince.set(host.id, this.now());
      await this.commit(room);
      return {
        code,
        token: credential,
        snapshot: this.snapshot(code, host.id),
      };
    });
  }
  join(code, name) {
    return this.enqueue(async () => {
      const room = structuredClone(this.room(code));
      if (room.game) fail(409, "对局已经开始，请等待房主返回准备大厅");
      if (room.members.length >= 6)
        fail(409, "房间已满，可请房主移除一个电脑席位");
      const credential = token();
      const member = {
        id: id(),
        name: normalizeName(name),
        bot: false,
        automated: false,
        ready: false,
        tokenHash: hash(credential),
      };
      room.members.push(member);
      room.revision++;
      room.updatedAt = this.now();
      this.offlineSince.set(member.id, this.now());
      await this.commit(room);
      return {
        code: room.code,
        token: credential,
        snapshot: this.snapshot(room.code, member.id),
      };
    });
  }
  command(code, credential, input) {
    return this.enqueue(async () => {
      const auth = this.authenticate(code, credential);
      const room = structuredClone(auth.room);
      const self = room.members.find((m) => m.id === auth.member.id);
      const { requestId, expectedRevision, command } = input || {};
      if (
        typeof requestId !== "string" ||
        !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId) ||
        !command ||
        typeof command.type !== "string"
      )
        fail(400, "操作格式不正确");
      const fingerprint = JSON.stringify(command);
      const previous = room.operations.find(
        (op) => op.memberId === self.id && op.requestId === requestId,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail(409, "操作编号不能重复用于不同操作");
        return this.snapshot(room.code, self.id);
      }
      // Check the server deadline even if the timer callback is still queued.
      if (
        command.type === "game" &&
        room.turnClock &&
        this.now() >= room.turnClock.deadlineAt
      ) {
        await this.advanceTurn(room.code, room.turnClock);
        fail(409, "思考时间已到，服务器已代操作，请查看最新牌桌");
      }
      // Applause is a monotonic acknowledgement of one specific celebration, so
      // simultaneous clicks from the same snapshot must all succeed.
      if (command.type !== "applaud" && expectedRevision !== room.revision)
        fail(409, "牌桌已更新，请根据最新状态再操作");
      const host = () => {
        if (room.hostId !== self.id) fail(403, "只有房主可以执行此操作");
      };
      const lobby = () => {
        if (room.game) fail(409, "请等待当前对局结束");
      };
      const waitForApplause = () => {
        if (
          room.applause &&
          !applauseView(room.applause, room.members).complete
        )
          fail(409, "请等待全员点击「为ta鼓掌」后继续");
      };
      if (command.type === "applaud") {
        if (!room.applause || command.applauseId !== room.applause.id)
          fail(409, "这次庆祝已结束，请查看最新牌桌");
        if (!room.applause.acknowledgedIds.includes(self.id))
          room.applause.acknowledgedIds.push(self.id);
      } else if (command.type === "ready") {
        lobby();
        if (typeof command.ready !== "boolean") fail(400, "准备状态不正确");
        self.ready = self.id === room.hostId || command.ready;
      } else if (command.type === "setCardTracker") {
        host();
        if (room.game) fail(409, "请在准备大厅、开局前调整记牌器");
        if (typeof command.cardTracker !== "boolean")
          fail(400, "记牌器选项需要为开启或关闭");
        if (room.cardTracker !== command.cardTracker) {
          room.cardTracker = command.cardTracker;
          for (const member of room.members)
            member.ready = member.bot || member.id === room.hostId;
        }
      } else if (command.type === "addBot") {
        host();
        lobby();
        if (room.members.length >= 6) fail(409, "最多 6 个席位");
        const used = new Set(room.members.map((m) => m.name));
        room.members.push({
          id: id(),
          name: BOT_NAMES.find((n) => !used.has(n)) || "电脑",
          bot: true,
          style: ["balanced", "careful", "bold"][room.members.length % 3],
          ready: true,
        });
      } else if (command.type === "remove") {
        host();
        lobby();
        const target = room.members.find((m) => m.id === command.memberId);
        if (
          !target ||
          target.id === self.id ||
          (!target.bot && this.online(target.id))
        )
          fail(409, "只能移除电脑或离线玩家");
        room.members = room.members.filter((m) => m.id !== target.id);
      } else if (command.type === "start") {
        host();
        lobby();
        if (room.members.length < 3)
          fail(409, "至少需要 3 个席位，可添加电脑补足");
        if (
          room.members.some((m) => !m.bot && (!m.ready || !this.online(m.id)))
        )
          fail(409, "请等待所有真人在线并准备");
        room.game = createGame({
          players: room.members,
          seed: randomInt(1, 0xffffffff),
        });
      } else if (command.type === "game") {
        if (!room.game) fail(409, "牌局尚未开始");
        if (command.action?.type === "nextRound") waitForApplause();
        if (self.automated) fail(409, "请先接管自己的席位");
        try {
          room.game = applyAction(room.game, self.id, command.action);
        } catch (error) {
          fail(409, error.message);
        }
      } else if (command.type === "lobby") {
        host();
        if (room.game?.phase !== "finished") fail(409, "当前对局尚未结束");
        waitForApplause();
        room.game = null;
        for (const m of room.members) {
          m.ready = m.bot || m.id === room.hostId;
          m.automated = false;
        }
      } else if (command.type === "claimHost") {
        const oldHost = room.members.find((m) => m.id === room.hostId);
        if (
          this.online(oldHost.id) ||
          this.now() - (this.offlineSince.get(oldHost.id) ?? this.now()) <
            this.offlineGrace
        )
          fail(409, "原房主离线满 30 秒后可接任");
        room.hostId = self.id;
        self.ready = true;
      } else if (command.type === "takeover") {
        host();
        const target = room.members.find((m) => m.id === command.memberId);
        if (
          !room.game ||
          !target ||
          target.bot ||
          this.online(target.id) ||
          this.now() - (this.offlineSince.get(target.id) ?? this.now()) <
            this.offlineGrace
        )
          fail(409, "玩家离线满 30 秒后可由电脑托管");
        target.automated = true;
        room.game.players.find((p) => p.id === target.id).bot = true;
      } else if (command.type === "reclaim") {
        self.automated = false;
        if (room.game)
          room.game.players.find((p) => p.id === self.id).bot = false;
      } else if (command.type === "leave") {
        if (room.game) {
          self.bot = true;
          self.automated = false;
          self.ready = true;
          delete self.tokenHash;
          room.game.players.find((p) => p.id === self.id).bot = true;
        } else room.members = room.members.filter((m) => m.id !== self.id);
        if (room.hostId === self.id) {
          const successor = room.members.find((m) => !m.bot);
          room.hostId = successor?.id || null;
          if (successor) successor.ready = true;
        }
      } else fail(400, "不支持的房间操作");
      room.revision++;
      room.updatedAt = this.now();
      room.operations.push({ memberId: self.id, requestId, fingerprint });
      room.operations = room.operations.slice(-512);
      await this.commit(room);
      return this.snapshot(room.code, self.id);
    });
  }
  updateTurnClock(room) {
    const actorId = room.game && currentActor(room.game);
    if (!actorId) {
      room.turnClock = null;
      return;
    }
    const clock = room.turnClock;
    if (
      clock?.actorId === actorId &&
      clock.gameRevision === room.game.revision &&
      clock.round === room.game.round &&
      Number.isFinite(clock.deadlineAt)
    )
      return;
    room.turnClock = {
      actorId,
      gameRevision: room.game.revision,
      round: room.game.round,
      deadlineAt: this.now() + TURN_LIMIT_MS,
    };
  }
  async advanceTurn(code, expectedClock) {
    const current = this.rooms.get(code);
    const clock = current?.turnClock;
    if (
      !clock ||
      JSON.stringify(clock) !== JSON.stringify(expectedClock) ||
      !current.members.some((m) => !m.bot && this.online(m.id))
    )
      return;
    const actor = current.members.find((m) => m.id === clock.actorId);
    const automated = actor.bot || actor.automated;
    if (!automated && this.now() < clock.deadlineAt) {
      this.scheduleTurn(code);
      return;
    }
    const next = structuredClone(current);
    let action;
    if (automated || pendingEffect(next.game))
      action = chooseBotAction(publicView(next.game), actor.id);
    else
      action = {
        type:
          !isOpeningTurn(next.game) &&
          canStay(next.game.players.find((p) => p.id === actor.id))
            ? "stay"
            : "hit",
      };
    if (!automated) {
      next.game.events.push({
        id: ++next.game.eventId,
        round: next.game.round,
        type: "timeout",
        playerId: actor.id,
        text: `${actor.name} 思考超过 10 秒，${action.type === "target" ? "自动选择特殊牌目标" : action.type === "stay" ? "自动收手" : "自动翻牌"}。`,
      });
      next.game.events = next.game.events.slice(-100);
    }
    next.game = applyAction(next.game, actor.id, action);
    next.revision++;
    next.updatedAt = this.now();
    await this.commit(next);
  }
  scheduleTurn(code) {
    clearTimeout(this.timers.get(code));
    this.timers.delete(code);
    const room = this.rooms.get(code);
    if (
      this.closed ||
      !room?.game ||
      room.game.phase !== "playing" ||
      !room.members.some((m) => !m.bot && this.online(m.id))
    )
      return;
    const actor = room.members.find((m) => m.id === currentActor(room.game));
    const clock = room.turnClock;
    const remaining = Math.max(0, clock.deadlineAt - this.now());
    const timer = setTimeout(
      () => {
        this.timers.delete(code);
        void this.enqueue(() => this.advanceTurn(code, clock)).catch(
          this.onError,
        );
      },
      actor.bot || actor.automated
        ? Math.min(this.botDelay, remaining)
        : remaining,
    );
    timer.unref?.();
    this.timers.set(code, timer);
  }
  async close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.queue;
  }
}
