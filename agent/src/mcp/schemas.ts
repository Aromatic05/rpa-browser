import { z } from 'zod';

const coordSchema = z.object({
    x: z.number(),
    y: z.number(),
});

const ensureIdOrSelector = (value: { id?: string; selector?: string }) => {
    return Boolean(value.id || value.selector);
};

const entityKindSchema = z.enum(['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv']);
const entityKindOrArraySchema = z.union([entityKindSchema, z.array(entityKindSchema).nonempty()]);
const textOrArraySchema = z.union([z.string(), z.array(z.string()).nonempty()]);
const snapshotRoleFilterSchema = z.union([z.string(), z.array(z.string()).nonempty()]);
const snapshotFilterInputSchema = z
    .object({
        role: snapshotRoleFilterSchema.optional(),
        text: z.string().optional(),
        interactive: z.boolean().optional(),
    })
    .strict();

const batchFillActionSchema = z.object({
    op: z.literal('fill'),
    id: z.string().optional(),
    selector: z.string().optional(),
    label: z.string().optional(),
    role: z.string().optional(),
    value: z.string(),
});

const batchSelectOptionActionSchema = z.object({
    op: z.literal('select_option'),
    id: z.string().optional(),
    selector: z.string().optional(),
    label: z.string().optional(),
    role: z.string().optional(),
    values: z.array(z.string()).nonempty(),
});

const batchClickActionSchema = z.object({
    op: z.literal('click'),
    id: z.string().optional(),
    selector: z.string().optional(),
    label: z.string().optional(),
    role: z.string().optional(),
    coord: coordSchema.optional(),
    options: z
        .object({
            button: z.enum(['left', 'right', 'middle']).optional(),
            double: z.boolean().optional(),
        })
        .optional(),
});

const batchActionSchema = z.discriminatedUnion('op', [
    batchFillActionSchema,
    batchSelectOptionActionSchema,
    batchClickActionSchema,
]);

export const browserGotoInputSchema = z.object({
    tabToken: z.string().optional(),
    url: z.string(),
});

export const browserGoBackInputSchema = z.object({
    tabToken: z.string().optional(),
});

export const browserReloadInputSchema = z.object({
    tabToken: z.string().optional(),
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

export const browserListTabsInputSchema = z.object({
    tabToken: z.string().optional(),
});

export const browserSnapshotInputSchema = z.object({
    tabToken: z.string().optional(),
    includeA11y: z.boolean().optional(),
    focus_only: z.boolean().optional(),
    refresh: z.boolean().optional(),
    contain: z.string().optional(),
    depth: z.number().int().min(-1).optional(),
    filter: snapshotFilterInputSchema.optional(),
    diff: z.boolean().optional(),
});

export const browserEntityInputSchema = z.discriminatedUnion('op', [
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('list'),
        kind: entityKindOrArraySchema.optional(),
        businessTag: textOrArraySchema.optional(),
        query: z.string().optional(),
    }),
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('get'),
        nodeId: z.string(),
    }),
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('find'),
        kind: entityKindOrArraySchema.optional(),
        businessTag: textOrArraySchema.optional(),
        query: z.string().optional(),
    }),
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('add'),
        nodeId: z.string(),
        kind: entityKindSchema,
        name: z.string().optional(),
        businessTag: z.string().optional(),
    }),
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('delete'),
        nodeId: z.string(),
        kind: entityKindSchema.optional(),
        businessTag: z.string().optional(),
    }),
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('rename'),
        nodeId: z.string(),
        name: z.string(),
    }),
]);

const browserQueryWhereSchema = z
    .object({
        role: z.string().optional(),
        tag: z.string().optional(),
        text: z
            .object({
                contains: z.string().optional(),
            })
            .optional(),
        attrs: z.record(z.string(), z.string()).optional(),
    })
    .strict();

