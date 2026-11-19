import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AxiosError, AxiosHeaders } from 'axios';
import { getRequestErrorMessage } from './requestErrorMessage';

const axiosError = (status: number, data: unknown) =>
  new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  });

describe('getRequestErrorMessage', () => {
  it('passes on the reason for a refused request', () => {
    assert.strictEqual(
      getRequestErrorMessage(
        axiosError(403, {
          message:
            'This title is streaming on Netflix and cannot be requested.',
        })
      ),
      'This title is streaming on Netflix and cannot be requested.'
    );
  });

  it('keeps the generic message for server errors', () => {
    assert.strictEqual(
      getRequestErrorMessage(axiosError(500, { message: 'stack details' })),
      undefined
    );
  });

  it('keeps the generic message without a reason', () => {
    assert.strictEqual(getRequestErrorMessage(axiosError(403, {})), undefined);
    assert.strictEqual(getRequestErrorMessage(new Error('offline')), undefined);
  });
});
