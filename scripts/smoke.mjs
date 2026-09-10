import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const base = process.env.BASE_URL ?? 'http://localhost:3000';
const clients = [];
async function request(client, event, data = {}) {
  const reply = await client.timeout(4000).emitWithAck(event, data);
  assert.equal(reply.ok, true, reply.error);
  return reply;
}
async function command(client, value) {
  const { room } = await request(client, 'room:sync');
  return request(client, 'room:command', {
    actionId: randomUUID(),
    version: room.version,
    command: value,
  });
}
async function connect() {
  const client = io(base, { reconnection: false, autoConnect: false });
  clients.push(client);
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
    client.connect();
  });
  return client;
}
let joined = false;
try {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('璀璨宝石'));
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((m) => m[1]);
  assert.ok(
    assets.some((path) => path.endsWith('.js')),
    'A production JavaScript asset must be served',
  );
  for (const path of [...assets, '/gem.svg', '/fonts.css']) {
    const asset = await fetch(new URL(path, base));
    assert.equal(asset.status, 200, path);
    assert.ok(!asset.headers.get('content-type').includes('text/html'), path);
  }
  console.log(`Production page and ${assets.length + 2} local assets: OK`);
  const a = await connect(),
    b = await connect();
  const created = await request(a, 'room:create', { name: '验收甲' });
  await request(b, 'room:join', { name: '验收乙', code: created.room.code });
  joined = true;
  await command(a, { type: 'ready', ready: true });
  await command(b, { type: 'ready', ready: true });
  const started = await command(a, { type: 'start' });
  const actor = started.room.game.players[0].id === created.room.selfId ? a : b;
  const action = await command(actor, {
    type: 'action',
    action: { type: 'take', colors: ['white', 'blue', 'red'] },
  });
  assert.equal(action.room.game.currentPlayer, 1);
  const { room } = await request(actor === a ? b : a, 'room:sync');
  assert.equal(room.version, action.room.version);
  assert.equal(room.game.bank.white, 3);
  console.log('Two production clients: create, join, ready, start, take, synchronize: OK');
} finally {
  if (joined) {
    try {
      const { room } = await request(clients[0], 'room:sync');
      if (room.status === 'playing') await command(clients[0], { type: 'end' });
      await command(clients[1], { type: 'leave' });
      await command(clients[0], { type: 'leave' });
    } catch (error) {
      console.error('Test-room cleanup:', error.message);
    }
  }
  for (const client of clients) client.disconnect();
}
