import { z } from 'zod';

const coordSchema = z.object({
    x: z.number(),
    y: z.number(),
});

const ensureIdOrSelector = <T extends { id?: string; selector?: string }>(value: T) => {
    return Boolean(value.id || value.selector);
};

const entityKindSchema = z.enum(['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv']);
const entityKindOrArraySchema = z.union([entityKindSchema, z.array(entityKindSchema).nonempty()]);
const textOrArraySchema = z.union([z.string(), z.array(z.string()).nonempty()]);

export const browserGotoInputSchema = z.object({
    tabToken: z.string().optional(),
    url: z.string(),
    timeout: z.number().int().positive().optional(),
});

export const browserGoBackInputSchema = z.object({
    tabToken: z.string().optional(),
    timeout: z.number().int().positive().optional(),
});

export const browserReloadInputSchema = z.object({
    tabToken: z.string().optional(),
    timeout: z.number().int().positive().optional(),
});

export const browserCreateTabInputSchema = z.object({
    tabToken: z.string().optional(),
    url: z.string().optional(),
});

export const browserSwitchTabInputSchema = z.object({
    tabToken: z.string().optional(),
    tab_id: z.string(),
});

export const browserCloseTabInputSchema = z.object({
    tabToken: z.string().optional(),
    tab_id: z.string().optional(),
});

export const browserGetPageInfoInputSchema = z.object({
    tabToken: z.string().optional(),
});

export const browserSnapshotInputSchema = z.object({
    tabToken: z.string().optional(),
    refresh: z.boolean().optional(),
});

export const browserListEntitiesInputSchema = z.object({
    tabToken: z.string().optional(),
    kind: entityKindOrArraySchema.optional(),
    businessTag: textOrArraySchema.optional(),
    query: z.string().optional(),
});

export const browserGetEntityInputSchema = z.object({
    tabToken: z.string().optional(),
    nodeId: z.string(),
});

export const browserFindEntitiesInputSchema = z.object({
    tabToken: z.string().optional(),
    query: z.string(),
    kind: entityKindOrArraySchema.optional(),
    businessTag: textOrArraySchema.optional(),
});

export const browserAddEntityInputSchema = z.object({
    tabToken: z.string().optional(),
    nodeId: z.string(),
    kind: entityKindSchema,
    name: z.string().optional(),
    businessTag: z.string().optional(),
});

export const browserDeleteEntityInputSchema = z.object({
    tabToken: z.string().optional(),
    nodeId: z.string(),
    kind: entityKindSchema.optional(),
    businessTag: z.string().optional(),
});

export const browserRenameEntityInputSchema = z.object({
    tabToken: z.string().optional(),
    nodeId: z.string(),
    name: z.string(),
});

export const browserGetContentInputSchema = z.object({
    tabToken: z.string().optional(),
    ref: z.string(),
});

export const browserReadConsoleInputSchema = z.object({
    tabToken: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
});

export const browserReadNetworkInputSchema = z.object({
    tabToken: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
});

export const browserEvaluateInputSchema = z.object({
    tabToken: z.string().optional(),
    expression: z.string(),
    arg: z.unknown().optional(),
});

export const browserTakeScreenshotInputSchema = z.object({
    tabToken: z.string().optional(),
    id: z.string().optional(),
    selector: z.string().optional(),
    full_page: z.boolean().optional(),
});

export const browserClickInputSchema = z
    .object({
        tabToken: z.string().optional(),
        id: z.string().optional(),
        selector: z.string().optional(),
        coord: coordSchema.optional(),
        options: z
            .object({
                button: z.enum(['left', 'right', 'middle']).optional(),
                double: z.boolean().optional(),
            })
            .optional(),
        timeout: z.number().int().positive().optional(),
    })
    .refine((value) => Boolean(value.coord) || ensureIdOrSelector(value), {
        message: 'click requires coord or id/selector',
    });

export const browserFillInputSchema = z
    .object({
        tabToken: z.string().optional(),
        id: z.string().optional(),
        selector: z.string().optional(),
        value: z.string(),
        timeout: z.number().int().positive().optional(),
    })
    .refine(ensureIdOrSelector, {
        message: 'fill requires id or selector',
    });

export const browserTypeInputSchema = z
    .object({
        tabToken: z.string().optional(),
        id: z.string().optional(),
        selector: z.string().optional(),
        text: z.string(),
        delay_ms: z.number().int().min(0).optional(),
        timeout: z.number().int().positive().optional(),
    })
    .refine(ensureIdOrSelector, {
        message: 'type requires id or selector',
    });

export const browserSelectOptionInputSchema = z
    .object({
        tabToken: z.string().optional(),
        id: z.string().optional(),
        selector: z.string().optional(),
        values: z.array(z.string()),
        timeout: z.number().int().positive().optional(),
    })
    .refine(ensureIdOrSelector, {
        message: 'select_option requires id or selector',
    });

export const browserHoverInputSchema = z
    .object({
        tabToken: z.string().optional(),
        id: z.string().optional(),
        selector: z.string().optional(),
        timeout: z.number().int().positive().optional(),
    })
    .refine(ensureIdOrSelector, {
        message: 'hover requires id or selector',
    });

export const browserScrollInputSchema = z.object({
    tabToken: z.string().optional(),
    id: z.string().optional(),
    selector: z.string().optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
});

export const browserPressKeyInputSchema = z.object({
    tabToken: z.string().optional(),
    key: z.string(),
    id: z.string().optional(),
    selector: z.string().optional(),
    timeout: z.number().int().positive().optional(),
});

