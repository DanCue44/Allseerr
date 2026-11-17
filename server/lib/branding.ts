import { ALLSEERR_BRANCH, ALLSEERR_REPO } from '@server/constants/repository';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { Metadata, SharpOptions } from 'sharp';
import sharp from 'sharp';

export const DEFAULT_APPLICATION_TITLE = 'Allseerr';

// Allseerr logo for mail clients that cannot reach this server, a PNG since
// many of them do not show SVG images
const PUBLIC_ASSET_URL = `https://raw.githubusercontent.com/${ALLSEERR_REPO}/refs/heads/${ALLSEERR_BRANCH}/public`;
export const PUBLIC_LOGO_URL = `${PUBLIC_ASSET_URL}/logo_full.png`;
// The same wordmark with dark text, for mail apps in light mode
export const PUBLIC_LOGO_LIGHT_URL = `${PUBLIC_ASSET_URL}/logo_full_dark.png`;

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MIN_SIZE = 64;

// Width and height may differ by this much and still count as square; the
// generated icons center the logo either way
const SQUARE_TOLERANCE = 0.02;

export type LogoType = 'png' | 'webp' | 'svg';

export const LOGO_MIME_TYPES: Record<LogoType, string> = {
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export type LogoErrorCode =
  | 'INVALID_DATA'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'UNSAFE_SVG'
  | 'NOT_SQUARE'
  | 'TOO_SMALL';

export class LogoValidationError extends Error {
  constructor(
    public code: LogoErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LogoValidationError';
  }
}

// Theme color of the web manifest; fills icons that cannot be transparent
const ICON_BACKGROUND = { r: 32, g: 33, b: 36, alpha: 1 };

interface IconSpec {
  size: number;
  /** Placed on a solid background, scaled into the maskable safe zone. */
  maskable?: boolean;
  /** Flattened onto the background (iOS shows transparency as black). */
  opaque?: boolean;
}

/**
 * Icons generated from an uploaded logo. The names match the bundled files
 * in public/, which are served when no logo has been uploaded.
 */
export const ICON_SPECS = {
  'favicon-16x16.png': { size: 16 },
  'favicon-32x32.png': { size: 32 },
  'apple-touch-icon.png': { size: 180, opaque: true },
  'android-chrome-192x192.png': { size: 192 },
  'android-chrome-512x512.png': { size: 512 },
  'android-chrome-192x192_maskable.png': { size: 192, maskable: true },
  'android-chrome-512x512_maskable.png': { size: 512, maskable: true },
} satisfies Record<string, IconSpec>;

export type IconName = keyof typeof ICON_SPECS | 'favicon.ico';

export const ICON_NAMES = [
  ...Object.keys(ICON_SPECS),
  'favicon.ico',
] as IconName[];

export const isIconName = (name: string): name is IconName =>
  (ICON_NAMES as string[]).includes(name);

export const brandingDirectory = (): string =>
  path.join(appDataPath(), 'branding');

/** Works out the image type from the file contents, not the name. */
export const detectLogoType = (buffer: Buffer): LogoType | undefined => {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  // An SVG is text: an optional BOM, XML prolog, comments and doctype, then
  // the <svg> root element
  const head = buffer
    .toString('utf8', 0, Math.min(buffer.length, 4096))
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trimStart();

  if (/^<svg[\s>]/i.test(head)) {
    return 'svg';
  }

  return undefined;
};

// SVGs are shown as images, which never run scripts, but the original file
// is also reachable directly, so refuse anything that could act as a page
const UNSAFE_SVG_PATTERNS = [
  /<script/i,
  /<foreignObject/i,
  /<iframe/i,
  /<embed/i,
  /<object/i,
  /\son[a-z]+\s*=/i,
  /javascript:/i,
  /<!ENTITY/i,
];

export const isSafeSvg = (buffer: Buffer): boolean => {
  const text = buffer.toString('utf8');
  return !UNSAFE_SVG_PATTERNS.some((pattern) => pattern.test(text));
};

/**
 * Turns the uploaded value (a data URL or bare base64) into the file bytes
 * and checks its size and type. The declared type of a data URL has to
 * agree with the contents.
 */
export const decodeLogoUpload = (
  value: unknown
): { buffer: Buffer; type: LogoType } => {
  if (typeof value !== 'string' || !value) {
    throw new LogoValidationError('INVALID_DATA', 'No image was provided.');
  }

  let declared: string | undefined;
  let base64 = value.trim();
  const dataUrl = base64.match(/^data:([^;,]+)?(;[^,]*)?,(.*)$/s);

  if (dataUrl) {
    declared = dataUrl[1]?.toLowerCase();
    if (!dataUrl[2]?.includes(';base64')) {
      throw new LogoValidationError(
        'INVALID_DATA',
        'The image must be base64 encoded.'
      );
    }
    base64 = dataUrl[3];
  }

  base64 = base64.replace(/\s/g, '');

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new LogoValidationError('INVALID_DATA', 'The image data is invalid.');
  }

  // Check the size before decoding so an oversized upload is not held twice
  if (Math.floor((base64.length * 3) / 4) > LOGO_MAX_BYTES + 2) {
    throw new LogoValidationError(
      'TOO_LARGE',
      'The image is larger than 2 MB.'
    );
  }

  const buffer = Buffer.from(base64, 'base64');

  if (buffer.length > LOGO_MAX_BYTES) {
    throw new LogoValidationError(
      'TOO_LARGE',
      'The image is larger than 2 MB.'
    );
  }

  const type = detectLogoType(buffer);

  if (!type || (declared && declared !== LOGO_MIME_TYPES[type])) {
    throw new LogoValidationError(
      'UNSUPPORTED_TYPE',
      'The image must be a PNG, SVG or WebP file.'
    );
  }

  if (type === 'svg' && !isSafeSvg(buffer)) {
    throw new LogoValidationError(
      'UNSAFE_SVG',
      'The SVG contains scripts or embedded content.'
    );
  }

  return { buffer, type };
};

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const openLogo = async (buffer: Buffer, type: LogoType, size: number) => {
  let options: SharpOptions | undefined;

  if (type === 'svg') {
    // Rasterize at a density that renders the vector at the target size
    const { width = size, height = size } = await sharp(buffer).metadata();
    const density = Math.ceil((72 * size) / Math.max(width, height, 1));
    options = { density: Math.min(2400, Math.max(1, density)) };
  }

  return sharp(buffer, options).resize(size, size, {
    fit: 'contain',
    background: TRANSPARENT,
  });
};