const browserQueryFromSchema = z.union([
    z.literal('snapshot'),
    z.literal('snapshot.latest'),
    z.object({
        nodeIds: z.array(z.string()).nonempty(),
    }),
    z.object({
        nodes: z
            .array(
                z.union([
                    z.object({ id: z.string() }).strict(),
                    z.object({ handle: z.object({ nodeId: z.string() }).strict() }).strict(),
                ]),
            )
            .nonempty(),
    }),
]);

export const browserQueryInputSchema = z.union([
    z.object({
        tabToken: z.string().optional(),
        from: browserQueryFromSchema,
        where: browserQueryWhereSchema.optional(),
        relation: z.enum(['child', 'descendant']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
    }),
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('entity'),
        businessTag: z.string(),
        query: z.enum([
            'table.row_count',
            'table.headers',
            'table.primary_key',
            'table.columns',
            'table.current_rows',
            'form.fields',
            'form.actions',
        ]),
    }),
    z.object({
        tabToken: z.string().optional(),
        op: z.literal('entity.target'),
        businessTag: z.string(),
        target: z.discriminatedUnion('kind', [
            z.object({
                kind: z.literal('form.field'),
                fieldKey: z.string(),
            }),
            z.object({
                kind: z.literal('form.action'),
                actionIntent: z.string(),
            }),
            z.object({
                kind: z.literal('table.row'),
                primaryKey: z.object({
                    fieldKey: z.string(),
                    value: z.string(),
                }),
            }),
            z.object({
                kind: z.literal('table.row_action'),
                primaryKey: z.object({
                    fieldKey: z.string(),
                    value: z.string(),
                }),
                actionIntent: z.string(),
            }),
        ]),
    }),
]);

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
    mutatesPage: z.boolean().optional(),
});

export const browserTakeScreenshotInputSchema = z.object({
    tabToken: z.string().optional(),
    id: z.string().optional(),
    selector: z.string().optional(),
    full_page: z.boolean().optional(),
    inline: z.boolean().optional(),
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
    })
    .refine(ensureIdOrSelector, {
        message: 'select_option requires id or selector',
    });

export const browserHoverInputSchema = z
    .object({
        tabToken: z.string().optional(),
        id: z.string().optional(),
        selector: z.string().optional(),
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
});

export const browserPressKeyInputSchema = z.object({
    tabToken: z.string().optional(),
    key: z.string(),
    id: z.string().optional(),
    selector: z.string().optional(),
});

export const browserDragAndDropInputSchema = z
    .object({
        tabToken: z.string().optional(),
        source_id: z.string().optional(),
        source_selector: z.string().optional(),
        dest_id: z.string().optional(),
        dest_selector: z.string().optional(),
        dest_coord: coordSchema.optional(),
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

export const browserBatchInputSchema = z
    .object({
        tabToken: z.string().optional(),
        actions: z.array(batchActionSchema).nonempty(),
        stopOnError: z.boolean().optional(),
        contain: z.string().optional(),
        depth: z.number().int().min(-1).optional(),
    })
    .superRefine((value, ctx) => {
        value.actions.forEach((action, index) => {
            const hasTarget = Boolean(action.id || action.selector || action.label || action.op === 'click' && action.coord);
            if (hasTarget) {return;}
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    action.op === 'click'
                        ? 'batch click action requires coord, id, selector, or label'
                        : `batch ${action.op} action requires id, selector, or label`,
                path: ['actions', index],
            });
        });
    });

export type BrowserGotoInput = z.infer<typeof browserGotoInputSchema>;
export type BrowserGoBackInput = z.infer<typeof browserGoBackInputSchema>;
export type BrowserReloadInput = z.infer<typeof browserReloadInputSchema>;
export type BrowserCreateTabInput = z.infer<typeof browserCreateTabInputSchema>;
export type BrowserSwitchTabInput = z.infer<typeof browserSwitchTabInputSchema>;
export type BrowserCloseTabInput = z.infer<typeof browserCloseTabInputSchema>;
export type BrowserGetPageInfoInput = z.infer<typeof browserGetPageInfoInputSchema>;
export type BrowserListTabsInput = z.infer<typeof browserListTabsInputSchema>;
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
export type BrowserEntityInput = z.infer<typeof browserEntityInputSchema>;
export type BrowserQueryInput = z.infer<typeof browserQueryInputSchema>;
export type BrowserBatchInput = z.infer<typeof browserBatchInputSchema>;

