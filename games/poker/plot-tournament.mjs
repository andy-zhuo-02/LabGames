import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function plot_run(directory) {
  const summary = JSON.parse(readFileSync(join(directory, "summary.json")));
  const [header, ...lines] = readFileSync(join(directory, "stacks.csv"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  const rows = lines.map((row) => row.map(Number)),
    styles = header.slice(1);
  if (
    rows.length !== summary.hands_played + 1 ||
    rows.some(
      (row, i) =>
        row.length !== header.length ||
        row[0] !== i ||
        row.some((v) => !Number.isSafeInteger(v) || v < 0) ||
        row.slice(1).reduce((a, b) => a + b, 0) !== summary.total_chips,
    )
  )
    throw new Error("比赛记录不连续或筹码总量不守恒。");
  for (let seat = 1; seat < header.length; seat++) {
    let eliminated = false;
    for (const row of rows) {
      if (eliminated && row[seat]) throw new Error("淘汰后筹码应持续为零。");
      eliminated ||= row[seat] === 0;
    }
  }
  const colors = [
    "#355eaa",
    "#af6540",
    "#34826d",
    "#8960a6",
    "#a68021",
    "#c84e65",
    "#567989",
    "#4d4b85",
  ];
  const escape = (text) =>
    String(text).replace(
      /[<>&"']/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    );
  const svg = (selected) => {
    const x = (i) => 70 + (i / Math.max(1, summary.hands_played)) * 830,
      y = (v) => 460 - (v / summary.total_chips) * 390;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="980" height="580" viewBox="0 0 980 580"><rect width="980" height="580" fill="#faf8f2"/><g font-family="sans-serif" fill="#292d35"><text x="70" y="35" font-size="22">Poker · chips by hand</text><path d="M70 60V460H910" fill="none" stroke="#7d858e"/>${[0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="12" y="${y(f * summary.total_chips) + 5}" font-size="12">${Math.round(f * summary.total_chips)}</text><path d="M70 ${y(f * summary.total_chips)}H910" stroke="#dddddc"/>`).join("")}${selected.map((i) => `<path d="${rows.map((row, k) => (k ? `H${x(k)}V${y(row[i + 1])}` : `M${x(0)} ${y(row[i + 1])}`)).join(" ")}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2"/><text x="${70 + (i % 4) * 210}" y="${520 + Math.floor(i / 4) * 25}" fill="${colors[i % colors.length]}" font-size="14">${escape(styles[i])}</text>`).join("")}<text x="70" y="485">0</text><text x="840" y="485">${summary.hands_played} hands</text></g></svg>`;
  };
  writeFileSync(
    join(directory, "chip-curves.svg"),
    svg(styles.map((_, i) => i)),
  );
  styles.forEach((_, i) =>
    writeFileSync(join(directory, `chip-curves-seat-${i + 1}.svg`), svg([i])),
  );
  return summary;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (!process.argv[2])
      throw new Error("用法：node plot-tournament.mjs 比赛目录");
    plot_run(resolve(process.argv[2]));
    console.log("已生成总览与各玩家的 SVG 曲线，无需安装绘图库。");
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
