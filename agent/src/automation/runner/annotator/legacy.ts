import {replyAction} from '../../../interface/actions/action_protocol';
import {ActionError, ERROR_CODES} from '../../../interface/actions/results';
import type {ControlPlaneResult} from '../../../app/runtime/control_plane';
import type {WorkspaceRouterInput} from '../../../app/runtime/workspace/router';
import {
    buildAnnotatorProjection,
    resolveAnnotatorPoint,
    type AnnotatorDraft,
    type AnnotatorProjection,
    type AnnotatorTarget,
} from '../../snapshot/annotator';
import type {ObservationNodeId, PageObservation, Rect} from '../../snapshot/observation/model/contracts';
import type {PageSessionSelection, PageSnapshotSessionEntry} from '../../snapshot/session/contracts';
import {entityRulesArtifactRevision, type WorkflowEntityRules} from '../../workflow';
import type {RunStepsDeps} from '../run_steps_types';
import {ensureFreshPageSession} from '../session/capture';
import {
    evaluateAnnotatorDraft,
    projectAnnotatorEvaluation,
} from './draft';

export type LegacyEntityKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';
type LegacyTarget = {
    kind?: LegacyEntityKind;
    nameContains?: string;
    idEquals?: string;
    nameEquals?: string;
    roleEquals?: string;
    placeholderEquals?: string;
    classContains?: string;
    textContains?: string;
    ariaContains?: string;
    relation?: 'pagination';
    v2TargetId?: string;
    v2Match?: Record<string, unknown>;
};
type LegacyAnnotation = {
    id: string;
    type: 'field' | 'action' | 'pagination';
    name?: string;
    businessKey: string;
    target: LegacyTarget;
    expect?: 'unique' | 'one_or_more';
    origin: 'inferred' | 'confirmed' | 'manual';
    disposition: 'active' | 'ignored';
};
type LegacyColumnAction = {
    id: string;
    actionIntent: string;
    text?: string;
    target: LegacyTarget;
    origin: 'inferred' | 'confirmed' | 'manual';
    disposition: 'active' | 'ignored';
};
type LegacyColumn = {
    id: string;
    fieldKey: string;
    name?: string;
    kind?: 'text' | 'number' | 'date' | 'status' | 'action_column';
    actions: LegacyColumnAction[];
    origin: 'inferred' | 'confirmed' | 'manual';
    disposition: 'active' | 'ignored';
    v2TargetId?: string;
};
type LegacyEntity = {
    id: string;
    source: 'region' | 'group' | 'node';
    kind: LegacyEntityKind;
    name: string;
    businessTag: string;
    entityKey?: string;
    target: LegacyTarget;
    expect?: 'unique' | 'one_or_more';
    annotations: LegacyAnnotation[];
    primaryKey?: {fieldKey: string; columns?: string[]};
    columns: LegacyColumn[];
    pagination?: {actionIntent: string; pageTarget: LegacyTarget; itemTarget?: LegacyTarget};
    origin: 'inferred' | 'confirmed' | 'manual';
};
export type LegacyCanvasDraft = {
    version: number;
    profileName: string;
    page: {kind: LegacyEntityKind; urlPattern?: string};
    entities: LegacyEntity[];
    preserved: unknown;
};

type LegacyPickFingerprint = {
    point: {x: number; y: number};
    role?: string;
    text?: string;
    ariaLabel?: string;
    tagName: string;
    classTokens: string[];
    rect: Rect;
};

type LegacyVisualTargetRef = {
    entityId: string;
    nodeId: string;
    kind?: LegacyEntityKind;
    role: 'entity' | 'field' | 'action' | 'column' | 'pagination';
    fieldKey?: string;
    actionIntent?: string;
    canvasAnnotationId?: string;
    bbox?: Rect;
    matchedNodeBoxes?: Rect[];
};

type LegacyCompileResult = {
    draft: AnnotatorDraft;
    ruleIdByCanvasId: Map<string, string>;
};

const entityVisualId = (entityId: string): string => `entity:${entityId}`;
const paginationVisualId = (entityId: string): string => `${entityId}_pgpage`;

