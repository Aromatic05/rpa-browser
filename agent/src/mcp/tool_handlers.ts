import { type z } from 'zod';
import crypto from 'crypto';
import type { PageRegistry } from '../runtime/page_registry';
import type { WorkspaceRegistry } from '../runtime/workspace_registry';
import type { RunnerConfig } from '../config';
import { runStepList } from '../runner/run_steps';
import type { RunStepsDeps } from '../runner/run_steps_types';
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
    browserListTabsInputSchema,
    type BrowserListTabsInput,
    browserTakeScreenshotInputSchema,
    type BrowserTakeScreenshotInput,
    browserCaptureResolveInputSchema,
    type BrowserCaptureResolveInput,
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
    browserEntityInputSchema,
    type BrowserEntityInput,
    browserQueryInputSchema,
    type BrowserQueryInput,
    browserBatchInputSchema,
    type BrowserBatchInput,
} from './schemas';

export type McpToolDeps = {
    pageRegistry: PageRegistry;
    workspaceRegistry: WorkspaceRegistry;
    config?: RunnerConfig;
    log?: (...args: unknown[]) => void;
    runStepsDeps?: RunStepsDeps;
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
    tabName: string | undefined,
    step: StepUnion,
    options?: { allowBootstrap?: boolean },
) => {
    const scope = await resolveOrBootstrapScope(deps, tabName, options);
    const workspace = deps.workspaceRegistry.createWorkspace(scope.workspaceName);
    if (workspace.tabRegistry.hasTab(scope.tabId)) {
        workspace.tabRegistry.setActiveTab(scope.tabId);
    }
    const { pipe, checkpoint } = await runStepList(scope.workspaceName, [step], deps.runStepsDeps, {
        stopOnError: true,
    });
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
    tabName: string | undefined,
    options?: { allowBootstrap?: boolean },
): Promise<{ workspaceName: string; tabId: string }> => {
    const allowBootstrap = options?.allowBootstrap !== false;
    const resolvedTabName = resolveTabNameOrActive(deps, tabName);
    for (const workspace of deps.workspaceRegistry.listWorkspaces()) {
        if (workspace.tabRegistry.hasTab(resolvedTabName)) {
            return { workspaceName: workspace.name, tabId: resolvedTabName };
        }
    }
    if (!allowBootstrap) {
        throw new Error('tab not found');
    }
    const workspaceName = deps.workspaceRegistry.getActiveWorkspace()?.name || 'default';
    const workspace = deps.workspaceRegistry.createWorkspace(workspaceName);
    const page = await deps.pageRegistry.getPage(resolvedTabName);
    if (!workspace.tabRegistry.hasTab(resolvedTabName)) {
        workspace.tabRegistry.createTab({ tabName: resolvedTabName, page, url: page.url() });
    } else {
        workspace.tabRegistry.bindPage(resolvedTabName, page);
    }
    workspace.tabRegistry.setActiveTab(resolvedTabName);
    return { workspaceName, tabId: resolvedTabName };
};

const resolveTabNameOrActive = (deps: McpToolDeps, tabName?: string): string => {
    if (typeof tabName === 'string' && tabName.trim().length > 0) {
        return tabName;
    }
    const activeWorkspace = deps.workspaceRegistry.getActiveWorkspace();
    const activeTab = activeWorkspace?.tabRegistry.getActiveTab();
    if (activeTab?.name) {
        return activeTab.name;
    }
    throw new Error('active tab not found');
};

const resolveOrCreateTabName = (deps: McpToolDeps, tabName?: string): string => {
    if (typeof tabName === 'string' && tabName.trim().length > 0) {
        return tabName;
    }
    const activeWorkspace = deps.workspaceRegistry.getActiveWorkspace();
    return activeWorkspace?.tabRegistry.getActiveTab()?.name || crypto.randomUUID();
};

const handleGoto = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGotoInput>(browserGotoInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.goto',
        args: { url: input.url },
        meta: { source: 'mcp' },
    });
};

