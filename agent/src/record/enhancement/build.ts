import type {Page} from 'playwright';
import {getLogger} from '../../logging/logger';
import {
    resolveSemanticRole,
    type ObservationNodeId,
    type RuntimeStateRecord,
} from '../../snapshot';
import type {ResolveHint} from '../../runner/steps/types';
import {normalizeResolveHint} from '../../runner/steps/resolve_utils';
import type {RecorderEvent} from '../capture/recorder';
import type {RecordingState} from '../pipeline/state';
import type {RecordedEntityBinding, RecordedStepEnhancement, RecordedTargetFingerprint} from '../types';
import {resolveRecordTargetBinding} from '../pipeline/target_binding';
import {
    recordSnapshotId,
    resolveRecordSnapshotForEvent,
    type RecordPageSnapshot,
} from '../pipeline/snapshot';
import {buildRecordResolveFromSnapshotCandidate} from './resolve';


export const enrichRecordedStepWithSnapshot = async (input: {
    event: RecorderEvent;
    page?: Page;
    state: RecordingState;
    workspaceName?: string;
    tabName?: string;
}): Promise<RecordedStepEnhancement> => {
    const recordLog = getLogger('record');
    const {event, page, state} = input;
    if (isPageLevelEvent(event)) {
        const snapshot = await resolveRecordSnapshotForEvent({event, page, state, workspaceName: input.workspaceName || ''});
        return snapshot
            ? withRawContext(event, {
                version: 1,
                eventType: event.type,
                snapshot: buildSnapshotMetadata(snapshot, input),
            })
            : withRawContext(event, buildLowConfidenceRawOnlyResolve(event));
    }
    if (requiresTargetSelector(event) && !event.selector) {
        return withRawContext(event, buildLowConfidenceRawOnlyResolve(event, {
            reason: ['missing_selector_for_target_event'],
            warnings: ['MISSING_SELECTOR_FOR_TARGET_EVENT', 'LOW_CONFIDENCE_RAW_ONLY'],
            confidence: 0.2,
        }));
    }

    const binding = await resolveRecordTargetBinding({event, page, state, workspaceName: input.workspaceName || ''});
    if (!binding) {
        recordLog('record_enhancement_binding', {
            result: 'raw_only',
            eventType: event.type,
            selector: event.selector,
            reason: 'binding_missing',
        });
        return withRawContext(event, buildLowConfidenceRawOnlyResolve(event));
    }

    const target = buildTargetFingerprint(binding.snapshot, binding.targetNodeId);
    if (!target) {
        return withRawContext(event, buildLowConfidenceRawOnlyResolve(event));
    }
    const entityBindings = buildEntityBindings(binding.snapshot, binding.targetNodeId);
    const confidenceInfo = computeRecordConfidence(event, binding.snapshot, binding.targetNodeId);
    const resolveDraft = buildRecordResolveFromSnapshotCandidate({
        snapshot: binding.snapshot,
        candidate: {
            nodeId: target.nodeId,
            selector: event.selector,
            role: target.role,
            name: target.name,
            text: target.content,
            confidence: confidenceInfo.confidence,
            reason: confidenceInfo.reason,
        },
        rawSelector: event.selector,
        rawLocatorCandidates: event.locatorCandidates?.map((candidate) => ({...candidate})),
        warnings: confidenceInfo.warnings,
    });

    recordLog('record_enhancement_binding', {
        result: 'bound',
        eventType: event.type,
        selector: event.selector,
        targetNodeId: binding.targetNodeId,
        componentKind: binding.componentKind,
    });
    return withRawContext(event, {
        version: 1,
        eventType: event.type,
        snapshot: buildSnapshotMetadata(binding.snapshot, input),
        target,
        entityBindings,
        resolveHint: resolveDraft.hint,
        resolvePolicy: resolveDraft.policy,
    });
};

