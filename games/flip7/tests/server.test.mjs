import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createApp } from "../server.mjs";
import { makeDeck } from "../src/game.js";
import { CARD_ART, cardArtKey } from "../web/card-art.js";

test("serves the game and modules; private files are not exposed", async (t) => {
  const server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, contentType] of [
    ["/", "text/html"],
    ["/app.js", "text/javascript"],
    ["/card-art.js", "text/javascript"],
    ["/src/game.js", "text/javascript"],
    ["/src/bot.js", "text/javascript"],
    ["/styles.css", "text/css"],
    ["/favicon.svg", "image/svg+xml"],
  ]) {
    const result = await fetch(base + path);
    assert.equal(result.status, 200);
    assert.ok(result.headers.get("content-type").startsWith(contentType));
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await result.text()).length > 30);
  }
  const manifest = JSON.parse(
    await readFile(
      new URL("../docs/art-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  for (const asset of manifest.assets) {
    const result = await fetch(`${base}/art/${asset.file}`);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-type"), "image/png");
    const png = Buffer.from(await result.arrayBuffer());
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(png.readUInt32BE(16), asset.width);
    assert.equal(png.readUInt32BE(20), asset.height);
    assert.equal(png.length, asset.bytes);
    assert.equal(createHash("sha256").update(png).digest("hex"), asset.sha256);
  }
  const cardKinds = new Set(makeDeck().map(cardArtKey));
  assert.equal(cardKinds.size, 22);
  assert.deepEqual(new Set(Object.keys(CARD_ART)), cardKinds);
  for (const key of cardKinds) {
    const art = CARD_ART[key];
    const asset = manifest.assets.find(
      (item) => `/art/${item.file}` === art.file,
    );
    assert.ok(asset, `${key} has a served original image`);
    assert.equal(art.width, asset.width);
    assert.equal(art.height, asset.height);
    const [x, y, width, height] = art.frame;
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
    assert.ok(x + width <= asset.width && y + height <= asset.height);
  }
  for (const path of [
    "/package.json",
    "/server.mjs",
    "/.git/config",
    "/%2e%2e/README.md",
    "/missing",
    "/art/missing.png",
    "/docs/art-manifest.json",
  ])
    assert.equal((await fetch(base + path)).status, 404);
  const health = await fetch(base + "/api/health");
  assert.deepEqual(await health.json(), {
    ok: true,
    version: "0.1.0",
    mode: "solo",
  });
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await fetch(base, { method: "POST" });
  assert.equal(post.status, 405);
});
