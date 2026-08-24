import {
    resolveSemanticRole,
    type ObservationNodeId,
    type PageObservation,
    type PageSnapshotSessionEntry,
} from '../../snapshot';
import type {QueryIR, QueryPredicate} from '../../program/query/contracts';
import type {BrowserQueryResult} from '../steps/types';
import {queryPageSessionBusinessEntity, resolvePageSessionBusinessTarget} from './entity_view';

export type QueryIRExecutionError = {
    code: 'ERR_BAD_ARGS' | 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS';
    message: string;
    details?: unknown;
};

export type QueryIRExecutionResult =
    | {ok: true; data: BrowserQueryResult}
    | {ok: false; error: QueryIRExecutionError};

type QueryIRValue =
    | {kind: 'nodes'; nodeIds: ObservationNodeId[]}
    | {kind: 'result'; result: BrowserQueryResult};

export const executePageSessionQueryIR = (
    entry: PageSnapshotSessionEntry,
    ir: unknown,
): QueryIRExecutionResult => {
    if (!ir || typeof ir !== 'object' || !('op' in ir) || typeof ir.op !== 'string') {
        return badArgs('invalid QueryIR');
    }
    const evaluated = evaluate(entry, ir as QueryIR);
    if (!evaluated.ok) {return evaluated;}
    if (evaluated.value.kind === 'result') {return {ok: true, data: evaluated.value.result};}
    const observation = entry.capture.control.observation;
    const nodeIds = evaluated.value.nodeIds;
    return {
        ok: true,
        data: {
            kind: 'nodeIds',
            nodeIds,
            count: nodeIds.length,
            meta: {
                nodes: nodeIds.map((nodeId) => toNodeLike(observation, nodeId)),
                pageEpoch: observation.identity.pageEpoch,
                captureRevision: observation.identity.captureRevision,
            },
        },
    };
};

const evaluate = (
    entry: PageSnapshotSessionEntry,
    ir: QueryIR,
): {ok: true; value: QueryIRValue} | {ok: false; error: QueryIRExecutionError} => {
    const observation = entry.capture.control.observation;
    if (ir.op === 'entity') {
        const result = queryPageSessionBusinessEntity(entry, ir.businessTag, ir.query);
        return result.ok
            ? {ok: true, value: {kind: 'result', result: withWorldMeta(observation, result.data as BrowserQueryResult)}}
            : result;
    }
    if (ir.op === 'entity.target') {
        const result = resolvePageSessionBusinessTarget(entry, ir.businessTag, ir.target);
        return result.ok
            ? {ok: true, value: {kind: 'result', result: withWorldMeta(observation, result.data)}}
            : result;
    }
    if (ir.op === 'scan') {
        const nodeIds = ir.source.kind === 'roots'
            ? observation.scopes.rootScopeIds.map((scopeId) => observation.scopes.scopes[scopeId].rootNodeId)
            : ir.source.nodeIds.filter((nodeId) => Boolean(observation.nodes[nodeId]));
        return {ok: true, value: {kind: 'nodes', nodeIds: unique(nodeIds)}};
    }

    const input = evaluate(entry, ir.input);
    if (!input.ok) {return input;}
    if (input.value.kind !== 'nodes') {
        return badArgs(`${ir.op} requires a structural node input`);
    }
    if (ir.op === 'traverse') {
        return {
            ok: true,
            value: {
                kind: 'nodes',
                nodeIds: collectCandidates(observation, input.value.nodeIds, ir.relation),
            },
        };
    }
    if (ir.op === 'filter') {
        return {
            ok: true,
            value: {
                kind: 'nodes',
                nodeIds: input.value.nodeIds.filter((nodeId) => matchesPredicate(observation, nodeId, ir.predicate)),
            },
        };
    }
    if (ir.op === 'limit') {
        return {
            ok: true,
            value: {kind: 'nodes', nodeIds: input.value.nodeIds.slice(0, ir.count)},
        };
    }
    if (ir.op === 'count') {
        return resultValue(observation, input.value.nodeIds.length);
    }
    if (ir.op === 'exists') {
        return resultValue(observation, input.value.nodeIds.length > 0);
    }
    const actual = input.value.nodeIds.length;
    if (actual !== 1) {
        return {
            ok: false,
            error: {
                code: actual === 0 ? 'ERR_NOT_FOUND' : 'ERR_AMBIGUOUS',
                message: `one expected exactly one result, got ${actual}`,
                details: {
                    operator: 'one',
                    expected: 1,
                    actual,
                    ...worldMeta(observation),
                },
            },
        };
    }
    return {
        ok: true,
        value: {
            kind: 'result',
            result: {
                kind: 'nodeId',
                nodeId: input.value.nodeIds[0],
                meta: worldMeta(observation),
            },
        },
    };
};