export const browserDragAndDropInputSchema = z
    .object({
        tabToken: z.string().optional(),
        source_id: z.string().optional(),
        source_selector: z.string().optional(),
        dest_id: z.string().optional(),
        dest_selector: z.string().optional(),
        dest_coord: coordSchema.optional(),
        timeout: z.number().int().positive().optional(),
    })
    .refine((value) => Boolean(value.source_id || value.source_selector), {
        message: 'drag_and_drop requires source_id or source_selector',
    })
    .refine((value) => Boolean(value.dest_id || value.dest_selector || value.dest_coord), {
        message: 'drag_and_drop requires destination target or dest_coord',
    });

export const browserMouseInputSchema = z.object({
    tabToken: z.string().optional(),
    action: z.enum(['move', 'down', 'up', 'wheel', 'click', 'dblclick']),
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
export type BrowserGetContentInput = z.infer<typeof browserGetContentInputSchema>;
export type BrowserReadConsoleInput = z.infer<typeof browserReadConsoleInputSchema>;
export type BrowserReadNetworkInput = z.infer<typeof browserReadNetworkInputSchema>;
export type BrowserEvaluateInput = z.infer<typeof browserEvaluateInputSchema>;
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
export type BrowserListEntitiesInput = z.infer<typeof browserListEntitiesInputSchema>;
export type BrowserGetEntityInput = z.infer<typeof browserGetEntityInputSchema>;
export type BrowserFindEntitiesInput = z.infer<typeof browserFindEntitiesInputSchema>;
export type BrowserAddEntityInput = z.infer<typeof browserAddEntityInputSchema>;
export type BrowserDeleteEntityInput = z.infer<typeof browserDeleteEntityInputSchema>;
export type BrowserRenameEntityInput = z.infer<typeof browserRenameEntityInputSchema>;

export const toolInputJsonSchemas = {
    'browser.goto': {
        type: 'object',
        required: ['url'],
        properties: {
            tabToken: { type: 'string' },
            url: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.go_back': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.reload': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.create_tab': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            url: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.switch_tab': {
        type: 'object',
        required: ['tab_id'],
        properties: {
            tabToken: { type: 'string' },
            tab_id: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.close_tab': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            tab_id: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.get_page_info': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.snapshot': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            refresh: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    'browser.list_entities': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            kind: {
                anyOf: [
                    { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] },
                    { type: 'array', items: { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] } },
                ],
            },
            businessTag: {
                anyOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } },
                ],
            },
            query: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.get_entity': {
        type: 'object',
        required: ['nodeId'],
        properties: {
            tabToken: { type: 'string' },
            nodeId: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.find_entities': {
        type: 'object',
        required: ['query'],
        properties: {
            tabToken: { type: 'string' },
            query: { type: 'string' },
            kind: {
                anyOf: [
                    { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] },
                    { type: 'array', items: { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] } },
                ],
            },
            businessTag: {
                anyOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } },
                ],
            },
        },
        additionalProperties: false,
    },
    'browser.add_entity': {
        type: 'object',
        required: ['nodeId', 'kind'],
        properties: {
            tabToken: { type: 'string' },
            nodeId: { type: 'string' },
            kind: { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] },
            name: { type: 'string' },
            businessTag: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.delete_entity': {
        type: 'object',
        required: ['nodeId'],
        properties: {
            tabToken: { type: 'string' },
            nodeId: { type: 'string' },
            kind: { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] },
            businessTag: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.rename_entity': {
        type: 'object',
        required: ['nodeId', 'name'],
        properties: {
            tabToken: { type: 'string' },
            nodeId: { type: 'string' },
            name: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.get_content': {
        type: 'object',
        required: ['ref'],
        properties: {
            tabToken: { type: 'string' },
            ref: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.read_console': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
    },
    'browser.read_network': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
    },
    'browser.evaluate': {
        type: 'object',
        required: ['expression'],
        properties: {
            tabToken: { type: 'string' },
            expression: { type: 'string' },
            arg: {},
        },
        additionalProperties: false,
    },
    'browser.take_screenshot': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
            full_page: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    'browser.click': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
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
        },
        additionalProperties: false,
    },
    'browser.fill': {
        type: 'object',
        required: ['value'],
        properties: {
            tabToken: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
            value: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.type': {
        type: 'object',
        required: ['text'],
        properties: {
            tabToken: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
            text: { type: 'string' },
            delay_ms: { type: 'integer', minimum: 0 },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.select_option': {
        type: 'object',
        required: ['values'],
        properties: {
            tabToken: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
            values: { type: 'array', items: { type: 'string' } },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.hover': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.scroll': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down'] },
            amount: { type: 'integer', minimum: 1 },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.press_key': {
        type: 'object',
        required: ['key'],
        properties: {
            tabToken: { type: 'string' },
            key: { type: 'string' },
            id: { type: 'string' },
            selector: { type: 'string' },
            timeout: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    'browser.drag_and_drop': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
            source_id: { type: 'string' },
            source_selector: { type: 'string' },
            dest_id: { type: 'string' },
            dest_selector: { type: 'string' },
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
            tabToken: { type: 'string' },
            action: { type: 'string', enum: ['move', 'down', 'up', 'wheel', 'click', 'dblclick'] },
            x: { type: 'number' },
            y: { type: 'number' },
            deltaY: { type: 'number' },
            button: { type: 'string', enum: ['left', 'right', 'middle'] },
        },
        additionalProperties: false,
    },
} as const;
