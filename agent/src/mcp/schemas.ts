import { z } from 'zod';

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
    a11yNodeId: z.string(),
    timeout: z.number().int().positive().optional(),
});

export const browserFillInputSchema = z.object({
    tabToken: z.string(),
    a11yNodeId: z.string(),
    value: z.string(),
});

export type BrowserGotoInput = z.infer<typeof browserGotoInputSchema>;
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotInputSchema>;
export type BrowserClickInput = z.infer<typeof browserClickInputSchema>;
export type BrowserFillInput = z.infer<typeof browserFillInputSchema>;

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
        required: ['tabToken', 'a11yNodeId'],
        properties: {
            tabToken: { type: 'string' },
            a11yNodeId: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.fill': {
        type: 'object',
        required: ['tabToken', 'a11yNodeId', 'value'],
        properties: {
            tabToken: { type: 'string' },
            a11yNodeId: { type: 'string' },
            value: { type: 'string' },
        },
        additionalProperties: false,
    },
} as const;
