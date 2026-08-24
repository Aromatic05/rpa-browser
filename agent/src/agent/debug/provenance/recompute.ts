import {isDeepStrictEqual} from 'node:util';
import {evaluateComputeExpression} from '../../../program/compute/evaluate';
import type {QueryExpr} from '../../../program/dsl/ast/types';
import type {DslScopeSnapshot} from '../../../automation/dsl/debug/contracts';
import {adaptDslQueryResult} from '../../../automation/dsl/runtime/value_adapter';
import {compileBrowserQuery} from '../../../program/query/compile';
import type {BrowserQueryRequest, BusinessQueryName, BusinessTarget} from '../../../program/query/contracts';
import type {DebugQuerySession} from '../query/contracts';
import type {
    DebugValueExplanation,
    DebugValueRecomputeResult,
    DebugValueProvenanceStore,
} from './contracts';

type CandidateResult =
    | Readonly<{ok: true; value: unknown}>
    | Readonly<{
        ok: false;
        status: 'unavailable';
        reason: 'untracked' | 'unsupported_source' | 'unsupported_query' | 'cycle' | 'missing_scope_value';
        sourceKind?: NonNullable<DebugValueExplanation['provenance']>['source']['kind'];
    }>
    | Readonly<{
        ok: false;
        status: 'failed';
        error: Readonly<{code: string; message: string; details?: unknown}>;
    }>;

type MutableComputeScope = {
    input?: Record<string, unknown>;
    local?: Record<string, unknown>;
    vars?: Record<string, unknown>;
    output?: Record<string, unknown>;
    failure?: Record<string, unknown>;
};

export const recomputeDebugValue = (
    store: DebugValueProvenanceStore,
    programId: string,
    path: string,
    scope: DslScopeSnapshot,
    debug: DebugQuerySession,
): DebugValueRecomputeResult => {
    const explanation = store.explain(programId, path);
    if (explanation.origin === 'untracked') {
        return Object.freeze({
            status: 'unavailable' as const,
            programId,
            path,
            reason: 'untracked' as const,
            explanation,
        });
    }
    const current = readScopePath(scope, path);
    if (!current.found) {
        return Object.freeze({
            status: 'unavailable' as const,
            programId,
            path,
            reason: 'missing_scope_value' as const,
            explanation,
        });
    }
    const candidate = evaluateExplanation(explanation, scope, debug, new Set());
    if (!candidate.ok) {
        return candidate.status === 'failed'
            ? Object.freeze({status: 'failed' as const, programId, path, error: candidate.error, explanation})
            : Object.freeze({
                status: 'unavailable' as const,
                programId,
                path,
                reason: candidate.reason,
                ...(candidate.sourceKind ? {sourceKind: candidate.sourceKind} : {}),
                explanation,
            });
    }
    return Object.freeze({
        status: 'recomputed' as const,
        programId,
        path,
        currentValue: structuredClone(current.value),
        candidateValue: structuredClone(candidate.value),
        changed: !isDeepStrictEqual(current.value, candidate.value),
        explanation,
    });
};

const evaluateExplanation = (
    explanation: DebugValueExplanation,
    scope: DslScopeSnapshot,
    debug: DebugQuerySession,
    visiting: Set<string>,
): CandidateResult => {
    const key = `${explanation.programId}\u0000${explanation.path}`;
    if (visiting.has(key)) {return unavailable('cycle');}
    if (explanation.origin === 'untracked') {return unavailable('untracked');}
    if (explanation.origin === 'input' || explanation.origin === 'failure') {
        const value = readScopePath(scope, explanation.path);
        return value.found ? {ok: true, value: value.value} : unavailable('missing_scope_value');
    }
    const provenance = explanation.provenance;
    if (!provenance) {return unavailable('untracked');}
    const next = new Set(visiting);
    next.add(key);
    const source = provenance.source;
    if (source.kind === 'checkpoint' || source.kind === 'loop') {
        return unavailable('unsupported_source', source.kind);
    }
    if (source.kind === 'ref') {
        const dependency = dependencyByPath(explanation, source.ref);
        return dependency ? evaluateExplanation(dependency, scope, debug, next) : unavailable('untracked');
    }

    const candidates = new Map<string, unknown>();
    for (const dependencyPath of source.dependencies) {
        const dependency = dependencyByPath(explanation, dependencyPath);
        if (!dependency) {return unavailable('untracked');}
        const evaluated = evaluateExplanation(dependency, scope, debug, next);
        if (!evaluated.ok) {return evaluated;}
        candidates.set(dependencyPath, evaluated.value);
    }

    if (source.kind === 'query') {
        if (!source.query) {return unavailable('unsupported_query', source.kind);}
        const query = source.dependencies.length === 0
            ? {ok: true as const, ir: source.query}
            : compileQueryExpression(source.expression, candidates);
        if (!query.ok) {
            return failed(query.error.code, query.error.message);
        }
        const result = debug.query(query.ir);
        return result.ok
            ? {ok: true, value: adaptDslQueryResult(result.result)}
            : failed(result.error.code, result.error.message, result.error.details);
    }

    const computeScope = cloneComputeScope(scope);
    for (const [dependencyPath, value] of candidates) {
        if (!writeScopePath(computeScope, dependencyPath, value)) {
            return unavailable('missing_scope_value');
        }
    }
    try {
        return {ok: true, value: evaluateComputeExpression(source.expression.expr, computeScope)};
    } catch (error) {
        return failed('ERR_BAD_ARGS', error instanceof Error ? error.message : 'failed to recompute expression');
    }
};

