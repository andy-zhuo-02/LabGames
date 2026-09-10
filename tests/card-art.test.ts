import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARDS } from '../src/engine/data.js';
import art from '../src/web/card-art.json';
import photos from '../docs/card-photo-manifest.json';
import { COLORS } from '../src/shared/types.js';

describe('printed-card artwork matches the authoritative game data', () => {
  it('matches every card by tier, bonus, points and all five costs', () => {
    expect(Object.keys(art)).toHaveLength(90);
    expect(new Set(Object.values(art)).size).toBe(90);
    for (const card of CARDS) {
      const path = (art as Record<string, string>)[card.id];
      const photo = photos.find((p) => `/art/${p.image}` === path);
      expect(photo, card.id).toBeDefined();
      expect(photo!.level).toBe(card.tier);
      expect(photo!.bonus).toBe(card.bonus);
      expect(photo!.prestige_points).toBe(card.points);
      for (const c of COLORS) expect(photo!.cost[c] ?? 0).toBe(card.cost[c]);
    }
  });
  it('ships every referenced image locally at its original 630 × 880 size', () => {
    for (const path of Object.values(art)) {
      expect(path.startsWith('/art/cards/')).toBe(true);
      const png = readFileSync(resolve('public', path.slice(1)));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(630);
      expect(png.readUInt32BE(20)).toBe(880);
    }
  });
});