const buildSnapshotMetadata = (
    snapshot: RecordPageSnapshot,
    input: {event: RecorderEvent; page?: Page; workspaceName?: string; tabName?: string},
): NonNullable<RecordedStepEnhancement['snapshot']> => {
    const identity = snapshot.control.observation.identity;
    const pageIdentity = input.workspaceName
        ? {
            workspaceName: input.workspaceName,
            tabName: input.tabName || input.event.tabName,
            url: readPageUrl(input.event, input.page),
        }
        : undefined;
    return {
        mode: 'full',
        snapshotId: recordSnapshotId(snapshot),
        pageIdentity,
        pageEpoch: identity.pageEpoch,
        captureRevision: identity.captureRevision,
        capturedAt: Date.now(),
    };
};

const readPageUrl = (event: RecorderEvent, page?: Page): string => {
    if (event.pageUrl || event.url) {return event.pageUrl || event.url || '';}
    try {
        return page?.url() || '';
    } catch {
        return '';
    }
};

const isPageLevelEvent = (event: RecorderEvent): boolean => event.type === 'navigate' || event.type === 'scroll';

const requiresTargetSelector = (event: RecorderEvent): boolean => [
    'click',
    'input',
    'change',
    'date',
    'select',
    'check',
    'paste',
    'copy',
    'keydown',
].includes(event.type);

const withRawContext = (event: RecorderEvent, enhancement?: RecordedStepEnhancement): RecordedStepEnhancement => {
    const existingHint = enhancement?.resolveHint;
    const mergedRaw: ResolveHint['raw'] = {
        ...(existingHint?.raw || {}),
        selector: event.selector,
        locatorCandidates: event.locatorCandidates?.map((candidate) => ({...candidate})),
        scopeHint: event.scopeHint || undefined,
        targetHint: event.targetHint,
    };
    const next: RecordedStepEnhancement = {
        ...(enhancement || {version: 1}),
        version: 1,
        eventType: event.type,
        resolveHint: {
            ...(existingHint || {}),
            target: {
                ...(existingHint?.target || {}),
                tag: existingHint?.target?.tag || event.targetHint,
                role: existingHint?.target?.role || event.a11yHint?.role,
                attrs: existingHint?.target?.attrs || event.targetAttrs,
                state: existingHint?.target?.state || event.targetState,
            },
            raw: mergedRaw,
        },
        rawContext: {
            ...(enhancement?.rawContext || {}),
            pageUrl: event.pageUrl || event.url || undefined,
            recorderVersion: event.recorderVersion,
        },
    };
    next.resolveHint = normalizeResolveHint(next.resolveHint);
    return next;
};

const buildTargetFingerprint = (
    snapshot: RecordPageSnapshot,
    nodeId: ObservationNodeId,
): RecordedTargetFingerprint | undefined => {
    const observation = snapshot.control.observation;
    const node = new Map(Object.entries(observation.nodes)).get(nodeId);
    if (!node) {return undefined;}
    const attrs = {...(new Map(Object.entries(observation.attributes)).get(nodeId) ?? {})};
    const identity = new Map(Object.entries(observation.domIdentity)).get(nodeId);
    const geometryRecords = new Map(Object.entries(observation.geometry)).get(nodeId) ?? [];
    const geometry = geometryRecords.find((item) => item.space === 'top-css-viewport') ?? geometryRecords.at(0);
    return {
        nodeId,
        primaryDomId: identity?.backendNodeId,
        sourceDomIds: identity?.backendNodeId ? [identity.backendNodeId] : undefined,
        role: normalizeText(resolveSemanticRole(observation, nodeId).value),
        tag: node.tag,
        name: normalizeText(new Map(Object.entries(observation.accessibility)).get(nodeId)?.name),
        content: normalizeText(observation.text[nodeId]),
        attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        bbox: geometry ? {...geometry.rect} : undefined,
        runtimeState: cloneRuntimeState(observation.runtimeState[nodeId]),
        semanticHints: buildStructuralSemanticHints(snapshot, nodeId),
    };
};

