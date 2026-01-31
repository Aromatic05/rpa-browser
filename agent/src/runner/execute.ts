/**
 * execute：统一命令路由入口，负责：
 * - 根据 cmd 找到对应 action handler
 * - 处理高亮与可视化辅助
 * - 将异常映射为标准 Result 结构
 *
 * 依赖关系：
 * - 上游：agent/index.ts 负责构造 ActionContext 并调用 executeCommand
 * - 下游：runner/actions/* 执行具体动作；runtime/target_resolver 解析定位
 *
 * 错误约定：
 * - ActionError 会带 ErrorCode/详情并原样映射
 * - 其它异常统一映射为 ERR_BAD_ARGS / ERR_TIMEOUT
 */
import type { Page } from 'playwright';
import { ERROR_CODES, type ErrorCode } from './error_codes';
import type { Command } from './commands';
import { errorResult, okResult, type Result } from './results';
import { actionHandlers } from './actions';
import { resolveTarget } from '../runtime/target_resolver';
import { highlightLocator, clearHighlight } from './actions/highlight';
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
    execute?: (command: Command) => Promise<Result>;
};

export type ActionHandler = (ctx: ActionContext, command: Command) => Promise<Result>;

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
 * 仅在“可定位元素”的命令上做高亮提示。
 * 该辅助失败不影响动作执行。
 */
const shouldHighlight = (command: Command) => {
    const target = (command as any).args?.target;
    if (!target) return false;
    const cmd = command.cmd;
    if (cmd === 'page.scrollBy' || cmd === 'page.scrollTo' || cmd === 'element.scrollIntoView') return false;
    return true;
};

/**
 * 将异常转为标准 Result，避免抛出到 WS 层。
 */
const mapError = (tabToken: string, requestId: string | undefined, error: unknown): Result => {
    if (error instanceof ActionError) {
        return errorResult(tabToken, error.code, error.message, requestId, error.details);
    }
    if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
            return errorResult(tabToken, ERROR_CODES.ERR_TIMEOUT, error.message, requestId);
        }
        return errorResult(tabToken, ERROR_CODES.ERR_BAD_ARGS, error.message, requestId);
    }
    return errorResult(tabToken, ERROR_CODES.ERR_BAD_ARGS, String(error), requestId);
};

/**
 * 执行单条命令。内部负责高亮、调用 handler、统一结果包装。
 */
export const executeCommand = async (ctx: ActionContext, command: Command): Promise<Result> => {
    const handler = actionHandlers[command.cmd];
    if (!handler) {
        return errorResult(
            ctx.tabToken,
            ERROR_CODES.ERR_UNSUPPORTED,
            `unsupported cmd: ${command.cmd}`,
            command.requestId,
        );
    }
    const selector = (command as any).args?.target?.selector;
    ctx.log('execute', {
        cmd: command.cmd,
        tabToken: ctx.tabToken,
        requestId: command.requestId,
        selector,
        pageUrl: ctx.page.url(),
    });
    let highlighted = null as null | { locator: any };
    try {
        if (shouldHighlight(command)) {
            try {
                const target = (command as any).args?.target;
                const resolved = await resolveTarget({
                    page: ctx.page,
                    tabToken: ctx.tabToken,
                    target,
                    pageRegistry: ctx.pageRegistry,
                });
                highlighted = { locator: resolved.locator };
                await highlightLocator(resolved.locator);
                await ctx.page.waitForTimeout(150);
            } catch {
                // ignore highlight failures
            }
        }
        const result = await handler(ctx, command);
        if (result.ok) {
            return okResult(ctx.tabToken, result.data, command.requestId);
        }
        return result.requestId ? result : { ...result, requestId: command.requestId };
    } catch (error) {
        return mapError(ctx.tabToken, command.requestId, error);
    } finally {
        if (highlighted?.locator) {
            try {
                await clearHighlight(highlighted.locator);
            } catch {
                // ignore
            }
        }
    }
};
