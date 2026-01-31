import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import { z } from 'zod';
import { executeTool } from '../runner/tool_registry';
import { ERROR_CODES } from '../runner/error_codes';
import { errorResult, type Result } from '../runner/results';
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

const buildRegistryDeps = (deps: McpToolDeps, tabToken: string) => ({
    pageRegistry: deps.pageRegistry,
    recordingState: deps.recordingState,
    log: deps.log,
    replayOptions: deps.replayOptions,
    navDedupeWindowMs: deps.navDedupeWindowMs,
    getActiveTabToken: async () => tabToken,
});

const handleGoto = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserGotoInput>(browserGotoInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    return executeTool(
        buildRegistryDeps(deps, input.tabToken),
        'browser.goto',
        { url: input.url },
        { tabTokenOverride: input.tabToken },
    );
};

const handleClick = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserClickInput>(browserClickInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    return executeTool(
        buildRegistryDeps(deps, input.tabToken),
        'browser.click',
        { target: input.target },
        { tabTokenOverride: input.tabToken },
    );
};

const handleType = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserTypeInput>(browserTypeInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    return executeTool(
        buildRegistryDeps(deps, input.tabToken),
        'browser.type',
        { target: input.target, text: input.text, clearFirst: input.clearFirst },
        { tabTokenOverride: input.tabToken },
    );
};

const handleSnapshot = (deps: McpToolDeps) => async (args: unknown): Promise<Result> => {
    const parsed = parseInput<BrowserSnapshotInput>(browserSnapshotInputSchema, args);
    if (!parsed.ok) return parsed.result;
    const input = parsed.data;
    return executeTool(
        buildRegistryDeps(deps, input.tabToken),
        'browser.snapshot',
        { includeA11y: input.includeA11y, maxNodes: input.maxNodes },
        { tabTokenOverride: input.tabToken },
    );
};

export const createToolHandlers = (deps: McpToolDeps): Record<string, McpToolHandler> => ({
    'browser.goto': handleGoto(deps),
    'browser.click': handleClick(deps),
    'browser.type': handleType(deps),
    'browser.snapshot': handleSnapshot(deps),
});
