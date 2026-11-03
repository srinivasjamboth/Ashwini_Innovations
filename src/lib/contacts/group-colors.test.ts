import { describe, expect, it } from 'vitest';
import {
  GROUP_COLORS,
  defaultGroupColor,
  folderToneVars,
  groupColorDef,
  isGroupColorKey,
  resolveGroupColor,
} from './group-colors';

const HEX_RE = /^#[0-9a-f]{6}$/i;

describe('GROUP_COLORS', () => {
  it('defines ten shades with unique keys and six explicit hex tones each', () => {
    expect(GROUP_COLORS).toHaveLength(10);
    expect(new Set(GROUP_COLORS.map((c) => c.key)).size).toBe(10);
    for (const def of GROUP_COLORS) {
      for (const tones of [def.light, def.dark]) {
        expect(HEX_RE.test(tones.back)).toBe(true);
        expect(HEX_RE.test(tones.front)).toBe(true);
        expect(HEX_RE.test(tones.tab)).toBe(true);
      }
    }
  });
});

describe('defaultGroupColor', () => {
  it('is deterministic for the same id', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(defaultGroupColor(id)).toBe(defaultGroupColor(id));
    expect(isGroupColorKey(defaultGroupColor(id))).toBe(true);
  });

  it('spreads distinct shades across a batch of ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) seen.add(defaultGroupColor(`group-id-${i}`));
    // A single hash bucket for 24 ids would mean the grid is monotone.
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe('resolveGroupColor', () => {
  it('prefers the stored key and falls back to the id default', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(resolveGroupColor('teal', id)).toBe('teal');
    expect(resolveGroupColor(null, id)).toBe(defaultGroupColor(id));
    expect(resolveGroupColor('nonsense', id)).toBe(defaultGroupColor(id));
    expect(resolveGroupColor(undefined, id)).toBe(defaultGroupColor(id));
  });
});

describe('folderToneVars', () => {
  it('emits both theme sets for the chosen shade', () => {
    const vars = folderToneVars('sea');
    expect(vars['--folder-back-l' as string]).toBe(groupColorDef('sea').light.back);
    expect(vars['--folder-front-d' as string]).toBe(groupColorDef('sea').dark.front);
    expect(vars['--folder-tab-l' as string]).toBe(groupColorDef('sea').light.tab);
  });
});