export const toolInputJsonSchemas = {
    'browser.goto': {
        type: 'object',
        required: ['url'],
        properties: {
            tabToken: { type: 'string' },
            url: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.go_back': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
        },
        additionalProperties: false,
    },
    'browser.reload': {
        type: 'object',
        required: [],
        properties: {
            tabToken: { type: 'string' },
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
    'browser.list_tabs': {
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
            includeA11y: { type: 'boolean' },
            focus_only: { type: 'boolean' },
            refresh: { type: 'boolean' },
            contain: { type: 'string' },
            depth: { type: 'integer', minimum: -1 },
            filter: {
                type: 'object',
                required: [],
                properties: {
                    role: {
                        anyOf: [
                            { type: 'string' },
                            { type: 'array', items: { type: 'string' }, minItems: 1 },
                        ],
                    },
                    text: { type: 'string' },
                    interactive: { type: 'boolean' },
                },
                additionalProperties: false,
            },
            diff: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    'browser.entity': {
        oneOf: [
            {
                type: 'object',
                required: ['op'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['list'] },
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
            {
                type: 'object',
                required: ['op', 'nodeId'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['get'] },
                    nodeId: { type: 'string' },
                },
                additionalProperties: false,
            },
            {
                type: 'object',
                required: ['op'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['find'] },
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
            {
                type: 'object',
                required: ['op', 'nodeId', 'kind'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['add'] },
                    nodeId: { type: 'string' },
                    kind: { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] },
                    name: { type: 'string' },
                    businessTag: { type: 'string' },
                },
                additionalProperties: false,
            },
            {
                type: 'object',
                required: ['op', 'nodeId'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['delete'] },
                    nodeId: { type: 'string' },
                    kind: { type: 'string', enum: ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'] },
                    businessTag: { type: 'string' },
                },
                additionalProperties: false,
            },
            {
                type: 'object',
                required: ['op', 'nodeId', 'name'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['rename'] },
                    nodeId: { type: 'string' },
                    name: { type: 'string' },
                },
                additionalProperties: false,
            },
        ],
    },
    'browser.query': {
        oneOf: [
            {
                type: 'object',
                required: ['from'],
                properties: {
                    tabToken: { type: 'string' },
                    from: {
                        anyOf: [
                            { type: 'string', enum: ['snapshot', 'snapshot.latest'] },
                            { type: 'object', required: ['nodeIds'], properties: { nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 } }, additionalProperties: false },
                            {
                                type: 'object',
                                required: ['nodes'],
                                properties: {
                                    nodes: {
                                        type: 'array',
                                        minItems: 1,
                                        items: {
                                            oneOf: [
                                                { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
                                                {
                                                    type: 'object',
                                                    required: ['handle'],
                                                    properties: {
                                                        handle: {
                                                            type: 'object',
                                                            required: ['nodeId'],
                                                            properties: { nodeId: { type: 'string' } },
                                                            additionalProperties: false,
                                                        },
                                                    },
                                                    additionalProperties: false,
                                                },
                                            ],
                                        },
                                    },
                                },
                                additionalProperties: false,
                            },
                        ],
                    },
                    where: {
                        type: 'object',
                        required: [],
                        properties: {
                            role: { type: 'string' },
                            tag: { type: 'string' },
                            text: {
                                type: 'object',
                                required: [],
                                properties: {
                                    contains: { type: 'string' },
                                },
                                additionalProperties: false,
                            },
                            attrs: {
                                type: 'object',
                                additionalProperties: { type: 'string' },
                            },
                        },
                        additionalProperties: false,
                    },
                    relation: { type: 'string', enum: ['child', 'descendant'] },
                    limit: { type: 'integer', minimum: 1, maximum: 500 },
                },
                additionalProperties: false,
            },
            {
                type: 'object',
                required: ['op', 'businessTag', 'query'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['entity'] },
                    businessTag: { type: 'string' },
                    query: {
                        type: 'string',
                        enum: [
                            'table.row_count',
                            'table.headers',
                            'table.primary_key',
                            'table.columns',
                            'table.current_rows',
                            'form.fields',
                            'form.actions',
                        ],
                    },
                },
                additionalProperties: false,
            },
            {
                type: 'object',
                required: ['op', 'businessTag', 'target'],
                properties: {
                    tabToken: { type: 'string' },
                    op: { type: 'string', enum: ['entity.target'] },
                    businessTag: { type: 'string' },
                    target: {
                        oneOf: [
                            {
                                type: 'object',
                                required: ['kind', 'fieldKey'],
                                properties: {
                                    kind: { type: 'string', enum: ['form.field'] },
                                    fieldKey: { type: 'string' },
                                },
                                additionalProperties: false,
                            },
                            {
                                type: 'object',
                                required: ['kind', 'actionIntent'],
                                properties: {
                                    kind: { type: 'string', enum: ['form.action'] },
                                    actionIntent: { type: 'string' },
                                },
                                additionalProperties: false,
                            },
                            {
                                type: 'object',
                                required: ['kind', 'primaryKey'],
                                properties: {
                                    kind: { type: 'string', enum: ['table.row'] },
                                    primaryKey: {
                                        type: 'object',
                                        required: ['fieldKey', 'value'],
                                        properties: {
                                            fieldKey: { type: 'string' },
                                            value: { type: 'string' },
                                        },
                                        additionalProperties: false,
                                    },
                                },
                                additionalProperties: false,
                            },
                            {
                                type: 'object',
                                required: ['kind', 'primaryKey', 'actionIntent'],
                                properties: {
                                    kind: { type: 'string', enum: ['table.row_action'] },
                                    primaryKey: {
                                        type: 'object',
                                        required: ['fieldKey', 'value'],
                                        properties: {
                                            fieldKey: { type: 'string' },
                                            value: { type: 'string' },
                                        },
                                        additionalProperties: false,
                                    },
                                    actionIntent: { type: 'string' },
                                },
                                additionalProperties: false,
                            },
                        ],
                    },
                },
                additionalProperties: false,
            },
        ],
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
            mutatesPage: { type: 'boolean' },
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
            inline: { type: 'boolean' },
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
    'browser.batch': {
        type: 'object',
        required: ['actions'],
        properties: {
            tabToken: { type: 'string' },
            stopOnError: { type: 'boolean' },
            contain: { type: 'string' },
            depth: { type: 'integer', minimum: -1 },
            actions: {
                type: 'array',
                minItems: 1,
                items: {
                    oneOf: [
                        {
                            type: 'object',
                            required: ['op', 'value'],
                            properties: {
                                op: { type: 'string', const: 'fill' },
                                id: { type: 'string' },
                                selector: { type: 'string' },
                                label: { type: 'string' },
                                role: { type: 'string' },
                                value: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                        {
                            type: 'object',
                            required: ['op', 'values'],
                            properties: {
                                op: { type: 'string', const: 'select_option' },
                                id: { type: 'string' },
                                selector: { type: 'string' },
                                label: { type: 'string' },
                                role: { type: 'string' },
                                values: { type: 'array', items: { type: 'string' }, minItems: 1 },
                            },
                            additionalProperties: false,
                        },
                        {
                            type: 'object',
                            required: ['op'],
                            properties: {
                                op: { type: 'string', const: 'click' },
                                id: { type: 'string' },
                                selector: { type: 'string' },
                                label: { type: 'string' },
                                role: { type: 'string' },
                                coord: {
                                    type: 'object',
                                    required: ['x', 'y'],
                                    properties: {
                                        x: { type: 'number' },
                                        y: { type: 'number' },
                                    },
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
                            },
                            additionalProperties: false,
                        },
                    ],
                },
            },
        },
        additionalProperties: false,
    },
} as const;
