import { z } from 'zod';

export const locatorCandidateSchema = z
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

export const targetSchema = z
    .object({
        selector: z.string(),
        frame: z.string().optional(),
        locatorCandidates: z.array(locatorCandidateSchema).optional(),
        scopeHint: z.string().optional(),
    })
    .passthrough();

export const browserGotoInputSchema = z.object({
    tabToken: z.string(),
    url: z.string(),
});

export const browserSnapshotInputSchema = z.object({
    tabToken: z.string(),
    includeA11y: z.boolean().optional(),
    maxNodes: z.number().int().min(0).optional(),
});

export const browserClickInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema,
});

export const browserTypeInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema,
    text: z.string(),
    clearFirst: z.boolean().optional(),
});

export type BrowserGotoInput = z.infer<typeof browserGotoInputSchema>;
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotInputSchema>;
export type BrowserClickInput = z.infer<typeof browserClickInputSchema>;
export type BrowserTypeInput = z.infer<typeof browserTypeInputSchema>;

const locatorCandidateJsonSchema = {
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
} as const;

const targetJsonSchema = {
    type: 'object',
    required: ['selector'],
    properties: {
        selector: { type: 'string' },
        frame: { type: 'string' },
        locatorCandidates: { type: 'array', items: locatorCandidateJsonSchema },
        scopeHint: { type: 'string' },
    },
    additionalProperties: true,
} as const;

export const toolInputJsonSchemas = {
    'browser.goto': {
        type: 'object',
        required: ['tabToken', 'url'],
        properties: {
            tabToken: { type: 'string' },
            url: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.snapshot': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
            includeA11y: { type: 'boolean' },
            maxNodes: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
    },
    'browser.click': {
        type: 'object',
        required: ['tabToken', 'target'],
        properties: {
            tabToken: { type: 'string' },
            target: targetJsonSchema,
        },
        additionalProperties: false,
    },
    'browser.type': {
        type: 'object',
        required: ['tabToken', 'target', 'text'],
        properties: {
            tabToken: { type: 'string' },
            target: targetJsonSchema,
            text: { type: 'string' },
            clearFirst: { type: 'boolean' },
        },
        additionalProperties: false,
    },
} as const;
