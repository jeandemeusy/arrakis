/**
 * An error that carries the HTTP status it should be answered with.
 *
 * Everything below the route handlers throws these for conditions a caller can
 * act on — bad input, missing login, unknown query — so the message reaches the
 * client verbatim. Any other error is a bug or an outage and is reported as a
 * generic 500 without its message, which may name internals.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    message: string,
    options?: {
      details?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = options?.details;
    this.headers = options?.headers;
  }
}

export const badRequest = (
  message: string,
  details?: Record<string, unknown>,
) => new HttpError(400, message, { details });

export const notFound = (message: string) => new HttpError(404, message);