const handleGoBack = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGoBackInput>(browserGoBackInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.go_back',
        args: {},
        meta: { source: 'mcp' },
    });
};

const handleReload = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserReloadInput>(browserReloadInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.reload',
        args: {},
        meta: { source: 'mcp' },
    });
};

const handleCreateTab = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserCreateTabInput>(browserCreateTabInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    const sourceTabName = resolveOrCreateTabName(deps, input.tabName);
    const result = await runSingleStep(deps, sourceTabName, {
        id: crypto.randomUUID(),
        name: 'browser.create_tab',
        args: { url: input.url },
        meta: { source: 'mcp' },
    });
    if (!result.ok) {return result;}

    return result;
};

const handleSwitchTab = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserSwitchTabInput>(browserSwitchTabInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    const sourceTabName = resolveTabNameOrActive(deps, input.tabName);
    const result = await runSingleStep(deps, sourceTabName, {
        id: crypto.randomUUID(),
        name: 'browser.switch_tab',
        args: { tabId: input.tabId, tabRef: input.tabRef, tabUrl: input.tabUrl },
        meta: { source: 'mcp' },
    });
    if (!result.ok) {return result;}

    return result;
};

const handleCloseTab = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserCloseTabInput>(browserCloseTabInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.close_tab',
        args: { tabId: input.tabId, tabRef: input.tabRef },
        meta: { source: 'mcp' },
    });
};

const handleGetPageInfo = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGetPageInfoInput>(browserGetPageInfoInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    try {
        return await runSingleStep(
            deps,
            input.tabName,
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
                        message: 'tab not found',
                    },
                },
            ],
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'tab not found',
            },
        };
    }
};

const handleListTabs = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserListTabsInput>(browserListTabsInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    try {
        return await runSingleStep(
            deps,
            input.tabName,
            {
                id: crypto.randomUUID(),
                name: 'browser.list_tabs',
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
                        message: 'tab not found',
                    },
                },
            ],
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'tab not found',
            },
        };
    }
};

const handleClick = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserClickInput>(browserClickInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    const options = {
        button: input.options?.button ?? 'left',
        double: input.options?.double ?? false,
    };
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.click',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            coord: input.coord,
            resolveId: input.resolveId,
            options,
        },
        meta: { source: 'mcp' },
    });
};

const handleFill = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserFillInput>(browserFillInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.fill',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            resolveId: input.resolveId,
            value: input.value,
        },
        meta: { source: 'mcp' },
    });
};

const handleType = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserTypeInput>(browserTypeInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.type',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            resolveId: input.resolveId,
            text: input.text,
            delay_ms: input.delay_ms ?? 0,
        },
        meta: { source: 'mcp' },
    });
};

const handleSelectOption = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserSelectOptionInput>(browserSelectOptionInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.select_option',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            resolveId: input.resolveId,
            values: input.values,
        },
        meta: { source: 'mcp' },
    });
};

const handleHover = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserHoverInput>(browserHoverInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.hover',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            resolveId: input.resolveId,
        },
        meta: { source: 'mcp' },
    });
};

const handleScroll = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserScrollInput>(browserScrollInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.scroll',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            resolveId: input.resolveId,
            direction: input.direction,
            amount: input.amount ?? 600,
        },
        meta: { source: 'mcp' },
    });
};

const handlePressKey = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserPressKeyInput>(browserPressKeyInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.press_key',
        args: {
            key: input.key,
            nodeId: input.nodeId,
            selector: input.selector,
            resolveId: input.resolveId,
        },
        meta: { source: 'mcp' },
    });
};

const handleDragAndDrop = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserDragAndDropInput>(browserDragAndDropInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.drag_and_drop',
        args: {
            sourceNodeId: input.sourceNodeId,
            sourceSelector: input.sourceSelector,
            sourceResolveId: input.sourceResolveId,
            destNodeId: input.destNodeId,
            destSelector: input.destSelector,
            destResolveId: input.destResolveId,
            destCoord: input.destCoord,
        },
        meta: { source: 'mcp' },
    });
};

