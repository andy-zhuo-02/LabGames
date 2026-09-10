import express from 'express';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createApplication, lanAddresses } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须是 1～65535 的整数');
const dev = process.argv.includes('--dev');
const service = createApplication(resolve(process.env.DATA_DIR ?? 'data', 'splendor.sqlite'));
let closeVite: (() => Promise<void>) | undefined;
if (dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { server: service.http } },
    appType: 'spa',
  });
  service.app.use(vite.middlewares);
  closeVite = () => vite.close();
} else {
  const directory = resolve('dist');
  if (!existsSync(resolve(directory, 'index.html'))) throw new Error('请先运行 pnpm build');
  service.app.use(express.static(directory));
  service.app.get('/{*path}', (_req, res) => res.sendFile(resolve(directory, 'index.html')));
}
service.http.on('error', (error) => {
  console.error('启动失败：', error.message);
  process.exitCode = 1;
});
service.http.listen(port, '0.0.0.0', () => {
  console.log(`\n璀璨宝石 · 局域网联机\n本机：http://localhost:${port}`);
  for (const url of lanAddresses(port)) console.log(`局域网：${url}`);
  console.log('让其他玩家在同一网络中打开局域网地址。按 Ctrl+C 停止。\n');
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (closeVite) await closeVite();
  await service.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