const buildEntityBindings = (
    snapshot: RecordPageSnapshot,
    nodeId: ObservationNodeId,
): RecordedEntityBinding[] | undefined => {
    const bindings: RecordedEntityBinding[] = [];
    const seen = new Set<string>();
    const add = (binding: RecordedEntityBinding) => {
        const key = [binding.entityId, binding.type, binding.role, binding.itemId || '', binding.slotIndex ?? ''].join('|');
        if (seen.has(key)) {return;}
        seen.add(key);
        bindings.push(binding);
    };

    const formIndex = snapshot.form.forms;
    const formIds = new Set<string>();
    for (const id of formIndex.byNodeId[nodeId] ?? []) {
        if (new Map(Object.entries(formIndex.forms)).has(id)) {formIds.add(id);}
        for (const form of Object.values(formIndex.forms)) {
            if (form.fields.some((field) => field.id === id)
                || form.actions.some((action) => action.id === id)
                || form.groups.some((group) => group.id === id)) {
                formIds.add(form.id);
            }
        }
    }
    for (const formId of formIds) {
        const form = new Map(Object.entries(formIndex.forms)).get(formId);
        if (!form) {continue;}
        add({
            entityId: form.id,
            type: 'region',
            role: form.location.structuralRootNodeId === nodeId ? 'container' : 'descendant',
            kind: 'form',
        });
    }

    const tableIndex = snapshot.table.tables;
    const tableIds = new Set<string>();
    for (const id of tableIndex.byNodeId[nodeId] ?? []) {
        const table = new Map(Object.entries(tableIndex.tables)).get(id);
        if (table) {tableIds.add(table.id);}
        const row = new Map(Object.entries(tableIndex.rows)).get(id);
        if (row) {
            tableIds.add(row.tableId);
            add({entityId: row.tableId, type: 'group', role: 'item', kind: 'table', itemId: row.id});
        }
        const cell = new Map(Object.entries(tableIndex.cells)).get(id);
        if (cell) {
            const ownerRow = new Map(Object.entries(tableIndex.rows)).get(cell.rowId);
            if (ownerRow) {tableIds.add(ownerRow.tableId);}
        }
        const column = new Map(Object.entries(tableIndex.columns)).get(id);
        if (column) {
            const owner = Object.values(tableIndex.tables).find((candidate) =>
                candidate.columns.some((item) => item.id === column.id));
            if (owner) {tableIds.add(owner.id);}
        }
    }
    for (const tableId of tableIds) {
        const table = new Map(Object.entries(tableIndex.tables)).get(tableId);
        if (!table) {continue;}
        add({
            entityId: table.id,
            type: 'region',
            role: table.location.structuralRootNodeId === nodeId ? 'container' : 'descendant',
            kind: 'table',
        });
    }
    return bindings.length > 0 ? bindings : undefined;
};

const buildStructuralSemanticHints = (
    snapshot: RecordPageSnapshot,
    nodeId: ObservationNodeId,
): RecordedTargetFingerprint['semanticHints'] => {
    const bindings = buildEntityBindings(snapshot, nodeId) ?? [];
    const structural = bindings.find((binding) => binding.type === 'region');
    if (!structural) {return undefined;}
    return {
        entityNodeId: structural.entityId,
        entityKind: structural.kind,
        fieldLabel: readFieldLabel(snapshot, nodeId),
    };
};

const readFieldLabel = (snapshot: RecordPageSnapshot, nodeId: ObservationNodeId): string | undefined => {
    const formIndex = snapshot.form.forms;
    const fieldIds = new Set((formIndex.byNodeId[nodeId] ?? []).filter((id) =>
        new Map(Object.entries(formIndex.fields)).has(id)));
    for (const fieldId of fieldIds) {
        const field = new Map(Object.entries(formIndex.fields)).get(fieldId);
        if (!field) {continue;}
        const label = field.labelNodeIds
            .map((labelNodeId) => snapshot.control.observation.text[labelNodeId])
            .filter((value): value is string => Boolean(value))
            .join(' ');
        if (label) {return normalizeText(label);}
    }
    return undefined;
};

