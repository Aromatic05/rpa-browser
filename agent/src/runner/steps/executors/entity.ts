import {
    resolveSemanticRole,
    type ObservationNodeId,
    type PageSnapshotSessionEntry,
    type SemanticBusinessBinding,
} from '../../../snapshot';
import type {RunStepsDeps} from '../../run_steps';
import {
    buildPageSessionEntityView,
    ensureFreshPageSession,
    filterPageSessionEntities,
    type PageSessionEntityRecord,
    type RuntimeEntityKind,
} from '../../session';
import type {Step, StepResult} from '../types';

export const executeBrowserEntity = async (
    step: Step<'browser.entity'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const context = await ensureFreshPageSession(deps, workspaceName);
    const page = context.binding.page;
    const args = step.args;

    if (args.op === 'list' || args.op === 'find') {
        const filtered = filterPageSessionEntities(
            buildPageSessionEntityView(context.entry).entities,
            {
                kind: args.kind,
                businessTag: args.businessTag,
                query: args.query,
            },
        );
        return {
            stepId: step.id,
            ok: true,
            data: {
                total: filtered.length,
                entities: filtered.map(toEntityOutputRecord),
                diagnostics: summarizeSemanticDiagnostics(context.entry),
            },
        };
    }

    const nodeId = normalizeText(args.nodeId);
    if (!nodeId) {return badArgs(step.id, 'nodeId is required');}
    if (!hasNode(context.entry, nodeId)) {
        return notFound(step.id, 'node id not found in PageSession', {nodeId});
    }

    if (args.op === 'get') {
        const view = buildPageSessionEntityView(context.entry);
        const entities = view.byNodeId[nodeId] ?? [];
        return {
            stepId: step.id,
            ok: true,
            data: {
                node: buildNodeSummary(context.entry, nodeId, entities),
                entities: entities.map(toEntityOutputRecord),
                total: entities.length,
                table_meta: buildTableMeta(context.entry, nodeId),
                diagnostics: summarizeSemanticDiagnostics(context.entry),
            },
        };
    }

    if (args.op === 'add') {
        const kind = readEntityKind(args.kind);
        if (!kind) {return badArgs(step.id, 'kind must be a supported entity kind');}
        const name = normalizeText(args.name);
        const businessTag = normalizeText(args.businessTag);
        const mutation = deps.pageSession.upsertManualSemanticBinding(page, {
            id: `entity:${stableNodeIdentity(context.entry, nodeId)}:${kind}:${businessTag ?? name ?? ''}`,
            nodeId,
            annotation: {
                entityKind: kind,
                ...(name ? {displayName: name} : {}),
                ...(businessTag ? {businessTag} : {}),
            },
        });
        if (!mutation.ok) {return mutationError(step.id, mutation.reason);}
        const view = buildPageSessionEntityView(mutation.entry);
        const added = view.entities.find((entity) => entity.bindingIds?.includes(mutation.binding.id));
        return {
            stepId: step.id,
            ok: true,
            data: {
                node: buildNodeSummary(mutation.entry, nodeId, view.byNodeId[nodeId] ?? []),
                entity: added ? toEntityOutputRecord(added) : undefined,
                semantic_summary: buildManualSemanticSummary(mutation.entry),
            },
        };
    }

    if (args.op === 'rename') {
        const name = normalizeText(args.name);
        if (!name) {return badArgs(step.id, 'name is required');}
        const mutation = deps.pageSession.upsertManualSemanticBinding(page, {
            id: `rename:${stableNodeIdentity(context.entry, nodeId)}`,
            nodeId,
            annotation: {displayName: name},
        });
        if (!mutation.ok) {return mutationError(step.id, mutation.reason);}
        const entities = buildPageSessionEntityView(mutation.entry).byNodeId[nodeId] ?? [];
        return {
            stepId: step.id,
            ok: true,
            data: {
                node: buildNodeSummary(mutation.entry, nodeId, entities),
                name,
                semantic_summary: buildManualSemanticSummary(mutation.entry),
            },
        };
    }

    const businessTag = normalizeText(args.businessTag);
    const beforeView = buildPageSessionEntityView(context.entry);
    const matched = (beforeView.byNodeId[nodeId] ?? []).filter((entity) =>
        (!args.kind || entity.kind === args.kind)
        && (!businessTag || entity.businessTag === businessTag));
    let currentEntry = context.entry;
    for (const entity of matched) {
        const manualEntityBinding = findManualEntityBinding(currentEntry, entity);
        if (manualEntityBinding) {
            const ignored = deps.pageSession.ignoreManualSemanticBindings(page, [manualEntityBinding.id]);
            if (!ignored.ok) {return mutationError(step.id, ignored.reason);}
            currentEntry = ignored.entry;
            continue;
        }
        const suppression = deps.pageSession.upsertManualSemanticBinding(page, {
            id: `suppress:${entity.id}`,
            nodeId: entity.nodeId,
            annotation: {suppressesEntityId: entity.id},
        });
        if (!suppression.ok) {return mutationError(step.id, suppression.reason);}
        currentEntry = suppression.entry;
    }
    const afterView = buildPageSessionEntityView(currentEntry);
    const after = (afterView.byNodeId[nodeId] ?? []).filter((entity) =>
        (!args.kind || entity.kind === args.kind)
        && (!businessTag || entity.businessTag === businessTag)).length;
    return {
        stepId: step.id,
        ok: true,
        data: {
            node_id: nodeId,
            matched_before: matched.length,
            matched_after: after,
            deleted_count: Math.max(0, matched.length - after),
            node_exists: true,
            semantic_summary: buildManualSemanticSummary(currentEntry),
        },
    };
};

