import type { Page } from 'playwright';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import { z } from 'zod';
import { executeCommand, type ActionContext } from '../runner/execute';
import type {
    Command,
    ElementClickCommand,
    ElementFillCommand,
    ElementTypeCommand,
    PageGotoCommand,
    Target,
} from '../runner/commands';
import { ERROR_CODES } from '../runner/error_codes';
import { errorResult, okResult, type Result } from '../runner/results';
import {
    browserClickInputSchema,
    browserGotoInputSchema,
    browserSnapshotInputSchema,
    browserTypeInputSchema,
    type BrowserClickInput,
    type BrowserGotoInput,
    type BrowserSnapshotInput,
    type BrowserTypeInput,
} from './schemas';

export type McpToolDeps = {
    pageRegistry: PageRegistry;
    recordingState: RecordingState;
    log: (...args: unknown[]) => void;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
};

export type McpToolHandler = (args: unknown) => Promise<Result>;

const getOrCreatePage = async (
    pageRegistry: PageRegistry,
    tabToken: string,
    urlHint?: string,
): Promise<Page> => pageRegistry.getPage(tabToken, urlHint);

const buildActionContext = async (
    deps: McpToolDeps,
    tabToken: string,
    urlHint?: string,
): Promise<ActionContext> => {
    const page = await getOrCreatePage(deps.pageRegistry, tabToken, urlHint);
    const ctx: ActionContext = {
        page,
        tabToken,
        pageRegistry: deps.pageRegistry,
        log: deps.log,
        recordingState: deps.recordingState,
        replayOptions: deps.replayOptions,
        navDedupeWindowMs: deps.navDedupeWindowMs,
        execute: undefined,
    };
    ctx.execute = (cmd: Command) => executeCommand(ctx, cmd);
    return ctx;
};

const validationError = (input: unknown, message: string, details?: unknown) => {
    const tabToken = typeof (input as any)?.tabToken === 'string' ? ((input as any).tabToken as string) : '';
    return errorResult(tabToken, ERROR_CODES.ERR_BAD_ARGS, message, undefined, details);
};

const parseInput = <T>(schema: z.ZodType<T>, input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false as const,
            result: validationError(input, 'invalid tool arguments', parsed.error.issues),
        };
    }
    return { ok: true as const, data: parsed.data };
};

const toTarget = (target: unknown): Target => target as Target;

const handleGoto = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserGotoInput>(browserGotoInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    const ctx = await buildActionContext(deps, input.tabToken, input.url);
    const command: PageGotoCommand = {
        cmd: 'page.goto',
        tabToken: input.tabToken,
        args: { url: input.url, waitUntil: 'domcontentloaded' },
    };
    return executeCommand(ctx, command);
};

const handleClick = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserClickInput>(browserClickInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    const ctx = await buildActionContext(deps, input.tabToken);
    const command: ElementClickCommand = {
        cmd: 'element.click',
        tabToken: input.tabToken,
        args: { target: toTarget(input.target), options: { timeout: 5000, noWaitAfter: true } },
    };
    return executeCommand(ctx, command);
};

const handleType = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserTypeInput>(browserTypeInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    const ctx = await buildActionContext(deps, input.tabToken);
    const target = toTarget(input.target);
    if (input.clearFirst) {
        const command: ElementFillCommand = {
            cmd: 'element.fill',
            tabToken: input.tabToken,
            args: { target, text: input.text },
        };
        return executeCommand(ctx, command);
    }
    const command: ElementTypeCommand = {
        cmd: 'element.type',
        tabToken: input.tabToken,
        args: { target, text: input.text },
    };
    return executeCommand(ctx, command);
};

const handleSnapshot = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserSnapshotInput>(browserSnapshotInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    if (input.includeA11y) {
        return errorResult(
            input.tabToken,
            ERROR_CODES.ERR_UNSUPPORTED,
            'includeA11y is not supported yet',
        );
    }
    const page = await getOrCreatePage(deps.pageRegistry, input.tabToken);
    const title = await page.title();
    return okResult(input.tabToken, { url: page.url(), title });
};

export const createToolHandlers = (deps: McpToolDeps): Record<string, McpToolHandler> => ({
    'browser.goto': handleGoto(deps),
    'browser.click': handleClick(deps),
    'browser.type': handleType(deps),
    'browser.snapshot': handleSnapshot(deps),
});
