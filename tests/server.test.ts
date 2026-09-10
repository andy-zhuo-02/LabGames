import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { Command, Reply, RoomView } from '../src/shared/types.js';

let service: ReturnType<typeof createApplication>;
let directory: string, base: string;
let sockets: Socket[] = [];
async function boot(botDelayMs = 25) {
  service = createApplication(join(directory, 'game.sqlite'), { botDelayMs });
  await new Promise<void>((resolve) => service.http.listen(0, '127.0.0.1', resolve));
  const address = service.http.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}
async function connect() {
  const socket = io(base, { autoConnect: false, reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  return socket;
}
const request = async (socket: Socket, event: string, data: unknown = {}): Promise<Reply> =>
  socket.timeout(2000).emitWithAck(event, data);
async function successful(socket: Socket, event: string, data: unknown = {}) {
  const reply = await request(socket, event, data);
  expect(reply.ok, reply.error).toBe(true);
  return reply;
}
async function command(socket: Socket, cmd: Command, actionId = randomUUID(), version?: number) {
  if (version === undefined) version = (await successful(socket, 'room:sync')).room!.version;
  return request(socket, 'room:command', { command: cmd, actionId, version });
}
async function game(count = 2) {
  const members: { socket: Socket; token: string; id: string }[] = [];
  let code = '';
  for (let i = 0; i < count; i++) {
    const socket = await connect();
    const reply = await successful(
      socket,
      i ? 'room:join' : 'room:create',
      i ? { name: `玩家${i}`, code } : { name: '玩家0' },
    );
    code = reply.room!.code;
    members.push({ socket, token: reply.token!, id: reply.room!.selfId });
  }
  for (const member of members)
    expect((await command(member.socket, { type: 'ready', ready: true })).ok).toBe(true);
  const start = await command(members[0].socket, { type: 'start' });
  expect(start.ok, start.error).toBe(true);
  return { members, room: start.room!, code };
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'splendor-test-'));
  await boot();
});
afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  sockets = [];
  await service.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('room and transport integration', () => {
  it('provides local health and network discovery without third-party services', async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.ok).toBe(true);
    expect(await health.json()).toMatchObject({ ok: true });
    const network = await fetch(`${base}/api/network`);
    expect(Array.isArray((await network.json()).addresses)).toBe(true);
  });
  it('requires valid nicknames, unique names and valid room codes', async () => {
    const a = await connect(),
      b = await connect();
    expect((await request(a, 'room:create', { name: '' })).ok).toBe(false);
    expect((await request(a, 'room:create', { name: 'x'.repeat(17) })).ok).toBe(false);
    const created = await successful(a, 'room:create', { name: '商人' });
    expect(created.room!.code).toMatch(/^[A-Z2-9]{6}$/);
    expect((await request(b, 'room:join', { name: '商人', code: created.room!.code })).ok).toBe(
      false,
    );
    expect((await request(b, 'room:join', { name: '商人2', code: 'AAAAAA' })).ok).toBe(false);
    const joined = await successful(b, 'room:join', {
      name: '商人2',
      code: created.room!.code.toLowerCase(),
    });
    expect(joined.room!.seats.length).toBe(2);
    expect((await command(b, { type: 'start' })).ok).toBe(false);
    expect((await command(a, { type: 'start' })).ok).toBe(false);
  });
  it('broadcasts consistent game state to four authenticated clients', async () => {
    const { members, room, code } = await game(4);
    const active = members.find((m) => m.id === room.game!.players[0].id)!;
    expect(
      (
        await command(active.socket, {
          type: 'action',
          action: { type: 'take', colors: ['red', 'blue', 'green'] },
        })
      ).ok,
    ).toBe(true);
    const views = await Promise.all(members.map((m) => successful(m.socket, 'room:sync')));
    expect(new Set(views.map((v) => v.room!.version)).size).toBe(1);
    expect(views.every((v) => v.room!.game!.currentPlayer === 1)).toBe(true);
    expect(views.every((v) => v.room!.game!.bank.red === 6)).toBe(true);
    const fifth = await connect();
    expect((await request(fifth, 'room:join', { name: '多余玩家', code })).ok).toBe(false);
  });
  it('rejects stolen player IDs, malicious payloads and unauthorized actions', async () => {
    const { members, room } = await game();
    const other = members.find((m) => m.id !== room.game!.players[0].id)!;
    expect(
      (
        await command(other.socket, {
          type: 'action',
          action: { type: 'take', colors: ['red', 'blue', 'green'] },
        })
      ).ok,
    ).toBe(false);
    const stranger = await connect();
    expect((await request(stranger, 'room:resume', members[0].id)).ok).toBe(false);
    expect((await request(stranger, 'room:resume', 'a'.repeat(64))).ok).toBe(false);
    expect(
      (
        await request(stranger, 'room:command', {
          actionId: randomUUID(),
          version: room.version,
          command: { type: 'end' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await request(members[0].socket, 'room:command', {
          actionId: randomUUID(),
          version: room.version,
          playerId: members[1].id,
          command: { type: 'end' },
        })
      ).ok,
    ).toBe(false);
    expect((await command(members[1].socket, { type: 'end' })).ok).toBe(false);
    expect((await command(members[0].socket, { type: 'leave' })).ok).toBe(false);
  });
  it('rejects stale commands and executes a repeated actionId exactly once', async () => {
    const { members, room } = await game();
    const active = members.find((m) => m.id === room.game!.players[0].id)!;
    const id = randomUUID(),
      cmd: Command = { type: 'action', action: { type: 'reserveDeck', tier: 3 } };
    const first = await command(active.socket, cmd, id, room.version);
    expect(first.ok).toBe(true);
    const duplicate = await command(active.socket, cmd, id, room.version);
    expect(duplicate.ok).toBe(true);
    expect(duplicate.room!.version).toBe(first.room!.version);
    expect(duplicate.room!.game!.players[0].reserved.length).toBe(1);
    const stale = await command(active.socket, cmd, randomUUID(), room.version);
    expect(stale.ok).toBe(false);
    expect(stale.room!.version).toBe(first.room!.version);
  });
  it('hides reserved cards in every other player projection and persists only token hashes', async () => {
    const { members, room } = await game();
    const active = members.find((m) => m.id === room.game!.players[0].id)!;
    const other = members.find((m) => m.id !== active.id)!;
    const own = await command(active.socket, {
      type: 'action',
      action: { type: 'reserveDeck', tier: 3 },
    });
    const hiddenCard = own.room!.game!.players[0].reserved[0]!;
    const opponent = await successful(other.socket, 'room:sync');
    expect(opponent.room!.game!.players[0].reserved).toEqual([null]);
    expect(JSON.stringify(opponent).includes(hiddenCard.id)).toBe(false);
    const rows = service.store.db.prepare('SELECT token_hash FROM sessions').all();
    for (const member of members) expect(JSON.stringify(rows)).not.toContain(member.token);
  });
  it('restores identity, hidden cards and deduplication records after a server restart', async () => {
    const { members, room } = await game();
    const active = members.find((m) => m.id === room.game!.players[0].id)!;
    const id = randomUUID(),
      cmd: Command = { type: 'action', action: { type: 'reserveDeck', tier: 2 } };
    const moved = await command(active.socket, cmd, id, room.version);
    const savedGame = moved.room!.game!;
    for (const member of members) member.socket.disconnect();
    await service.close();
    await boot();
    const reconnected = await connect();
    const resumed = await successful(reconnected, 'room:resume', active.token);
    expect(resumed.room!.selfId).toBe(active.id);
    expect(resumed.room!.game).toEqual(savedGame);
    const duplicate = await command(reconnected, cmd, id, room.version);
    expect(duplicate.ok).toBe(true);
    expect(duplicate.room!.game!.players[0].reserved.length).toBe(1);
  });
  it('transfers room ownership when the host disconnects and replaces duplicate tabs', async () => {
    const { members } = await game();
    members[0].socket.disconnect();
    let synced: Reply | undefined;
    await expect
      .poll(async () => {
        synced = await successful(members[1].socket, 'room:sync');
        return synced.room!.hostId;
      })
      .toBe(members[1].id);
    const newer = await connect();
    const replaced = new Promise<void>((resolve) =>
      members[1].socket.once('session:replaced', () => resolve()),
    );
    const resumed = await successful(newer, 'room:resume', members[1].token);
    await replaced;
    expect(resumed.room!.selfId).toBe(members[1].id);
    expect(resumed.room!.seats.find((s) => s.id === members[1].id)!.online).toBe(true);
  });
  it('ends a game, starts a rematch and lets players leave cleanly', async () => {
    const { members, code } = await game();
    const ended = await command(members[0].socket, { type: 'end' });
    expect(ended.room!.status).toBe('finished');
    expect(ended.room!.game!.winners).toEqual([]);
    const reset = await command(members[0].socket, { type: 'rematch' });
    expect(reset.room!.status).toBe('waiting');
    expect(reset.room!.seats.every((s) => !s.ready)).toBe(true);
    expect(reset.room!.game).toBeNull();
    expect((await command(members[1].socket, { type: 'leave' })).left).toBe(true);
    expect((await request(members[1].socket, 'room:resume', members[1].token)).ok).toBe(false);
    expect((await command(members[0].socket, { type: 'leave' })).left).toBe(true);
    expect(service.store.getRoom(code)).toBeUndefined();
  });
  it('rolls back state and command IDs together when a persistence transaction fails', () => {
    const room = {
      code: 'ABCDEF',
      hostId: 'a',
      version: 0,
      status: 'waiting' as const,
      seats: [{ id: 'a', name: 'a', ready: false }],
      game: null,
    };
    service.store.saveRoom(room);
    expect(() =>
      service.store.transaction(() => {
        service.store.saveRoom({ ...room, version: 99 });
        service.store.recordCommand(room.code, 'a', 'id');
        throw new Error('disk failure');
      }),
    ).toThrow('disk failure');
    expect(service.store.getRoom(room.code)!.version).toBe(0);
    expect(service.store.hasCommand(room.code, 'a', 'id')).toBe(false);
  });
  it('allows only the waiting-room host to remove an offline player', async () => {
    const host = await connect(),
      guest = await connect();
    const created = await successful(host, 'room:create', { name: '房主' });
    const joined = await successful(guest, 'room:join', { name: '好友', code: created.room!.code });
    const guestId = joined.room!.selfId;
    expect((await command(host, { type: 'kick', playerId: guestId })).ok).toBe(false);
    expect((await command(guest, { type: 'kick', playerId: created.room!.selfId })).ok).toBe(false);
    guest.disconnect();
    await expect
      .poll(
        async () =>
          (await successful(host, 'room:sync')).room!.seats.find((s) => s.id === guestId)!.online,
      )
      .toBe(false);
    const kicked = await command(host, { type: 'kick', playerId: guestId });
    expect(kicked.ok).toBe(true);
    expect(kicked.room!.seats.length).toBe(1);
    const returning = await connect();
    expect((await request(returning, 'room:resume', joined.token)).ok).toBe(false);
  });
});

describe('AI room lifecycle', () => {
  it('restricts AI management to the host and respects capacity and human seats', async () => {
    const host = await connect(),
      guest = await connect();
    const created = await successful(host, 'room:create', { name: '房主' });
    await successful(guest, 'room:join', { name: '好友', code: created.room!.code });
    expect((await command(guest, { type: 'addBot' })).ok).toBe(false);
    const first = await command(host, { type: 'addBot' });
    expect(first.ok).toBe(true);
    const bot = first.room!.seats.find((s) => s.bot)!;
    expect(bot).toMatchObject({ ready: true, online: true });
    expect((await command(host, { type: 'addBot' })).ok).toBe(true);
    expect((await command(host, { type: 'addBot' })).ok).toBe(false);
    expect((await command(guest, { type: 'removeBot', playerId: bot.id })).ok).toBe(false);
    expect((await command(host, { type: 'removeBot', playerId: created.room!.selfId })).ok).toBe(
      false,
    );
    expect((await command(host, { type: 'removeBot', playerId: bot.id })).room!.seats.length).toBe(
      3,
    );
    expect(service.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n).toBe(2);
  });
  it('starts with one human, executes AI turns, and keeps AI ready for a rematch', async () => {
    const host = await connect();
    const created = await successful(host, 'room:create', { name: '独行商人' });
    const added = await command(host, { type: 'addBot' });
    const bot = added.room!.seats.find((s) => s.bot)!;
    await command(host, { type: 'ready', ready: true });
    const started = await command(host, { type: 'start' });
    expect(started.ok).toBe(true);
    if (started.room!.game!.players[0].id === created.room!.selfId) {
      expect(
        (
          await command(host, {
            type: 'action',
            action: { type: 'take', colors: ['white', 'blue', 'red'] },
          })
        ).ok,
      ).toBe(true);
    }
    await expect
      .poll(() => {
        const g = service.store.getRoom(created.room!.code)!.game!;
        return (
          g.players[g.currentPlayer].id === created.room!.selfId &&
          g.log.some((l) => l.text.startsWith(bot.name))
        );
      })
      .toBe(true);
    expect((await command(host, { type: 'removeBot', playerId: bot.id })).ok).toBe(false);
    expect((await command(host, { type: 'addBot' })).ok).toBe(false);
    await command(host, { type: 'end' });
    const reset = await command(host, { type: 'rematch' });
    expect(reset.room!.seats.find((s) => s.bot)!.ready).toBe(true);
    expect(reset.room!.seats.find((s) => !s.bot)!.ready).toBe(false);
    await command(host, { type: 'leave' });
    expect(service.store.getRoom(created.room!.code)).toBeUndefined();
  });
  it('pauses with no human connected and resumes an AI turn after a server restart', async () => {
    const host = await connect();
    const created = await successful(host, 'room:create', { name: '暂停测试' });
    const added = await command(host, { type: 'addBot' });
    const botId = added.room!.seats.find((s) => s.bot)!.id;
    await command(host, { type: 'ready', ready: true });
    await command(host, { type: 'start' });
    const room = service.store.getRoom(created.room!.code)!;
    room.game!.currentPlayer = room.game!.players.findIndex((p) => p.id === botId);
    service.store.saveRoom(room);
    host.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.store.getRoom(room.code)!.game).toEqual(room.game);
    await service.close();
    await boot();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.store.getRoom(room.code)!.game).toEqual(room.game);
    const returned = await connect();
    const resumed = await successful(returned, 'room:resume', created.token);
    expect(resumed.room!.hostId).toBe(created.room!.selfId);
    expect(resumed.room!.seats.find((s) => s.id === botId)!.bot).toBe(true);
    await expect
      .poll(() => service.store.getRoom(room.code)!.game!.log.length)
      .toBeGreaterThan(room.game!.log.length);
  });
  it('cancels pending AI work after ending a game and never transfers ownership to a bot', async () => {
    const host = await connect(),
      guest = await connect();
    const created = await successful(host, 'room:create', { name: '房主' });
    await command(host, { type: 'addBot' });
    const joined = await successful(guest, 'room:join', { name: '好友', code: created.room!.code });
    await command(host, { type: 'ready', ready: true });
    await command(guest, { type: 'ready', ready: true });
    await command(host, { type: 'start' });
    const ended = await command(host, { type: 'end' });
    const savedGame = service.store.getRoom(created.room!.code)!.game;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.store.getRoom(created.room!.code)!.game).toEqual(savedGame);
    expect(service.store.getRoom(created.room!.code)!.version).toBe(ended.room!.version);
    host.disconnect();
    await expect
      .poll(async () => (await successful(guest, 'room:sync')).room!.hostId)
      .toBe(joined.room!.selfId);
  });
});
