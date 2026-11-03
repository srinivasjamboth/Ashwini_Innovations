// ============================================================
// Group folder colors — the ONE palette definition for the
// Groups-tab folder grid (spec PART 3).
//
// Ten shades, each with three explicit tones (back / front / tab)
// for light and dark themes. No tone is computed at runtime: the
// tile and the preview read these hex values directly, so a folder
// looks identical everywhere it appears.
//
// `color` on a group is a nullable palette KEY (stored as TEXT).
// Groups without one (all pre-existing rows) get a deterministic
// pick from their id, which spreads varied shades across the grid
// without touching the data.
// ============================================================

export type GroupColorKey =
  | 'sea'
  | 'teal'
  | 'green'
  | 'olive'
  | 'amber'
  | 'orange'
  | 'rose'
  | 'violet'
  | 'indigo'
  | 'slate';

export interface GroupColorTones {
  back: string;
  front: string;
  tab: string;
}

export interface GroupColorDef {
  key: GroupColorKey;
  /** Display name for the swatch tooltip / aria-label. */
  label: string;
  light: GroupColorTones;
  dark: GroupColorTones;
}

export const GROUP_COLORS: readonly GroupColorDef[] = [
  {
    key: 'sea',
    label: 'Sea Blue',
    light: { back: '#1e5aa8', front: '#2f6fc0', tab: '#164a8f' },
    dark: { back: '#17417c', front: '#1e5393', tab: '#123363' },
  },
  {
    key: 'teal',
    label: 'Teal',
    light: { back: '#0d7f80', front: '#12969a', tab: '#0a6a6b' },
    dark: { back: '#0b5456', front: '#0f6d6f', tab: '#084345' },
  },
  {
    key: 'green',
    label: 'Green',
    light: { back: '#1c7f4c', front: '#24965c', tab: '#166a3f' },
    dark: { back: '#145c38', front: '#1b7447', tab: '#0f4c2e' },
  },
  {
    key: 'olive',
    label: 'Olive',
    light: { back: '#6b7f24', front: '#7f9630', tab: '#586a1c' },
    dark: { back: '#4c5a1e', front: '#5f7226', tab: '#3d4a17' },
  },
  {
    key: 'amber',
    label: 'Amber',
    light: { back: '#b06f10', front: '#c9821b', tab: '#965c0c' },
    dark: { back: '#7c4f0f', front: '#96611a', tab: '#65400c' },
  },
  {
    key: 'orange',
    label: 'Orange',
    light: { back: '#c2500f', front: '#d9631f', tab: '#a5420b' },
    dark: { back: '#8a3d12', front: '#a64e1d', tab: '#71320e' },
  },
  {
    key: 'rose',
    label: 'Rose',
    light: { back: '#b03058', front: '#c74269', tab: '#952749' },
    dark: { back: '#7c2540', front: '#983252', tab: '#671e36' },
  },
  {
    key: 'violet',
    label: 'Violet',
    light: { back: '#6d3bb8', front: '#7e4ecd', tab: '#5b2f9c' },
    dark: { back: '#4d2b80', front: '#5f3a9c', tab: '#3f236a' },
  },
  {
    key: 'indigo',
    label: 'Indigo',
    light: { back: '#3949ab', front: '#4a5bc7', tab: '#2f3c91' },
    dark: { back: '#283477', front: '#334194', tab: '#1f2a63' },
  },
  {
    key: 'slate',
    label: 'Slate',
    light: { back: '#475569', front: '#5b6a7e', tab: '#3a4757' },
    dark: { back: '#333d4b', front: '#415062', tab: '#29323d' },
  },
] as const;

/** Keys accepted by the DB `color` CHECK + the app sanitizer. */
export const GROUP_COLOR_KEYS: readonly GroupColorKey[] = GROUP_COLORS.map(
  (c) => c.key
);

export function isGroupColorKey(value: unknown): value is GroupColorKey {
  return (
    typeof value === 'string' &&
    (GROUP_COLOR_KEYS as readonly string[]).includes(value)
  );
}

export function groupColorDef(key: GroupColorKey): GroupColorDef {
  const def = GROUP_COLORS.find((c) => c.key === key);
  // Every key in GROUP_COLOR_KEYS resolves — the find can only miss if
  // the config itself is broken, which the unit tests catch.
  return def ?? GROUP_COLORS[0];
}

/** Deterministic palette pick from the group id (FNV-1a over the hex
 *  chars). Stable across reloads/sessions — the same group always lands
 *  on the same shade, and a page of uncolored groups looks varied. */
export function defaultGroupColor(groupId: string): GroupColorKey {
  let hash = 0x811c9dc5;
  for (let i = 0; i < groupId.length; i++) {
    hash ^= groupId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length].key;
}

/** The color a group renders with: its chosen key, or the deterministic
 *  default when `color` is null / unknown. */
export function resolveGroupColor(
  color: string | null | undefined,
  groupId: string
): GroupColorKey {
  return isGroupColorKey(color) ? color : defaultGroupColor(groupId);
}

/** CSS custom properties for one folder, both theme sets; the
 *  `.group-folder` rules in globals.css pick light vs dark purely in
 *  CSS, so the SVG/divs never need to know the current mode (no flash,
 *  no hydration risk). */
export function folderToneVars(
  key: GroupColorKey
): React.CSSProperties & Record<string, string> {
  const def = groupColorDef(key);
  return {
    '--folder-back-l': def.light.back,
    '--folder-front-l': def.light.front,
    '--folder-tab-l': def.light.tab,
    '--folder-back-d': def.dark.back,
    '--folder-front-d': def.dark.front,
    '--folder-tab-d': def.dark.tab,
  } as React.CSSProperties & Record<string, string>;
}

/** Folders per grid page (spec PART 1). */
export const GROUP_PAGE_SIZE = 24;
