import { DslRuntimeError } from '../../../program/dsl/diagnostics/errors';

export type DslScope = {
    input: Record<string, unknown>;
    failure?: Readonly<Record<string, unknown>>;
    vars: Record<string, unknown>;
    output: Record<string, unknown>;
};

const READABLE_ROOT_KEYS = new Set(['input', 'failure', 'vars', 'output']);
const WRITABLE_ROOT_KEYS = new Set(['vars', 'output']);

export const createDslScope = (input?: Record<string, unknown>, failure?: Record<string, unknown>): DslScope => ({
    input: { ...(input || {}) },
    ...(failure ? {failure: freezeDslValue(failure) as Readonly<Record<string, unknown>>} : {}),
    vars: {},
    output: {},
});

export const createChildDslScope = (parent: DslScope): DslScope => ({
    input: parent.input,
    ...(parent.failure ? {failure: parent.failure} : {}),
    vars: { ...parent.vars },
    output: parent.output,
});

export const promoteDslVariables = (
    parent: DslScope,
    child: DslScope,
    names: Iterable<string>,
): void => {
    for (const name of names) {
        if (Object.hasOwn(child.vars, name)) {
            parent.vars[name] = child.vars[name];
        }
    }
};

export const getDslValue = (scope: DslScope, path: string): unknown => {
    const [root, ...segments] = path.split('.');
    if (!root || !READABLE_ROOT_KEYS.has(root)) {
        throw new DslRuntimeError(`invalid DSL ref root: ${path}`);
    }

    let cursor: unknown = scope[root as keyof DslScope];
    for (const segment of segments) {
        if (!cursor || typeof cursor !== 'object' || !(segment in (cursor as Record<string, unknown>))) {
            throw new DslRuntimeError(`DSL ref not found: ${path}`);
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
};

export const setDslValue = (scope: DslScope, path: string, value: unknown): void => {
    const [root, ...segments] = path.split('.');
    if (!root || !WRITABLE_ROOT_KEYS.has(root)) {
        throw new DslRuntimeError(`invalid DSL assignment root: ${path}`);
    }

    let cursor = scope[root as 'vars' | 'output'];
    if (segments.length === 0) {
        throw new DslRuntimeError(`cannot assign DSL root directly: ${path}`);
    }

    for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        const next = cursor[segment];
        if (next === undefined) {
            cursor[segment] = {};
            cursor = cursor[segment] as Record<string, unknown>;
            continue;
        }
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
            throw new DslRuntimeError(`cannot assign through non-object path: ${path}`);
        }
        cursor = next as Record<string, unknown>;
    }

    cursor[segments[segments.length - 1]] = value;
};

const freezeDslValue = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {return value;}
    for (const child of Object.values(value)) {freezeDslValue(child);}
    return Object.freeze(value);
};
