import type {
    AnnotatorDraft,
    AnnotatorSemanticInput,
    AnnotatorTarget,
} from '../../snapshot/annotator';
import {
    buildAnnotatorProjection,
    resolveSemanticRole,
    type ObservationNodeId,
    type PageSessionSelection,
    type PageSnapshotSessionEntry,
} from '../../snapshot';

export type MaterializeAnnotatorTargetInput = {
    entry: PageSnapshotSessionEntry;
    draft: AnnotatorDraft;
    targetId: string;
    semantic: AnnotatorSemanticInput;
    selection?: PageSessionSelection;
};

export type MaterializeAnnotatorTargetResult =
    | {ok: true; draft: AnnotatorDraft}
    | {ok: false; message: string; details?: unknown};

export const materializeAnnotatorTarget = (
    input: MaterializeAnnotatorTargetInput,
): MaterializeAnnotatorTargetResult => {
    const projection = buildAnnotatorProjection(input.entry, input.selection);
    const target = projection.targets.find((candidate) => candidate.id === input.targetId);
    if (!target) {
        return {ok: false, message: `annotator target not found: ${input.targetId}`, details: {targetId: input.targetId}};
    }
    const draft = structuredClone(input.draft);
    switch (input.semantic.kind) {
        case 'entity':
            return applyEntity(input.entry, draft, target, input.semantic);
        case 'field':
            return applyFormField(input.entry, draft, target, input.semantic);
        case 'action':
            return applyFormAction(input.entry, draft, target, input.semantic);
        case 'column':
            return applyTableColumn(input.entry, draft, target, input.semantic);
        case 'primary-key':
            return applyTablePrimaryKey(input.entry, draft, target, input.semantic);
        case 'table-action':
            return applyTableAction(input.entry, draft, target, input.semantic);
    }
};

const applyEntity = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    target: AnnotatorTarget,
    semantic: Extract<AnnotatorSemanticInput, {kind: 'entity'}>,
): MaterializeAnnotatorTargetResult => {
    const entityKind = target.domain === 'form' || target.domain === 'table'
        ? target.domain
        : semantic.entityKind;
    if (!entityKind) {
        return {ok: false, message: 'generic entity annotation requires entityKind'};
    }
    const nodeId = componentRootNodeId(entry, target) ?? selectedTargetNodeId(target);
    if (!nodeId) {return {ok: false, message: `target has no canonical entity node: ${target.id}`};}
    const ruleId = `entity-${slug(draft.profileName)}`;
    const source = entityKind === 'form' || entityKind === 'table' ? 'region' : 'node';
    upsertRule(draft, {
        ruleId,
        source,
        expect: 'unique',
        match: {
            kind: entityKind,
            ...stableNodeMatch(entry, nodeId, source !== 'node'),
        },
    });
    upsertBinding(draft, ruleId, {
        businessTag: requireText(semantic.businessTag, 'businessTag'),
        ...(text(semantic.displayName) ? {displayName: text(semantic.displayName)} : {}),
        ...(source === 'node' ? {entityKind} : {}),
    });
    if (!draft.page) {
        draft.page = {kind: entityKind, urlPattern: pagePathPattern(entry.pageUrl)};
    }
    return {ok: true, draft};
};

