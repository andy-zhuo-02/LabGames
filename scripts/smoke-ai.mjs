import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const client = io(process.env.BASE_URL ?? 'http://localhost:3000', {
  autoConnect: false,
  reconnection: false,
});
let room;
function accept(next) {
  if (next && (!room || next.version >= room.version)) room = next;
}
client.on('room:state', accept);
async function request(event, data = {}) {
  const reply = await client.timeout(4000).emitWithAck(event, data);
  assert.equal(reply.ok, true, reply.error);
  accept(reply.room);
  return reply;
}
async function command(command) {
  await request('room:sync');
  return request('room:command', { actionId: randomUUID(), version: room.version, command });
}
try {
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
    client.connect();
  });
  await request('room:create', { name: 'AI 联机验收' });
  for (let i = 0; i < 3; i++) await command({ type: 'addBot' });
  assert.equal(room.seats.filter((s) => s.bot && s.ready && s.online).length, 3);
  await command({ type: 'ready', ready: true });
  await command({ type: 'start' });
  const bots = room.seats.filter((s) => s.bot).map((s) => s.id);
  const acted = () =>
    bots.every((id) => {
      const p = room.game.players.find((p) => p.id === id);
      return Object.values(p.tokens).some((n) => n > 0) || p.purchased.length || p.reserved.length;
    });
  const deadline = Date.now() + 12000;
  while (!acted() && Date.now() < deadline) {
    if (room.game.players[room.game.currentPlayer].id === room.selfId) {
      await command({ type: 'action', action: { type: 'take', colors: ['white', 'blue', 'red'] } });
    } else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(acted(), 'All three AI opponents must take their own legal turn');
  console.log(
    'Production AI: one human + three bots, ready, start, automatic turns and broadcast: OK',
  );
} finally {
  if (room && client.connected) {
    if (room.status === 'playing') await command({ type: 'end' });
    await command({ type: 'leave' });
  }
  client.disconnect();
}
