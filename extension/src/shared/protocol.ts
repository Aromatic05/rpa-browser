/**
 * 协议常量：消息类型的唯一来源。
 *
 * 说明：
 * - 所有 message type 必须从这里引用，禁止散落字符串。
 * - RpcResult/RpcError 用于统一 send 的错误返回结构。
 */

export const MSG = {
    HELLO: 'RPA_HELLO',
    GET_TOKEN: 'RPA_GET_TOKEN',
    REFRESH: 'RPA_REFRESH',
    ACTION: 'ACTION',
} as const;

export type ErrorCode =
    | 'TIMEOUT'
    | 'PORT_CLOSED'
    | 'RUNTIME_ERROR'
    | 'NO_RECEIVER'
    | 'BAD_REQUEST'
    | 'WS_DOWN';

export type RpcError = { code: ErrorCode; message: string; details?: any };

export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: RpcError };
