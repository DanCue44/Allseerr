import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Rgb } from '@server/utils/accentColor';
import {
  DEFAULT_ACCENT_COLOR,
  accentColorCss,
  contrastRatio,
  deriveAccentShades,
  isDefaultAccentColor,
  normalizeHexColor,
  parseHexColor,
} from '@server/utils/accentColor';

const GROUND: Rgb = [32, 33, 36];

const assertClose = (actual: Rgb, expected: Rgb, tolerance = 4) => {
  actual.forEach((channel, i) => {
    assert.ok(
      Math.abs(channel - expected[i]) <= tolerance,
      `expected ${actual.join(' ')} to be close to ${expected.join(' ')}`
    );
  });
};

describe('parseHexColor', () => {
  it('reads six and three digit colors, with or without #', () => {
    assert.deepEqual(parseHexColor('#EC703E'), [236, 112, 62]);
    assert.deepEqual(parseHexColor('ec703e'), [236, 112, 62]);
    assert.deepEqual(parseHexColor('#fff'), [255, 255, 255]);
  });

  it('rejects anything else', () => {
    assert.equal(parseHexColor(''), undefined);
    assert.equal(parseHexColor(null), undefined);
    assert.equal(parseHexColor('#12345'), undefined);
    assert.equal(parseHexColor('red'), undefined);
    assert.equal(parseHexColor('#gggggg'), undefined);
    assert.equal(parseHexColor('#ec703e;}body{'), undefined);
  });
});

describe('normalizeHexColor', () => {
  it('returns uppercase #RRGGBB', () => {
    assert.equal(normalizeHexColor('ec703e'), '#EC703E');
    assert.equal(normalizeHexColor('#abc'), '#AABBCC');
    assert.equal(normalizeHexColor('nope'), undefined);
  });

  it('treats an empty or stock color as the default', () => {
    assert.equal(isDefaultAccentColor(''), true);
    assert.equal(isDefaultAccentColor('#ec703e'), true);
    assert.equal(isDefaultAccentColor('#4F8EF7'), false);
  });
});

describe('deriveAccentShades', () => {
  it('reproduces the stock accent family from the stock orange', () => {
    const shades = deriveAccentShades(DEFAULT_ACCENT_COLOR);
    assert.ok(shades);
    assert.deepEqual(shades.accent, [236, 112, 62]);
    assertClose(shades.soft, [247, 176, 145]);
    assertClose(shades.strong, [214, 96, 50]);
    assertClose(shades.deep, [176, 74, 36]);
  });

  it('orders the shades from light to dark', () => {
    const shades = deriveAccentShades('#4F8EF7');
    assert.ok(shades);
    const lightness = (rgb: Rgb) => rgb.reduce((a, b) => a + b, 0);
    assert.ok(lightness(shades.soft) > lightness(shades.accent));
    assert.ok(lightness(shades.accent) > lightness(shades.strong));
    assert.ok(lightness(shades.strong) > lightness(shades.deep));
  });

  it('lifts a dark color so ground colored text on it stays readable', () => {
    for (const color of ['#101010', '#1A0F5C', '#5A1010', '#000000']) {
      const shades = deriveAccentShades(color);
      assert.ok(shades);
      assert.ok(
        contrastRatio(shades.accent, GROUND) >= 4.5,
        `${color} gave ${shades.accent.join(' ')}`
      );
    }
  });

  it('keeps a color that is already readable', () => {
    assert.deepEqual(deriveAccentShades('#4F8EF7')?.accent, [79, 142, 247]);
  });

  it('returns nothing for an invalid color', () => {
    assert.equal(deriveAccentShades('blue'), undefined);
  });
});

describe('accentColorCss', () => {
  it('overrides every accent variable while a palette is set', () => {
    const css = accentColorCss('#4F8EF7');
    assert.ok(css?.startsWith(':root[data-palette],:root [data-palette]{'));
    for (const name of [
      '--as-accent:',
      '--as-accent-soft:',
      '--as-accent-strong:',
      '--as-accent-deep:',
    ]) {
      assert.ok(css?.includes(name), name);
    }
    assert.ok(css?.includes('--as-accent:79 142 247;'));
  });

  it('emits nothing for an invalid color', () => {
    assert.equal(accentColorCss('</style><script>'), undefined);
  });
});
