import { z } from 'zod';
import type { Page } from 'playwright';
import type { PageRegistry } from './runtime/page_registry';
import { executeCommand, type ActionContext } from './runner/execute';
import type {
    Command,
    ElementClickCommand,
    ElementFillCommand,
    ElementTypeCommand,
    PageA11yScanCommand,
    PageGotoCommand,
    Target,
} from './runner/commands';
import { ERROR_CODES } from './runner/error_codes';
import { errorResult, okResult, type Result } from './runner/results';
import type { RecordingState } from './record/recording';
import type { ReplayOptions } from './play/replay';
import type { A11yScanResult } from './runner/a11y_types';

export type ToolSpec = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

const locatorCandidateSchema = z
    .object({
        kind: z.string(),
        selector: z.string().optional(),
        testId: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
        text: z.string().optional(),
        exact: z.boolean().optional(),
        note: z.string().optional(),
    })
    .passthrough();

const targetSchema = z
    .object({
        selector: z.string(),
        frame: z.string().optional(),
        locatorCandidates: z.array(locatorCandidateSchema).optional(),
        scopeHint: z.string().optional(),
    })
    .passthrough();

const gotoInputSchema = z.object({ url: z.string() });
const snapshotInputSchema = z.object({
    includeA11y: z.boolean().optional(),
    maxNodes: z.number().int().min(0).optional(),
});
const clickInputSchema = z.object({ target: targetSchema });
const typeInputSchema = z.object({
    target: targetSchema,
    text: z.string(),
    clearFirst: z.boolean().optional(),
});

const toolInputJsonSchemas = {
    'browser.goto': {
        type: 'object',
        required: ['url'],
        properties: {
            url: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.snapshot': {
        type: 'object',
        required: [],
        properties: {
            includeA11y: { type: 'boolean' },
            maxNodes: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
    },
    'browser.click': {
        type: 'object',
        required: ['target'],
        properties: {
            target: {
                type: 'object',
                required: ['selector'],
                properties: {
                    selector: { type: 'string' },
                    frame: { type: 'string' },
                    locatorCandidates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['kind'],
                            properties: {
                                kind: { type: 'string' },
                                selector: { type: 'string' },
                                testId: { type: 'string' },
                                role: { type: 'string' },
                                name: { type: 'string' },
                                text: { type: 'string' },
                                exact: { type: 'boolean' },
                                note: { type: 'string' },
                            },
                            additionalProperties: true,
                        },
                    },
                    scopeHint: { type: 'string' },
                },
                additionalProperties: true,
            },
        },
        additionalProperties: false,
    },
    'browser.type': {
        type: 'object',
        required: ['target', 'text'],
        properties: {
            target: {
                type: 'object',
                required: ['selector'],
                properties: {
                    selector: { type: 'string' },
                    frame: { type: 'string' },
                    locatorCandidates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['kind'],
                            properties: {
                                kind: { type: 'string' },
                                selector: { type: 'string' },
                                testId: { type: 'string' },
                                role: { type: 'string' },
                                name: { type: 'string' },
                                text: { type: 'string' },
                                exact: { type: 'boolean' },
                                note: { type: 'string' },
                            },
                            additionalProperties: true,
                        },
                    },
                    scopeHint: { type: 'string' },
                },
                additionalProperties: true,
            },
            text: { type: 'string' },
            clearFirst: { type: 'boolean' },
        },
        additionalProperties: false,
    },
} as const;

export type ToolRegistryDeps = {
    pageRegistry: PageRegistry;
    recordingState: RecordingState;
    log: (...args: unknown[]) => void;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    getActiveTabToken: () => Promise<string>;
};

export type ExecuteToolOptions = {
    tabTokenOverride?: string;
};

const buildActionContext = async (
    deps: ToolRegistryDeps,
    tabToken: string,
): Promise<ActionContext> => {
    const page = await deps.pageRegistry.getPage(tabToken);
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

const validationError = (tabToken: string, details: unknown) =>
    errorResult(tabToken, ERROR_CODES.ERR_BAD_ARGS, 'invalid tool arguments', undefined, details);

const parseInput = <T>(schema: z.ZodType<T>, input: unknown, tabToken: string): T | Result => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        return validationError(tabToken, parsed.error.issues);
    }
    return parsed.data;
};

