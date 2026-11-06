import { HttpError } from '../api/errors';

/**
 * An error as a widget carries it: what went wrong, in words the editor who
 * built the chart can act on — and nothing more for anything unexpected.
 */
export type ApiErrorShape = {
  status: number;
  message: string;
  details?: Record<string, unknown>;
};

export function toErrorShape(error: unknown): ApiErrorShape {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      message: error.message,
      details: error.details,
    };
  }
  console.error('Widget failed:', error);
  return { status: 500, message: 'This chart could not be drawn.' };
}
