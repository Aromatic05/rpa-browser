import crypto from 'node:crypto';
import type { QueryExpr } from '../ast/types';
import { DslRuntimeError } from '../diagnostics/errors';
import type { Step, StepArgsMap, StepUnion } from '../../runner/steps/types';

const createStep = <TName extends StepUnion['name']>(name: TName, args: Step<TName>['args']): Step<TName> => ({
    id: crypto.randomUUID(),
    name,
    args,
    meta: {
        source: 'dsl',
        ts: Date.now(),
    },
});

export const buildQueryStep = (expr: QueryExpr): Step<'browser.query'> => {
    if (expr.op === 'entity') {
        return createStep('browser.query', {
            op: 'entity',
            businessTag: expr.businessTag,
            query: expr.payload as Extract<StepArgsMap['browser.query'], { op: 'entity' }>['query'],
        });
    }

    return createStep('browser.query', {
        op: 'entity.target',
        businessTag: expr.businessTag,
        target: expr.payload as Extract<StepArgsMap['browser.query'], { op: 'entity.target' }>['target'],
    });
};

const toTargetArgs = (target: unknown): Pick<Step<'browser.click'>['args'], 'nodeId' | 'selector' | 'resolveId'> => {
    if (typeof target === 'string') {
        return { nodeId: target };
    }
    if (!target || typeof target !== 'object') {
        throw new DslRuntimeError('action target must resolve to a nodeId-like value');
    }

    const targetRecord = target as Record<string, unknown>;
    if (typeof targetRecord.nodeId === 'string') {
        return { nodeId: targetRecord.nodeId };
    }
    if (typeof targetRecord.selector === 'string') {
        return { selector: targetRecord.selector };
    }
    if (typeof targetRecord.resolveId === 'string') {
        return { resolveId: targetRecord.resolveId };
    }
    if (targetRecord.kind === 'nodeId' && typeof targetRecord.nodeId === 'string') {
        return { nodeId: targetRecord.nodeId };
    }

    throw new DslRuntimeError('action target did not resolve to nodeId/selector/resolveId');
};



const SELECT_OPTION_KINDS = new Set<Step<'browser.select_option'>['args']['kind']>([
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
]);

const toSelectOptionKind = (target: unknown): Step<'browser.select_option'>['args']['kind'] => {
    if (!target || typeof target !== 'object') {return 'native_select';}
    const targetRecord = target as Record<string, unknown>;
    const directKind = targetRecord.controlKind;
    const meta = targetRecord.meta;
    const metaKind = meta && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).controlKind
        : undefined;
    const candidate = typeof directKind === 'string' ? directKind : metaKind;
    return typeof candidate === 'string'
        && SELECT_OPTION_KINDS.has(candidate as Step<'browser.select_option'>['args']['kind'])
        ? candidate as Step<'browser.select_option'>['args']['kind']
        : 'native_select';
};

const toActionText = (value: unknown): string => {
    if (value === null || value === undefined) {return '';}
    if (typeof value === 'string') {return value;}
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    throw new DslRuntimeError('action value must resolve to a primitive');
};

export const buildFillStep = (target: unknown, value: unknown): Step<'browser.fill'> => {
    const targetArgs = toTargetArgs(target);
    return createStep('browser.fill', {
        ...targetArgs,
        value: toActionText(value),
    });
};

export const buildClickStep = (target: unknown): Step<'browser.click'> => {
    const targetArgs = toTargetArgs(target);
    return createStep('browser.click', targetArgs);
};

export const buildTypeStep = (target: unknown, value: unknown): Step<'browser.type'> => {
    const targetArgs = toTargetArgs(target);
    return createStep('browser.type', {
        ...targetArgs,
        text: toActionText(value),
    });
};

export const buildSelectStep = (target: unknown, value: unknown): Step<'browser.select_option'> => {
    const targetArgs = toTargetArgs(target);
    return createStep('browser.select_option', {
        ...targetArgs,
        kind: toSelectOptionKind(target),
        values: [toActionText(value)],
    });
};

export const buildSnapshotStep = (): Step<'browser.snapshot'> => {
    return createStep('browser.snapshot', {});
};
