import {
    resolveSemanticRole,
    type ObservationNodeId,
    type PageObservation,
} from '../../../snapshot';
import type {RunStepsDeps} from '../../run_steps';
import {
    ensureFreshPageSession,
    queryPageSessionBusinessEntity,
    resolvePageSessionBusinessTarget,
} from '../../session';
import type {Step, StepResult} from '../types';

const MAX_LIMIT = 500;
const ROOT_FROM_REFS = new Set(['snapshot', 'snapshot.latest']);

type StructuralQueryArgs = Extract<Step<'browser.query'>['args'], {from: unknown}>;

export const executeBrowserQuery = async (
    step: Step<'browser.query'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const {entry} = await ensureFreshPageSession(deps, workspaceName);

    if ('op' in step.args) {
        const result = step.args.op === 'entity'
            ? queryPageSessionBusinessEntity(
                entry,
                step.args.businessTag,
                step.args.query,
            )
            : resolvePageSessionBusinessTarget(
                entry,
                step.args.businessTag,
                step.args.target,
            );
        return result.ok
            ? {stepId: step.id, ok: true, data: result.data}
            : {stepId: step.id, ok: false, error: result.error};
    }

    const args = step.args;
    const relationResult = normalizeRelation(args.relation);
    if (!relationResult.ok) {
        return stepError(step.id, 'ERR_BAD_ARGS', relationResult.message);
    }
    const relation = relationResult.value;
    if (args.limit !== undefined
        && (!Number.isInteger(args.limit) || args.limit <= 0 || args.limit > MAX_LIMIT)) {
        return stepError(step.id, 'ERR_BAD_ARGS', `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }

    const observation = entry.capture.control.observation;
    const sources = resolveSourceNodeIds(observation, args.from);
    if (!sources.ok) {return {stepId: step.id, ok: false, error: sources.error};}

    const limit = args.limit ?? MAX_LIMIT;
    const nodeIds = collectCandidates(observation, sources.nodeIds, relation)
        .filter((nodeId) => isActive(observation, nodeId))
        .filter((nodeId) => matchesWhere(observation, nodeId, args.where))
        .slice(0, limit);

    return {
        stepId: step.id,
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

const resolveSourceNodeIds = (
    observation: PageObservation,
    from: StructuralQueryArgs['from'],
): {ok: true; nodeIds: ObservationNodeId[]} | {ok: false; error: StepResult['error']} => {
    if (typeof from === 'string') {
        const normalized = normalizeText(from);
        if (!normalized) {return queryError('from is required');}
        if (!ROOT_FROM_REFS.has(normalized)) {
            return queryError('from must be snapshot or snapshot.latest');
        }
        return {
            ok: true,
            nodeIds: observation.scopes.rootScopeIds
                .map((scopeId) => observation.scopes.scopes[scopeId].rootNodeId),
        };
    }

    if ('nodeIds' in from) {
        if (!Array.isArray(from.nodeIds) || from.nodeIds.length === 0) {
            return queryError('from.nodeIds must be a non-empty array');
        }
        const nodes = new Map(Object.entries(observation.nodes));
        return {
            ok: true,
            nodeIds: unique(from.nodeIds.filter((nodeId) => nodes.has(nodeId))),
        };
    }

    if ('nodes' in from) {
        if (!Array.isArray(from.nodes) || from.nodes.length === 0) {
            return queryError('from.nodes must be a non-empty array');
        }
        const nodes = new Map(Object.entries(observation.nodes));
        const nodeIds = from.nodes
            .map((item) => {
                if (typeof item !== 'object') {return undefined;}
                if ('id' in item && typeof item.id === 'string') {return item.id;}
                if ('handle' in item && typeof item.handle === 'object'
                    && 'nodeId' in item.handle && typeof item.handle.nodeId === 'string') {
                    return item.handle.nodeId;
                }
                return undefined;
            })
            .filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodes.has(nodeId));
        return {ok: true, nodeIds: unique(nodeIds)};
    }

    return queryError('unsupported from type');
};

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
    return out.sort((left, right) =>
        observation.documentOrder[left] - observation.documentOrder[right]);
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

const matchesWhere = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    where: StructuralQueryArgs['where'],
): boolean => {
    if (!where) {return true;}
    if (where.role && normalizeLower(resolveSemanticRole(observation, nodeId).value) !== normalizeLower(where.role)) {
        return false;
    }
    if (where.tag && normalizeLower(observation.nodes[nodeId].tag) !== normalizeLower(where.tag)) {
        return false;
    }
    if (where.text?.contains
        && !normalizeLower(readNodeText(observation, nodeId)).includes(normalizeLower(where.text.contains))) {
        return false;
    }
    if (where.attrs) {
        const attrs = observation.attributes[nodeId];
        for (const [key, value] of Object.entries(where.attrs)) {
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
        const text = normalizeText(observation.accessibility[current]?.name)
            ?? normalizeText(observation.text[current]);
        if (text && !values.includes(text)) {values.push(text);}
        stack.unshift(...observation.children[current]);
    }
    return normalizeText(values.join(' '));
};

const isActive = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const activity = observation.activity[nodeId];
    return activity.rendered && activity.subtreeActive && !activity.hiddenByStyle && !activity.inert
        && activity.ariaExposed !== false;
};

const normalizeRelation = (value: unknown):
    | {ok: true; value: 'child' | 'descendant'}
    | {ok: false; message: string} => {
    if (value === undefined || value === 'descendant') {return {ok: true, value: 'descendant'};}
    if (value === 'child') {return {ok: true, value: 'child'};}
    return {ok: false, message: 'relation must be child or descendant'};
};

const stepError = (
    stepId: string,
    code: 'ERR_BAD_ARGS' | 'ERR_NOT_FOUND',
    message: string,
): StepResult => ({stepId, ok: false, error: {code, message}});
const queryError = (message: string): {ok: false; error: StepResult['error']} => ({
    ok: false,
    error: {code: 'ERR_BAD_ARGS', message},
});
const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};
const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() ?? '';
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
