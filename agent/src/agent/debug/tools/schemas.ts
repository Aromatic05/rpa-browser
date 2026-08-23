import type {ComputeEvalScope} from '../../../runner/compute/evaluate';
import type {ComputeExpr, StepArgsMap} from '../../../runner/steps/types';

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

export const debugQueryJsonSchema = {
    oneOf: [
        {
            type: 'object',
            required: ['from'],
            properties: {
                from: {
                    anyOf: [
                        {type: 'string', enum: ['snapshot', 'snapshot.latest']},
                        {type: 'object', required: ['nodeIds'], properties: {nodeIds: {type: 'array', minItems: 1, items: string}}, additionalProperties: false},
                        {
                            type: 'object',
                            required: ['nodes'],
                            properties: {
                                nodes: {
                                    type: 'array',
                                    minItems: 1,
                                    items: {
                                        oneOf: [
                                            {type: 'object', required: ['id'], properties: {id: string}, additionalProperties: false},
                                            {type: 'object', required: ['handle'], properties: {handle: {type: 'object', required: ['nodeId'], properties: {nodeId: string}, additionalProperties: false}}, additionalProperties: false},
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
                    properties: {
                        role: string,
                        tag: string,
                        text: {type: 'object', properties: {contains: string}, additionalProperties: false},
                        attrs: {type: 'object', additionalProperties: string},
                    },
                    additionalProperties: false,
                },
                relation: {type: 'string', enum: ['child', 'descendant']},
                limit: {type: 'integer', minimum: 1, maximum: 500},
            },
            additionalProperties: false,
        },
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
                target: businessTarget,
            },
            additionalProperties: false,
        },
    ],
} as const satisfies object;

export const debugComputeJsonSchema = {
    type: 'object',
    required: ['expr'],
    $defs: {
        computeExpr: {
            type: 'object',
            required: ['op', 'args'],
            properties: {
                op: {type: 'string', enum: ['len', 'exists', 'first', 'get', 'eq', 'not', 'and', 'or']},
                args: {type: 'array', items: {$ref: '#/$defs/computeValue'}},
            },
            additionalProperties: false,
        },
        computeValue: {
            oneOf: [
                {
                    type: 'object',
                    required: ['literal'],
                    properties: {literal: {}},
                    additionalProperties: false,
                },
                {
                    type: 'object',
                    required: ['ref'],
                    properties: {
                        ref: {
                            type: 'object',
                            required: ['path'],
                            properties: {path: {type: 'string'}},
                            additionalProperties: false,
                        },
                    },
                    additionalProperties: false,
                },
                {$ref: '#/$defs/computeExpr'},
            ],
        },
    },
    properties: {
        expr: {$ref: '#/$defs/computeExpr'},
        scope: {
            type: 'object',
            properties: {
                steps: {type: 'object', additionalProperties: true},
                input: {type: 'object', additionalProperties: true},
                local: {type: 'object', additionalProperties: true},
                vars: {type: 'object', additionalProperties: true},
                output: {type: 'object', additionalProperties: true},
                failure: {type: 'object', additionalProperties: true},
            },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
} as const satisfies object;

export type DebugQueryToolInput = StepArgsMap['browser.query'];
export type DebugComputeToolInput = {expr: ComputeExpr; scope?: ComputeEvalScope};