const toEntityOutputRecord = (entity: PageSessionEntityRecord) => ({
    id: entity.id,
    nodeId: entity.nodeId,
    kind: entity.kind,
    name: entity.name,
    businessTag: entity.businessTag,
    source: entity.source,
    componentId: entity.componentId,
    bindingId: entity.bindingId,
});

const buildNodeSummary = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
    entities: readonly PageSessionEntityRecord[],
) => {
    const observation = entry.capture.control.observation;
    const attrs = observation.attributes[nodeId];
    const children = observation.children[nodeId];
    const renamed = entities.map((entity) => entity.name).find(Boolean);
    return {
        id: nodeId,
        role: resolveSemanticRole(observation, nodeId).value || undefined,
        tag: observation.nodes[nodeId].tag,
        name: renamed ?? observation.accessibility[nodeId]?.name,
        text: readNodeText(entry, nodeId),
        attrs: Object.keys(attrs).length > 0 ? {...attrs} : undefined,
        children: children.length > 0 ? [...children] : undefined,
        handle: {nodeId},
    };
};

const buildTableMeta = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId) => {
    const table = Object.values(entry.capture.table.tables.tables)
        .find((candidate) => candidate.location.structuralRootNodeId === nodeId);
    if (!table) {return undefined;}
    return {
        componentId: table.id,
        status: table.status,
        rowCount: table.body.visibleRows.length,
        headers: table.columns.map((column) => column.name),
        pagination: table.pagination?.status,
    };
};

const findManualEntityBinding = (
    entry: PageSnapshotSessionEntry,
    entity: PageSessionEntityRecord,
): SemanticBusinessBinding | undefined => {
    const manual = new Map(Object.entries(entry.semanticBindingsByProfile)).get('@manual');
    if (!manual) {return undefined;}
    const bindingsById = new Map(Object.entries(manual.byId));
    return (entity.bindingIds ?? [])
        .map((bindingId) => bindingsById.get(bindingId))
        .find((binding): binding is SemanticBusinessBinding => Boolean(binding?.annotation.entityKind));
};

const summarizeSemanticDiagnostics = (entry: PageSnapshotSessionEntry) => {
    const diagnostics = Object.values(entry.semanticBindingsByProfile)
        .flatMap((bindings) => bindings.diagnostics);
    return {
        total: diagnostics.length,
        errors: diagnostics.filter((item) => item.severity === 'error').length,
        warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    };
};

const buildManualSemanticSummary = (entry: PageSnapshotSessionEntry) => {
    const manual = new Map(Object.entries(entry.semanticBindingsByProfile)).get('@manual');
    const bindings = manual ? Object.values(manual.byId) : [];
    return {
        active_count: bindings.filter((binding) => binding.status === 'active' && binding.disposition === 'active').length,
        ignored_count: bindings.filter((binding) => binding.disposition === 'ignored').length,
        invalidated_count: bindings.filter((binding) => binding.status === 'invalidated').length,
    };
};

const stableNodeIdentity = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string => {
    const identity = entry.capture.control.observation.domIdentity[nodeId];
    return encodeURIComponent(identity.backendNodeId ?? identity.runtimeIdentityToken ?? nodeId);
};

const hasNode = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): boolean =>
    new Map(Object.entries(entry.capture.control.observation.nodes)).has(nodeId);

const readNodeText = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined => {
    const observation = entry.capture.control.observation;
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

const readEntityKind = (value: unknown): RuntimeEntityKind | undefined =>
    typeof value === 'string' && ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'].includes(value)
        ? value as RuntimeEntityKind
        : undefined;
const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};
const badArgs = (stepId: string, message: string): StepResult => ({
    stepId,
    ok: false,
    error: {code: 'ERR_BAD_ARGS', message},
});
const notFound = (stepId: string, message: string, details?: unknown): StepResult => ({
    stepId,
    ok: false,
    error: {code: 'ERR_NOT_FOUND', message, details},
});
const mutationError = (stepId: string, reason: string): StepResult => ({
    stepId,
    ok: false,
    error: {
        code: reason === 'unknown-node' || reason === 'unknown-binding' ? 'ERR_NOT_FOUND' : 'ERR_AMBIGUOUS',
        message: `manual semantic mutation failed: ${reason}`,
    },
});
