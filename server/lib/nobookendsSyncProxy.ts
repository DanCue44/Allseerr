import { getNoBookEndsSyncProxyTarget } from '@server/lib/nobookendsSync';
import logger from '@server/logger';
import type { NextFunction, Request, Response } from 'express';
import http from 'node:http';
import https from 'node:https';

/**
 * Serves the NoBookEnds Sync reader API under Allseerr's own address, so
 * phones reach it without a reverse proxy of its own. Mounted at
 * /api/v1/nbe-sync before the body parsers, sessions and CSRF checks:
 * /api/v1/nbe-sync/api/v1/health is forwarded to /api/v1/health.
 *
 * Requests and answers are streamed. The reader's Authorization header (an
 * Audiobookshelf token) is passed on untouched and the Sync server checks
 * it with Audiobookshelf itself. Allseerr's cookies and keys are never
 * passed on, and the admin API is not served, so the admin token stays
 * between Allseerr and the Sync server.
 */

// The Sync server refuses bodies over 8 MB
export const MAX_PROXY_BODY_BYTES = 9 * 1024 * 1024;
// Time to the answer's headers, and the longest pause while streaming
export const PROXY_TIMEOUT_MS = 60 * 1000;

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);

const FORWARDED_REQUEST_HEADERS = [
  'authorization',
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-length',
  'if-none-match',
  'if-modified-since',
  'user-agent',
];

const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'content-length',
  'etag',
  'last-modified',
  'cache-control',
  'vary',
  'retry-after',
  'www-authenticate',
];

/**
 * The Sync server path to forward to, or null for one Allseerr does not
 * serve: only /api/v1/..., never the admin API, and nothing that could
 * climb out of it (dot segments, encoded slashes or dots, backslashes).
 */
export const getProxiedPath = (url: string): string | null => {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? '' : url.slice(queryAt);

  if (!path.startsWith('/api/v1/') || /%2[ef]|%5c|\\/i.test(path)) {
    return null;
  }

  const segments = path.split('/');

  if (segments.some((s) => s === '.' || s === '..')) {
    return null;
  }

  if (/^\/api\/v1\/admin(\/|$)/i.test(path)) {
    return null;
  }

  return `${path}${query}`;
};

const sendError = (res: Response, status: number, message: string) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.status(status).json({ message });
};

export const nobookendsSyncProxy = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const target = getNoBookEndsSyncProxyTarget();

  if (!target) {
    return sendError(res, 404, 'NoBookEnds Sync is not served here.');
  }

  const path = getProxiedPath(req.url);

  if (!path) {
    return sendError(res, 404, 'Not found.');
  }

  if (!ALLOWED_METHODS.has(req.method)) {
    res.setHeader('Allow', [...ALLOWED_METHODS].join(', '));
    return sendError(res, 405, 'Method not allowed.');
  }

  const declaredLength = Number(req.headers['content-length'] ?? 0);

  if (declaredLength > MAX_PROXY_BODY_BYTES) {
    // Read and drop the body, so the client sees the answer
    req.resume();
    return sendError(res, 413, 'Request body too large.');
  }

  let upstreamUrl: URL;

  try {
    upstreamUrl = new URL(`${target.replace(/\/+$/, '')}${path}`);
  } catch {
    return next({ status: 500, message: 'Invalid NoBookEnds Sync address.' });
  }

  const headers: http.OutgoingHttpHeaders = {};

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];

    if (value !== undefined) {
      headers[name] = value;
    }
  }

  const remote = req.socket.remoteAddress;
  const forwardedFor = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = [forwardedFor, remote]
    .flat()
    .filter(Boolean)
    .join(', ');
  headers['x-forwarded-proto'] = req.protocol;

  if (req.headers.host) {
    headers['x-forwarded-host'] = req.headers.host;
  }

  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  let finished = false;

  const upstream = transport.request(upstreamUrl, {
    method: req.method,
    headers,
    timeout: PROXY_TIMEOUT_MS,
  });

  upstream.on('response', (answer) => {
    res.status(answer.statusCode ?? 502);

    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = answer.headers[name];

      if (value !== undefined) {
        res.setHeader(name, value);
      }
    }

    answer.on('error', () => res.destroy());
    answer.pipe(res);
  });

  upstream.on('timeout', () => {
    upstream.destroy(new Error('timeout'));
  });

  upstream.on('error', (e) => {
    if (finished) {
      return;
    }
    finished = true;
    const timedOut = e.message === 'timeout';

    logger.warn('NoBookEnds Sync did not answer a proxied request', {
      label: 'NoBookEnds Sync',
      errorMessage: e.message,
    });
    sendError(
      res,
      timedOut ? 504 : 502,
      timedOut
        ? 'NoBookEnds Sync did not answer in time.'
        : 'Failed to reach NoBookEnds Sync.'
    );
  });

  // The reader went away: stop the work on the Sync server's side too
  res.on('close', () => {
    finished = finished || res.writableFinished;
    if (!res.writableFinished) {
      upstream.destroy();
    }
  });

  let received = 0;

  req.on('data', (chunk: Buffer) => {
    received += chunk.length;

    if (received > MAX_PROXY_BODY_BYTES && !finished) {
      finished = true;
      upstream.destroy();
      req.unpipe(upstream);
      sendError(res, 413, 'Request body too large.');
      req.resume();
    }
  });

  req.pipe(upstream);
};

export default nobookendsSyncProxy;
