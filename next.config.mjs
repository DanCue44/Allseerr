/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  env: {
    commitTag: process.env.COMMIT_TAG || 'local',
    unsafeDoNotUseDemo: process.env.UNSAFE_DO_NOT_USE_DEMO,
  },
  images: {
    remotePatterns: [
      { hostname: 'gravatar.com' },
      { hostname: 'image.tmdb.org' },
      { hostname: 'artworks.thetvdb.com' },
      { hostname: 'plex.tv' },
    ],
  },
  transpilePackages: ['country-flag-icons'],
  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },
  // The movie, series, music and books pages became spaces. Query strings
  // are passed on, so filtered links keep their filters. Kept in step with
  // LEGACY_SPACE_REDIRECTS in src/utils/spaces.ts.
  async redirects() {
    return [
      { source: '/discover/movies', destination: '/movies/browse' },
      { source: '/discover/tv', destination: '/series/browse' },
      { source: '/discover/music', destination: '/music' },
      { source: '/discover/books', destination: '/books' },
    ].map((redirect) => ({ ...redirect, permanent: false }));
  },
  experimental: {
    scrollRestoration: true,
    largePageDataBytes: 512 * 1000,
  },
};

export default nextConfig;