const resultValue = (
    observation: PageObservation,
    value: unknown,
): {ok: true; value: QueryIRValue} => ({
    ok: true,
    value: {
        kind: 'result',
        result: {kind: 'value', value, meta: worldMeta(observation)},
    },
});

const worldMeta = (observation: PageObservation): Record<string, unknown> => ({
    pageEpoch: observation.identity.pageEpoch,
    captureRevision: observation.identity.captureRevision,
});

const withWorldMeta = (
    observation: PageObservation,
    result: BrowserQueryResult,
): BrowserQueryResult => ({
    ...result,
    meta: {...(result.meta ?? {}), ...worldMeta(observation)},
});

const collectCandidates = (
    observation: PageObservation,
    sources: readonly ObservationNodeId[],
    relation: 'child' | 'descendant',
): ObservationNodeId[] => {
    const seen = new Set<ObservationNodeId>();
    const out: ObservationNodeId[] = [];
    for (const source of sources) {
        const candidates = relation === 'child'
            ? observation.children[source]
            : descendants(observation, source);
        for (const nodeId of candidates) {
            if (seen.has(nodeId)) {continue;}
            seen.add(nodeId);
            out.push(nodeId);
        }
    }
    return out.sort((left, right) => observation.documentOrder[left] - observation.documentOrder[right]);
};

const descendants = (
    observation: PageObservation,
    rootNodeId: ObservationNodeId,
): ObservationNodeId[] => {
    const out: ObservationNodeId[] = [];
    const stack = [...observation.children[rootNodeId]];
    while (stack.length > 0) {
        const nodeId = stack.shift()!;
        out.push(nodeId);
        stack.unshift(...observation.children[nodeId]);
    }
    return out;
};

const matchesPredicate = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    predicate: QueryPredicate,
): boolean => {
    if (!isActive(observation, nodeId)) {return false;}
    if (predicate.roleEquals
        && normalizeLower(resolveSemanticRole(observation, nodeId).value) !== normalizeLower(predicate.roleEquals)) {
        return false;
    }
    if (predicate.tagEquals
        && normalizeLower(observation.nodes[nodeId].tag) !== normalizeLower(predicate.tagEquals)) {
        return false;
    }
    if (predicate.textContains
        && !normalizeLower(readNodeText(observation, nodeId)).includes(normalizeLower(predicate.textContains))) {
        return false;
    }
    if (predicate.attrsEqual) {
        const attrs = observation.attributes[nodeId];
        for (const [key, value] of Object.entries(predicate.attrsEqual)) {
            if ((attrs[key] ?? '') !== value) {return false;}
        }
    }
    return true;
};

const toNodeLike = (observation: PageObservation, nodeId: ObservationNodeId) => {
    const attrs = observation.attributes[nodeId];
    const children = observation.children[nodeId];
    return {
        id: nodeId,
        role: resolveSemanticRole(observation, nodeId).value || undefined,
        tag: observation.nodes[nodeId].tag,
        text: readNodeText(observation, nodeId),
        attrs: Object.keys(attrs).length > 0 ? {...attrs} : undefined,
        children: children.length > 0 ? [...children] : undefined,
        handle: {nodeId},
    };
};

const readNodeText = (observation: PageObservation, nodeId: ObservationNodeId): string | undefined => {
    const values: string[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
        const current = stack.shift()!;
        const value = normalizeText(observation.accessibility[current]?.name)
            ?? normalizeText(observation.text[current]);
        if (value && !values.includes(value)) {values.push(value);}
        stack.unshift(...observation.children[current]);
    }
    return normalizeText(values.join(' '));
};

const isActive = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const activity = observation.activity[nodeId];
    return activity.rendered && activity.subtreeActive && !activity.hiddenByStyle && !activity.inert
        && activity.ariaExposed !== false;
};

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() ?? '';
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const badArgs = (message: string): {ok: false; error: QueryIRExecutionError} => ({
    ok: false,
    error: {code: 'ERR_BAD_ARGS', message},
});
