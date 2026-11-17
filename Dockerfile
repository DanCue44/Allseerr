FROM node:22.23.5-alpine3.23@sha256:6868d4695b947ee120bffaa463fecd68cde370d7bfec92955e7c8ac576b4f475 AS base
ARG SOURCE_DATE_EPOCH
ARG TARGETPLATFORM
ENV TARGETPLATFORM=${TARGETPLATFORM:-linux/amd64}

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY . ./app
WORKDIR /app

FROM base AS prod-deps

RUN CI=true pnpm install --prod --frozen-lockfile

# Remove large native modules for linux-x64-gnu platform (we use alpine which is musl-based)
# not supported in pnpm for now due to this bug: https://github.com/pnpm/pnpm/issues/9654
RUN du -shL ./node_modules/.pnpm/* | grep '[0-9]M.*' | grep 'linux-x64-gnu@' | awk '{print $2}' | xargs rm -rf

# The Allseerr image runner uses the classic Docker builder, which cannot
# exclude files in COPY, so the runtime's unneeded files are removed here.
# @next/swc is only for next build and for next.config.ts
# ts-node, @swc/core, and typescript are only needed for build-time type checking and compilation
# ace-builds, country-flag-icons and @heroicons subfolders are large module files not needed for production
# Source map files are not needed for production
RUN rm -rf \
  node_modules/.pnpm/@next+swc-* \
  node_modules/.pnpm/@swc+core* \
  node_modules/.pnpm/ts-node@* \
  node_modules/.pnpm/typescript@* && \
  find node_modules/.pnpm \( \
  -path "*/ace-builds/src-noconflict" -o \
  -path "*/ace-builds/src" -o \
  -path "*/ace-builds/src-min" -o \
  -path "*/country-flag-icons/react" -o \
  -path "*/country-flag-icons/string" -o \
  -path "*/country-flag-icons/1x1" -o \
  -path "*/@heroicons/react/16" \
  \) -prune -exec rm -rf {} + && \
  find node_modules -name '*.map' -type f -delete && \
  rm -rf src server

FROM base AS build

ARG COMMIT_TAG
ENV COMMIT_TAG=${COMMIT_TAG}

RUN \
  case "${TARGETPLATFORM}" in \
  'linux/arm64' | 'linux/arm/v7') \
  apk update && \
  apk add --no-cache python3 make g++ gcc libc6-compat bash && \
  npm install --global node-gyp \
  ;; \
  esac

RUN CYPRESS_INSTALL_BINARY=0 pnpm install --frozen-lockfile

RUN pnpm build

RUN rm -rf .next/cache && find .next -name '*.map' -type f -delete

FROM node:22.23.5-alpine3.23@sha256:6868d4695b947ee120bffaa463fecd68cde370d7bfec92955e7c8ac576b4f475
ARG SOURCE_DATE_EPOCH
ARG COMMIT_TAG
ENV NODE_ENV=production
ENV COMMIT_TAG=${COMMIT_TAG}

LABEL org.opencontainers.image.title="Allseerr" \
  org.opencontainers.image.description="Request management for movies, series, music, books and audiobooks, based on Seerr" \
  org.opencontainers.image.source="https://github.com/DanCue44/Allseerr" \
  org.opencontainers.image.url="https://github.com/DanCue44/Allseerr" \
  org.opencontainers.image.licenses="MIT"

# tini reaps zombies and forwards signals, so the image does not depend on
# `docker run --init`. -s keeps it quiet when --init is also used.
RUN apk add --no-cache tini tzdata

# The classic builder creates WORKDIR as root, so hand it to node first.
RUN mkdir -p /app && chown node:node /app

# Runs as the image's node user (UID 1000, GID 1000) and does not read
# PUID/PGID, so the /app/config volume must be writable by UID 1000.
USER node:node

WORKDIR /app

# The app files without src and server, from the pruned prod-deps stage
COPY --chown=node:node --from=prod-deps /app ./
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/dist ./dist

RUN touch config/DOCKER && \
  echo "{\"commitTag\": \"${COMMIT_TAG}\"}" > committag.json

EXPOSE 5055

ENTRYPOINT [ "/sbin/tini", "-s", "--" ]

CMD [ "npm", "start" ]
