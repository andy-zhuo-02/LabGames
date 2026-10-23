import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RoomError, RoomService } from "./src/rooms.js";

const files = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["web/favicon.svg", "image/svg+xml"]],
  ["/src/game.js", ["src/game.js", "text/javascript; charset=utf-8"]],
  ["/src/bot.js", ["src/bot.js", "text/javascript; charset=utf-8"]],
  ["/src/clock.js", ["src/clock.js", "text/javascript; charset=utf-8"]],
]);
const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new RoomError(415, "请使用 JSON 请求");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new RoomError(413, "请求内容过长");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new RoomError(400, "请求格式不正确");
  }
}
export function lanAddresses(port) {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((a) => a?.family === "IPv4" && !a.internal)
        .map((a) => `http://${a.address}:${port}`),
    ),
  ];
}
export function createApp({ rooms = new RoomService(), autoTick = true } = {}) {
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.origin) {
          let origin;
          try {
            origin = new URL(req.headers.origin).host;
          } catch {
            /* invalid origin */
          }
          if (origin !== req.headers.host)
            throw new RoomError(403, "不接受跨站房间请求");
        }
        if (url.pathname === "/api/health" && req.method === "GET")
          return json(res, 200, { ok: true, game: "quoridor" });
        if (url.pathname === "/api/network" && req.method === "GET")
          return json(res, 200, {
            addresses: lanAddresses(server.address().port),
          });
        if (url.pathname === "/api/rooms" && req.method === "POST")
          return json(res, 201, rooms.create(await body(req)));
        const match =
          /^\/api\/rooms\/([A-F0-9]{6})(?:\/(join|commands))?$/.exec(
            url.pathname,
          );
        if (!match) throw new RoomError(404, "接口不存在");
        const [, code, route] = match;
        if (route === "join" && req.method === "POST")
          return json(res, 201, rooms.join(code, await body(req)));
        const token = /^Bearer (.+)$/.exec(
          req.headers.authorization || "",
        )?.[1];
        if (!route && req.method === "GET")
          return json(res, 200, rooms.snapshot(code, token));
        if (route === "commands" && req.method === "POST")
          return json(res, 200, rooms.command(code, token, await body(req)));
        throw new RoomError(405, "请求方法不支持");
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const entry = files.get(url.pathname);
      if (!entry) {
        res.writeHead(404).end("Not found");
        return;
      }
      const content = await readFile(new URL(entry[0], import.meta.url));
      res.writeHead(200, {
        "Content-Type": entry[1],
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!error.status) console.error(error);
      json(res, error.status || 500, {
        error: error.status ? error.message : "服务暂时不可用，请稍后重试",
      });
    }
  });
  const timer = autoTick
    ? setInterval(() => {
        try {
          rooms.tick();
        } catch (e) {
          console.error("电脑行动失败：", e.message);
        }
      }, 400)
    : null;
  timer?.unref();
  server.rooms = rooms;
  server.stop = async () => {
    clearInterval(timer);
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rooms.save();
  };
  return server;
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const port = Number(process.env.PORT || 3009),
    host = process.env.HOST || "0.0.0.0";
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口必须为 1～65535 的整数");
  const file =
    process.env.QUORIDOR_DATA_FILE ||
    fileURLToPath(new URL("./data/rooms.json", import.meta.url));
  const server = createApp({ rooms: new RoomService({ file }) });
  server.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`步步为营 → http://localhost:${port}`);
    if (host !== "127.0.0.1")
      for (const address of lanAddresses(port))
        console.log(`同一网络的朋友可打开：${address}`);
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await server.stop();
      process.exit(0);
    });
}
