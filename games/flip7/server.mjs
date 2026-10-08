import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const files = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/card-art.js", ["web/card-art.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
  ["/src/game.js", ["src/game.js", "text/javascript; charset=utf-8"]],
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
]) {
  files.set(`/art/${asset}.png`, [`web/art/${asset}.png`, "image/png"]);
}

export function createApp() {
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({ ok: true, version: "0.1.0", mode: "solo" }),
      );
      return;
    }
    const entry = files.get(pathname);
    if (!entry) {
      res.writeHead(404).end("Not found");
      return;
    }
    try {
      const content = await readFile(new URL(entry[0], import.meta.url));
      res.writeHead(200, {
        "Content-Type": entry[1],
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      res.writeHead(500).end("Unable to load game file");
    }
  });
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const port = Number(process.env.PORT || 3007);
  const host = process.env.HOST || "127.0.0.1";
  const server = createApp();
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `端口 ${port} 已被占用，请用 PORT=其他端口 ./start.sh 启动。`
        : error.message,
    );
    process.exitCode = 1;
  });
  server.listen(port, host, () =>
    console.log(
      `\n  FLIP 7 · 七连翻\n  打开 http://localhost:${server.address().port}\n  单人对战电脑 · Ctrl+C 停止\n`,
    ),
  );
}
