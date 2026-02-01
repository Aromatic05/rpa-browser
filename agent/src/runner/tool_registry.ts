import crypto from 'crypto';
import { z } from 'zod';
import type { PageRegistry } from '../runtime/page_registry';
import { runSteps } from './run_steps';
import type { StepUnion } from './steps/types';

export type ToolSpec = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

const gotoInputSchema = z.object({ url: z.string() });
const snapshotInputSchema = z.object({
    includeA11y: z.boolean().optional(),
});
const a11yHintSchema = z.object({
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
});
const clickInputSchema = z
    .object({
        a11yNodeId: z.string().optional(),
        a11yHint: a11yHintSchema.optional(),
        timeout: z.number().int().positive().optional(),
    })
    .refine((value) => Boolean(value.a11yNodeId || value.a11yHint), {
        message: 'a11yNodeId or a11yHint required',
    });
const fillInputSchema = z
    .object({
        a11yNodeId: z.string().optional(),
        a11yHint: a11yHintSchema.optional(),
        value: z.string(),
    })
    .refine((value) => Boolean(value.a11yNodeId || value.a11yHint), {
        message: 'a11yNodeId or a11yHint required',
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
        },
        additionalProperties: false,
    },
    'browser.click': {
        type: 'object',
        required: [],
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
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.fill': {
        type: 'object',
        required: ['value'],
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
            value: { type: 'string' },
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
        name: 'browser.snapshot',
        description: 'Return page metadata or run an a11y snapshot.',
        inputSchema: toolInputJsonSchemas['browser.snapshot'],
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
];

export const executeTool = async (
    deps: ToolRegistryDeps,
    name: string,
    args: unknown,
    options?: ExecuteToolOptions,
): Promise<{ ok: boolean; data?: unknown; error?: unknown }> => {
    const tabToken = await resolveTabToken(deps, options);
    const scope = deps.pageRegistry.resolveScopeFromToken(tabToken);

    const parsedGoto = name === 'browser.goto' ? parseInput(gotoInputSchema, args) : null;
    const parsedSnapshot = name === 'browser.snapshot' ? parseInput(snapshotInputSchema, args) : null;
    const parsedClick = name === 'browser.click' ? parseInput(clickInputSchema, args) : null;
    const parsedFill = name === 'browser.fill' ? parseInput(fillInputSchema, args) : null;

    if (parsedGoto && !parsedGoto.ok) return { ok: false, error: parsedGoto.error };
    if (parsedSnapshot && !parsedSnapshot.ok) return { ok: false, error: parsedSnapshot.error };
    if (parsedClick && !parsedClick.ok) return { ok: false, error: parsedClick.error };
    if (parsedFill && !parsedFill.ok) return { ok: false, error: parsedFill.error };

    const step: StepUnion | null =
        name === 'browser.goto'
            ? { id: crypto.randomUUID(), name: 'browser.goto', args: parsedGoto!.data }
            : name === 'browser.snapshot'
                ? { id: crypto.randomUUID(), name: 'browser.snapshot', args: parsedSnapshot!.data }
                : name === 'browser.click'
                    ? { id: crypto.randomUUID(), name: 'browser.click', args: parsedClick!.data }
                    : name === 'browser.fill'
                        ? { id: crypto.randomUUID(), name: 'browser.fill', args: parsedFill!.data }
                        : null;

    if (!step) {
        return { ok: false, error: { code: 'ERR_NOT_IMPLEMENTED', message: `unsupported tool: ${name}` } };
    }

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
