/**
 * execute：Action 协议的统一入口。
 *
 * 说明：
 * - Action 是外部协议，Step 是内部执行协议
 * - 本模块仅负责：Action 路由 + 统一错误封装
 */

import type { Page } from 'playwright';
import { ERROR_CODES, type ErrorCode } from './error_codes';
import type { Action, ActionErr, ActionOk } from './action_protocol';
import { makeErr, makeOk } from './action_protocol';
import { actionHandlers } from './index';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';

export type ActionContext = {
    page: Page;
    tabToken: string;
    pageRegistry: PageRegistry;
    log: (...args: unknown[]) => void;
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    execute?: (action: Action) => Promise<ActionHandlerResult>;
};

export type ActionHandlerResult = ActionOk<any> | ActionErr;
export type ActionHandler = (ctx: ActionContext, action: Action) => Promise<ActionHandlerResult>;

export class ActionError extends Error {
    code: ErrorCode;
    details?: unknown;

    constructor(code: ErrorCode, message: string, details?: unknown) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

/**
 * 将异常转为标准 Result，避免抛出到 WS 层。
 */
const mapError = (error: unknown): ActionHandlerResult => {
    if (error instanceof ActionError) {
        return makeErr(error.code, error.message, error.details);
    }
    if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
            return makeErr(ERROR_CODES.ERR_TIMEOUT, error.message);
        }
        return makeErr(ERROR_CODES.ERR_BAD_ARGS, error.message);
    }
    return makeErr(ERROR_CODES.ERR_BAD_ARGS, String(error));
};

/**
 * 执行单条 Action。内部负责调用 handler 与统一结果包装。
 */
export const executeAction = async (ctx: ActionContext, action: Action): Promise<ActionHandlerResult> => {
    const handler = actionHandlers[action.type];
    if (!handler) {
        return makeErr(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    }
    ctx.log('execute', { type: action.type, tabToken: ctx.tabToken, id: action.id, pageUrl: ctx.page.url() });
    try {
        const result = await handler(ctx, action);
        if (result.ok) return makeOk(result.data);
        return result;
    } catch (error) {
        return mapError(error);
    }
};
