import { z } from 'zod';

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

export const browserGotoInputSchema = z.object({
    tabToken: z.string(),
    url: z.string(),
    timeout: z.number().int().positive().optional(),
});

export const browserGoBackInputSchema = z.object({
    tabToken: z.string(),
    timeout: z.number().int().positive().optional(),
});

export const browserReloadInputSchema = z.object({
    tabToken: z.string(),
    timeout: z.number().int().positive().optional(),
});

export const browserCreateTabInputSchema = z.object({
    tabToken: z.string(),
    url: z.string().optional(),
});

export const browserSwitchTabInputSchema = z.object({
    tabToken: z.string(),
    tab_id: z.string(),
});

export const browserCloseTabInputSchema = z.object({
    tabToken: z.string(),
    tab_id: z.string().optional(),
});

export const browserGetPageInfoInputSchema = z.object({
    tabToken: z.string(),
});

export const browserSnapshotInputSchema = z.object({
    tabToken: z.string(),
    includeA11y: z.boolean().optional(),
    focus_only: z.boolean().optional(),
});

export const browserTakeScreenshotInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema.optional(),
    full_page: z.boolean().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});

export const browserClickInputSchema = z.object({
    tabToken: z.string(),
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

export const browserFillInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema.optional(),
    value: z.string(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});

export const browserTypeInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema.optional(),
    text: z.string(),
    delay_ms: z.number().int().min(0).optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});

export const browserSelectOptionInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema.optional(),
    values: z.array(z.string()),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});

export const browserHoverInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema.optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});

export const browserScrollInputSchema = z.object({
    tabToken: z.string(),
    target: targetSchema.optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});

export const browserPressKeyInputSchema = z.object({
    tabToken: z.string(),
    key: z.string(),
    target: targetSchema.optional(),
    timeout: z.number().int().positive().optional(),
    a11yNodeId: z.string().optional(),
    a11yHint: a11yHintSchema.optional(),
});

export const browserDragAndDropInputSchema = z.object({
    tabToken: z.string(),
    source: targetSchema,
    dest_target: targetSchema.optional(),
    dest_coord: coordSchema.optional(),
    timeout: z.number().int().positive().optional(),
});

export const browserMouseInputSchema = z.object({
    tabToken: z.string(),
    action: z.enum(['move', 'down', 'up', 'wheel']),
    x: z.number(),
    y: z.number(),
    deltaY: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
});

export type BrowserGotoInput = z.infer<typeof browserGotoInputSchema>;
export type BrowserGoBackInput = z.infer<typeof browserGoBackInputSchema>;
export type BrowserReloadInput = z.infer<typeof browserReloadInputSchema>;
export type BrowserCreateTabInput = z.infer<typeof browserCreateTabInputSchema>;
export type BrowserSwitchTabInput = z.infer<typeof browserSwitchTabInputSchema>;
export type BrowserCloseTabInput = z.infer<typeof browserCloseTabInputSchema>;
export type BrowserGetPageInfoInput = z.infer<typeof browserGetPageInfoInputSchema>;
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotInputSchema>;
export type BrowserTakeScreenshotInput = z.infer<typeof browserTakeScreenshotInputSchema>;
export type BrowserClickInput = z.infer<typeof browserClickInputSchema>;
export type BrowserFillInput = z.infer<typeof browserFillInputSchema>;
export type BrowserTypeInput = z.infer<typeof browserTypeInputSchema>;
export type BrowserSelectOptionInput = z.infer<typeof browserSelectOptionInputSchema>;
export type BrowserHoverInput = z.infer<typeof browserHoverInputSchema>;
export type BrowserScrollInput = z.infer<typeof browserScrollInputSchema>;
export type BrowserPressKeyInput = z.infer<typeof browserPressKeyInputSchema>;
export type BrowserDragAndDropInput = z.infer<typeof browserDragAndDropInputSchema>;
export type BrowserMouseInput = z.infer<typeof browserMouseInputSchema>;

export const toolInputJsonSchemas = {
    'browser.goto': {
        type: 'object',
        required: ['tabToken', 'url'],
        properties: {
            tabToken: { type: 'string' },
            url: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.go_back': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.reload': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.create_tab': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
            url: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.switch_tab': {
        type: 'object',
        required: ['tabToken', 'tab_id'],
        properties: {
            tabToken: { type: 'string' },
            tab_id: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.close_tab': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
            tab_id: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.get_page_info': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.snapshot': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
            includeA11y: { type: 'boolean' },
            focus_only: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    'browser.take_screenshot': {
        type: 'object',
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
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
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
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
    'browser.fill': {
        type: 'object',
        required: ['tabToken', 'value'],
        properties: {
            tabToken: { type: 'string' },
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
            value: { type: 'string' },
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
    'browser.type': {
        type: 'object',
        required: ['tabToken', 'text'],
        properties: {
            tabToken: { type: 'string' },
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
        required: ['tabToken', 'values'],
        properties: {
            tabToken: { type: 'string' },
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
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
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
        required: ['tabToken'],
        properties: {
            tabToken: { type: 'string' },
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
        required: ['tabToken', 'key'],
        properties: {
            tabToken: { type: 'string' },
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
        required: ['tabToken', 'source'],
        properties: {
            tabToken: { type: 'string' },
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
        required: ['tabToken', 'action', 'x', 'y'],
        properties: {
            tabToken: { type: 'string' },
            action: { type: 'string', enum: ['move', 'down', 'up', 'wheel'] },
            x: { type: 'number' },
            y: { type: 'number' },
            deltaY: { type: 'number' },
            button: { type: 'string', enum: ['left', 'right', 'middle'] },
        },
        additionalProperties: false,
    },
} as const;
