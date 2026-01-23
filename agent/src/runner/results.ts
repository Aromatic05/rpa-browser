import type { ErrorCode } from './error_codes';

export type ErrorResult = {
  ok: false;
  requestId?: string;
  tabToken: string;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
};

export type SuccessResult<T = unknown> = {
  ok: true;
  requestId?: string;
  tabToken: string;
  data: T;
};

export type Result<T = unknown> = SuccessResult<T> | ErrorResult;

export const okResult = <T>(
  tabToken: string,
  data: T,
  requestId?: string
): SuccessResult<T> => ({
  ok: true,
  tabToken,
  requestId,
  data
});

export const errorResult = (
  tabToken: string,
  code: ErrorCode,
  message: string,
  requestId?: string,
  details?: unknown
): ErrorResult => ({
  ok: false,
  tabToken,
  requestId,
  error: { code, message, details }
});
