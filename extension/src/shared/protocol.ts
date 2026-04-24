/**
 * 协议常量：消息类型的唯一来源。
 *
 * 说明：
 * - 所有 message type 必须从这里引用，禁止散落字符串。
 * - TransportResult/TransportError 仅用于 runtime/tabs 传输层兼容，不是业务协议。
 */

export const MSG = {
    HELLO: 'RPA_HELLO',
    GET_TOKEN: 'RPA_GET_TOKEN',
    REFRESH: 'RPA_REFRESH',
    ACTION: 'ACTION',
    ACTION_EVENT: 'ACTION_EVENT',
} as const;

export type ErrorCode =
    | 'TIMEOUT'
    | 'PORT_CLOSED'
    | 'RUNTIME_ERROR'
    | 'NO_RECEIVER'
    | 'BAD_REQUEST'
    | 'WS_DOWN';

export type TransportError = { code: ErrorCode; message: string; details?: unknown };

export type TransportResult<T> = { ok: true; data: T } | { ok: false; error: TransportError };
