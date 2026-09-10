import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { Store, type Room, type Session } from './store.js';
import { applyAction, createGame, gameView, RuleError } from '../engine/game.js';
import { chooseBotAction } from '../engine/bot.js';
import { createSchema, joinSchema, envelopeSchema } from '../shared/protocol.js';
import type { RoomView, Reply } from '../shared/types.js';

export function lanAddresses(port: number) {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((info) => info && info.family === 'IPv4' && !info.internal)
        .map((info) => `http://${info!.address}:${port}`),
    ),
  ];
}
export function createApplication(dbPath: string, options: { botDelayMs?: number } = {}) {
  const store = new Store(dbPath),
    app = express(),
    http = createServer(app);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  const io = new Server(http, {
    maxHttpBufferSize: 16_384,
    allowRequest(req, done) {
      const origin = req.headers.origin;
      if (!origin) {
        done(null, true);
        return;
      }
      try {
        done(null, new URL(origin).host === req.headers.host);
      } catch {
        done(null, false);
      }
    },
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.2.0' }));
  app.get('/api/network', (_req, res) => {
    const address = http.address();
    res.json({
      addresses: lanAddresses(typeof address === 'object' && address ? address.port : 3000),
    });
  });
  const connections = new Map<string, Set<string>>();
  const botTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closing = false;
  const online = (id: string) => !!connections.get(id)?.size;
  function botMayAct(room: Room | undefined): room is Room & { game: NonNullable<Room['game']> } {
    return (
      !!room &&
      room.status === 'playing' &&
      !!room.game &&
      room.game.phase !== 'finished' &&
      room.seats.some((s) => !s.bot && online(s.id)) &&
      room.seats.some((s) => s.bot && s.id === room.game!.players[room.game!.currentPlayer].id)
    );
  }
  function scheduleBot(code: string) {
    if (closing) return;
    if (!botMayAct(store.getRoom(code))) {
      clearTimeout(botTimers.get(code));
      botTimers.delete(code);
      return;
    }
    if (botTimers.has(code)) return;
    botTimers.set(
      code,
      setTimeout(() => {
        botTimers.delete(code);
        if (closing) return;
        // Re-read at execution time: a human may have ended the game or disconnected.
        const room = store.getRoom(code);
        if (!botMayAct(room)) return;
        try {
          const id = room.game.players[room.game.currentPlayer].id;
          room.game = applyAction(room.game, id, chooseBotAction(gameView(room.game, id), id));
          room.version++;
          if (room.game.phase === 'finished') room.status = 'finished';
          store.transaction(() => store.saveRoom(room));
          broadcast(code);
        } catch (error) {
          console.error('AI turn failed:', error);
        }
      }, options.botDelayMs ?? 800),
    );
  }
  function view(room: Room, playerId: string): RoomView {
    return {
      code: room.code,
      hostId: room.hostId,
      selfId: playerId,
      version: room.version,
      status: room.status,
      seats: room.seats.map((s) => ({ ...s, online: !!s.bot || online(s.id) })),
      game: room.game ? gameView(room.game, playerId) : null,
    };
  }
  function broadcast(code: string) {
    scheduleBot(code);
    const room = store.getRoom(code);
    if (!room) return;
    for (const seat of room.seats)
      for (const id of connections.get(seat.id) ?? []) {
        io.sockets.sockets.get(id)?.emit('room:state', view(room, seat.id));
      }
  }
  function requireRoom(socket: Socket): { room: Room; playerId: string } {
    const session = socket.data.session as Session | undefined;
    if (!session) throw new RuleError('请先加入房间');
    const room = store.getRoom(session.roomCode);
    if (!room || !room.seats.some((s) => s.id === session.playerId))
      throw new RuleError('房间或座位已失效，请重新加入');
    return { room, playerId: session.playerId };
  }
  function transferHost(room: Room) {
    if (!online(room.hostId)) {
      const next = room.seats.find((s) => !s.bot && online(s.id));
      if (next && next.id !== room.hostId) {
        room.hostId = next.id;
        room.version++;
        store.saveRoom(room);
      }
    }
  }
  function attach(socket: Socket, session: Session) {
    const old = [...(connections.get(session.playerId) ?? [])];
    connections.set(session.playerId, new Set([socket.id]));
    socket.data.session = session;
    for (const id of old)
      if (id !== socket.id) {
        const previous = io.sockets.sockets.get(id);
        previous?.emit('session:replaced');
        previous?.disconnect(true);
      }
    const room = store.getRoom(session.roomCode)!;
    transferHost(room);
  }
  function detach(socket: Socket) {
    const session = socket.data.session as Session | undefined;
    if (!session) return;
    connections.get(session.playerId)?.delete(socket.id);
    if (!connections.get(session.playerId)?.size) connections.delete(session.playerId);
    delete socket.data.session;
    const room = store.getRoom(session.roomCode);
    if (room) transferHost(room);
    broadcast(session.roomCode);
  }
  function newCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    } while (store.getRoom(code));
    return code;
  }
  // A socket has a small burst budget. No asynchronous work is performed between
  // reading state and committing it: room transitions are serialized by Node.
  io.on('connection', (socket) => {
    let budget = 30,
      lastRefill = Date.now();
    const handle = (event: string, operation: (raw: unknown) => Reply) => {
      socket.on(event, (raw: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        try {
          const now = Date.now();
          budget = Math.min(30, budget + (now - lastRefill) / 200);
          lastRefill = now;
          if (budget < 1) throw new RuleError('操作过于频繁，请稍候');
          budget--;
          (ack as (reply: Reply) => void)(operation(raw));
        } catch (error) {
          if (!(error instanceof RuleError)) console.error('Room operation failed:', error);
          (ack as (reply: Reply) => void)({
            ok: false,
            error: error instanceof RuleError ? error.message : '操作未完成，请重试',
          });
        }
      });
    };
    handle('room:create', (raw) => {
      if (socket.data.session) throw new RuleError('请先离开当前房间');
      const parsed = createSchema.safeParse(raw);
      if (!parsed.success) throw new RuleError('请输入 1～16 个字的昵称');
      const playerId = randomUUID(),
        token = randomBytes(32).toString('hex');
      const room: Room = {
        code: newCode(),
        hostId: playerId,
        version: 0,
        status: 'waiting',
        seats: [{ id: playerId, name: parsed.data.name, ready: false }],
        game: null,
      };
      const session = { playerId, roomCode: room.code };
      store.transaction(() => {
        store.saveRoom(room);
        store.addSession(token, session);
      });
      attach(socket, session);
      return { ok: true, token, room: view(store.getRoom(room.code)!, playerId) };
    });
    handle('room:join', (raw) => {
      if (socket.data.session) throw new RuleError('请先离开当前房间');
      const parsed = joinSchema.safeParse(raw);
      if (!parsed.success) throw new RuleError('请输入昵称和 6 位房间码');
      const room = store.getRoom(parsed.data.code);
      if (!room) throw new RuleError('没有找到这个房间，请检查房间码');
      if (room.status !== 'waiting') throw new RuleError('这局游戏已经开始，请等待下一局');
      if (room.seats.length >= 4) throw new RuleError('房间已满');
      if (room.seats.some((s) => s.name === parsed.data.name))
        throw new RuleError('房间内已有这个昵称，请换一个');
      const playerId = randomUUID(),
        token = randomBytes(32).toString('hex');
      room.seats.push({ id: playerId, name: parsed.data.name, ready: false });
      room.version++;
      const session = { playerId, roomCode: room.code };
      store.transaction(() => {
        store.saveRoom(room);
        store.addSession(token, session);
      });
      attach(socket, session);
      broadcast(room.code);
      return { ok: true, token, room: view(store.getRoom(room.code)!, playerId) };
    });
    handle('room:resume', (raw) => {
      if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw))
        throw new RuleError('座位凭证无效，请重新加入');
      const session = store.session(raw);
      if (!session) throw new RuleError('原座位已失效，请重新加入');
      if (socket.data.session) detach(socket);
      attach(socket, session);
      broadcast(session.roomCode);
      return { ok: true, room: view(store.getRoom(session.roomCode)!, session.playerId) };
    });
    handle('room:sync', () => {
      const { room, playerId } = requireRoom(socket);
      return { ok: true, room: view(room, playerId) };
    });
    handle('room:command', (raw) => {
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) throw new RuleError('操作格式无效');
      const { room, playerId } = requireRoom(socket);
      const { command, actionId, version } = parsed.data;
      if (store.hasCommand(room.code, playerId, actionId))
        return { ok: true, room: view(room, playerId) };
      if (version !== room.version)
        return { ok: false, error: '棋盘已更新，请重新操作', room: view(room, playerId) };
      const self = room.seats.find((s) => s.id === playerId)!;
      const requireHost = () => {
        if (room.hostId !== playerId) throw new RuleError('只有房主可以执行此操作');
      };
      switch (command.type) {
        case 'addBot': {
          requireHost();
          if (room.status !== 'waiting') throw new RuleError('只能在等待房间中添加 AI');
          if (room.seats.length >= 4) throw new RuleError('房间已满');
          let number = 1;
          while (room.seats.some((s) => s.name === `AI 商人 ${number}`)) number++;
          room.seats.push({ id: randomUUID(), name: `AI 商人 ${number}`, ready: true, bot: true });
          break;
        }
        case 'removeBot':
          requireHost();
          if (room.status !== 'waiting') throw new RuleError('只能在等待房间中移除 AI');
          if (!room.seats.some((s) => s.id === command.playerId && s.bot))
            throw new RuleError('这不是 AI 座位');
          room.seats = room.seats.filter((s) => s.id !== command.playerId);
          break;
        case 'ready':
          if (room.status !== 'waiting') throw new RuleError('游戏已开始');
          self.ready = command.ready;
          break;
        case 'start':
          requireHost();
          if (room.status !== 'waiting') throw new RuleError('游戏已开始');
          if (room.seats.length < 2 || !room.seats.every((s) => s.ready && (s.bot || online(s.id))))
            throw new RuleError('需要至少两位玩家，且所有人在线并准备好');
          // Randomize seat order once at the start, keep it stable for the entire game.
          for (let i = room.seats.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [room.seats[i], room.seats[j]] = [room.seats[j], room.seats[i]];
          }
          room.game = createGame(room.seats, () => randomInt(0x100000000) / 0x100000000);
          room.status = 'playing';
          break;
        case 'action':
          if (room.status !== 'playing' || !room.game) throw new RuleError('当前没有进行中的对局');
          room.game = applyAction(room.game, playerId, command.action);
          if (room.game.phase === 'finished') room.status = 'finished';
          break;
        case 'end':
          requireHost();
          if (room.status !== 'playing' || !room.game) throw new RuleError('当前没有进行中的对局');
          room.game.phase = 'finished';
          room.game.winners = [];
          room.game.log.push({ id: ++room.game.logSequence, text: '房主结束了本局游戏' });
          room.status = 'finished';
          break;
        case 'rematch':
          requireHost();
          if (room.status !== 'finished') throw new RuleError('请先完成当前对局');
          room.status = 'waiting';
          room.game = null;
          room.seats.forEach((s) => {
            s.ready = !!s.bot;
          });
          break;
        case 'kick':
          requireHost();
          if (room.status !== 'waiting') throw new RuleError('只能在等待房间中移除离线玩家');
          if (command.playerId === playerId || online(command.playerId))
            throw new RuleError('只能移除离线玩家');
          if (!room.seats.some((s) => s.id === command.playerId))
            throw new RuleError('座位已不存在');
          room.seats = room.seats.filter((s) => s.id !== command.playerId);
          break;
        case 'leave':
          if (room.status === 'playing')
            throw new RuleError('对局中请保留座位；需要退出时请让房主结束本局');
          room.seats = room.seats.filter((s) => s.id !== playerId);
          if (!room.seats.some((s) => !s.bot)) room.seats = [];
          if (room.hostId === playerId && room.seats.length)
            room.hostId = (
              room.seats.find((s) => !s.bot && online(s.id)) ?? room.seats.find((s) => !s.bot)!
            ).id;
          break;
      }
      room.version++;
      store.transaction(() => {
        if (!room.seats.length) {
          store.removeRoom(room.code);
          return;
        }
        store.saveRoom(room);
        store.recordCommand(room.code, playerId, actionId);
        if (command.type === 'leave') store.removeSeat(room.code, playerId);
        if (command.type === 'kick') store.removeSeat(room.code, command.playerId);
      });
      if (command.type === 'leave') {
        detach(socket);
        return { ok: true, left: true };
      }
      broadcast(room.code);
      return { ok: true, room: view(room, playerId) };
    });
    socket.on('disconnect', () => detach(socket));
  });
  return {
    app,
    http,
    io,
    store,
    close: async () => {
      closing = true;
      for (const timer of botTimers.values()) clearTimeout(timer);
      botTimers.clear();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      store.close();
    },
  };
}
