import type { Page } from 'playwright';
import { ERROR_CODES, type ErrorCode } from './error_codes';
import type { Command } from './commands';
import { errorResult, okResult, type Result } from './results';
import { actionHandlers } from './actions';
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

export const executeCommand = async (
  ctx: ActionContext,
  command: Command
): Promise<Result> => {
  const handler = actionHandlers[command.cmd];
  if (!handler) {
    return errorResult(
      ctx.tabToken,
      ERROR_CODES.ERR_UNSUPPORTED,
      `unsupported cmd: ${command.cmd}`,
      command.requestId
    );
  }
  const selector = (command as any).args?.target?.selector;
  ctx.log('execute', {
    cmd: command.cmd,
    tabToken: ctx.tabToken,
    requestId: command.requestId,
    selector,
    pageUrl: ctx.page.url()
  });
  try {
    const result = await handler(ctx, command);
    if (result.ok) {
      return okResult(ctx.tabToken, result.data, command.requestId);
    }
    return result.requestId ? result : { ...result, requestId: command.requestId };
  } catch (error) {
    return mapError(ctx.tabToken, command.requestId, error);
  }
};
