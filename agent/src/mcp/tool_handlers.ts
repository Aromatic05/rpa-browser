import { z } from 'zod';
import crypto from 'crypto';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import { runSteps } from '../runner/run_steps';
import type { Step, StepUnion } from '../runner/steps/types';
import {
    browserClickInputSchema,
    browserGotoInputSchema,
    browserSnapshotInputSchema,
    type BrowserClickInput,
    type BrowserGotoInput,
    type BrowserSnapshotInput,
    browserFillInputSchema,
    type BrowserFillInput,
} from './schemas';

export type McpToolDeps = {
    pageRegistry: PageRegistry;
    recordingState: RecordingState;
    log: (...args: unknown[]) => void;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
};

export type McpToolHandler = (args: unknown) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>;

const parseInput = <T>(schema: z.ZodType<T>, input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false as const,
            error: { code: 'ERR_BAD_ARGS', message: 'invalid tool arguments', details: parsed.error.issues },
        };
    }
    return { ok: true as const, data: parsed.data };
};

const runSingleStep = async (deps: McpToolDeps, tabToken: string, step: StepUnion) => {
    const scope = deps.pageRegistry.resolveScopeFromToken(tabToken);
    deps.pageRegistry.setActiveWorkspace(scope.workspaceId);
    deps.pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);
    const result = await runSteps({
        workspaceId: scope.workspaceId,
        steps: [step],
        options: { stopOnError: true },
    });
    const first = result.results[0];
    if (!first) {
        return { ok: false, error: { code: 'ERR_UNKNOWN', message: 'empty result' } };
    }
    if (!first.ok) {
        return { ok: false, error: first.error };
    }
    return { ok: true, data: first.data };
};

const handleGoto = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGotoInput>(browserGotoInputSchema, args);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.goto',
        args: { url: input.url },
        meta: { source: 'mcp' },
    });
};

const handleClick = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserClickInput>(browserClickInputSchema, args);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.click',
        args: { a11yNodeId: input.a11yNodeId, timeout: input.timeout },
        meta: { source: 'mcp' },
    });
};

const handleFill = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserFillInput>(browserFillInputSchema, args);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.fill',
        args: { a11yNodeId: input.a11yNodeId, value: input.value },
        meta: { source: 'mcp' },
    });
};

const handleSnapshot = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserSnapshotInput>(browserSnapshotInputSchema, args);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.snapshot',
        args: { includeA11y: input.includeA11y },
        meta: { source: 'mcp' },
    });
};

export const createToolHandlers = (deps: McpToolDeps): Record<string, McpToolHandler> => ({
    'browser.goto': handleGoto(deps),
    'browser.click': handleClick(deps),
    'browser.snapshot': handleSnapshot(deps),
    'browser.fill': handleFill(deps),
});
