// Accent color helpers shared by the server and the interface. The Ambient
// skin reads its accent family from CSS variables holding space separated
// RGB channels, so everything here works in channels.

export const DEFAULT_ACCENT_COLOR = '#EC703E';

export type Rgb = [number, number, number];

export interface AccentShades {
  accent: Rgb;
  soft: Rgb;
  strong: Rgb;
  deep: Rgb;
}

// The charcoal ground; text on accent fills uses it, so the accent is kept
// light enough for that text to stay readable
const GROUND: Rgb = [32, 33, 36];
const MIN_CONTRAST = 4.5;

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parses #rgb or #rrggbb (the # is optional) into RGB channels. */
export const parseHexColor = (value?: string | null): Rgb | undefined => {
  const match = value?.trim().match(HEX_PATTERN);

  if (!match) {
    return undefined;
  }

  const hex =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : match[1];

  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
};

export const toHexColor = ([r, g, b]: Rgb): string =>
  `#${[r, g, b]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;

/** Returns the color as #RRGGBB, or undefined when it is not a hex color. */
export const normalizeHexColor = (
  value?: string | null
): string | undefined => {
  const rgb = parseHexColor(value);
  return rgb ? toHexColor(rgb) : undefined;
};

export const isDefaultAccentColor = (value?: string | null): boolean => {
  const normalized = normalizeHexColor(value);
  return !normalized || normalized === DEFAULT_ACCENT_COLOR;
};

type Hsl = [number, number, number];

const rgbToHsl = ([r, g, b]: Rgb): Hsl => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) {
    return [0, 0, l];
  }

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;

  if (max === rn) {
    h = ((gn - bn) / d) % 6;
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }

  return [(h * 60 + 360) % 360, s, l];
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const hslToRgb = ([h, s, l]: Hsl): Rgb => {
  const sat = clamp(s);
  const light = clamp(l);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let rgb: [number, number, number];

  if (h < 60) {
    rgb = [c, x, 0];
  } else if (h < 120) {
    rgb = [x, c, 0];
  } else if (h < 180) {
    rgb = [0, c, x];
  } else if (h < 240) {
    rgb = [0, x, c];
  } else if (h < 300) {
    rgb = [x, 0, c];
  } else {
    rgb = [c, 0, x];
  }

  return rgb.map((v) => Math.round((v + m) * 255)) as Rgb;
};

const channelLuminance = (channel: number) => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = ([r, g, b]: Rgb): number =>
  0.2126 * channelLuminance(r) +
  0.7152 * channelLuminance(g) +
  0.0722 * channelLuminance(b);

export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * Derives the accent family from one color, in the same proportions as the
 * stock orange: soft is lighter, strong and deep are darker and a little
 * less saturated. A color too dark for ground colored text on it is lifted
 * until that text is readable.
 */
export const deriveAccentShades = (
  value?: string | null
): AccentShades | undefined => {
  const rgb = parseHexColor(value);

  if (!rgb) {
    return undefined;
  }

  const [h, s, initialLightness] = rgbToHsl(rgb);
  let l = initialLightness;
  let accent = rgb;

  while (contrastRatio(accent, GROUND) < MIN_CONTRAST && l < 0.95) {
    l = Math.min(0.95, l + 0.02);
    accent = hslToRgb([h, s, l]);
  }

  return {
    accent,
    soft: hslToRgb([h, s, l + (1 - l) * 0.45]),
    strong: hslToRgb([h, s * 0.82, l * 0.89]),
    deep: hslToRgb([h, s * 0.8, l * 0.71]),
  };
};

const channels = (rgb: Rgb) => rgb.join(' ');

/**
 * CSS overriding the Ambient accent variables. It only applies while a
 * palette is on <html>, so the classic interface keeps its colors.
 */
export const accentColorCss = (value?: string | null): string | undefined => {
  const shades = deriveAccentShades(value);

  if (!shades) {
    return undefined;
  }

  return (
    // The Ambient shell sets data-palette on its own wrapper too, so the
    // override has to reach that element, not only the root
    `:root[data-palette],:root [data-palette]{` +
    `--as-accent:${channels(shades.accent)};` +
    `--as-accent-soft:${channels(shades.soft)};` +
    `--as-accent-strong:${channels(shades.strong)};` +
    `--as-accent-deep:${channels(shades.deep)};}`
  );
};