/** Checks that the image can be read and is square and big enough. */
export const validateLogo = async (
  buffer: Buffer,
  type: LogoType
): Promise<{ width: number; height: number }> => {
  let metadata: Metadata;

  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new LogoValidationError(
      'INVALID_DATA',
      'The image could not be read.'
    );
  }

  const { width, height } = metadata;

  if (!width || !height) {
    throw new LogoValidationError(
      'INVALID_DATA',
      'The image could not be read.'
    );
  }

  if (Math.abs(width - height) / Math.max(width, height) > SQUARE_TOLERANCE) {
    throw new LogoValidationError('NOT_SQUARE', 'The image must be square.');
  }

  // SVGs scale, so their nominal size does not matter
  if (type !== 'svg' && Math.min(width, height) < LOGO_MIN_SIZE) {
    throw new LogoValidationError(
      'TOO_SMALL',
      `The image must be at least ${LOGO_MIN_SIZE}x${LOGO_MIN_SIZE} pixels.`
    );
  }

  return { width, height };
};

const renderIcon = async (
  buffer: Buffer,
  type: LogoType,
  spec: IconSpec
): Promise<Buffer> => {
  if (spec.maskable) {
    // Keep the logo inside the central safe zone of maskable icons
    const inner = Math.round(spec.size * 0.7);
    const pad = Math.floor((spec.size - inner) / 2);
    const logo = await (await openLogo(buffer, type, inner)).png().toBuffer();

    return sharp(logo)
      .extend({
        top: pad,
        bottom: spec.size - inner - pad,
        left: pad,
        right: spec.size - inner - pad,
        background: ICON_BACKGROUND,
      })
      .flatten({ background: ICON_BACKGROUND })
      .png()
      .toBuffer();
  }

  const image = await openLogo(buffer, type, spec.size);

  if (spec.opaque) {
    image.flatten({ background: ICON_BACKGROUND });
  }

  return image.png().toBuffer();
};

/** Packs PNG images into an ICO file (PNG entries are valid since Vista). */
export const buildIco = (images: { size: number; png: Buffer }[]): Buffer => {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, ...images.map(({ png }) => png)]);
};