const applyFormField = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    target: AnnotatorTarget,
    semantic: Extract<AnnotatorSemanticInput, {kind: 'field'}>,
): MaterializeAnnotatorTargetResult => {
    if (target.kind !== 'field' || target.domain !== 'form' || !target.componentId || !target.memberId) {
        return incompatible(target, 'form field');
    }
    const form = new Map(Object.entries(entry.capture.form.forms.forms)).get(target.componentId);
    const field = form?.fields.find((candidate) => candidate.id === target.memberId);
    if (!form || !field) {return {ok: false, message: `canonical form field is unavailable: ${target.id}`};}
    const control = field.controlIds.map((id) => entry.capture.control.controls.controls[id]).find(Boolean);
    const nodeId = control?.controlNodeId ?? control?.rootNodeId ?? field.anchorNodeId;
    const rootRuleId = ensureComponentRoot(entry, draft, 'form', form.id, form.location.structuralRootNodeId);
    const fieldKey = requireText(semantic.fieldKey, 'fieldKey');
    const ruleId = `field-${slug(fieldKey)}`;
    upsertRule(draft, {
        ruleId,
        source: 'node',
        expect: 'unique',
        within: rootRuleId,
        match: stableNodeMatch(entry, nodeId, false),
    });
    upsertBinding(draft, ruleId, {
        fieldKey,
        ...(text(semantic.displayName) || target.label ? {fieldName: text(semantic.displayName) ?? target.label} : {}),
        ...(control?.kind ? {controlKind: control.kind} : {}),
    });
    return {ok: true, draft};
};

const applyFormAction = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    target: AnnotatorTarget,
    semantic: Extract<AnnotatorSemanticInput, {kind: 'action'}>,
): MaterializeAnnotatorTargetResult => {
    if (target.kind !== 'action' || target.domain !== 'form' || !target.componentId || !target.memberId) {
        return incompatible(target, 'form action');
    }
    const form = new Map(Object.entries(entry.capture.form.forms.forms)).get(target.componentId);
    const action = form?.actions.find((candidate) => candidate.id === target.memberId);
    if (!form || !action) {return {ok: false, message: `canonical form action is unavailable: ${target.id}`};}
    const rootRuleId = ensureComponentRoot(entry, draft, 'form', form.id, form.location.structuralRootNodeId);
    const actionIntent = requireText(semantic.actionIntent, 'actionIntent');
    const ruleId = `action-${slug(actionIntent)}`;
    upsertRule(draft, {
        ruleId,
        source: 'node',
        expect: 'unique',
        within: rootRuleId,
        match: stableNodeMatch(entry, action.nodeId, false),
    });
    upsertBinding(draft, ruleId, {
        actionIntent,
        ...(text(semantic.displayName) || target.label ? {actionText: text(semantic.displayName) ?? target.label} : {}),
    });
    return {ok: true, draft};
};

const applyTableColumn = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    target: AnnotatorTarget,
    semantic: Extract<AnnotatorSemanticInput, {kind: 'column'}>,
): MaterializeAnnotatorTargetResult => {
    const resolved = tableColumn(entry, target);
    if (!resolved.ok) {return resolved;}
    const rootRuleId = ensureComponentRoot(
        entry,
        draft,
        'table',
        resolved.table.id,
        resolved.table.location.structuralRootNodeId,
    );
    const fieldKey = requireText(semantic.fieldKey, 'fieldKey');
    updateRootBinding(draft, rootRuleId, (binding) => ({
        ...binding,
        columns: upsertColumn(binding.columns, {
            fieldKey,
            name: resolved.column.name,
            kind: semantic.columnKind ?? 'text',
            source: 'annotation',
        }),
    }));
    return {ok: true, draft};
};

const applyTablePrimaryKey = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    target: AnnotatorTarget,
    semantic: Extract<AnnotatorSemanticInput, {kind: 'primary-key'}>,
): MaterializeAnnotatorTargetResult => {
    const resolved = tableColumn(entry, target);
    if (!resolved.ok) {return resolved;}
    const rootRuleId = ensureComponentRoot(
        entry,
        draft,
        'table',
        resolved.table.id,
        resolved.table.location.structuralRootNodeId,
    );
    const fieldKey = requireText(semantic.fieldKey, 'fieldKey');
    updateRootBinding(draft, rootRuleId, (binding) => ({
        ...binding,
        primaryKey: {fieldKey, columns: [resolved.column.name], source: 'annotation'},
        columns: upsertColumn(binding.columns, {
            fieldKey,
            name: resolved.column.name,
            kind: 'text',
            source: 'annotation',
        }),
    }));
    return {ok: true, draft};
};

