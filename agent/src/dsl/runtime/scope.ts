import { DslRuntimeError } from '../diagnostics/errors';

export type DslScope = {
    input: Record<string, unknown>;
    vars: Record<string, unknown>;
    output: Record<string, unknown>;
};

const ROOT_KEYS = new Set(['input', 'vars', 'output']);

export const createDslScope = (input?: Record<string, unknown>): DslScope => ({
    input: { ...(input || {}) },
    vars: {},
    output: {},
});

export const getDslValue = (scope: DslScope, path: string): unknown => {
    const [root, ...segments] = path.split('.');
    if (!root || !ROOT_KEYS.has(root)) {
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
    if (!root || !ROOT_KEYS.has(root)) {
        throw new DslRuntimeError(`invalid DSL assignment root: ${path}`);
    }

    let cursor: Record<string, unknown> = scope[root as keyof DslScope];
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
