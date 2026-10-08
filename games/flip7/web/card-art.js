// Exact viewports into the publisher-maintained Dized rulebook illustrations.
// Original PNGs are stored byte-for-byte; SVG viewBox selects a card at render time.
// See docs/ART_SOURCES.md for source URLs and attribution.
const sheet = (file, width, height) => ({
  file: `/art/${file}.png`,
  width,
  height,
});
const upper = sheet("numbers-a", 1329, 279);
const middle = sheet("numbers-b", 1327, 270);
const lower = sheet("numbers-c", 776, 272);
const modifiers = sheet("modifiers", 1312, 267);
const actions = sheet("actions", 782, 268);

export const CARD_ART = {};
function register(key, atlas, x, y, width = 165, height = 257) {
  CARD_ART[key] = { ...atlas, frame: [x, y, width, height] };
}
[12, 11, 10, 9, 8].forEach((n, i) =>
  register(`number-${n}`, upper, [10, 283, 555, 824, 1097][i], 9),
);
[7, 6, 5, 4, 3].forEach((n, i) =>
  register(`number-${n}`, middle, [8, 281, 553, 822, 1095][i], 5, 165, 256),
);
[2, 1, 0].forEach((n, i) =>
  register(`number-${n}`, lower, [7, 280, 552][i], 8),
);
[2, 4, 6, 8, 10].forEach((n, i) =>
  register(`add-${n}`, modifiers, [3, 220, 436, 653, 870][i], 5),
);
register("multiply", modifiers, 1087, 5, 164);
register("freeze", actions, 3, 6, 165, 256);
register("three", actions, 275, 6, 165, 256);
register("second", actions, 548, 6, 165, 256);

export const cardArtKey = (card) =>
  ["number", "add"].includes(card.kind)
    ? `${card.kind}-${card.value}`
    : card.kind;
export function cardArtwork(key) {
  const art = CARD_ART[key];
  if (!art) throw new Error(`Unknown card artwork: ${key}`);
  return `<svg class="card-art" viewBox="${art.frame.join(" ")}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><image href="${art.file}" width="${art.width}" height="${art.height}" /></svg>`;
}
