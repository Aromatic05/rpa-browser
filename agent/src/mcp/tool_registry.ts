import crypto from 'crypto';
import { z } from 'zod';
import type { PageRegistry } from '../runtime/page_registry';
import { runSteps } from '../runner/run_steps';
import type { StepUnion } from '../runner/steps/types';

export type ToolSpec = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

const a11yHintSchema = z.object({
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
});
const targetSchema = z.object({
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
    selector: z.string().optional(),
});
const coordSchema = z.object({
    x: z.number(),
    y: z.number(),
});

const gotoInputSchema = z.object({ url: z.string(), timeout: z.number().int().positive().optional() });
const goBackInputSchema = z.object({ timeout: z.number().int().positive().optional() });
const reloadInputSchema = z.object({ timeout: z.number().int().positive().optional() });
const createTabInputSchema = z.object({ url: z.string().optional() });
const switchTabInputSchema = z.object({ tab_id: z.string() });
const closeTabInputSchema = z.object({ tab_id: z.string().optional() });
const getPageInfoInputSchema = z.object({});
const snapshotInputSchema = z.object({
    includeA11y: z.boolean().optional(),
    focus_only: z.boolean().optional(),
});
const takeScreenshotInputSchema = z.object({
    target: targetSchema.optional(),
    full_page: z.boolean().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const clickInputSchema = z.object({
    target: targetSchema.optional(),
    coord: coordSchema.optional(),
    options: z
        .object({
            button: z.enum(['left', 'right', 'middle']).optional(),
            double: z.boolean().optional(),
        })
        .optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const fillInputSchema = z.object({
    target: targetSchema.optional(),
    value: z.string(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const typeInputSchema = z.object({
    target: targetSchema.optional(),
    text: z.string(),
    delay_ms: z.number().int().min(0).optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const selectOptionInputSchema = z.object({
    target: targetSchema.optional(),
    values: z.array(z.string()),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const hoverInputSchema = z.object({
    target: targetSchema.optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const scrollInputSchema = z.object({
    target: targetSchema.optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const pressKeyInputSchema = z.object({
    key: z.string(),
    target: targetSchema.optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});
const dragAndDropInputSchema = z.object({
    source: targetSchema,
    dest_target: targetSchema.optional(),
    dest_coord: coordSchema.optional(),
    timeout: z.number().int().positive().optional(),
});
const mouseInputSchema = z.object({
    action: z.enum(['move', 'down', 'up', 'wheel']),
    x: z.number(),
    y: z.number(),
    deltaY: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
});

const toolInputJsonSchemas = {
    'browser.goto': {
        type: 'object',
        required: ['url'],
        properties: {
            url: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.go_back': {
        type: 'object',
        required: [],
        properties: {
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.reload': {
        type: 'object',
        required: [],
        properties: {
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.create_tab': {
        type: 'object',
        required: [],
        properties: {
            url: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.switch_tab': {
        type: 'object',
        required: ['tab_id'],
        properties: {
            tab_id: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.close_tab': {
        type: 'object',
        required: [],
        properties: {
            tab_id: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.get_page_info': {
        type: 'object',
        required: [],
        properties: {},
        additionalProperties: false,
    },
    'browser.snapshot': {
        type: 'object',
        required: [],
        properties: {
            includeA11y: { type: 'boolean' },
            focus_only: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    'browser.take_screenshot': {
        type: 'object',
        required: [],
        properties: {
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            full_page: { type: 'boolean' },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    'browser.click': {
        type: 'object',
        required: [],
        properties: {
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            coord: {
                type: 'object',
                properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                },
                required: ['x', 'y'],
                additionalProperties: false,
            },
            options: {
                type: 'object',
                properties: {
                    button: { type: 'string', enum: ['left', 'right', 'middle'] },
                    double: { type: 'boolean' },
                },
                additionalProperties: false,
            },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.fill': {
        type: 'object',
        required: ['value'],
        properties: {
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
            value: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.type': {
        type: 'object',
        required: ['text'],
        properties: {
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            text: { type: 'string' },
            delay_ms: { type: 'integer', minimum: 0 },
            timeout: { type: 'integer', minimum: 1 },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    'browser.select_option': {
        type: 'object',
        required: ['values'],
        properties: {
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            values: { type: 'array', items: { type: 'string' } },
            timeout: { type: 'integer', minimum: 1 },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    'browser.hover': {
        type: 'object',
        required: [],
        properties: {
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            timeout: { type: 'integer', minimum: 1 },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    'browser.scroll': {
        type: 'object',
        required: [],
        properties: {
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            direction: { type: 'string', enum: ['up', 'down'] },
            amount: { type: 'integer', minimum: 1 },
            timeout: { type: 'integer', minimum: 1 },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    'browser.press_key': {
        type: 'object',
        required: ['key'],
        properties: {
            key: { type: 'string' },
            target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            timeout: { type: 'integer', minimum: 1 },
            a11yNodeId: { type: 'string' },
            a11yHint: {
                type: 'object',
                properties: {
                    role: { type: 'string' },
                    name: { type: 'string' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    'browser.drag_and_drop': {
        type: 'object',
        required: ['source'],
        properties: {
            source: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            dest_target: {
                type: 'object',
                properties: {
                    a11yNodeId: { type: 'string' },
                    a11yHint: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            name: { type: 'string' },
                            text: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    selector: { type: 'string' },
                },
                additionalProperties: false,
            },
            dest_coord: {
                type: 'object',
                properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                },
                required: ['x', 'y'],
                additionalProperties: false,
            },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.mouse': {
        type: 'object',
        required: ['action', 'x', 'y'],
        properties: {
            action: { type: 'string', enum: ['move', 'down', 'up', 'wheel'] },
            x: { type: 'number' },
            y: { type: 'number' },
            deltaY: { type: 'number' },
            button: { type: 'string', enum: ['left', 'right', 'middle'] },
        },
        additionalProperties: false,
    },
} as const;

export type ToolRegistryDeps = {
    pageRegistry: PageRegistry;
    getActiveTabToken: () => Promise<string>;
};

export type ExecuteToolOptions = {
    tabTokenOverride?: string;
};

const parseInput = <T>(schema: z.ZodType<T>, input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        return { ok: false as const, error: parsed.error.issues };
    }
    return { ok: true as const, data: parsed.data };
};

const resolveTabToken = async (deps: ToolRegistryDeps, options?: ExecuteToolOptions) =>
    options?.tabTokenOverride || (await deps.getActiveTabToken());

export const getToolSpecs = (): ToolSpec[] => [
    {
        name: 'browser.goto',
        description: 'Navigate the active workspace to a URL.',
        inputSchema: toolInputJsonSchemas['browser.goto'],
    },
    {
        name: 'browser.go_back',
        description: 'Go back in history for the current tab.',
        inputSchema: toolInputJsonSchemas['browser.go_back'],
    },
    {
        name: 'browser.reload',
        description: 'Reload the current tab.',
        inputSchema: toolInputJsonSchemas['browser.reload'],
    },
    {
        name: 'browser.create_tab',
        description: 'Create a new tab in the current workspace.',
        inputSchema: toolInputJsonSchemas['browser.create_tab'],
    },
    {
        name: 'browser.switch_tab',
        description: 'Switch to a tab by id.',
        inputSchema: toolInputJsonSchemas['browser.switch_tab'],
    },
    {
        name: 'browser.close_tab',
        description: 'Close a tab by id or the current tab.',
        inputSchema: toolInputJsonSchemas['browser.close_tab'],
    },
    {
        name: 'browser.get_page_info',
        description: 'Return page metadata and tab list.',
        inputSchema: toolInputJsonSchemas['browser.get_page_info'],
    },
    {
        name: 'browser.snapshot',
        description: 'Return page metadata or run an a11y snapshot.',
        inputSchema: toolInputJsonSchemas['browser.snapshot'],
    },
    {
        name: 'browser.take_screenshot',
        description: 'Capture a screenshot for the page or target.',
        inputSchema: toolInputJsonSchemas['browser.take_screenshot'],
    },
    {
        name: 'browser.click',
        description: 'Click an element using an a11y node id.',
        inputSchema: toolInputJsonSchemas['browser.click'],
    },
    {
        name: 'browser.fill',
        description: 'Fill an element using an a11y node id.',
        inputSchema: toolInputJsonSchemas['browser.fill'],
    },
    {
        name: 'browser.type',
        description: 'Type text into a target element.',
        inputSchema: toolInputJsonSchemas['browser.type'],
    },
    {
        name: 'browser.select_option',
        description: 'Select option values from a target element.',
        inputSchema: toolInputJsonSchemas['browser.select_option'],
    },
    {
        name: 'browser.hover',
        description: 'Hover over a target element.',
        inputSchema: toolInputJsonSchemas['browser.hover'],
    },
    {
        name: 'browser.scroll',
        description: 'Scroll the page or a target element into view.',
        inputSchema: toolInputJsonSchemas['browser.scroll'],
    },
    {
        name: 'browser.press_key',
        description: 'Press a keyboard key with optional target focus.',
        inputSchema: toolInputJsonSchemas['browser.press_key'],
    },
    {
        name: 'browser.drag_and_drop',
        description: 'Drag a source element to a destination.',
        inputSchema: toolInputJsonSchemas['browser.drag_and_drop'],
    },
    {
        name: 'browser.mouse',
        description: 'Perform a low-level mouse action.',
        inputSchema: toolInputJsonSchemas['browser.mouse'],
    },
];

export const executeTool = async (
    deps: ToolRegistryDeps,
    name: string,
    args: unknown,
    options?: ExecuteToolOptions,
): Promise<{ ok: boolean; results: unknown[]; trace?: unknown; error?: unknown }> => {
    const tabToken = await resolveTabToken(deps, options);
    const scope = deps.pageRegistry.resolveScopeFromToken(tabToken);

    const parsedGoto = name === 'browser.goto' ? parseInput(gotoInputSchema, args) : null;
    const parsedGoBack = name === 'browser.go_back' ? parseInput(goBackInputSchema, args) : null;
    const parsedReload = name === 'browser.reload' ? parseInput(reloadInputSchema, args) : null;
    const parsedCreateTab = name === 'browser.create_tab' ? parseInput(createTabInputSchema, args) : null;
    const parsedSwitchTab = name === 'browser.switch_tab' ? parseInput(switchTabInputSchema, args) : null;
    const parsedCloseTab = name === 'browser.close_tab' ? parseInput(closeTabInputSchema, args) : null;
    const parsedGetPageInfo = name === 'browser.get_page_info' ? parseInput(getPageInfoInputSchema, args) : null;
    const parsedSnapshot = name === 'browser.snapshot' ? parseInput(snapshotInputSchema, args) : null;
    const parsedTakeScreenshot = name === 'browser.take_screenshot' ? parseInput(takeScreenshotInputSchema, args) : null;
    const parsedClick = name === 'browser.click' ? parseInput(clickInputSchema, args) : null;
    const parsedFill = name === 'browser.fill' ? parseInput(fillInputSchema, args) : null;
    const parsedType = name === 'browser.type' ? parseInput(typeInputSchema, args) : null;
    const parsedSelectOption = name === 'browser.select_option' ? parseInput(selectOptionInputSchema, args) : null;
    const parsedHover = name === 'browser.hover' ? parseInput(hoverInputSchema, args) : null;
    const parsedScroll = name === 'browser.scroll' ? parseInput(scrollInputSchema, args) : null;
    const parsedPressKey = name === 'browser.press_key' ? parseInput(pressKeyInputSchema, args) : null;
    const parsedDragAndDrop = name === 'browser.drag_and_drop' ? parseInput(dragAndDropInputSchema, args) : null;
    const parsedMouse = name === 'browser.mouse' ? parseInput(mouseInputSchema, args) : null;

    if (parsedGoto && !parsedGoto.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedGoto.error }], error: parsedGoto.error };
    if (parsedGoBack && !parsedGoBack.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedGoBack.error }], error: parsedGoBack.error };
    if (parsedReload && !parsedReload.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedReload.error }], error: parsedReload.error };
    if (parsedCreateTab && !parsedCreateTab.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedCreateTab.error }], error: parsedCreateTab.error };
    if (parsedSwitchTab && !parsedSwitchTab.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedSwitchTab.error }], error: parsedSwitchTab.error };
    if (parsedCloseTab && !parsedCloseTab.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedCloseTab.error }], error: parsedCloseTab.error };
    if (parsedGetPageInfo && !parsedGetPageInfo.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedGetPageInfo.error }], error: parsedGetPageInfo.error };
    if (parsedSnapshot && !parsedSnapshot.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedSnapshot.error }], error: parsedSnapshot.error };
    if (parsedTakeScreenshot && !parsedTakeScreenshot.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedTakeScreenshot.error }], error: parsedTakeScreenshot.error };
    if (parsedClick && !parsedClick.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedClick.error }], error: parsedClick.error };
    if (parsedFill && !parsedFill.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedFill.error }], error: parsedFill.error };
    if (parsedType && !parsedType.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedType.error }], error: parsedType.error };
    if (parsedSelectOption && !parsedSelectOption.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedSelectOption.error }], error: parsedSelectOption.error };
    if (parsedHover && !parsedHover.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedHover.error }], error: parsedHover.error };
    if (parsedScroll && !parsedScroll.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedScroll.error }], error: parsedScroll.error };
    if (parsedPressKey && !parsedPressKey.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedPressKey.error }], error: parsedPressKey.error };
    if (parsedDragAndDrop && !parsedDragAndDrop.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedDragAndDrop.error }], error: parsedDragAndDrop.error };
    if (parsedMouse && !parsedMouse.ok) return { ok: false, results: [{ stepId: 'invalid', ok: false, error: parsedMouse.error }], error: parsedMouse.error };

    const step: StepUnion | null =
        name === 'browser.goto'
            ? { id: crypto.randomUUID(), name: 'browser.goto', args: parsedGoto!.data }
            : name === 'browser.go_back'
                ? { id: crypto.randomUUID(), name: 'browser.go_back', args: parsedGoBack!.data }
                : name === 'browser.reload'
                    ? { id: crypto.randomUUID(), name: 'browser.reload', args: parsedReload!.data }
                    : name === 'browser.create_tab'
                        ? { id: crypto.randomUUID(), name: 'browser.create_tab', args: parsedCreateTab!.data }
                        : name === 'browser.switch_tab'
                            ? { id: crypto.randomUUID(), name: 'browser.switch_tab', args: parsedSwitchTab!.data }
                            : name === 'browser.close_tab'
                                ? { id: crypto.randomUUID(), name: 'browser.close_tab', args: parsedCloseTab!.data }
                                : name === 'browser.get_page_info'
                                    ? { id: crypto.randomUUID(), name: 'browser.get_page_info', args: parsedGetPageInfo!.data }
                                    : name === 'browser.snapshot'
                                        ? { id: crypto.randomUUID(), name: 'browser.snapshot', args: parsedSnapshot!.data }
                                        : name === 'browser.take_screenshot'
                                            ? { id: crypto.randomUUID(), name: 'browser.take_screenshot', args: parsedTakeScreenshot!.data }
                                            : name === 'browser.click'
                                                ? { id: crypto.randomUUID(), name: 'browser.click', args: parsedClick!.data }
                                                : name === 'browser.fill'
                                                    ? { id: crypto.randomUUID(), name: 'browser.fill', args: parsedFill!.data }
                                                    : name === 'browser.type'
                                                        ? { id: crypto.randomUUID(), name: 'browser.type', args: parsedType!.data }
                                                        : name === 'browser.select_option'
                                                            ? { id: crypto.randomUUID(), name: 'browser.select_option', args: parsedSelectOption!.data }
                                                            : name === 'browser.hover'
                                                                ? { id: crypto.randomUUID(), name: 'browser.hover', args: parsedHover!.data }
                                                                : name === 'browser.scroll'
                                                                    ? { id: crypto.randomUUID(), name: 'browser.scroll', args: parsedScroll!.data }
                                                                    : name === 'browser.press_key'
                                                                        ? { id: crypto.randomUUID(), name: 'browser.press_key', args: parsedPressKey!.data }
                                                                        : name === 'browser.drag_and_drop'
                                                                            ? { id: crypto.randomUUID(), name: 'browser.drag_and_drop', args: parsedDragAndDrop!.data }
                                                                            : name === 'browser.mouse'
                                                                                ? { id: crypto.randomUUID(), name: 'browser.mouse', args: parsedMouse!.data }
                                                                                : null;

    if (!step) {
        return { ok: false, results: [], error: { code: 'ERR_NOT_IMPLEMENTED', message: `unsupported tool: ${name}` } };
    }

    return runSteps({
        workspaceId: scope.workspaceId,
        steps: [step],
        options: { stopOnError: true },
    });
};