const dependencyByPath = (
    explanation: DebugValueExplanation,
    path: string,
): DebugValueExplanation | undefined => explanation.dependencies.find((dependency) => dependency.path === path);

const compileQueryExpression = (
    expression: QueryExpr,
    candidates: ReadonlyMap<string, unknown>,
) => {
    const payload = resolveQueryPayload(expression.payload, candidates);
    const request: BrowserQueryRequest = expression.op === 'entity'
        ? {op: 'entity', businessTag: expression.businessTag, query: payload as BusinessQueryName}
        : {op: 'entity.target', businessTag: expression.businessTag, target: payload as BusinessTarget};
    return compileBrowserQuery(request);
};

const resolveQueryPayload = (value: unknown, candidates: ReadonlyMap<string, unknown>): unknown => {
    if (!value || typeof value !== 'object') {return value;}
    if (Array.isArray(value)) {return value.map((item) => resolveQueryPayload(item, candidates));}
    const record = value as Record<string, unknown>;
    if (record.kind === 'ref' && typeof record.ref === 'string') {
        return String(candidates.get(record.ref));
    }
    return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, resolveQueryPayload(item, candidates)]),
    );
};

const cloneComputeScope = (scope: DslScopeSnapshot): MutableComputeScope => {
    const vars = cloneRecord(scope.vars);
    return {
        input: cloneRecord(scope.input),
        vars,
        local: vars,
        output: cloneRecord(scope.output),
        ...(scope.failure ? {failure: cloneRecord(scope.failure)} : {}),
    };
};

const cloneRecord = (value: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(structuredClone(value)));

const readScopePath = (
    scope: DslScopeSnapshot,
    path: string,
): {found: true; value: unknown} | {found: false} => {
    const keys = path.split('.').filter(Boolean);
    if (keys.length === 0) {return {found: false};}
    const root = keys.shift()!;
    let cursor: unknown = root === 'local'
        ? scope.vars
        : root === 'input'
            ? scope.input
            : root === 'vars'
                ? scope.vars
                : root === 'output'
                    ? scope.output
                    : root === 'failure'
                        ? scope.failure
                        : undefined;
    if (cursor === undefined) {return {found: false};}
    for (const key of keys) {
        if (!cursor || typeof cursor !== 'object' || !(key in (cursor as Record<string, unknown>))) {
            return {found: false};
        }
        cursor = (cursor as Record<string, unknown>)[key];
    }
    return {found: true, value: cursor};
};

const writeScopePath = (scope: MutableComputeScope, path: string, value: unknown): boolean => {
    const keys = path.split('.').filter(Boolean);
    if (keys.length < 2) {return false;}
    const root = keys.shift()!;
    const resolvedRoot = root === 'local' ? 'vars' : root;
    if (!['input', 'vars', 'output', 'failure'].includes(resolvedRoot)) {return false;}
    const rootValue = resolvedRoot === 'input'
        ? scope.input
        : resolvedRoot === 'vars'
            ? scope.vars
            : resolvedRoot === 'output'
                ? scope.output
                : scope.failure;
    if (!rootValue || typeof rootValue !== 'object') {return false;}
    let cursor = rootValue;
    while (keys.length > 1) {
        const key = keys.shift()!;
        const next = cursor[key];
        if (!next || typeof next !== 'object' || Array.isArray(next)) {return false;}
        cursor = next as Record<string, unknown>;
    }
    cursor[keys[0]] = structuredClone(value);
    if (root === 'local') {scope.local = scope.vars;}
    return true;
};

const unavailable = (
    reason: 'untracked' | 'unsupported_source' | 'unsupported_query' | 'cycle' | 'missing_scope_value',
    sourceKind?: NonNullable<DebugValueExplanation['provenance']>['source']['kind'],
): CandidateResult => ({ok: false, status: 'unavailable', reason, ...(sourceKind ? {sourceKind} : {})});

const failed = (code: string, message: string, details?: unknown): CandidateResult => ({
    ok: false,
    status: 'failed',
    error: {code, message, ...(details === undefined ? {} : {details: structuredClone(details)})},
});
