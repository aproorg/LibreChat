import type { SafeErrorMetadata } from '~/utils/errors';
import { getSafeErrorMetadata } from '~/utils/errors';

/** What a `[search]` log line may say about a failure. */
export interface SearchFailureMetadata extends SafeErrorMetadata {
  /** The error's class, such as `MongoServerError` or `TypeError`, when it is not plain `Error`. */
  name?: string;
  /** A driver's numeric code, or a short identifier such as `ECONNRESET` or `search_busy`. */
  code?: number | string;
  /** A server error's name for its code, such as `BadValue`. */
  codeName?: string;
}

const CLASS_NAME = /^[A-Za-z]{1,40}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;
const CODE_NAME = /^[A-Za-z]{1,60}$/;

function read(error: unknown, property: string): unknown {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  try {
    return (error as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

/**
 * Safe diagnostics for a search failure: the error's class, its code and its code name. They
 * tell an unsupported option from a missing index from a network error, where `Error` alone
 * reads the same for all three. Each is a short identifier by pattern, so none can carry
 * submitted content. Never the message.
 */
export function safeFailure(error: unknown): SearchFailureMetadata {
  const name = read(error, 'name');
  const code = read(error, 'code');
  const codeName = read(error, 'codeName');
  return {
    ...getSafeErrorMetadata(error),
    ...(typeof name === 'string' && name !== 'Error' && CLASS_NAME.test(name) ? { name } : {}),
    ...(typeof code === 'number' || (typeof code === 'string' && CODE.test(code)) ? { code } : {}),
    ...(typeof codeName === 'string' && CODE_NAME.test(codeName) ? { codeName } : {}),
  };
}

/** The same as one short string, for a stored `lastFailureCode`: `MongoServerError:13`. */
export function safeFailureCode(error: unknown): string {
  const { name = 'Error', code } = safeFailure(error);
  return typeof code === 'number' ? `${name}:${code}` : name;
}
