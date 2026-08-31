import type {ComputeEvalScope} from '../../../program/compute/evaluate';
import type {ComputeExpr} from '../../../program/compute/types';
import type {QueryIR} from '../../../program/query/contracts';
import {queryIrJsonSchema} from '../../../program/query/schema';

export const debugQueryJsonSchema = queryIrJsonSchema;

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

export type DebugQueryToolInput = QueryIR;
export type DebugComputeToolInput = {expr: ComputeExpr; scope?: ComputeEvalScope};
