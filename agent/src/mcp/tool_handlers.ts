import { z } from 'zod';
import crypto from 'crypto';
import type { PageRegistry } from '../runtime/page_registry';
import { runStepList } from '../runner/run_steps';
import type { StepUnion } from '../runner/steps/types';
import {
    browserClickInputSchema,
    browserGotoInputSchema,
    browserSnapshotInputSchema,
    type BrowserClickInput,
    type BrowserGotoInput,
    type BrowserSnapshotInput,
    browserGetContentInputSchema,
    type BrowserGetContentInput,
    browserReadConsoleInputSchema,
    type BrowserReadConsoleInput,
    browserReadNetworkInputSchema,
    type BrowserReadNetworkInput,
    browserEvaluateInputSchema,
    type BrowserEvaluateInput,
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
    browserListEntitiesInputSchema,
    type BrowserListEntitiesInput,
    browserGetEntityInputSchema,
    type BrowserGetEntityInput,
    browserFindEntitiesInputSchema,
    type BrowserFindEntitiesInput,
    browserAddEntityInputSchema,
    type BrowserAddEntityInput,
    browserDeleteEntityInputSchema,
    type BrowserDeleteEntityInput,
    browserRenameEntityInputSchema,
    type BrowserRenameEntityInput,
} from './schemas';

export type McpToolDeps = {
    pageRegistry: PageRegistry;
    log?: (...args: unknown[]) => void;
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

const runSingleStep = async (
    deps: McpToolDeps,
    tabToken: string | undefined,
    step: StepUnion,
    options?: { allowBootstrap?: boolean },
) => {
    const scope = await resolveOrBootstrapScope(deps, tabToken, options);
    deps.pageRegistry.setActiveWorkspace(scope.workspaceId);
    deps.pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);
    const { pipe, checkpoint } = await runStepList(scope.workspaceId, [step], undefined, { stopOnError: true });
    const items = pipe.items as Array<{ stepId: string; ok: boolean; data?: unknown; error?: unknown }>;
    const results = items.map((item) => ({ stepId: item.stepId, ok: item.ok, data: item.data, error: item.error }));
    if (checkpoint.status === 'failed') {
        return {
            ok: false,
            results,
            error: results.find((item) => !item.ok)?.error,
        };
    }
    return { ok: results.every((item) => item.ok), results };
};

const resolveOrBootstrapScope = async (
    deps: McpToolDeps,
    tabToken: string | undefined,
    options?: { allowBootstrap?: boolean },
): Promise<{ workspaceId: string; tabId: string }> => {
    const allowBootstrap = options?.allowBootstrap !== false;
    const resolvedTabToken = resolveTabTokenOrActive(deps, tabToken);
    try {
        return deps.pageRegistry.resolveScopeFromToken(resolvedTabToken);
    } catch {
        if (!allowBootstrap) {
            throw new Error('tab token not found');
        }
        const shell = deps.pageRegistry.createWorkspaceShell();
        deps.pageRegistry.setActiveWorkspace(shell.workspaceId);
        await deps.pageRegistry.getPage(resolvedTabToken);
        const bound = deps.pageRegistry.bindTokenToWorkspace(resolvedTabToken, shell.workspaceId);
        if (bound) {
            return bound;
        }
        return deps.pageRegistry.resolveScopeFromToken(resolvedTabToken);
    }
};

const resolveTabTokenOrActive = (deps: McpToolDeps, tabToken?: string): string => {
    if (typeof tabToken === 'string' && tabToken.trim().length > 0) {
        return tabToken;
    }
    try {
        return deps.pageRegistry.resolveTabToken();
    } catch {
        throw new Error('active tab not found');
    }
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
    const sourceTabToken = resolveTabTokenOrActive(deps, input.tabToken);
    const result = await runSingleStep(deps, sourceTabToken, {
        id: crypto.randomUUID(),
        name: 'browser.create_tab',
        args: { url: input.url },
        meta: { source: 'mcp' },
    });
    if (!result.ok) return result;

    const createdTabId = result.results.find((item) => item.ok)?.data as { tab_id?: unknown } | undefined;
    if (typeof createdTabId?.tab_id === 'string') {
        const scope = deps.pageRegistry.resolveScopeFromToken(sourceTabToken);
        deps.pageRegistry.rebindTokenToTab(sourceTabToken, scope.workspaceId, createdTabId.tab_id);
    }
    return result;
};

