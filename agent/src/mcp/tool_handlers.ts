import { z } from 'zod';
import crypto from 'crypto';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import { runSteps } from '../runner/run_steps';
import type { StepUnion } from '../runner/steps/types';
import {
    browserClickInputSchema,
    browserGotoInputSchema,
    browserSnapshotInputSchema,
    type BrowserClickInput,
    type BrowserGotoInput,
    type BrowserSnapshotInput,
    browserFillInputSchema,
    type BrowserFillInput,
    browserGoBackInputSchema,
    type BrowserGoBackInput,
    browserReloadInputSchema,
    type BrowserReloadInput,
    browserCreateTabInputSchema,
    type BrowserCreateTabInput,
    browserSwitchTabInputSchema,
    type BrowserSwitchTabInput,
    browserCloseTabInputSchema,
    type BrowserCloseTabInput,
    browserGetPageInfoInputSchema,
    type BrowserGetPageInfoInput,
    browserTakeScreenshotInputSchema,
    type BrowserTakeScreenshotInput,
    browserTypeInputSchema,
    type BrowserTypeInput,
    browserSelectOptionInputSchema,
    type BrowserSelectOptionInput,
    browserHoverInputSchema,
    type BrowserHoverInput,
    browserScrollInputSchema,
    type BrowserScrollInput,
    browserPressKeyInputSchema,
    type BrowserPressKeyInput,
    browserDragAndDropInputSchema,
    type BrowserDragAndDropInput,
    browserMouseInputSchema,
    type BrowserMouseInput,
} from './schemas';

export type McpToolDeps = {
    pageRegistry: PageRegistry;
    recordingState: RecordingState;
    log: (...args: unknown[]) => void;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
};

export type McpToolHandler = (args: unknown) => Promise<{ ok: boolean; results: unknown[]; trace?: unknown; error?: unknown }>;

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

const buildParseErrorResult = (error: unknown) => ({
    ok: false,
    results: [{ stepId: 'invalid', ok: false, error }],
    error,
});

const runSingleStep = async (deps: McpToolDeps, tabToken: string, step: StepUnion) => {
    const scope = deps.pageRegistry.resolveScopeFromToken(tabToken);
    deps.pageRegistry.setActiveWorkspace(scope.workspaceId);
    deps.pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);
    return runSteps({
        workspaceId: scope.workspaceId,
        steps: [step],
        options: { stopOnError: true },
    });
};

const handleGoto = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGotoInput>(browserGotoInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.goto',
        args: { url: input.url, timeout: input.timeout },
        meta: { source: 'mcp' },
    });
};

const handleGoBack = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGoBackInput>(browserGoBackInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.go_back',
        args: { timeout: input.timeout },
        meta: { source: 'mcp' },
    });
};

const handleReload = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserReloadInput>(browserReloadInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.reload',
        args: { timeout: input.timeout },
        meta: { source: 'mcp' },
    });
};

const handleCreateTab = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserCreateTabInput>(browserCreateTabInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.create_tab',
        args: { url: input.url },
        meta: { source: 'mcp' },
    });
};

const handleSwitchTab = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserSwitchTabInput>(browserSwitchTabInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.switch_tab',
        args: { tab_id: input.tab_id },
        meta: { source: 'mcp' },
    });
};

const handleCloseTab = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserCloseTabInput>(browserCloseTabInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.close_tab',
        args: { tab_id: input.tab_id },
        meta: { source: 'mcp' },
    });
};

const handleGetPageInfo = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGetPageInfoInput>(browserGetPageInfoInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.get_page_info',
        args: {},
        meta: { source: 'mcp' },
    });
};

const handleClick = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserClickInput>(browserClickInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    const options = {
        button: input.options?.button ?? 'left',
        double: input.options?.double ?? false,
    };
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.click',
        args: {
            target: input.target,
            coord: input.coord,
            options,
            timeout: input.timeout,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

const handleFill = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserFillInput>(browserFillInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.fill',
        args: {
            target: input.target,
            value: input.value,
            timeout: input.timeout,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

const handleType = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserTypeInput>(browserTypeInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.type',
        args: {
            target: input.target,
            text: input.text,
            delay_ms: input.delay_ms ?? 0,
            timeout: input.timeout,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

const handleSelectOption = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserSelectOptionInput>(browserSelectOptionInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.select_option',
        args: {
            target: input.target,
            values: input.values,
            timeout: input.timeout,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

const handleHover = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserHoverInput>(browserHoverInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.hover',
        args: {
            target: input.target,
            timeout: input.timeout,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

const handleScroll = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserScrollInput>(browserScrollInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.scroll',
        args: {
            target: input.target,
            direction: input.direction,
            amount: input.amount ?? 600,
            timeout: input.timeout,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

const handlePressKey = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserPressKeyInput>(browserPressKeyInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.press_key',
        args: {
            key: input.key,
            target: input.target,
            timeout: input.timeout,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

const handleDragAndDrop = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserDragAndDropInput>(browserDragAndDropInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.drag_and_drop',
        args: {
            source: input.source,
            dest_target: input.dest_target,
            dest_coord: input.dest_coord,
            timeout: input.timeout,
        },
        meta: { source: 'mcp' },
    });
};

const handleMouse = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserMouseInput>(browserMouseInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.mouse',
        args: {
            action: input.action,
            x: input.x,
            y: input.y,
            deltaY: input.deltaY,
            button: input.button,
        },
        meta: { source: 'mcp' },
    });
};

const handleSnapshot = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserSnapshotInput>(browserSnapshotInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.snapshot',
        args: { includeA11y: input.includeA11y ?? true, focus_only: input.focus_only ?? false },
        meta: { source: 'mcp' },
    });
};

const handleTakeScreenshot = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserTakeScreenshotInput>(browserTakeScreenshotInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.take_screenshot',
        args: {
            target: input.target,
            full_page: input.full_page,
            a11yNodeId: input.a11yNodeId,
            a11yHint: input.a11yHint,
        },
        meta: { source: 'mcp' },
    });
};

export const createToolHandlers = (deps: McpToolDeps): Record<string, McpToolHandler> => ({
    'browser.goto': handleGoto(deps),
    'browser.go_back': handleGoBack(deps),
    'browser.reload': handleReload(deps),
    'browser.create_tab': handleCreateTab(deps),
    'browser.switch_tab': handleSwitchTab(deps),
    'browser.close_tab': handleCloseTab(deps),
    'browser.get_page_info': handleGetPageInfo(deps),
    'browser.click': handleClick(deps),
    'browser.snapshot': handleSnapshot(deps),
    'browser.fill': handleFill(deps),
    'browser.take_screenshot': handleTakeScreenshot(deps),
    'browser.type': handleType(deps),
    'browser.select_option': handleSelectOption(deps),
    'browser.hover': handleHover(deps),
    'browser.scroll': handleScroll(deps),
    'browser.press_key': handlePressKey(deps),
    'browser.drag_and_drop': handleDragAndDrop(deps),
    'browser.mouse': handleMouse(deps),
});