const handleMouse = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserMouseInput>(browserMouseInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
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
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
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

const handleEntity = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserEntityInput>(browserEntityInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    const { tabName, ...stepArgs } = input;
    return await runSingleStep(deps, tabName, {
        id: crypto.randomUUID(),
        name: 'browser.entity',
        args: stepArgs,
        meta: { source: 'mcp' },
    });
};

const handleQuery = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserQueryInput>(browserQueryInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    const { tabName, ...stepArgs } = input;
    return await runSingleStep(deps, tabName, {
        id: crypto.randomUUID(),
        name: 'browser.query',
        args: stepArgs,
        meta: { source: 'mcp' },
    });
};

const handleGetContent = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserGetContentInput>(browserGetContentInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.get_content',
        args: { ref: input.ref },
        meta: { source: 'mcp' },
    });
};

const handleReadConsole = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserReadConsoleInput>(browserReadConsoleInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.read_console',
        args: { limit: input.limit },
        meta: { source: 'mcp' },
    });
};

const handleReadNetwork = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserReadNetworkInput>(browserReadNetworkInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.read_network',
        args: { limit: input.limit },
        meta: { source: 'mcp' },
    });
};

const handleEvaluate = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserEvaluateInput>(browserEvaluateInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
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
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.take_screenshot',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            resolveId: input.resolveId,
            full_page: input.full_page,
            inline: input.inline,
        },
        meta: { source: 'mcp' },
    });
};

const handleCaptureResolve = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserCaptureResolveInput>(browserCaptureResolveInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    return await runSingleStep(deps, input.tabName, {
        id: crypto.randomUUID(),
        name: 'browser.capture_resolve',
        args: {
            nodeId: input.nodeId,
            selector: input.selector,
            text: input.text,
            role: input.role,
            name: input.name,
            limit: input.limit,
        },
        meta: { source: 'mcp' },
    });
};

type SnapshotLikeNode = {
    id?: string;
    role?: string;
    name?: string;
    children?: SnapshotLikeNode[];
};

const normalizeText = (value: string | undefined): string => (value || '').trim().toLowerCase();

const walkSnapshotNodes = (node: SnapshotLikeNode | undefined, out: SnapshotLikeNode[]) => {
    if (!node) {return;}
    out.push(node);
    for (const child of node.children || []) {
        walkSnapshotNodes(child, out);
    }
};

const defaultRoleByBatchOp = (op: BrowserBatchInput['actions'][number]['op']): string => {
    if (op === 'fill') {return 'textbox';}
    if (op === 'select_option') {return 'combobox';}
    return 'button';
};

const resolveBatchActionTargetsByLabel = async (
    deps: McpToolDeps,
    tabName: string | undefined,
    input: BrowserBatchInput,
): Promise<{ ok: true; actions: BrowserBatchInput['actions'] } | { ok: false; error: unknown }> => {
    const unresolved = input.actions.filter((action) => !action.nodeId && !action.selector && action.label);
    if (unresolved.length === 0) {
        return { ok: true, actions: input.actions };
    }

    const snap = await runSingleStep(deps, tabName, {
        id: crypto.randomUUID(),
        name: 'browser.snapshot',
        args: {
            contain: input.contain,
            depth: input.depth,
            filter: { interactive: true },
        },
        meta: { source: 'mcp' },
    });
    if (!snap.ok) {
        return { ok: false, error: snap.error || { code: 'ERR_INTERNAL', message: 'batch pre-snapshot failed' } };
    }

    const root = (snap.results.find((item) => item.ok)?.data || null);
    const nodes: SnapshotLikeNode[] = [];
    walkSnapshotNodes(root || undefined, nodes);

    const resolved = input.actions.map((action) => ({ ...action }));
    for (let idx = 0; idx < resolved.length; idx += 1) {
        const action = resolved[idx];
        if (action.nodeId || action.selector || !action.label) {continue;}
        const wantedRole = normalizeText(action.role || defaultRoleByBatchOp(action.op));
        const wantedLabel = normalizeText(action.label);
        const candidates = nodes.filter((node) => {
            const role = normalizeText(node.role);
            const name = normalizeText(node.name);
            return role === wantedRole && name === wantedLabel && typeof node.id === 'string' && node.id.length > 0;
        });
        if (candidates.length === 0) {
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'batch label target not found',
                    details: { actionIndex: idx, label: action.label, role: wantedRole },
                },
            };
        }
        if (candidates.length > 1) {
            return {
                ok: false,
                error: {
                    code: 'ERR_AMBIGUOUS',
                    message: 'batch label target is ambiguous',
                    details: {
                        actionIndex: idx,
                        label: action.label,
                        role: wantedRole,
                        candidateIds: candidates.map((item) => item.id),
                    },
                },
            };
        }
        action.nodeId = candidates[0].id!;
    }

    return { ok: true, actions: resolved as BrowserBatchInput['actions'] };
};

