const string = {type: 'string'} as const;
const primaryKey = {
    type: 'object',
    required: ['fieldKey', 'value'],
    properties: {fieldKey: string, value: string},
    additionalProperties: false,
} as const;

const businessTarget = {
    oneOf: [
        {type: 'object', required: ['kind', 'fieldKey'], properties: {kind: {const: 'entity.field'}, fieldKey: string}, additionalProperties: false},
        {type: 'object', required: ['kind', 'actionIntent'], properties: {kind: {const: 'entity.action'}, actionIntent: string}, additionalProperties: false},
        {type: 'object', required: ['kind', 'fieldKey'], properties: {kind: {const: 'form.field'}, fieldKey: string}, additionalProperties: false},
        {type: 'object', required: ['kind', 'actionIntent'], properties: {kind: {const: 'form.action'}, actionIntent: string}, additionalProperties: false},
        {type: 'object', required: ['kind', 'fieldKey'], properties: {kind: {const: 'table.filter'}, fieldKey: string}, additionalProperties: false},
        {type: 'object', required: ['kind', 'actionIntent'], properties: {kind: {const: 'table.module_action'}, actionIntent: string}, additionalProperties: false},
        {type: 'object', required: ['kind', 'primaryKey'], properties: {kind: {const: 'table.row'}, primaryKey}, additionalProperties: false},
        {type: 'object', required: ['kind', 'primaryKey', 'actionIntent'], properties: {kind: {const: 'table.row_action'}, primaryKey, actionIntent: string}, additionalProperties: false},
    ],
} as const;

export const queryIrJsonSchema = {
    $defs: {
        source: {
            oneOf: [
                {
                    type: 'object',
                    required: ['kind'],
                    properties: {kind: {const: 'roots'}},
                    additionalProperties: false,
                },
                {
                    type: 'object',
                    required: ['kind', 'nodeIds'],
                    properties: {
                        kind: {const: 'nodes'},
                        nodeIds: {type: 'array', items: string},
                    },
                    additionalProperties: false,
                },
            ],
        },
        predicate: {
            type: 'object',
            required: ['active'],
            properties: {
                active: {const: true},
                roleEquals: string,
                tagEquals: string,
                textContains: string,
                attrsEqual: {type: 'object', additionalProperties: string},
            },
            additionalProperties: false,
        },
        target: businessTarget,
        query: {
            oneOf: [
                {
                    type: 'object',
                    required: ['op', 'source'],
                    properties: {op: {const: 'scan'}, source: {$ref: '#/$defs/source'}},
                    additionalProperties: false,
                },
                {
                    type: 'object',
                    required: ['op', 'input', 'relation'],
                    properties: {
                        op: {const: 'traverse'},
                        input: {$ref: '#/$defs/query'},
                        relation: {type: 'string', enum: ['child', 'descendant']},
                    },
                    additionalProperties: false,
                },
                {
                    type: 'object',
                    required: ['op', 'input', 'predicate'],
                    properties: {
                        op: {const: 'filter'},
                        input: {$ref: '#/$defs/query'},
                        predicate: {$ref: '#/$defs/predicate'},
                    },
                    additionalProperties: false,
                },
                {
                    type: 'object',
                    required: ['op', 'input', 'count'],
                    properties: {
                        op: {const: 'limit'},
                        input: {$ref: '#/$defs/query'},
                        count: {type: 'integer', minimum: 1, maximum: 500},
                    },
                    additionalProperties: false,
                },
                ...['one', 'exists', 'count'].map((op) => ({
                    type: 'object' as const,
                    required: ['op', 'input'],
                    properties: {op: {const: op}, input: {$ref: '#/$defs/query'}},
                    additionalProperties: false,
                })),
                {
                    type: 'object',
                    required: ['op', 'businessTag', 'query'],
                    properties: {
                        op: {const: 'entity'},
                        businessTag: string,
                        query: {
                            type: 'string',
                            enum: [
                                'table.rowCount', 'table.headers', 'table.primaryKey', 'table.columns',
                                'table.currentRows', 'table.hasNextPage', 'table.nextPageTarget',
                                'form.fields', 'form.actions',
                            ],
                        },
                    },
                    additionalProperties: false,
                },
                {
                    type: 'object',
                    required: ['op', 'businessTag', 'target'],
                    properties: {
                        op: {const: 'entity.target'},
                        businessTag: string,
                        target: {$ref: '#/$defs/target'},
                    },
                    additionalProperties: false,
                },
            ],
        },
    },
    $ref: '#/$defs/query',
} as const satisfies object;