const applyTableAction = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    target: AnnotatorTarget,
    semantic: Extract<AnnotatorSemanticInput, {kind: 'table-action'}>,
): MaterializeAnnotatorTargetResult => {
    if (target.kind !== 'action' || target.domain !== 'table' || !target.componentId || !target.memberId) {
        return incompatible(target, 'table action');
    }
    const table = new Map(Object.entries(entry.capture.table.tables.tables)).get(target.componentId);
    const slot = table?.controlSlots.find((candidate) => candidate.id === target.memberId);
    const column = slot ? table?.columns.find((candidate) => candidate.id === slot.columnId) : undefined;
    if (!table || !slot || !column) {return {ok: false, message: `canonical table action is unavailable: ${target.id}`};}
    const rootRuleId = ensureComponentRoot(entry, draft, 'table', table.id, table.location.structuralRootNodeId);
    const actionIntent = requireText(semantic.actionIntent, 'actionIntent');
    const actionText = text(semantic.displayName) ?? target.label;
    updateRootBinding(draft, rootRuleId, (binding) => ({
        ...binding,
        columns: upsertColumn(binding.columns, {
            fieldKey: slug(column.name) || column.id,
            name: column.name,
            kind: 'action_column',
            source: 'annotation',
            actions: [{actionIntent, ...(actionText ? {text: actionText} : {})}],
        }),
    }));
    return {ok: true, draft};
};

const ensureComponentRoot = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    domain: 'form' | 'table',
    componentId: string,
    nodeId: ObservationNodeId,
): string => {
    const existing = draft.match.rules.find((rule) => {
        const match = rule.match;
        return rule.source === 'region'
            && Boolean(match)
            && typeof match === 'object'
            && !Array.isArray(match)
            && (match as Record<string, unknown>).kind === domain;
    });
    if (existing && typeof existing.ruleId === 'string') {return existing.ruleId;}
    const ruleId = `entity-${slug(draft.profileName)}`;
    upsertRule(draft, {
        ruleId,
        source: 'region',
        expect: 'unique',
        match: {kind: domain, ...stableNodeMatch(entry, nodeId, true)},
    });
    upsertBinding(draft, ruleId, {});
    if (!draft.page) {draft.page = {kind: domain, urlPattern: pagePathPattern(entry.pageUrl)};}
    void componentId;
    return ruleId;
};

const componentRootNodeId = (
    entry: PageSnapshotSessionEntry,
    target: AnnotatorTarget,
): ObservationNodeId | undefined => {
    if (!target.componentId || !target.domain) {return undefined;}
    if (target.domain === 'form') {
        return new Map(Object.entries(entry.capture.form.forms.forms))
            .get(target.componentId)?.location.structuralRootNodeId;
    }
    if (target.domain === 'table') {
        return new Map(Object.entries(entry.capture.table.tables.tables))
            .get(target.componentId)?.location.structuralRootNodeId;
    }
    return undefined;
};

const selectedTargetNodeId = (target: AnnotatorTarget): ObservationNodeId | undefined => target.nodeIds[0];

const stableNodeMatch = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
    component: boolean,
): Record<string, unknown> => {
    const observation = entry.capture.control.observation;
    const attrs = observation.attributes[nodeId] ?? {};
    const role = resolveSemanticRole(observation, nodeId).value;
    if (text(attrs.id)) {return {idEquals: text(attrs.id)};}
    if (text(attrs.name)) {
        return {...(role ? {roleEquals: role} : {}), nameEquals: text(attrs.name)};
    }
    if (text(attrs['aria-label'])) {
        return {...(role ? {roleEquals: role} : {}), ariaContains: text(attrs['aria-label'])};
    }
    const accessibleName = text(observation.accessibility[nodeId]?.name);
    if (accessibleName) {
        return component
            ? {nameContains: accessibleName}
            : {...(role ? {roleEquals: role} : {}), textContains: accessibleName};
    }
    const nodeText = text(observation.text[nodeId]);
    if (nodeText) {
        return {...(role ? {roleEquals: role} : {}), textContains: nodeText.slice(0, 80)};
    }
    const classToken = text(attrs.class)?.split(/\s+/u).find((value) => value.length >= 3);
    if (classToken) {return {...(role ? {roleEquals: role} : {}), classContains: classToken};}
    return role ? {roleEquals: role} : {};
};

