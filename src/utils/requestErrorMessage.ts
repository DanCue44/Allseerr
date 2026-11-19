import axios from 'axios';

/**
 * The reason the server gave for refusing a request, such as a streaming
 * provider block, a quota or a content rating limit. Server errors (5xx)
 * keep the generic message, since their text is meant for the logs.
 */
export const getRequestErrorMessage = (e: unknown): string | undefined => {
  if (!axios.isAxiosError(e)) {
    return undefined;
  }

  const status = e.response?.status ?? 0;
  const message = (e.response?.data as { message?: unknown } | undefined)
    ?.message;

  return status >= 400 && status < 500 && typeof message === 'string' && message
    ? message
    : undefined;
};
