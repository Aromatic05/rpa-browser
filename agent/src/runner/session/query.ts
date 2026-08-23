import {
    resolveSemanticRole,
    type ObservationNodeId,
    type PageObservation,
    type PageSnapshotSessionEntry,
} from '../../snapshot';
import type {BrowserQueryResult, StepArgsMap} from '../steps/types';
import {
    buildPageSessionEntityView,
    queryPageSessionBusinessEntity,
    resolvePageSessionBusinessTarget,
} from './entity_view';

const MAX_LIMIT = 500;
const ROOT_FROM_REFS = new Set(['snapshot', 'snapshot.latest']);

type BrowserQueryArgs = StepArgsMap['browser.query'];
type StructuralQueryArgs = Extract<BrowserQueryArgs, {from: unknown}>;

export type PageSessionQueryError = {
    code: 'ERR_BAD_ARGS' | 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS';
    message: string;
    details?: unknown;
};

export type PageSessionQueryResult =
    | {ok: true; data: BrowserQueryResult}
    | {ok: false; error: PageSessionQueryError};

export const queryPageSessionEntry = (
    entry: PageSnapshotSessionEntry,
    args: BrowserQueryArgs,
): PageSessionQueryResult => {
    if ('op' in args) {
        const result = args.op === 'entity'
            ? queryPageSessionBusinessEntity(entry, args.businessTag, args.query)
            : resolvePageSessionBusinessTarget(entry, args.businessTag, args.target);
        return result.ok
            ? {ok: true, data: result.data as BrowserQueryResult}
            : {
                ok: false,
                error: {
                    ...result.error,
                    details: businessQueryDiagnosticDetails(entry, args, result.error.details),
                },
            };
    }

    const observation = entry.capture.control.observation;
    const diagnosticDetails = queryDiagnosticDetails(observation, args);
    const relationResult = normalizeRelation(args.relation);
    if (!relationResult.ok) {
        return error('ERR_BAD_ARGS', relationResult.message, diagnosticDetails);
    }
    const relation = relationResult.value;
    if (args.limit !== undefined
        && (!Number.isInteger(args.limit) || args.limit <= 0 || args.limit > MAX_LIMIT)) {
        return error(
            'ERR_BAD_ARGS',
            `limit must be an integer between 1 and ${MAX_LIMIT}`,
            diagnosticDetails,
        );
    }

    const sources = resolveSourceNodeIds(observation, args.from);
    if (!sources.ok) {
        return {ok: false, error: {...sources.error, details: diagnosticDetails}};
    }

    const limit = args.limit ?? MAX_LIMIT;
    const nodeIds = collectCandidates(observation, sources.nodeIds, relation)
        .filter((nodeId) => isActive(observation, nodeId))
        .filter((nodeId) => matchesWhere(observation, nodeId, args.where))
        .slice(0, limit);

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

const resolveSourceNodeIds = (
    observation: PageObservation,
    from: StructuralQueryArgs['from'],
): {ok: true; nodeIds: ObservationNodeId[]} | {ok: false; error: PageSessionQueryError} => {
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

const businessQueryDiagnosticDetails = (
    entry: PageSnapshotSessionEntry,
    args: Extract<BrowserQueryArgs, {op: unknown}>,
    resolutionDetails: unknown,
): Record<string, unknown> => {
    const observation = entry.capture.control.observation;
    const availableBusinessTags = buildPageSessionEntityView(entry).entities
        .map((entity) => entity.businessTag)
        .filter((businessTag): businessTag is string => Boolean(businessTag))
        .sort();
    return {
        pageEpoch: observation.identity.pageEpoch,
        captureRevision: observation.identity.captureRevision,
        scopeIds: [...observation.scopes.rootScopeIds],
        operation: args.op,
        businessTag: args.businessTag,
        ...('query' in args ? {query: args.query} : {target: structuredClone(args.target)}),
        semanticProfiles: Object.keys(entry.semanticBindingsByProfile).sort(),
        availableBusinessTags,
        ...(entry.capture.entityRules ? {entityRules: summarizeEntityRules(entry.capture.entityRules)} : {}),
        ...(resolutionDetails === undefined ? {} : {resolution: structuredClone(resolutionDetails)}),
    };
};

const summarizeEntityRules = (
    execution: NonNullable<PageSnapshotSessionEntry['capture']['entityRules']>,
): Record<string, unknown> => ({
    status: execution.status,
    ok: execution.ok,
    diagnostics: execution.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        status: diagnostic.status,
    })),
    profiles: Object.fromEntries(Object.entries(execution.profiles).map(([profileName, profile]) => [profileName, {
        ok: profile.ok,
        diagnostics: profile.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            status: diagnostic.status,
        })),
        rules: Object.fromEntries(Object.entries(profile.bindings).map(([ruleId, binding]) => [ruleId, {
            ok: binding.ok,
            cardinality: binding.cardinality,
            matchedComponentIds: binding.matchedComponentIds,
            matchedNodeIds: binding.matchedNodeIds,
        }])),
    }])),
});

const queryDiagnosticDetails = (
    observation: PageObservation,
    args: StructuralQueryArgs,
): Record<string, unknown> => ({
    pageEpoch: observation.identity.pageEpoch,
    captureRevision: observation.identity.captureRevision,
    scopeIds: [...observation.scopes.rootScopeIds],
    relation: args.relation ?? 'descendant',
    from: args.from,
});

const error = (
    code: PageSessionQueryError['code'],
    message: string,
    details?: unknown,
): PageSessionQueryResult => ({ok: false, error: {code, message, details}});

const queryError = (message: string): {ok: false; error: PageSessionQueryError} => ({
    ok: false,
    error: {code: 'ERR_BAD_ARGS', message},
});

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() ?? '';
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