const trimA11yNodes = (result: A11yScanResult, maxNodes?: number): A11yScanResult => {
    if (maxNodes === undefined) return result;
    const normalized = Math.max(0, maxNodes);
    return {
        ...result,
        violations: result.violations.map((violation) => ({
            ...violation,
            nodes: violation.nodes.slice(0, normalized),
        })),
    };
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
        name: 'browser.snapshot',
        description: 'Return page metadata or run an a11y scan.',
        inputSchema: toolInputJsonSchemas['browser.snapshot'],
    },
    {
        name: 'browser.click',
        description: 'Click an element using a resolver-compatible target.',
        inputSchema: toolInputJsonSchemas['browser.click'],
    },
    {
        name: 'browser.type',
        description: 'Type text into an element using a resolver-compatible target.',
        inputSchema: toolInputJsonSchemas['browser.type'],
    },
];

export const executeTool = async (
    deps: ToolRegistryDeps,
    name: string,
    args: unknown,
    options?: ExecuteToolOptions,
): Promise<Result> => {
    const tabToken = await resolveTabToken(deps, options);

    if (name === 'browser.goto') {
        const parsed = parseInput(gotoInputSchema, args, tabToken);
        if ('ok' in (parsed as Result)) return parsed as Result;
        const input = parsed as z.infer<typeof gotoInputSchema>;
        const ctx = await buildActionContext(deps, tabToken);
        const command: PageGotoCommand = {
            cmd: 'page.goto',
            tabToken,
            args: { url: input.url, waitUntil: 'domcontentloaded' },
        };
        return executeCommand(ctx, command);
    }

    if (name === 'browser.click') {
        const parsed = parseInput(clickInputSchema, args, tabToken);
        if ('ok' in (parsed as Result)) return parsed as Result;
        const input = parsed as z.infer<typeof clickInputSchema>;
        const ctx = await buildActionContext(deps, tabToken);
        const command: ElementClickCommand = {
            cmd: 'element.click',
            tabToken,
            args: { target: input.target as Target, options: { timeout: 5000, noWaitAfter: true } },
        };
        return executeCommand(ctx, command);
    }

    if (name === 'browser.type') {
        const parsed = parseInput(typeInputSchema, args, tabToken);
        if ('ok' in (parsed as Result)) return parsed as Result;
        const input = parsed as z.infer<typeof typeInputSchema>;
        const ctx = await buildActionContext(deps, tabToken);
        const target = input.target as Target;
        if (input.clearFirst) {
            const command: ElementFillCommand = {
                cmd: 'element.fill',
                tabToken,
                args: { target, text: input.text },
            };
            return executeCommand(ctx, command);
        }
        const command: ElementTypeCommand = {
            cmd: 'element.type',
            tabToken,
            args: { target, text: input.text },
        };
        return executeCommand(ctx, command);
    }

    if (name === 'browser.snapshot') {
        const parsed = parseInput(snapshotInputSchema, args, tabToken);
        if ('ok' in (parsed as Result)) return parsed as Result;
        const input = parsed as z.infer<typeof snapshotInputSchema>;
        if (input.includeA11y) {
            const ctx = await buildActionContext(deps, tabToken);
            const command: PageA11yScanCommand = {
                cmd: 'page.a11yScan',
                tabToken,
                args: {},
            };
            const result = await executeCommand(ctx, command);
            if (!result.ok) return result;
            const data = trimA11yNodes(result.data as A11yScanResult, input.maxNodes);
            return okResult(tabToken, data, result.requestId);
        }
        const page = await deps.pageRegistry.getPage(tabToken);
        const title = await page.title();
        return okResult(tabToken, { url: page.url(), title });
    }

    return errorResult(tabToken, ERROR_CODES.ERR_UNSUPPORTED, `unknown tool: ${name}`);
};