type ResolvedTableColumn = {
    ok: true;
    table: PageSnapshotSessionEntry['capture']['table']['tables']['tables'][string];
    column: PageSnapshotSessionEntry['capture']['table']['tables']['columns'][string];
};

type TableColumnResult = ResolvedTableColumn | {ok: false; message: string; details?: unknown};

const tableColumn = (
    entry: PageSnapshotSessionEntry,
    target: AnnotatorTarget,
): TableColumnResult => {
    if (target.kind !== 'column' || target.domain !== 'table' || !target.componentId || !target.memberId) {
        return {
            ok: false,
            message: `annotator target ${target.id} is not a table column`,
            details: {targetId: target.id, targetKind: target.kind, domain: target.domain},
        };
    }
    const table = new Map(Object.entries(entry.capture.table.tables.tables)).get(target.componentId);
    const column = new Map(Object.entries(entry.capture.table.tables.columns)).get(target.memberId)
        ?? table?.columns.find((candidate) => candidate.id === target.memberId);
    if (!table || !column) {
        return {ok: false, message: `canonical table column is unavailable: ${target.id}`};
    }
    return {ok: true, table, column};
};

const upsertRule = (draft: AnnotatorDraft, rule: AnnotatorDraft['match']['rules'][number]): void => {
    const index = draft.match.rules.findIndex((candidate) => candidate.ruleId === rule.ruleId);
    if (index >= 0) {draft.match.rules[index] = rule;}
    else {draft.match.rules.push(rule);}
};

const upsertBinding = (draft: AnnotatorDraft, ruleId: string, values: Record<string, unknown>): void => {
    const index = draft.annotation.bindings.findIndex((candidate) => candidate.ruleId === ruleId);
    const next = {ruleId, ...(index >= 0 ? draft.annotation.bindings[index] : {}), ...values};
    if (index >= 0) {draft.annotation.bindings[index] = next;}
    else {draft.annotation.bindings.push(next);}
};

const updateRootBinding = (
    draft: AnnotatorDraft,
    ruleId: string,
    update: (binding: Record<string, unknown>) => Record<string, unknown>,
): void => {
    const current = draft.annotation.bindings.find((binding) => binding.ruleId === ruleId) ?? {ruleId};
    upsertBinding(draft, ruleId, update(current));
};

const upsertColumn = (value: unknown, column: Record<string, unknown>): Record<string, unknown>[] => {
    const columns = Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
            .map((item) => structuredClone(item))
        : [];
    const index = columns.findIndex((item) => item.fieldKey === column.fieldKey || item.name === column.name);
    if (index >= 0) {columns[index] = {...columns[index], ...column};}
    else {columns.push(column);}
    return columns;
};

const incompatible = (target: AnnotatorTarget, expected: string): MaterializeAnnotatorTargetResult => ({
    ok: false,
    message: `annotator target ${target.id} is not a ${expected}`,
    details: {targetId: target.id, targetKind: target.kind, domain: target.domain},
});

const requireText = (value: string, field: string): string => {
    const normalized = text(value);
    if (!normalized) {throw new Error(`${field} is required`);}
    return normalized;
};

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const slug = (value: string): string => value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'target';

const pagePathPattern = (pageUrl: string): string | undefined => {
    try {
        const path = new URL(pageUrl).pathname;
        return path && path !== '/' ? path : undefined;
    } catch {
        return undefined;
    }
};
