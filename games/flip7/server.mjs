import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RoomService, RoomError } from "./src/rooms.js";

const files = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/network.js", ["web/network.js", "text/javascript; charset=utf-8"]],
  ["/danmaku.js", ["web/danmaku.js", "text/javascript; charset=utf-8"]],
  [
    "/presentation.js",
    ["web/presentation.js", "text/javascript; charset=utf-8"],
  ],
  ["/card-art.js", ["web/card-art.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
  ["/src/game.js", ["src/game.js", "text/javascript; charset=utf-8"]],
  ["/src/applause.js", ["src/applause.js", "text/javascript; charset=utf-8"]],
  ["/src/bot.js", ["src/bot.js", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["web/favicon.svg", "image/svg+xml"]],
]);
for (const asset of [
  "numbers-a",
  "numbers-b",
  "numbers-c",
  "modifiers",
  "actions",
  "flip7-logo",
])
  files.set(`/art/${asset}.png`, [`web/art/${asset}.png`, "image/png"]);

export function lanAddresses(port) {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((a) => a && a.family === "IPv4" && !a.internal)
        .map((a) => `http://${a.address}:${port}`),
    ),
  ];
}
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
    if (size > 16_384) throw new RoomError(413, "请求内容过长");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new RoomError(400, "JSON 请求格式不正确");
  }
}
export function createApp({ rooms = new RoomService() } = {}) {
  const streams = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (
          req.headers.origin &&
          new URL(req.headers.origin).host !== req.headers.host
        )
          throw new RoomError(403, "不接受跨站房间请求");
        if (url.pathname === "/api/health" && req.method === "GET")
          return json(res, 200, {
            ok: true,
            version: "0.2.0",
            mode: "solo+lan",
          });
        if (url.pathname === "/api/network" && req.method === "GET")
          return json(res, 200, {
            addresses: lanAddresses(server.address().port),
          });
        if (url.pathname === "/api/rooms" && req.method === "POST") {
          const input = await body(req);
          return json(
            res,
            201,
            await rooms.create(input.name, { cardTracker: input.cardTracker }),
          );
        }
        const match =
          /^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|commands|events|danmaku))?$/.exec(
            url.pathname,
          );
        if (!match) throw new RoomError(404, "接口不存在");
        const [, code, route] = match;
        if (route === "join" && req.method === "POST")
          return json(res, 201, await rooms.join(code, (await body(req)).name));
        const credential = /^Bearer (.+)$/.exec(
          req.headers.authorization || "",
        )?.[1];
        const { member } = rooms.authenticate(code, credential);
        if (!route && req.method === "GET")
          return json(res, 200, rooms.snapshot(code, member.id));
        if (route === "commands" && req.method === "POST")
          return json(
            res,
            200,
            await rooms.command(code, credential, await body(req)),
          );
        if (route === "danmaku" && req.method === "POST")
          return json(
            res,
            200,
            await rooms.sendDanmaku(code, credential, await body(req)),
          );
        if (route === "events" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
          streams.add(res);
          const sendEvent = (value, event = "") => {
            if (res.destroyed) return;
            // Bound slow clients instead of buffering an entire match in memory.
            if (res.writableLength > 256_000) {
              res.destroy();
              return;
            }
            res.write(
              `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`,
            );
          };
          const unsubscribe = rooms.subscribe(
            code,
            credential,
            (snapshot) => sendEvent(snapshot),
            (message) => {
              if (url.searchParams.get("danmaku") === "1")
                sendEvent(message, "danmaku");
            },
          );
          const heartbeat = setInterval(
            () => res.write(": keepalive\n\n"),
            10_000,
          );
          heartbeat.unref?.();
          res.on("close", () => {
            clearInterval(heartbeat);
            streams.delete(res);
            unsubscribe();
          });
          return;
        }
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
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error.status || 500, {
        error: error.status
          ? error.message
          : "服务暂时无法完成请求，请稍后重试",
      });
    }
  });
  server.rooms = rooms;
  server.stop = async () => {
    for (const stream of streams) stream.end();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rooms.close();
  };
  return server;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const port = Number(process.env.PORT || 3007);
  const host = process.env.HOST || "0.0.0.0";
  const rooms = await new RoomService({
    file:
      process.env.FLIP7_DATA_FILE ||
      fileURLToPath(new URL("./data/rooms.json", import.meta.url)),
  }).init();
  const server = createApp({ rooms });
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `端口 ${port} 已被占用，请用 PORT=其他端口 ./start.sh 启动。`
        : error.message,
    );
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(
      `\n  FLIP 7 · 七连翻\n  本机 http://localhost:${server.address().port}`,
    );
    if (host === "0.0.0.0")
      for (const address of lanAddresses(server.address().port))
        console.log(`  局域网 ${address}`);
    console.log("  单人 / 多人房间 · Ctrl+C 停止\n");
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void server.stop().then(() => process.exit(0));
    });
}