/** Renders every icon from the logo, keyed by file name. */
export const renderLogoFiles = async (
  buffer: Buffer,
  type: LogoType
): Promise<Record<string, Buffer>> => {
  const files: Record<string, Buffer> = {
    [`logo.${type}`]: buffer,
  };

  for (const [name, spec] of Object.entries(ICON_SPECS)) {
    files[name] = await renderIcon(buffer, type, spec);
  }

  files['favicon.ico'] = buildIco([
    { size: 16, png: files['favicon-16x16.png'] },
    { size: 32, png: files['favicon-32x32.png'] },
  ]);

  return files;
};

const clearBrandingDirectory = async () => {
  await fs.rm(brandingDirectory(), { recursive: true, force: true });
};

/**
 * Validates and stores an uploaded logo with its generated icons under the
 * config directory, then records its version in the main settings.
 * Returns the new version.
 */
export const saveApplicationLogo = async (value: unknown): Promise<string> => {
  const { buffer, type } = decodeLogoUpload(value);
  await validateLogo(buffer, type);

  // Render everything before touching the current files
  const files = await renderLogoFiles(buffer, type);
  const version = createHash('sha256')
    .update(buffer)
    .digest('hex')
    .slice(0, 12);

  await clearBrandingDirectory();
  await fs.mkdir(brandingDirectory(), { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, data]) =>
      fs.writeFile(path.join(brandingDirectory(), name), data)
    )
  );

  const settings = getSettings();
  settings.main.applicationLogoVersion = version;
  await settings.save();

  logger.info('Saved a new application logo', {
    label: 'Branding',
    type,
    version,
  });

  return version;
};

/** Removes the uploaded logo so the bundled one is used again. */
export const removeApplicationLogo = async (): Promise<void> => {
  await clearBrandingDirectory();

  const settings = getSettings();
  settings.main.applicationLogoVersion = '';
  await settings.save();
};

/** The uploaded logo on disk, if there is one. */
export const getLogoFile = (): { path: string; type: LogoType } | undefined => {
  if (!getSettings().main.applicationLogoVersion) {
    return undefined;
  }

  for (const type of Object.keys(LOGO_MIME_TYPES) as LogoType[]) {
    const file = path.join(brandingDirectory(), `logo.${type}`);
    if (existsSync(file)) {
      return { path: file, type };
    }
  }

  return undefined;
};

/** A generated icon on disk, if a logo has been uploaded. */
export const getIconFile = (name: IconName): string | undefined => {
  if (!getLogoFile()) {
    return undefined;
  }

  const file = path.join(brandingDirectory(), name);
  return existsSync(file) ? file : undefined;
};

/** Where the interface and emails load an icon from. */
export const brandingIconPath = (name: IconName, version?: string): string =>
  version ? `/api/v1/branding/icon/${name}?v=${version}` : `/${name}`;

let bundledManifest: Record<string, unknown> | undefined;

const loadBundledManifest = (): Record<string, unknown> => {
  if (!bundledManifest) {
    try {
      bundledManifest = JSON.parse(
        readFileSync(
          path.join(__dirname, '../../public/site.webmanifest'),
          'utf-8'
        )
      ) as Record<string, unknown>;
    } catch (e) {
      logger.error('Unable to read the bundled web manifest', {
        label: 'Branding',
        errorMessage: e.message,
      });
      bundledManifest = {};
    }
  }

  return bundledManifest;
};

/**
 * The iOS launch screens, named apple-splash-<width>-<height>.jpg like the
 * bundled files in public/. Each is the logo centered on the theme color.
 */
export const SPLASH_SIZES: [number, number][] = [
  [640, 1136],
  [750, 1334],
  [828, 1792],
  [1125, 2436],
  [1170, 2532],
  [1242, 2208],
  [1242, 2688],
  [1284, 2778],
  [1536, 2048],
  [1620, 2160],
  [1668, 2224],
  [1668, 2388],
  [2048, 2732],
].flatMap(([width, height]): [number, number][] => [
  [width, height],
  [height, width],
]);

const SPLASH_NAME = /^apple-splash-(\d+)-(\d+)\.jpg$/;

// Share of the shorter side the logo takes up
const SPLASH_LOGO_SCALE = 0.4;

export const parseSplashName = (
  name: string
): { width: number; height: number } | undefined => {
  const match = name.match(SPLASH_NAME);

  if (!match) {
    return undefined;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);

  return SPLASH_SIZES.some(([w, h]) => w === width && h === height)
    ? { width, height }
    : undefined;
};

