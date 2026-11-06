import { HttpError } from './errors';

/**
 * What someone who is not signed in is told when something fails.
 *
 * A database's own error text can name hosts, ports, roles, schemas — even a
 * value from a row, quoted in a failed cast. Signed in, the studio shows all
 * of it, since that is what an editor fixes a query with. Signed out, a
 * reader learns that something failed and, where it is the app's own
 * message about their request (a page that does not exist, a chart that
 * changed, too many requests), what; never the database's words.
 */

/** Statuses whose messages are the app's own, about the reader's request. */
const OWN_MESSAGES = new Set([400, 404, 408, 409, 429]);

export const READER_FAILURE = 'This could not be loaded right now.';
export const READER_REFRESH_FAILED = 'The last refresh failed.';

/** An error as a reader may see it. */
export function forReader(error: unknown): HttpError {
  if (
    error instanceof HttpError &&
    OWN_MESSAGES.has(error.status) &&
    error.details?.sqlstate === undefined
  ) {
    return new HttpError(error.status, error.message, {
      headers: error.headers,
    });
  }
  const status =
    error instanceof HttpError && error.status < 500 ? error.status : 503;
  return new HttpError(status, READER_FAILURE, {
    headers: error instanceof HttpError ? error.headers : undefined,
  });
}

/** A widget's error shape, as a reader may see it. */
export function readerShape(shape: {
  status: number;
  message: string;
  details?: Record<string, unknown>;
}): { status: number; message: string } {
  const safe = forReader(
    new HttpError(shape.status, shape.message, { details: shape.details }),
  );
  return { status: safe.status, message: safe.message };
}

/** Per-source statuses with the stored failure text replaced. */
export function readerNetworks<
  T extends { lastAttempt: { error: string | null } | null },
>(networks: T[]): T[] {
  return networks.map((network) =>
    network.lastAttempt?.error
      ? {
          ...network,
          lastAttempt: { ...network.lastAttempt, error: READER_REFRESH_FAILED },
        }
      : network,
  );
}