const toBatchStep = (action: BrowserBatchInput['actions'][number]): StepUnion => {
    const stepId = crypto.randomUUID();
    if (action.op === 'fill') {
        return {
                id: stepId,
                name: 'browser.fill',
                args: {
                nodeId: action.nodeId,
                selector: action.selector,
                value: action.value,
            },
            meta: { source: 'mcp' },
        };
    }
    if (action.op === 'select_option') {
        return {
            id: stepId,
            name: 'browser.select_option',
            args: {
                nodeId: action.nodeId,
                selector: action.selector,
                values: action.values,
            },
            meta: { source: 'mcp' },
        };
    }
    return {
        id: stepId,
        name: 'browser.click',
        args: {
            nodeId: action.nodeId,
            selector: action.selector,
            coord: action.coord,
            options: action.options,
        },
        meta: { source: 'mcp' },
    };
};

const handleBatch = (deps: McpToolDeps): McpToolHandler => async (args: unknown) => {
    const parsed = parseInput<BrowserBatchInput>(browserBatchInputSchema, args);
    if (!parsed.ok) {return buildParseErrorResult(parsed.error);}
    const input = parsed.data;
    const stopOnError = input.stopOnError !== false;

    const resolved = await resolveBatchActionTargetsByLabel(deps, input.tabName, input);
    if (!resolved.ok) {
        return buildParseErrorResult(resolved.error);
    }

    const finalResults: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < resolved.actions.length; idx += 1) {
        const action = resolved.actions[idx];
        const step = toBatchStep(action);
        const stepResult = await runSingleStep(deps, input.tabName, step);
        const first = stepResult.results[0] as Record<string, unknown> | undefined;
        finalResults.push({
            actionIndex: idx,
            op: action.op,
            ...first,
        });
        if (!stepResult.ok && stopOnError) {
            return {
                ok: false,
                results: finalResults,
                error: stepResult.error || first?.error,
            };
        }
    }

    return {
        ok: finalResults.every((item) => item.ok === true),
        results: finalResults,
        error: finalResults.find((item) => item.ok !== true)?.error,
    };
};

export const createToolHandlers = (deps: McpToolDeps): Record<string, McpToolHandler> => ({
    'browser.goto': handleGoto(deps),
    'browser.go_back': handleGoBack(deps),
    'browser.reload': handleReload(deps),
    'browser.create_tab': handleCreateTab(deps),
    'browser.switch_tab': handleSwitchTab(deps),
    'browser.close_tab': handleCloseTab(deps),
    'browser.get_page_info': handleGetPageInfo(deps),
    'browser.list_tabs': handleListTabs(deps),
    'browser.click': handleClick(deps),
    'browser.snapshot': handleSnapshot(deps),
    'browser.capture_resolve': handleCaptureResolve(deps),
    'browser.entity': handleEntity(deps),
    'browser.query': handleQuery(deps),
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
    'browser.batch': handleBatch(deps),
});