const cloneRuntimeState = (state: RuntimeStateRecord | undefined): Record<string, string> | undefined => {
    if (!state) {return undefined;}
    const values = Object.fromEntries(Object.entries(state).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'));
    return Object.keys(values).length > 0 ? values : undefined;
};

const computeRecordConfidence = (
    event: RecorderEvent,
    snapshot: RecordPageSnapshot,
    nodeId: ObservationNodeId,
): {confidence: number; reason: string[]; warnings: string[]} => {
    const observation = snapshot.control.observation;
    const role = normalizeText(resolveSemanticRole(observation, nodeId).value);
    const name = normalizeText(
        new Map(Object.entries(observation.accessibility)).get(nodeId)?.name || observation.text[nodeId],
    );
    const selector = event.selector;
    const reasons: string[] = [];
    const warnings: string[] = [];
    let confidence: number;
    if (selector && selectorMatchesNode(snapshot, nodeId, selector)) {
        confidence = 0.95;
        reasons.push('direct_selector_exact_match');
    } else if (event.a11yHint?.role && event.a11yHint.name
        && normalizeText(event.a11yHint.role) === role
        && name.includes(normalizeText(event.a11yHint.name))) {
        confidence = 0.8;
        reasons.push('role_and_name_match');
    } else if (selector) {
        confidence = 0.5;
        reasons.push('raw_selector_only');
    } else {
        confidence = 0.35;
        reasons.push('text_or_a11y_only');
    }
    if ((event.locatorCandidates ?? []).length > 1) {
        confidence = Math.max(0.2, confidence - 0.15);
        warnings.push('AMBIGUOUS_TARGET');
    }
    if (confidence < 0.55) {warnings.push('LOW_CONFIDENCE_RAW_ONLY');}
    return {confidence, reason: reasons, warnings};
};

const selectorMatchesNode = (snapshot: RecordPageSnapshot, nodeId: ObservationNodeId, selector: string): boolean => {
    const normalized = selector.trim();
    const locators = snapshot.control.locators;
    if ((locators.byNodeId[nodeId] ?? [])
        .map((locatorId) => new Map(Object.entries(locators.locators)).get(locatorId))
        .some((locator) => locator?.status === 'resolved' && locator.selector === normalized)) {
        return true;
    }
    const attrs = snapshot.control.observation.attributes[nodeId] ?? {};
    if (attrs.id && (`#${attrs.id}` === normalized || `[id="${attrs.id}"]` === normalized)) {return true;}
    return Boolean(attrs['data-testid'] && `[data-testid="${attrs['data-testid']}"]` === normalized);
};

const normalizeText = (value: string | undefined): string =>
    (value || '').replace(/\s+/g, ' ').trim().toLowerCase();

const buildLowConfidenceRawOnlyResolve = (
    event: RecorderEvent,
    overrides?: {reason?: string[]; warnings?: string[]; confidence?: number},
): RecordedStepEnhancement => ({
    version: 1,
    resolveHint: {
        target: {
            tag: event.targetHint,
            role: event.a11yHint?.role,
            attrs: event.targetAttrs,
            state: event.targetState,
        },
        raw: {
            selector: event.selector,
            locatorCandidates: event.locatorCandidates?.map((candidate) => ({...candidate})),
            scopeHint: event.scopeHint || undefined,
            targetHint: event.targetHint,
        },
        capture: {
            source: 'record_enrichment',
            confidence: overrides?.confidence ?? 0.25,
            reason: overrides?.reason || ['raw_selector_or_text_only_without_snapshot'],
            warnings: overrides?.warnings || ['LOW_CONFIDENCE_RAW_ONLY'],
        },
    },
    resolvePolicy: {
        preferDirect: true,
        requireVisible: true,
        allowFuzzy: true,
        allowIndexDrift: true,
    },
});