export const handleLegacyAnnotatorAction = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneResult> => {
    switch (input.action.type) {
        case 'entity_rules.annotator.open':
            return await legacyOpen(deps, input, payload);
        case 'entity_rules.annotator.pick':
            return await legacyPick(deps, input, payload);
        case 'entity_rules.annotator.recognize':
            return await legacyRecognize(deps, input, payload);
        case 'entity_rules.annotator.visualize':
            return await legacyVisualize(deps, input, payload);
        case 'entity_rules.annotator.check':
            return await legacyCheck(deps, input, payload);
        case 'entity_rules.annotator.save':
            return await legacySave(deps, input, payload);
        default:
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported legacy annotator action: ${input.action.type}`);
    }
};

const legacyOpen = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneResult> => {
    const tabName = optionalString(payload.tabName);
    const current = await ensureFreshPageSession(deps, input.workspace.name, {tabName});
    const requestedProfileName = optionalString(payload.profileName);
    const requestedBusinessTag = optionalString(payload.businessTag);
    const availableProfiles = findMatchingProfiles(input.workspace.workflow, current.entry.pageUrl);
    const profile = requestedProfileName
        ? findProfileByName(input.workspace.workflow, requestedProfileName)
        : undefined;
    const evaluation = profile
        ? evaluateAnnotatorDraft(current.entry, profileToDraft(profile), 'check')
        : undefined;
    const projectionEntry = evaluation ? projectAnnotatorEvaluation(current.entry, evaluation) : current.entry;
    const projection = buildAnnotatorProjection(
        projectionEntry,
        deps.pageSession.readSelection(current.binding.page),
    );
    const fullCanvasDraft = profile ? legacyCanvasFromProfile(profile, projection, current.entry) : null;
    const canvasDraft = fullCanvasDraft && requestedBusinessTag
        ? selectLegacyCanvasEntity(fullCanvasDraft, requestedBusinessTag)
        : fullCanvasDraft;
    return {
        reply: replyAction(input.action, {
            workspaceName: input.workspace.name,
            tabName: current.binding.tabName,
            url: current.entry.pageUrl,
            pageKind: canvasDraft?.page.kind ?? inferPageKind(projection),
            profileName: profile?.name ?? null,
            canvasDraft,
            artifactRevision: profile ? entityRulesArtifactRevision(profile) : null,
            visualTargetRefs: canvasDraft ? visualRefs(current.entry, projection, canvasDraft) : [],
            availableProfiles: availableProfiles.map((candidate) => ({
                profileName: candidate.name,
                label: profileDisplayName(candidate),
            })),
            suggestedProfileName: suggestProfileName(input.workspace.workflow, current.entry.pageUrl),
        }),
        events: [],
    };
};

const selectLegacyCanvasEntity = (
    draft: LegacyCanvasDraft,
    businessTag: string,
): LegacyCanvasDraft => {
    const entity = draft.entities.find((candidate) => candidate.businessTag === businessTag);
    if (!entity) {
        throw new ActionError(
            ERROR_CODES.ERR_NOT_FOUND,
            `annotator business entity not found: ${businessTag}`,
            {businessTag, profileName: draft.profileName},
        );
    }
    return {...draft, entities: [entity]};
};

const legacyPick = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneResult> => {
    const fingerprint = requireFingerprint(payload.fingerprint);
    const current = await ensureFreshPageSession(deps, input.workspace.name, {
        tabName: optionalString(payload.tabName),
    });
    const resolution = resolveAnnotatorPoint(current.entry, fingerprint.point);
    if (resolution.status !== 'resolved') {
        return {
            reply: replyAction(input.action, {
                candidateChain: [],
                matchedNodeIds: resolution.status === 'ambiguous' ? resolution.candidateNodeIds : [],
                resolution: {
                    nodeId: null,
                    reason: 'none',
                    matchedNodeIds: resolution.status === 'ambiguous' ? resolution.candidateNodeIds : [],
                },
            }),
            events: [],
        };
    }
    const confirmation = deps.pageSession.confirmSelection(current.binding.page, resolution.nodeId);
    if (!confirmation.ok) {
        return {
            reply: replyAction(input.action, {
                candidateChain: [],
                matchedNodeIds: [],
                resolution: {nodeId: null, reason: 'none', matchedNodeIds: []},
            }),
            events: [],
        };
    }
    const refreshed = await ensureFreshPageSession(deps, input.workspace.name, {
        explicit: true,
        tabName: optionalString(payload.tabName),
    });
    const projection = buildAnnotatorProjection(
        refreshed.entry,
        deps.pageSession.readSelection(refreshed.binding.page),
    );
    const candidateChain = pickCandidates(
        refreshed.entry,
        projection,
        resolution.nodeId,
        payload.purpose === 'entity' ? 'entity' : 'annotation',
        fingerprint,
    );
    return {
        reply: replyAction(input.action, {
            candidateChain,
            matchedNodeIds: [resolution.nodeId],
            resolution: {nodeId: resolution.nodeId, reason: 'bbox', matchedNodeIds: [resolution.nodeId]},
        }),
        events: [],
    };
};

const legacyRecognize = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneResult> => {
    const source = requireCanvas(payload.canvasDraft);
    const current = await ensureFreshPageSession(deps, input.workspace.name, {
        explicit: true,
        tabName: optionalString(payload.tabName),
    });
    const selection = deps.pageSession.readSelection(current.binding.page);
    const projection = buildAnnotatorProjection(current.entry, selection);
    const canvasDraft = recognizeCanvas(current.entry, projection, source, selection);
    return {
        reply: replyAction(input.action, {
            canvasDraft,
            recognized: canvasDraft.entities.map((entity) => ({
                entityId: entity.id,
                kind: entity.kind,
                name: entity.name,
                fieldCount: entity.annotations.filter((item) => item.type === 'field').length,
                columnCount: entity.columns.length,
                actionCount: entity.annotations.filter((item) => item.type === 'action').length
                    + entity.columns.reduce((sum, column) => sum + column.actions.length, 0),
                origin: 'inferred',
            })),
            visualTargetRefs: visualRefs(current.entry, projection, canvasDraft),
        }),
        events: [],
    };
};

const legacyVisualize = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneResult> => {
    const canvasDraft = requireCanvas(payload.canvasDraft);
    const current = await ensureFreshPageSession(deps, input.workspace.name, {
        explicit: true,
        tabName: optionalString(payload.tabName),
    });
    const projection = buildAnnotatorProjection(
        current.entry,
        deps.pageSession.readSelection(current.binding.page),
    );
    return {
        reply: replyAction(input.action, {visualTargetRefs: visualRefs(current.entry, projection, canvasDraft)}),
        events: [],
    };
};

const legacyCheck = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneResult> => {
    const canvasDraft = requireCanvas(payload.canvasDraft);
    const current = await ensureFreshPageSession(deps, input.workspace.name, {
        tabName: optionalString(payload.tabName),
    });
    const selection = deps.pageSession.readSelection(current.binding.page);
    const projection = buildAnnotatorProjection(current.entry, selection);
    const compiled = compileLegacyCanvas(canvasDraft, current.entry, projection);
    const evaluation = evaluateAnnotatorDraft(current.entry, compiled.draft, 'check');
    return {
        reply: replyAction(input.action, {
            results: legacyCheckResults(canvasDraft, compiled, evaluation.validation.diagnostics),
            stale: selection.status === 'stale',
        }),
        events: [],
    };
};

const legacySave = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneResult> => {
    const canvasDraft = requireCanvas(payload.canvasDraft);
    const requestedProfileName = optionalString(payload.profileName);
    if (requestedProfileName) {canvasDraft.profileName = requestedProfileName;}
    const expectedRevision = requireExpectedRevision(payload.expectedRevision);
    const existing = findProfileByName(input.workspace.workflow, canvasDraft.profileName);
    const actualRevision = existing ? entityRulesArtifactRevision(existing) : null;
    if (expectedRevision !== actualRevision) {
        throw new ActionError(ERROR_CODES.ERR_CONFLICT, 'annotator artifact revision conflict', {
            profileName: canvasDraft.profileName,
            expectedRevision,
            actualRevision,
        });
    }
    const current = await ensureFreshPageSession(deps, input.workspace.name, {
        tabName: optionalString(payload.tabName),
    });
    const selection = deps.pageSession.readSelection(current.binding.page);
    const projection = buildAnnotatorProjection(current.entry, selection);
    const compiled = compileLegacyCanvas(canvasDraft, current.entry, projection);
    const evaluation = evaluateAnnotatorDraft(current.entry, compiled.draft, 'save');
    if (!evaluation.validation.ok || !evaluation.profile) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator draft validation failed', {
            validation: evaluation.validation,
        });
    }
    const saved = input.workspace.workflow.save(evaluation.profile, {expectedRevision});
    if (saved.kind !== 'entity_rules') {
        throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'workflow returned a non-entity_rules artifact');
    }
    await ensureFreshPageSession(deps, input.workspace.name, {
        explicit: true,
        tabName: optionalString(payload.tabName),
    });
    return {
        reply: replyAction(input.action, {
            profileName: saved.name,
            artifactRevision: entityRulesArtifactRevision(saved),
            saved: true,
        }),
        events: [],
    };
};

const recognizeCanvas = (
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
    source: LegacyCanvasDraft,
    selection: PageSessionSelection,
): LegacyCanvasDraft => {
    const sourceEntity = source.entities[0];
    if (!sourceEntity) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'legacy canvas requires one entity');}
    const component = selectComponent(entry, sourceEntity.kind, selection);
    if (!component) {
        throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `no ${sourceEntity.kind} component found for selection`);
    }
    const rootTarget = projection.targets.find((target) => target.kind === 'structural-root'
        && target.componentId === component.id);
    if (!rootTarget) {throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, 'canonical component root is unavailable');}
    const canonicalRootTarget = persistentTarget(
        entry,
        rootTarget.nodeIds[0],
        sourceEntity.kind,
        rootTarget.id,
    );
    const entity: LegacyEntity = {
        ...structuredClone(sourceEntity),
        target: {
            ...structuredClone(sourceEntity.target),
            v2TargetId: rootTarget.id,
            v2Match: cleanTarget(canonicalRootTarget, sourceEntity.kind),
        },
        annotations: [],
        columns: [],
        pagination: undefined,
    };
    if (component.domain === 'form') {
        addFormMembers(entry, projection, entry.capture.form.forms.forms[component.id], entity);
    } else if (component.domain === 'table') {
        const table = entry.capture.table.tables.tables[component.id];
        const operationColumnIds = new Set(table.columns
            .filter((column) => isOperationColumnName(column.name))
            .map((column) => column.id));
        entity.columns = table.columns.map((column, index) => {
            const target = projection.targets.find((candidate) => candidate.kind === 'column'
                && candidate.componentId === table.id && candidate.memberId === column.id);
            const actionSlots = operationColumnIds.has(column.id)
                ? table.controlSlots.filter((slot) => slot.columnId === column.id)
                : [];
            const seenActionIntents = new Set<string>();
            const actions = actionSlots.flatMap((slot, slotIndex): LegacyColumnAction[] => {
                const exemplarNodeId = slot.exemplarNodeIds.find((nodeId) => Boolean(
                    nodeLabel(entry.capture.control.observation, nodeId),
                ));
                if (!exemplarNodeId) {return [];}
                const name = normalizeActionLabel(
                    slot.label ?? nodeLabel(entry.capture.control.observation, exemplarNodeId) ?? '',
                );
                const actionIntent = inferActionIntent(name);
                if (!name || !actionIntent || seenActionIntents.has(actionIntent)) {return [];}
                seenActionIntents.add(actionIntent);
                const actionTarget = projection.targets.find((candidate) =>
                    candidate.kind === 'action'
                    && candidate.componentId === table.id
                    && candidate.memberId === slot.id
                    && candidate.nodeIds.includes(exemplarNodeId));
                return [{
                    id: `auto_${entity.id}_column_${String(index)}_action_${String(slotIndex)}`,
                    actionIntent,
                    text: name,
                    target: repeatedControlTarget(entry, exemplarNodeId, name, actionTarget?.id),
                    origin: 'inferred',
                    disposition: 'active',
                }];
            });
            return {
                id: `auto_${entity.id}_column_${String(index)}`,
                fieldKey: slug(column.name) || `column_${String(index)}`,
                name: column.name,
                kind: operationColumnIds.has(column.id) ? 'action_column' : 'text',
                actions,
                origin: 'inferred',
                disposition: 'active',
                v2TargetId: target?.id,
            } satisfies LegacyColumn;
        });
        const primaryKey = table.suggestions.find((suggestion) => suggestion.kind === 'primary-key-candidate');
        if (primaryKey) {
            const selected = table.columns.find((column) => column.id === primaryKey.value);
            if (selected) {
                entity.primaryKey = {fieldKey: slug(selected.name) || selected.id, columns: [selected.name]};
            }
        }
        const businessScopeNodeId = sharedBusinessScopeNodeId(
            entry,
            table.location.structuralRootNodeId,
        ) ?? table.location.selectionScopeNodeId ?? businessScopeAncestor(
            entry.capture.control.observation,
            table.location.structuralRootNodeId,
        );
        const nextPageNodeId = findDescendantByLabel(
            entry.capture.control.observation,
            businessScopeNodeId,
            /下一页|next(?:\s*page)?/iu,
        );
        const paginationNodeId = businessScopeNodeId
            ? findDescendantByLabel(entry.capture.control.observation, businessScopeNodeId, /分页|pagination/iu)
            : undefined;
        if (nextPageNodeId) {
            entity.pagination = {
                actionIntent: 'nextPage',
                pageTarget: persistentTarget(entry, nextPageNodeId),
                ...(paginationNodeId ? {itemTarget: persistentTarget(entry, paginationNodeId)} : {}),
            };
        }
        addEnclosedFormMembers(entry, projection, businessScopeNodeId, entity);
    }
    return {
        ...structuredClone(source),
        page: {...source.page, kind: entity.kind},
        entities: [entity],
    };
};

const addFormMembers = (
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
    form: PageSnapshotSessionEntry['capture']['form']['forms']['forms'][string],
    entity: LegacyEntity,
): void => {
    const observation = entry.capture.control.observation;
    let fieldIndex = entity.annotations.filter((annotation) => annotation.type === 'field').length;
    for (const field of form.fields) {
        const target = projection.targets.find((candidate) => candidate.kind === 'field'
            && candidate.componentId === form.id && candidate.memberId === field.id);
        const control = field.controlIds
            .map((id) => entry.capture.control.controls.controls[id])
            .find(Boolean);
        const nodeId = control?.controlNodeId ?? control?.rootNodeId ?? field.anchorNodeId;
        const name = target?.label ?? nodeLabel(observation, nodeId) ?? `字段 ${String(fieldIndex + 1)}`;
        entity.annotations.push({
            id: `auto_${entity.id}_field_${String(fieldIndex)}`,
            type: 'field',
            name,
            businessKey: fieldKey(observation, nodeId, name, fieldIndex),
            target: persistentTarget(entry, nodeId, undefined, target?.id),
            expect: 'unique',
            origin: 'inferred',
            disposition: 'active',
        });
        fieldIndex += 1;
    }

    let actionIndex = entity.annotations.filter((annotation) => annotation.type === 'action').length;
    for (const action of form.actions) {
        const target = projection.targets.find((candidate) => candidate.kind === 'action'
            && candidate.componentId === form.id && candidate.memberId === action.id);
        const rawName = target?.label ?? nodeLabel(observation, action.nodeId) ?? `操作 ${String(actionIndex + 1)}`;
        const name = normalizeActionLabel(rawName);
        entity.annotations.push({
            id: `auto_${entity.id}_action_${String(actionIndex)}`,
            type: 'action',
            name,
            businessKey: inferActionIntent(name) ?? `action_${String(actionIndex)}`,
            target: persistentTarget(entry, action.nodeId, undefined, target?.id),
            expect: 'unique',
            origin: 'inferred',
            disposition: 'active',
        });
        actionIndex += 1;
    }
};

const addEnclosedFormMembers = (
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
    scopeNodeId: ObservationNodeId | undefined,
    entity: LegacyEntity,
): void => {
    if (!scopeNodeId) {return;}
    const parents = entry.capture.control.observation.parents;
    for (const form of Object.values(entry.capture.form.forms.forms)) {
        if (!isDescendant(form.location.structuralRootNodeId, scopeNodeId, parents)) {continue;}
        addFormMembers(entry, projection, form, entity);
    }
};

const selectComponent = (
    entry: PageSnapshotSessionEntry,
    kind: LegacyEntityKind,
    selection: PageSessionSelection,
): {id: string; domain: 'form' | 'table'} | undefined => {
    const selectedNodeId = selection.status === 'resolved' ? selection.nodeId : undefined;
    const observation = entry.capture.control.observation;
    if (kind === 'form') {
        const forms = Object.values(entry.capture.form.forms.forms);
        const form = selectedNodeId
            ? forms.find((candidate) => isDescendant(selectedNodeId, candidate.location.selectionScopeNodeId
                ?? candidate.location.structuralRootNodeId, observation.parents))
            : forms[0];
        return form ? {id: form.id, domain: 'form'} : undefined;
    }
    if (kind === 'table') {
        const tables = Object.values(entry.capture.table.tables.tables);
        const table = selectedNodeId
            ? tables.find((candidate) => isDescendant(selectedNodeId, candidate.location.selectionScopeNodeId
                ?? candidate.location.structuralRootNodeId, observation.parents))
            : tables[0];
        return table ? {id: table.id, domain: 'table'} : undefined;
    }
    return undefined;
};

const pickCandidates = (
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
    nodeId: ObservationNodeId,
    purpose: 'entity' | 'annotation',
    fingerprint: LegacyPickFingerprint,
): Array<Record<string, unknown>> => {
    const observation = entry.capture.control.observation;
    const relevant = projection.targets.filter((target) => {
        if (target.kind === 'semantic-binding') {return false;}
        return target.nodeIds.some((targetNodeId) => targetNodeId === nodeId
            || isDescendant(nodeId, targetNodeId, observation.parents));
    });
    const candidateById = new Map<string, Record<string, unknown>>();
    for (const target of relevant) {
        const primaryNodeId = target.nodeIds.find((candidate) => observation.nodes[candidate]) ?? target.nodeIds[0];
        if (!primaryNodeId) {continue;}
        const level = targetLevel(target);
        if (purpose === 'entity' && level !== 'region' && level !== 'group') {continue;}
        const kind = target.domain === 'form' || target.domain === 'table' ? target.domain : undefined;
        const bbox = unionRects(target.geometry);
        const text = target.label ?? nodeLabel(observation, primaryNodeId)
            ?? (target.domain === 'table' ? '业务表格' : target.domain === 'form' ? '业务表单' : fingerprint.text);
        candidateById.set(target.id, {
            level,
            nodeId: primaryNodeId,
            ...(bbox ? {bbox} : {}),
            ...(kind ? {kind} : {}),
            ...(nodeRole(observation, primaryNodeId) ? {role: nodeRole(observation, primaryNodeId)} : {}),
            ...(text ? {text} : {}),
            ...(target.kind === 'field' ? {fieldKey: slug(text ?? '') || target.memberId} : {}),
            ...(target.kind === 'action' ? {actionIntent: inferActionIntent(text)} : {}),
            ...((target.kind === 'structural-root' || target.kind === 'selection-scope' || target.kind === 'host')
                && kind && target.componentId ? {
                    entityRef: {
                        entityId: target.componentId,
                        nodeId: primaryNodeId,
                        kind,
                        type: 'region',
                    },
                } : {}),
            score: candidateScore(target),
            matchCount: 1,
            matchedNodeIds: [...target.nodeIds],
            stabilityHint: 'stable',
            proposedTargets: [persistentTarget(entry, primaryNodeId, kind, target.id)],
            expect: 'unique',
        });
    }
    if (purpose === 'entity') {
        const component = selectComponent(entry, inferKindAtNode(entry, nodeId), {
            status: 'resolved',
            nodeId,
            anchor: {pageEpoch: entry.identity.pageEpoch, captureRevision: entry.identity.captureRevision, nodeId},
            evidence: [],
        });
        const root = component && projection.targets.find((target) => target.kind === 'structural-root'
            && target.componentId === component.id);
        const rootNodeId = root?.nodeIds[0];
        const scopeNodeId = rootNodeId ? businessScopeAncestor(observation, rootNodeId) : undefined;
        const scopeLabel = scopeNodeId ? nodeLabel(observation, scopeNodeId) : undefined;
        const scopeBoxes = scopeNodeId ? geometry(entry, scopeNodeId) : [];
        if (component && root && rootNodeId && scopeNodeId && scopeLabel && scopeBoxes.length > 0) {
            candidateById.set(`business-scope:${component.id}`, {
                level: 'region',
                nodeId: scopeNodeId,
                bbox: unionRects(scopeBoxes),
                kind: component.domain,
                text: scopeLabel,
                entityRef: {entityId: component.id, nodeId: rootNodeId, kind: component.domain, type: 'region'},
                score: 5,
                matchCount: 1,
                matchedNodeIds: [scopeNodeId],
                stabilityHint: 'stable',
                proposedTargets: [{
                    ...persistentTarget(entry, scopeNodeId, component.domain, root.id),
                    v2Match: cleanTarget(
                        persistentTarget(entry, rootNodeId, component.domain, root.id),
                        component.domain,
                    ),
                }],
                expect: 'unique',
            });
        }
    }
    if (![...candidateById.values()].some((candidate) => candidate.entityRef)) {
        const component = selectComponent(entry, inferKindAtNode(entry, nodeId), {
            status: 'resolved',
            nodeId,
            anchor: {pageEpoch: entry.identity.pageEpoch, captureRevision: entry.identity.captureRevision, nodeId},
            evidence: [],
        });
        const root = component && projection.targets.find((target) => target.kind === 'structural-root'
            && target.componentId === component.id);
        if (root) {
            const primaryNodeId = root.nodeIds[0];
            candidateById.set(root.id, {
                level: 'region',
                nodeId: primaryNodeId,
                bbox: unionRects(root.geometry),
                kind: component.domain,
                text: root.label ?? nodeLabel(observation, primaryNodeId)
                    ?? (component.domain === 'table' ? '业务表格' : '业务表单'),
                entityRef: {entityId: component.id, nodeId: primaryNodeId, kind: component.domain, type: 'region'},
                score: 1,
                matchCount: 1,
                matchedNodeIds: [...root.nodeIds],
                stabilityHint: 'stable',
                proposedTargets: [persistentTarget(entry, primaryNodeId, component.domain, root.id)],
                expect: 'unique',
            });
        }
    }
    const candidates = [...candidateById.values()].sort((left, right) => {
        const leftArea = rectArea(left.bbox as Rect | undefined);
        const rightArea = rectArea(right.bbox as Rect | undefined);
        return leftArea - rightArea || Number(right.score) - Number(left.score);
    });
    if (purpose !== 'entity') {return candidates;}
    return candidates.filter((candidate) => {
        if (!candidate.entityRef || (candidate.level !== 'region' && candidate.level !== 'group')) {
            return false;
        }
        const targets = candidate.proposedTargets;
        return Array.isArray(targets)
            && targets.some((target: unknown) => target !== null
                && typeof target === 'object'
                && Reflect.ownKeys(target).length > 0);
    });
};

const persistentNodeIdForTarget = (
    entry: PageSnapshotSessionEntry,
    target: AnnotatorTarget,
): ObservationNodeId | undefined => {
    if (target.kind === 'field' && target.componentId && target.memberId) {
        const form = entry.capture.form.forms.forms[target.componentId];
        const field = form?.fields.find((candidate) => candidate.id === target.memberId);
        const control = field?.controlIds
            .map((controlId) => entry.capture.control.controls.controls[controlId])
            .find(Boolean);
        return control?.controlNodeId ?? control?.rootNodeId ?? field?.anchorNodeId;
    }
    if (target.kind === 'action' && target.domain === 'form' && target.componentId && target.memberId) {
        return entry.capture.form.forms.forms[target.componentId]?.actions
            .find((candidate) => candidate.id === target.memberId)?.nodeId;
    }
    return target.nodeIds[0];
};

const refreshPersistentTarget = (
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
    target: LegacyTarget,
    kind?: LegacyEntityKind,
): LegacyTarget => {
    if (!target.v2TargetId) {return target;}
    const canonical = projection.targets.find((candidate) => candidate.id === target.v2TargetId);
    const nodeId = canonical ? persistentNodeIdForTarget(entry, canonical) : undefined;
    if (!nodeId) {return target;}
    return {
        ...persistentTarget(entry, nodeId, kind ?? target.kind, target.v2TargetId),
        ...(target.relation ? {relation: target.relation} : {}),
    };
};

const compileLegacyCanvas = (
    canvas: LegacyCanvasDraft,
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
): LegacyCompileResult => {
    if (!canvas.profileName.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'profile name is required');
    }
    const rules: Array<Record<string, unknown>> = [];
    const bindings: Array<Record<string, unknown>> = [];
    const ruleIdByCanvasId = new Map<string, string>();
    canvas.entities.forEach((entity, entityIndex) => {
        const rootRuleId = `entity-${slug(canvas.profileName)}-${String(entityIndex)}`;
        ruleIdByCanvasId.set(entityVisualId(entity.id), rootRuleId);
        const rootProjectionTarget = findProjectionTarget(
            entry,
            projection,
            entity.target,
            'structural-root',
            entity.kind,
        );
        const rootNodeId = rootProjectionTarget?.nodeIds[0];
        const projectedScopeNodeId = rootProjectionTarget?.componentId
            ? projection.targets.find((target) => target.kind === 'selection-scope'
                && target.componentId === rootProjectionTarget.componentId)?.nodeIds[0]
            : undefined;
        const scopeNodeId = entity.kind === 'table' && rootNodeId
            ? sharedBusinessScopeNodeId(entry, rootNodeId) ?? projectedScopeNodeId
            : projectedScopeNodeId;
        let scopeRuleId: string | undefined;
        const ensureScopeRule = (): string | undefined => {
            if (!scopeNodeId || scopeNodeId === rootNodeId) {return rootNodeId ? rootRuleId : undefined;}
            if (scopeRuleId) {return scopeRuleId;}
            scopeRuleId = `${rootRuleId}-scope`;
            rules.push({
                ruleId: scopeRuleId,
                source: 'node',
                expect: 'unique',
                contains: rootRuleId,
                match: cleanTarget(persistentTarget(entry, scopeNodeId)),
            });
            return scopeRuleId;
        };
        const withinRuleForTarget = (
            target: LegacyTarget,
            preferredKind?: AnnotatorTarget['kind'],
        ): string | undefined => {
            const canonical = findProjectionTarget(entry, projection, target, preferredKind);
            const nodeIds = canonical?.nodeIds.length
                ? canonical.nodeIds
                : matchTargetNodes(entry.capture.control.observation, target);
            if (rootNodeId && nodeIds.length > 0 && nodeIds.every((nodeId) =>
                isDescendant(nodeId, rootNodeId, entry.capture.control.observation.parents))) {
                return rootRuleId;
            }
            if (scopeNodeId && nodeIds.length > 0 && nodeIds.every((nodeId) =>
                isDescendant(nodeId, scopeNodeId, entry.capture.control.observation.parents))) {
                return ensureScopeRule();
            }
            return undefined;
        };
        const rootMatch = cleanTarget(
            refreshPersistentTarget(entry, projection, entity.target, entity.kind),
            entity.kind,
        );
        rules.push({
            ruleId: rootRuleId,
            source: entity.kind === 'form' || entity.kind === 'table' ? 'region' : 'node',
            expect: entity.expect ?? 'unique',
            match: rootMatch,
        });
        const rootBinding: Record<string, unknown> = {
            ruleId: rootRuleId,
            businessTag: entity.businessTag,
            ...(entity.entityKey ? {entityKey: entity.entityKey} : {}),
            displayName: entity.name,
            ...(entity.kind === 'form' || entity.kind === 'table' ? {} : {entityKind: entity.kind}),
            legacyCanvas: structuredClone(canvas),
        };
        if (entity.primaryKey) {
            rootBinding.primaryKey = {...entity.primaryKey, source: 'annotation'};
        }
        if (entity.columns.length > 0) {
            rootBinding.columns = entity.columns
                .filter((column) => column.disposition === 'active')
                .map((column) => ({
                    fieldKey: column.fieldKey,
                    ...(column.name ? {name: column.name} : {}),
                    ...(column.kind ? {kind: column.kind} : {}),
                    source: 'annotation',
                    ...(column.actions.length > 0 ? {
                        actions: column.actions
                            .filter((action) => action.disposition === 'active')
                            .map((action) => ({
                                actionIntent: action.actionIntent,
                                ...(action.text ? {text: action.text} : {}),
                            })),
                    } : {}),
                }));
        }
        bindings.push(rootBinding);
        entity.annotations
            .filter((annotation) => annotation.disposition === 'active' && hasTarget(annotation.target))
            .forEach((annotation, annotationIndex) => {
                const ruleId = `${rootRuleId}-annotation-${String(annotationIndex)}`;
                ruleIdByCanvasId.set(annotation.id, ruleId);
                const within = withinRuleForTarget(
                    annotation.target,
                    annotation.type === 'action' ? 'action' : 'field',
                );
                rules.push({
                    ruleId,
                    source: 'node',
                    expect: annotation.expect ?? (annotation.type === 'action' ? 'one_or_more' : 'unique'),
                    ...(within ? {within} : {}),
                    match: cleanTarget(refreshPersistentTarget(entry, projection, annotation.target)),
                });
                bindings.push({
                    ruleId,
                    ...(annotation.type === 'field' ? {
                        fieldKey: annotation.businessKey,
                        fieldRole: entity.kind === 'table' ? 'filter' : 'field',
                        ...(annotation.name ? {fieldName: annotation.name} : {}),
                    } : {
                        actionIntent: annotation.businessKey,
                        actionRole: entity.kind === 'table' ? 'module' : 'form',
                        ...(annotation.name ? {actionText: annotation.name} : {}),
                    }),
                });
            });
        entity.columns.forEach((column, columnIndex) => {
            column.actions
                .filter((action) => action.disposition === 'active' && hasTarget(action.target))
                .forEach((action, actionIndex) => {
                    const ruleId = `${rootRuleId}-column-${String(columnIndex)}-action-${String(actionIndex)}`;
                    ruleIdByCanvasId.set(action.id, ruleId);
                    const within = withinRuleForTarget(action.target, 'action');
                    rules.push({
                        ruleId,
                        source: 'node',
                        expect: 'one_or_more',
                        ...(within ? {within} : {}),
                        match: cleanTarget(refreshPersistentTarget(entry, projection, action.target)),
                    });
                    bindings.push({
                        ruleId,
                        actionIntent: action.actionIntent,
                        actionRole: 'row',
                        columnFieldKey: column.fieldKey,
                        ...(action.text ? {actionText: action.text} : {}),
                    });
                });
        });
        if (entity.pagination && hasTarget(entity.pagination.pageTarget)) {
            const ruleId = `${rootRuleId}-pagination-next`;
            ruleIdByCanvasId.set(paginationVisualId(entity.id), ruleId);
            const within = withinRuleForTarget(entity.pagination.pageTarget);
            rules.push({
                ruleId,
                source: 'node',
                expect: 'unique',
                ...(within ? {within} : {}),
                match: cleanTarget(refreshPersistentTarget(entry, projection, entity.pagination.pageTarget)),
            });
            bindings.push({ruleId, actionIntent: entity.pagination.actionIntent, paginationRole: 'next'});
        }
    });
    return {
        draft: {
            profileName: canvas.profileName.trim(),
            page: {
                kind: canvas.page.kind,
                ...(canvas.page.urlPattern ? {urlPattern: canvas.page.urlPattern} : {}),
            },
            match: {version: 2, rules},
            annotation: {version: 2, bindings},
        },
        ruleIdByCanvasId,
    };
};

const legacyCheckResults = (
    canvas: LegacyCanvasDraft,
    compiled: LegacyCompileResult,
    diagnostics: readonly {ruleId?: string; code: string; message: string}[],
): Array<Record<string, unknown>> => {
    const canvasItems = canvas.entities.flatMap((entity) => [
        {canvasAnnotationId: entityVisualId(entity.id), expected: entity.expect ?? 'unique'},
        ...entity.annotations.map((annotation) => ({
            canvasAnnotationId: annotation.id,
            expected: annotation.expect ?? 'unique',
        })),
        ...entity.columns.map((column) => ({
            canvasAnnotationId: column.id,
            expected: 'unique' as const,
        })),
        ...entity.columns.flatMap((column) => column.actions.map((action) => ({
            canvasAnnotationId: action.id,
            expected: 'one_or_more' as const,
        }))),
        ...(entity.pagination ? [{
            canvasAnnotationId: paginationVisualId(entity.id),
            expected: 'unique' as const,
        }] : []),
    ]);
    return canvasItems.map(({canvasAnnotationId, expected}) => {
        const ruleId = compiled.ruleIdByCanvasId.get(canvasAnnotationId);
        const issue = ruleId ? diagnostics.find((diagnostic) => diagnostic.ruleId === ruleId) : undefined;
        const status = issue ? diagnosticStatus(issue) : 'unique';
        return {
            canvasAnnotationId,
            status,
            matchCount: status === 'unique' ? 1 : status === 'multiple' ? 2 : 0,
            expected,
            message: issue?.message ?? 'unique',
            nodeIds: [],
        };
    });
};

const legacyCanvasFromProfile = (
    profile: WorkflowEntityRules,
    projection: AnnotatorProjection,
    entry: PageSnapshotSessionEntry,
): LegacyCanvasDraft => {
    for (const binding of profile.annotation.bindings) {
        if (isRecord(binding.legacyCanvas)) {
            return structuredClone(binding.legacyCanvas) as LegacyCanvasDraft;
        }
    }
    const rootBinding = profile.annotation.bindings.find((binding) =>
        typeof binding.businessTag === 'string') ?? profile.annotation.bindings[0];
    const rootRule = (rootBinding
        ? profile.match.rules.find((rule) => rule.ruleId === rootBinding.ruleId)
        : undefined) ?? profile.match.rules[0];
    const kind = profile.page?.kind ?? inferPageKind(projection);
    const component = projection.components.find((candidate) => candidate.domain === kind);
    const rootTarget = component && projection.targets.find((target) => target.kind === 'structural-root'
        && target.componentId === component.id);
    const entity: LegacyEntity = {
        id: 'e0',
        source: rootRule?.source ?? 'node',
        kind,
        name: readString(rootBinding?.displayName) ?? readString(rootBinding?.businessName) ?? profile.name,
        businessTag: readString(rootBinding?.businessTag) ?? `${kind}.main`,
        ...(readString(rootBinding?.entityKey) ? {entityKey: readString(rootBinding?.entityKey)} : {}),
        target: rootTarget
            ? persistentTarget(entry, rootTarget.nodeIds[0], kind, rootTarget.id)
            : legacyTargetFromRule(rootRule?.match, kind),
        expect: rootRule?.expect ?? 'unique',
        annotations: [],
        columns: [],
        origin: 'confirmed',
    };
    return {
        version: 1,
        profileName: profile.name,
        page: {kind, ...(profile.page?.urlPattern ? {urlPattern: profile.page.urlPattern} : {})},
        entities: [entity],
        preserved: {},
    };
};

const visualRefs = (
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
    canvas: LegacyCanvasDraft,
): LegacyVisualTargetRef[] => {
    const refs: LegacyVisualTargetRef[] = [];
    for (const entity of canvas.entities) {
        const entityTarget = findProjectionTarget(entry, projection, entity.target, 'structural-root', entity.kind);
        if (entityTarget) {
            refs.push(toVisualRef(entity.id, entityTarget, 'entity', {kind: entity.kind}));
        }
        for (const annotation of entity.annotations) {
            const target = findProjectionTarget(
                entry,
                projection,
                annotation.target,
                annotation.type === 'action' ? 'action' : 'field',
            );
            if (!target) {continue;}
            refs.push(toVisualRef(entity.id, target, annotation.type === 'action' ? 'action' : 'field', {
                canvasAnnotationId: annotation.id,
                ...(annotation.type === 'field' ? {fieldKey: annotation.businessKey} : {actionIntent: annotation.businessKey}),
            }));
        }
        for (const column of entity.columns) {
            const target = projection.targets.find((candidate) => candidate.id === column.v2TargetId)
                ?? projection.targets.find((candidate) => candidate.kind === 'column'
                    && candidate.label === column.name);
            if (target) {
                refs.push(toVisualRef(entity.id, target, 'column', {
                    canvasAnnotationId: column.id,
                    fieldKey: column.fieldKey,
                }));
            }
            for (const action of column.actions) {
                const actionTarget = findProjectionTarget(entry, projection, action.target, 'action');
                if (actionTarget) {
                    refs.push(toVisualRef(entity.id, actionTarget, 'action', {
                        canvasAnnotationId: action.id,
                        actionIntent: action.actionIntent,
                    }));
                }
            }
        }
        if (entity.pagination) {
            const nodes = matchTargetNodes(entry.capture.control.observation, entity.pagination.pageTarget);
            const boxes = nodes.flatMap((nodeId) => geometry(entry, nodeId));
            if (nodes[0] && boxes[0]) {
                refs.push({
                    entityId: entity.id,
                    nodeId: nodes[0],
                    kind: entity.kind,
                    role: 'pagination',
                    actionIntent: entity.pagination.actionIntent,
                    canvasAnnotationId: paginationVisualId(entity.id),
                    bbox: unionRects(boxes),
                    matchedNodeBoxes: boxes,
                });
            }
        }
    }
    return refs;
};

const toVisualRef = (
    entityId: string,
    target: AnnotatorTarget,
    role: LegacyVisualTargetRef['role'],
    extra: Partial<LegacyVisualTargetRef>,
): LegacyVisualTargetRef => ({
    entityId,
    nodeId: target.nodeIds[0],
    role,
    bbox: unionRects(target.geometry),
    matchedNodeBoxes: target.geometry.map((rect) => ({...rect})),
    ...extra,
});

const findProjectionTarget = (
    entry: PageSnapshotSessionEntry,
    projection: AnnotatorProjection,
    target: LegacyTarget,
    preferredKind?: AnnotatorTarget['kind'],
    domain?: LegacyEntityKind,
): AnnotatorTarget | undefined => {
    if (target.v2TargetId) {
        const direct = projection.targets.find((candidate) => candidate.id === target.v2TargetId);
        if (direct) {return direct;}
    }
    const matchingNodes = new Set(matchTargetNodes(entry.capture.control.observation, target));
    return projection.targets.find((candidate) =>
        (!preferredKind || candidate.kind === preferredKind)
        && (!domain || candidate.domain === domain)
        && candidate.nodeIds.some((nodeId) => matchingNodes.has(nodeId)));
};

const persistentTarget = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
    kind?: LegacyEntityKind,
    v2TargetId?: string,
): LegacyTarget => {
    const observation = entry.capture.control.observation;
    const attributes = observation.attributes[nodeId] ?? {};
    const role = nodeRole(observation, nodeId);
    const label = nodeLabel(observation, nodeId);
    const classToken = stableClassToken(attributes.class);
    return {
        ...(kind ? {kind} : {}),
        ...(attributes.id ? {idEquals: attributes.id} : {}),
        ...(!attributes.id && attributes.name ? {nameEquals: attributes.name} : {}),
        ...(!attributes.id && !attributes.name && attributes['aria-label'] ? {ariaContains: attributes['aria-label']} : {}),
        ...(!attributes.id && !attributes.name && !attributes['aria-label'] && attributes.placeholder
            ? {...(role ? {roleEquals: role} : {}), placeholderEquals: attributes.placeholder} : {}),
        ...(!attributes.id && !attributes.name && !attributes['aria-label'] && !attributes.placeholder && role && label
            ? {roleEquals: role, textContains: label.slice(0, 80)} : {}),
        ...(!attributes.id && !attributes.name && !attributes['aria-label'] && !attributes.placeholder && !(role && label) && classToken
            ? {classContains: classToken} : {}),
        ...(!attributes.id && !attributes.name && !attributes['aria-label'] && !attributes.placeholder && !(role && label) && !classToken && role
            ? {roleEquals: role} : {}),
        ...(!attributes.id && !attributes.name && !attributes['aria-label'] && !attributes.placeholder && !(role && label) && !classToken && !role && label
            ? {textContains: label.slice(0, 80)} : {}),
        ...(v2TargetId ? {v2TargetId} : {}),
    };
};

const repeatedControlTarget = (
    entry: PageSnapshotSessionEntry,
    exemplarNodeId: ObservationNodeId,
    label: string,
    v2TargetId?: string,
): LegacyTarget => {
    const role = nodeRole(entry.capture.control.observation, exemplarNodeId);
    if (label) {
        return {
            ...(role ? {roleEquals: role} : {}),
            textContains: label.slice(0, 80),
            ...(v2TargetId ? {v2TargetId} : {}),
        };
    }
    return persistentTarget(entry, exemplarNodeId, undefined, v2TargetId);
};

const legacyTargetFromRule = (
    value: unknown,
    kind: LegacyEntityKind,
): LegacyTarget => {
    const record = isRecord(value) ? value : {};
    return {
        kind,
        ...(typeof record.nameContains === 'string' ? {nameContains: record.nameContains} : {}),
        ...(typeof record.idEquals === 'string' ? {idEquals: record.idEquals} : {}),
        ...(typeof record.nameEquals === 'string' ? {nameEquals: record.nameEquals} : {}),
        ...(typeof record.roleEquals === 'string' ? {roleEquals: record.roleEquals} : {}),
        ...(typeof record.placeholderEquals === 'string' ? {placeholderEquals: record.placeholderEquals} : {}),
        ...(typeof record.classContains === 'string' ? {classContains: record.classContains} : {}),
        ...(typeof record.textContains === 'string' ? {textContains: record.textContains} : {}),
        ...(typeof record.ariaContains === 'string' ? {ariaContains: record.ariaContains} : {}),
        ...(record.relation === 'pagination' ? {relation: 'pagination'} : {}),
    };
};

const cleanTarget = (target: LegacyTarget, kind?: LegacyEntityKind): Record<string, unknown> => {
    if (target.v2Match && isRecord(target.v2Match)) {
        return structuredClone(target.v2Match);
    }
    const match: Record<string, unknown> = {};
    const effectiveKind = kind ?? target.kind;
    if (effectiveKind) {match.kind = effectiveKind;}
    for (const key of [
        'nameContains', 'idEquals', 'nameEquals', 'roleEquals', 'placeholderEquals',
        'classContains', 'textContains', 'ariaContains', 'relation',
    ] as const) {
        const value = target[key];
        if (typeof value === 'string' && value) {match[key] = value;}
    }
    if (Object.keys(match).length === 0) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotation target has no persistent conditions');
    }
    return match;
};

const matchTargetNodes = (observation: PageObservation, target: LegacyTarget): ObservationNodeId[] =>
    Object.keys(observation.nodes).filter((nodeId) => {
        const attrs = observation.attributes[nodeId] ?? {};
        const label = nodeLabel(observation, nodeId) ?? '';
        const role = nodeRole(observation, nodeId) ?? '';
        if (target.idEquals && attrs.id !== target.idEquals) {return false;}
        if (target.nameEquals && attrs.name !== target.nameEquals) {return false;}
        if (target.roleEquals && role !== target.roleEquals) {return false;}
        if (target.placeholderEquals && attrs.placeholder !== target.placeholderEquals) {return false;}
        if (target.classContains && !attrs.class?.split(/\s+/u).includes(target.classContains)) {return false;}
        if (target.textContains && !label.includes(target.textContains)) {return false;}
        if (target.nameContains && !label.includes(target.nameContains)) {return false;}
        if (target.ariaContains && !(attrs['aria-label'] ?? '').includes(target.ariaContains)) {return false;}
        return hasTarget(target);
    });

const hasTarget = (target: LegacyTarget): boolean => Boolean(
    target.kind || target.nameContains || target.idEquals || target.nameEquals || target.roleEquals
    || target.placeholderEquals || target.classContains || target.textContains || target.ariaContains || target.relation,
);

const findProfileByName = (
    workflow: WorkspaceRouterInput['workspace']['workflow'],
    requestedName: string,
): WorkflowEntityRules | undefined => {
    const found = workflow.get(requestedName, {kind: 'entity_rules'});
    return found?.kind === 'entity_rules' ? found : undefined;
};

const findMatchingProfiles = (
    workflow: WorkspaceRouterInput['workspace']['workflow'],
    pageUrl: string,
): WorkflowEntityRules[] => {
    const matches: WorkflowEntityRules[] = [];
    for (const item of workflow.list({kind: 'entity_rules'})) {
        const found = workflow.get(item.name, {kind: 'entity_rules'});
        if (found?.kind !== 'entity_rules') {continue;}
        if (!found.page?.urlPattern) {
            matches.push(found);
            continue;
        }
        try {
            if (new RegExp(found.page.urlPattern).test(pageUrl)) {matches.push(found);}
        } catch {
            continue;
        }
    }
    return matches;
};

const profileDisplayName = (profile: WorkflowEntityRules): string => {
    const root = profile.annotation.bindings.find((binding) =>
        typeof binding.businessTag === 'string') ?? profile.annotation.bindings[0];
    return readString(root?.displayName)
        ?? readString(root?.businessName)
        ?? profile.name;
};
const suggestProfileName = (
    workflow: WorkspaceRouterInput['workspace']['workflow'],
    pageUrl: string,
): string => {
    let suffix = 'rule';
    try {
        const url = new URL(pageUrl);
        suffix = `${url.hostname}${url.pathname}`
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase() || 'rule';
    } catch {
        // Keep the stable fallback.
    }
    const base = `page-${suffix}`;
    const existing = new Set(workflow.list({kind: 'entity_rules'}).map((item) => item.name));
    if (!existing.has(base)) {return base;}
    let index = 2;
    while (existing.has(`${base}-${index}`)) {index += 1;}
    return `${base}-${index}`;
};


const profileToDraft = (profile: WorkflowEntityRules): AnnotatorDraft => ({
    profileName: profile.name,
    page: profile.page ? structuredClone(profile.page) : undefined,
    match: structuredClone(profile.match),
    annotation: structuredClone(profile.annotation),
});

const requireCanvas = (value: unknown): LegacyCanvasDraft => {
    if (!isRecord(value) || !Array.isArray(value.entities) || !isRecord(value.page)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'legacy annotator requires canvasDraft');
    }
    return structuredClone(value) as LegacyCanvasDraft;
};

const requireFingerprint = (value: unknown): LegacyPickFingerprint => {
    if (!isRecord(value) || !isRecord(value.point)
        || typeof value.point.x !== 'number' || typeof value.point.y !== 'number') {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'legacy annotator pick requires fingerprint.point');
    }
    return structuredClone(value) as LegacyPickFingerprint;
};

const inferPageKind = (projection: AnnotatorProjection): LegacyEntityKind =>
    projection.components.some((component) => component.domain === 'table') ? 'table'
        : projection.components.some((component) => component.domain === 'form') ? 'form'
            : 'panel';

const inferKindAtNode = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): LegacyEntityKind => {
    const parents = entry.capture.control.observation.parents;
    if (Object.values(entry.capture.table.tables.tables).some((table) =>
        isDescendant(nodeId, table.location.selectionScopeNodeId ?? table.location.structuralRootNodeId, parents))) {
        return 'table';
    }
    return 'form';
};

const targetLevel = (target: AnnotatorTarget): 'control' | 'field' | 'row' | 'group' | 'region' | 'unknown' => {
    if (target.kind === 'control' || target.kind === 'action') {return 'control';}
    if (target.kind === 'field' || target.kind === 'column') {return 'field';}
    if (target.kind === 'row') {return 'row';}
    if (target.kind === 'structural-root' || target.kind === 'selection-scope' || target.kind === 'host') {
        return 'region';
    }
    return 'unknown';
};

const candidateScore = (target: AnnotatorTarget): number => ({
    control: 100,
    action: 95,
    field: 90,
    column: 85,
    row: 70,
    'structural-root': 50,
    host: 40,
    'selection-scope': 30,
    'semantic-binding': 0,
})[target.kind];

const diagnosticStatus = (diagnostic: {code: string; message: string}): 'missing' | 'multiple' | 'invalid' => {
    const text = `${diagnostic.code} ${diagnostic.message}`.toLowerCase();
    if (text.includes('multiple') || text.includes('ambiguous')) {return 'multiple';}
    if (text.includes('not_found') || text.includes('missing') || text.includes('zero')) {return 'missing';}
    return 'invalid';
};

const fieldKey = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    label: string,
    index: number,
): string => observation.attributes[nodeId]?.name
    ?? observation.attributes[nodeId]?.id
    ?? slug(label)
    ?? `field_${String(index)}`;

const isOperationColumnName = (value: string): boolean =>
    /操作|动作|管理|operations?|actions?/iu.test(value.replace(/\s+/gu, ''));

const normalizeActionLabel = (value: string): string => value
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();

const inferActionIntent = (value: string | undefined): string | undefined => {
    const normalized = value?.toLowerCase().replace(/\s+/gu, '') ?? '';
    if (!normalized) {return undefined;}
    if (/查询|搜索|search/u.test(normalized)) {return 'search';}
    if (/重置|清空|reset/u.test(normalized)) {return 'reset';}
    if (/下载|导出|download|export/u.test(normalized)) {return 'download';}
    if (/确认发货|发货|ship|dispatch/u.test(normalized)) {return 'confirmShipment';}
    if (/提交|submit/u.test(normalized)) {return 'submit';}
    if (/保存|save/u.test(normalized)) {return 'save';}
    if (/新增|创建|add|create/u.test(normalized)) {return 'create';}
    if (/编辑|修改|edit/u.test(normalized)) {return 'edit';}
    if (/删除|移除|delete|remove/u.test(normalized)) {return 'delete';}
    if (/查看|详情|view|detail/u.test(normalized)) {return 'view';}
    return slug(normalized) || undefined;
};

const nodeLabel = (observation: PageObservation, nodeId: ObservationNodeId): string | undefined => {
    const value = observation.accessibility[nodeId]?.name
        ?? observation.text[nodeId]
        ?? observation.attributes[nodeId]?.['aria-label']
        ?? observation.attributes[nodeId]?.title
        ?? observation.attributes[nodeId]?.placeholder;
    return value?.replace(/\s+/gu, ' ').trim() || undefined;
};

const nodeRole = (observation: PageObservation, nodeId: ObservationNodeId): string | undefined =>
    observation.accessibility[nodeId]?.role
    ?? observation.runtimeState[nodeId]?.role
    ?? observation.attributes[nodeId]?.role;

const geometry = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): Rect[] => {
    const records = entry.capture.control.observation.geometry[nodeId] ?? [];
    const top = records.filter((record) => record.space === 'top-css-viewport');
    return (top.length > 0 ? top : records).map((record) => ({...record.rect}));
};

const unionRects = (rects: readonly Rect[]): Rect | undefined => {
    if (rects.length === 0) {return undefined;}
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return {x: left, y: top, width: right - left, height: bottom - top};
};

const rectArea = (rect: Rect | undefined): number => rect ? rect.width * rect.height : Number.MAX_SAFE_INTEGER;

const isDescendant = (
    nodeId: ObservationNodeId,
    ancestorId: ObservationNodeId,
    parents: Readonly<Record<ObservationNodeId, ObservationNodeId | undefined>>,
): boolean => {
    let current: ObservationNodeId | undefined = nodeId;
    const visited = new Set<ObservationNodeId>();
    while (current && !visited.has(current)) {
        if (current === ancestorId) {return true;}
        visited.add(current);
        current = parents[current];
    }
    return false;
};



const findDescendantByLabel = (
    observation: PageObservation,
    scopeNodeId: ObservationNodeId | undefined,
    pattern: RegExp,
): ObservationNodeId | undefined => {
    if (!scopeNodeId) {return undefined;}
    return Object.keys(observation.nodes)
        .filter((nodeId) => isDescendant(nodeId, scopeNodeId, observation.parents))
        .sort((left, right) => (observation.documentOrder[left] ?? 0) - (observation.documentOrder[right] ?? 0))
        .find((nodeId) => pattern.test(nodeLabel(observation, nodeId) ?? ''));
};

const sharedBusinessScopeNodeId = (
    entry: PageSnapshotSessionEntry,
    tableRootNodeId: ObservationNodeId,
): ObservationNodeId | undefined => {
    const observation = entry.capture.control.observation;
    const formRoots = Object.values(entry.capture.form.forms.forms)
        .map((form) => form.location.structuralRootNodeId);
    if (formRoots.length === 0) {return undefined;}
    let current = observation.parents[tableRootNodeId];
    const visited = new Set<ObservationNodeId>();
    while (current && !visited.has(current)) {
        visited.add(current);
        const tag = observation.nodes[current]?.tag.toLowerCase();
        if (tag === 'main' || tag === 'body' || tag === 'html') {return undefined;}
        if (formRoots.some((formRoot) => isDescendant(formRoot, current!, observation.parents))) {
            return current;
        }
        current = observation.parents[current];
    }
    return undefined;
};

const businessScopeAncestor = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): ObservationNodeId | undefined => {
    let current = observation.parents[nodeId];
    let best: ObservationNodeId | undefined;
    const visited = new Set<ObservationNodeId>();
    while (current && !visited.has(current)) {
        visited.add(current);
        const attributes = observation.attributes[current] ?? {};
        if (attributes['aria-label']?.trim()) {best = current;}
        const tag = observation.nodes[current]?.tag.toLowerCase();
        if (tag === 'main' || tag === 'body' || tag === 'html') {break;}
        current = observation.parents[current];
    }
    return best;
};

const stableClassToken = (value: string | undefined): string | undefined => value
    ?.split(/\s+/u)
    .find((token) => token.length >= 3 && /[a-z]/iu.test(token) && !/[0-9a-f]{8,}/iu.test(token));

const slug = (value: string): string => value.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);

const requireExpectedRevision = (value: unknown): string | null => {
    if (value === null) {return null;}
    const revision = optionalString(value);
    if (!revision) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'expectedRevision must be a string or null');
    }
    return revision;
};

const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readString = (value: unknown): string | undefined => optionalString(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
