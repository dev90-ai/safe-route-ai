/**
 * A single error shape for the whole data layer.
 *
 * Screens branch on `kind`, never on a string message, so copy can change
 * without breaking behaviour. `retryable` tells the offline queue and the query
 * hooks whether backing off is worth it; `userMessage` is always safe to show.
 */

export type ApiErrorKind =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'validation'
  | 'rate-limited'
  | 'server';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly fieldErrors?: Record<string, string>;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(init: {
    kind: ApiErrorKind;
    message: string;
    userMessage?: string;
    status?: number;
    fieldErrors?: Record<string, string>;
    retryAfterMs?: number;
    requestId?: string;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status ?? STATUS_BY_KIND[init.kind];
    this.retryable = RETRYABLE.has(init.kind);
    this.userMessage = init.userMessage ?? DEFAULT_MESSAGE[init.kind];
    this.fieldErrors = init.fieldErrors;
    this.retryAfterMs = init.retryAfterMs;
    this.requestId = init.requestId;
  }
}

const STATUS_BY_KIND: Record<ApiErrorKind, number> = {
  network: 0,
  timeout: 408,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  validation: 422,
  'rate-limited': 429,
  server: 500,
};

const RETRYABLE = new Set<ApiErrorKind>(['network', 'timeout', 'server', 'rate-limited']);

const DEFAULT_MESSAGE: Record<ApiErrorKind, string> = {
  network: 'No connection. This will be sent automatically once you are back online.',
  timeout: 'The network is slow right now. We will keep trying in the background.',
  unauthorized: 'Your session has expired. Please sign in again.',
  forbidden: 'Your role does not allow this action.',
  'not-found': 'That item no longer exists.',
  conflict: 'Someone else changed this first. Refresh to see the latest version.',
  validation: 'Please check the highlighted fields.',
  'rate-limited': 'Too many attempts. Wait a moment and try again.',
  server: 'Something went wrong on our side. Try again shortly.',
};

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** Anything thrown anywhere becomes a presentable ApiError. */
export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (/network|fetch|connection/i.test(message)) {
    return new ApiError({ kind: 'network', message });
  }
  return new ApiError({ kind: 'server', message });
}
