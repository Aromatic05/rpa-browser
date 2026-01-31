/**
 * results：统一的命令执行返回结构。
 *
 * 约束：
 * - ok=true 时必须携带 data
 * - ok=false 时必须携带 error.code/message
 * - requestId 用于 WS/HTTP 追踪，不参与逻辑判断
 */
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

/**
 * 构造成功结果。
 */
export const okResult = <T>(tabToken: string, data: T, requestId?: string): SuccessResult<T> => ({
    ok: true,
    tabToken,
    requestId,
    data,
});

/**
 * 构造失败结果。details 仅用于调试/诊断，不应泄露敏感信息。
 */
export const errorResult = (
    tabToken: string,
    code: ErrorCode,
    message: string,
    requestId?: string,
    details?: unknown,
): ErrorResult => ({
    ok: false,
    tabToken,
    requestId,
    error: { code, message, details },
});