/** Renders a launch screen: the logo centered on the theme color. */
export const renderSplash = async (
  buffer: Buffer,
  type: LogoType,
  width: number,
  height: number
): Promise<Buffer> => {
  const size = Math.round(Math.min(width, height) * SPLASH_LOGO_SCALE);
  const logo = await (await openLogo(buffer, type, size)).png().toBuffer();

  return sharp({
    create: { width, height, channels: 3, background: ICON_BACKGROUND },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .jpeg({ quality: 85 })
    .toBuffer();
};

const splashRenders = new Map<string, Promise<string | undefined>>();

/**
 * The launch screen for an uploaded logo, rendered the first time an iPhone
 * or iPad asks for it and kept with the icons, so uploading a new logo
 * clears it. Undefined when no logo has been uploaded.
 */
export const getSplashFile = async (
  name: string
): Promise<string | undefined> => {
  const splash = parseSplashName(name);
  const logo = getLogoFile();

  if (!splash || !logo) {
    return undefined;
  }

  const file = path.join(brandingDirectory(), name);

  if (existsSync(file)) {
    return file;
  }

  let render = splashRenders.get(file);

  if (!render) {
    render = (async () => {
      try {
        const data = await renderSplash(
          await fs.readFile(logo.path),
          logo.type,
          splash.width,
          splash.height
        );
        await fs.writeFile(file, data);
        return file;
      } catch (e) {
        logger.error('Unable to render a launch screen', {
          label: 'Branding',
          name,
          errorMessage: e.message,
        });
        return undefined;
      } finally {
        splashRenders.delete(file);
      }
    })();
    splashRenders.set(file, render);
  }

  return render;
};

/** The web manifest with the application title and logo filled in. */
export const buildWebManifest = (): Record<string, unknown> => {
  const { applicationTitle, applicationLogoVersion } = getSettings().main;
  const manifest = { ...loadBundledManifest() };
  const title = applicationTitle || DEFAULT_APPLICATION_TITLE;

  manifest.name = title;
  manifest.short_name = title;

  if (applicationLogoVersion && getLogoFile()) {
    manifest.icons = (
      [
        ['android-chrome-192x192.png', '192x192', 'any'],
        ['android-chrome-192x192_maskable.png', '192x192', 'maskable'],
        ['android-chrome-512x512.png', '512x512', 'any'],
        ['android-chrome-512x512_maskable.png', '512x512', 'maskable'],
      ] as [IconName, string, string][]
    ).map(([name, sizes, purpose]) => ({
      src: `.${brandingIconPath(name, applicationLogoVersion)}`,
      sizes,
      type: 'image/png',
      purpose,
    }));
  }

  return manifest;
};

export interface EmailLogo {
  /** The bundled wordmark, made for the dark look. */
  logoUrl?: string;
  /** The wordmark with dark text, shown when the mail app is in light mode. */
  logoLightUrl?: string;
  /** An uploaded logo, shown next to the title. */
  logoIconUrl?: string;
}

/**
 * Logo locals for the email templates. A renamed or rebranded instance
 * shows its title as text, next to the uploaded logo, instead of the
 * bundled wordmark. Only the bundled wordmark has a light mode variant;
 * an uploaded logo and the title text work on both backgrounds.
 */
export const getEmailLogo = (): EmailLogo => {
  const settings = getSettings();
  const { applicationUrl, applicationTitle, applicationLogoVersion } =
    settings.main;
  const { usePublicLogo } = settings.notifications.agents.email.options;

  if (usePublicLogo) {
    return { logoUrl: PUBLIC_LOGO_URL, logoLightUrl: PUBLIC_LOGO_LIGHT_URL };
  }

  if (!applicationUrl) {
    return {};
  }

  if (applicationLogoVersion && getLogoFile()) {
    return {
      logoIconUrl: `${applicationUrl}${brandingIconPath(
        'android-chrome-192x192.png',
        applicationLogoVersion
      )}`,
    };
  }

  if (applicationTitle && applicationTitle !== DEFAULT_APPLICATION_TITLE) {
    return {};
  }

  // PNG rather than SVG, since Gmail and Outlook do not show SVG images
  return {
    logoUrl: `${applicationUrl}/logo_full.png`,
    logoLightUrl: `${applicationUrl}/logo_full_dark.png`,
  };
};