const handleSwitchTab = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserSwitchTabInput>(browserSwitchTabInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    const sourceTabToken = resolveTabTokenOrActive(deps, input.tabToken);
    const result = await runSingleStep(deps, sourceTabToken, {
        id: crypto.randomUUID(),
        name: 'browser.switch_tab',
        args: { tab_id: input.tab_id },
        meta: { source: 'mcp' },
    });
    if (!result.ok) return result;

    const scope = deps.pageRegistry.resolveScopeFromToken(sourceTabToken);
    deps.pageRegistry.rebindTokenToTab(sourceTabToken, scope.workspaceId, input.tab_id);
    return result;
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
    try {
        return await runSingleStep(
            deps,
            input.tabToken,
            {
                id: crypto.randomUUID(),
                name: 'browser.get_page_info',
                args: {},
                meta: { source: 'mcp' },
            },
            { allowBootstrap: false },
        );
    } catch {
        return {
            ok: false,
            results: [
                {
                    stepId: 'invalid',
                    ok: false,
                    error: {
                        code: 'ERR_NOT_FOUND',
                        message: 'tab token not found',
                    },
                },
            ],
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'tab token not found',
            },
        };
    }
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
            id: input.id,
            selector: input.selector,
            coord: input.coord,
            options,
            timeout: input.timeout,
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
            id: input.id,
            selector: input.selector,
            value: input.value,
            timeout: input.timeout,
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
            id: input.id,
            selector: input.selector,
            text: input.text,
            delay_ms: input.delay_ms ?? 0,
            timeout: input.timeout,
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
            id: input.id,
            selector: input.selector,
            values: input.values,
            timeout: input.timeout,
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
            id: input.id,
            selector: input.selector,
            timeout: input.timeout,
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
            id: input.id,
            selector: input.selector,
            direction: input.direction,
            amount: input.amount ?? 600,
            timeout: input.timeout,
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
            id: input.id,
            selector: input.selector,
            timeout: input.timeout,
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
            source: {
                id: input.source_id,
                selector: input.source_selector,
            },
            dest_target:
                input.dest_id || input.dest_selector
                    ? {
                          id: input.dest_id,
                          selector: input.dest_selector,
                      }
                    : undefined,
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
        args: {
            includeA11y: input.includeA11y,
            focus_only: input.focus_only,
            refresh: input.refresh,
            contain: input.contain,
            depth: input.depth,
            filter: input.filter,
            diff: input.diff,
        },
        meta: { source: 'mcp' },
    });
};

const handleListEntities = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserListEntitiesInput>(browserListEntitiesInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.list_entities',
        args: {
            kind: input.kind,
            businessTag: input.businessTag,
            query: input.query,
        },
        meta: { source: 'mcp' },
    });
};

const handleGetEntity = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGetEntityInput>(browserGetEntityInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.get_entity',
        args: {
            nodeId: input.nodeId,
        },
        meta: { source: 'mcp' },
    });
};

const handleFindEntities = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserFindEntitiesInput>(browserFindEntitiesInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.find_entities',
        args: {
            query: input.query,
            kind: input.kind,
            businessTag: input.businessTag,
        },
        meta: { source: 'mcp' },
    });
};

const handleAddEntity = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserAddEntityInput>(browserAddEntityInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.add_entity',
        args: {
            nodeId: input.nodeId,
            kind: input.kind,
            name: input.name,
            businessTag: input.businessTag,
        },
        meta: { source: 'mcp' },
    });
};

const handleDeleteEntity = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserDeleteEntityInput>(browserDeleteEntityInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.delete_entity',
        args: {
            nodeId: input.nodeId,
            kind: input.kind,
            businessTag: input.businessTag,
        },
        meta: { source: 'mcp' },
    });
};

const handleRenameEntity = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserRenameEntityInput>(browserRenameEntityInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.rename_entity',
        args: {
            nodeId: input.nodeId,
            name: input.name,
        },
        meta: { source: 'mcp' },
    });
};

const handleGetContent = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGetContentInput>(browserGetContentInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.get_content',
        args: { ref: input.ref },
        meta: { source: 'mcp' },
    });
};

const handleReadConsole = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserReadConsoleInput>(browserReadConsoleInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.read_console',
        args: { limit: input.limit },
        meta: { source: 'mcp' },
    });
};

const handleReadNetwork = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserReadNetworkInput>(browserReadNetworkInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.read_network',
        args: { limit: input.limit },
        meta: { source: 'mcp' },
    });
};

const handleEvaluate = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserEvaluateInput>(browserEvaluateInputSchema, args);
    if (!parsed.ok) return buildParseErrorResult(parsed.error);
    const input = parsed.data;
    return runSingleStep(deps, input.tabToken, {
        id: crypto.randomUUID(),
        name: 'browser.evaluate',
        args: {
            expression: input.expression,
            arg: input.arg,
            mutatesPage: input.mutatesPage,
        },
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
            id: input.id,
            selector: input.selector,
            full_page: input.full_page,
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
    'browser.list_entities': handleListEntities(deps),
    'browser.get_entity': handleGetEntity(deps),
    'browser.find_entities': handleFindEntities(deps),
    'browser.add_entity': handleAddEntity(deps),
    'browser.delete_entity': handleDeleteEntity(deps),
    'browser.rename_entity': handleRenameEntity(deps),
    'browser.get_content': handleGetContent(deps),
    'browser.read_console': handleReadConsole(deps),
    'browser.read_network': handleReadNetwork(deps),
    'browser.evaluate': handleEvaluate(deps),
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
