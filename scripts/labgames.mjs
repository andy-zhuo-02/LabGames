import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const games = {
  poker: { name: "德州扑克", port: 8765, file: "server.mjs" },
  splendor: {
    name: "璀璨宝石",
    port: 3000,
    file: "dist-server/server/index.js",
  },
  flip7: { name: "七连翻", port: 3007, file: "server.mjs" },
};
const [command = "start", selection = "all", ...extra] = process.argv.slice(2);
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error("LabGames 需要 Node.js 22.13 或更新版本。");
  process.exit(1);
}
if (
  !["start", "dev", "doctor"].includes(command) ||
  (selection !== "all" && !Object.hasOwn(games, selection))
) {
  console.error(
    "用法：npm start -- [poker|splendor|flip7|all]；npm run dev -- [游戏]；npm run doctor",
  );
  process.exit(1);
}
const selected = selection === "all" ? Object.keys(games) : [selection];
const require = createRequire(import.meta.url);
try {
  for (const pkg of ["qrcode", "tsx", "vite", "react", "socket.io"])
    require.resolve(pkg);
} catch {
  console.error("依赖尚未安装，请在仓库根目录运行 npm install。");
  process.exit(1);
}
if (command === "doctor") {
  console.log(
    `Node.js ${process.versions.node} · 依赖已就绪\n三个游戏共用 Node.js 和 npm，无需 Python、Conda 或 pnpm。`,
  );
  for (const [id, game] of Object.entries(games))
    console.log(`${game.name}：npm start -- ${id}`);
  process.exit(0);
}
if (selection === "all" && extra.length) {
  console.error(
    "额外参数只能用于单个游戏。多游戏端口请用 POKER_PORT、SPLENDOR_PORT、FLIP7_PORT 设置。",
  );
  process.exit(1);
}
const ports = selected.map((id) =>
  Number(
    process.env[`${id.toUpperCase()}_PORT`] ??
      (selected.length === 1 ? process.env.PORT : undefined) ??
      games[id].port,
  ),
);
if (
  ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535) ||
  new Set(ports).size !== ports.length
) {
  console.error("游戏端口必须为不同的 1～65535 整数。");
  process.exit(1);
}
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 8000);
  force.unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
function run(args, cwd, env = process.env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
    children.add(child);
    child.on("error", fail);
    child.on("exit", (code) => {
      children.delete(child);
      if (code === 0) done();
      else fail(new Error(`命令退出，状态码 ${code}`));
    });
  });
}
try {
  if (selected.includes("splendor") && command === "start") {
    console.log("正在构建璀璨宝石…");
    const npm = process.env.npm_execpath;
    if (!npm)
      throw new Error("请通过 npm start 启动，以便调用项目的构建工具。");
    await run([npm, "run", "build", "--workspace", "games/splendor"], root);
  }
  if (!stopping) {
    for (const [index, id] of selected.entries()) {
      const game = games[id],
        cwd = resolve(root, "games", id),
        env = {
          ...process.env,
          PORT: String(ports[index]),
          HOST: process.env.HOST || "0.0.0.0",
        };
      const args =
        command === "dev"
          ? id === "splendor"
            ? [
                require.resolve("tsx/cli"),
                "watch",
                "src/server/index.ts",
                "--dev",
              ]
            : ["--watch", game.file]
          : [game.file];
      console.log(`${game.name} → http://localhost:${ports[index]}`);
      void run([...args, ...extra], cwd, env).then(
        () => {
          if (!stopping) {
            console.error(
              `${game.name}服务已退出，正在停止本次启动的其他游戏。`,
            );
            stop(1);
          }
        },
        (e) => {
          if (!stopping) {
            console.error(`${game.name}：${e.message}`);
            stop(1);
          }
        },
      );
    }
    console.log("按 Ctrl+C 统一停止本次启动的游戏。");
  }
} catch (e) {
  if (!stopping) {
    console.error(e.message);
    stop(1);
  }
}
