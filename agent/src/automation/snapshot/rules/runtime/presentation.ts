import type {
    EntityRuleActionView,
    EntityRuleColumnView,
    EntityRuleEntityKind,
    EntityRuleEntityView,
    EntityRuleFieldView,
    EntityRulePrimaryKeyView,
    EntityRuleProfileSummary,
    EntityRuleProfileView,
    EntityRuleRowActionView,
} from '../../../../../../shared/entity-rules-contract/index.js';
import type {WorkflowEntityRules} from '../../../workflow';
import {readEffectDeclaration} from '../../../../program/effects/declaration';
import type {EffectDeclaration} from '../../../../program/effects/contracts';

export const projectEntityRuleProfileSummary = (
    profile: WorkflowEntityRules,
): EntityRuleProfileSummary => {
    const entities = projectEntityRuleEntities(profile);
    const label = entities.at(0)?.label ?? profile.name;
    const pageKind = readEntityKind(profile.page?.kind) ?? entities.at(0)?.entityKind;
    return {
        profileName: profile.name,
        label,
        ...(pageKind ? {pageKind} : {}),
        ...(text(profile.page?.urlPattern) ? {urlPattern: text(profile.page?.urlPattern)} : {}),
        entityCount: entities.length,
    };
};

export const projectEntityRuleProfileView = (
    profile: WorkflowEntityRules,
): EntityRuleProfileView => ({
    ...projectEntityRuleProfileSummary(profile),
    entities: projectEntityRuleEntities(profile),
});

export const projectEntityRuleEntities = (
    profile: WorkflowEntityRules,
): EntityRuleEntityView[] => profile.annotation.bindings
    .filter((binding) => text(binding.businessTag))
    .flatMap((root) => {
        const businessTag = text(root.businessTag);
        if (!businessTag) {return [];}
        const legacyEntity = findLegacyEntity(root.legacyCanvas, businessTag);
        const rootRule = profile.match.rules.find((rule) => rule.ruleId === root.ruleId);
        const entityKind = readEntityKind(
            legacyEntity?.kind
            ?? root.entityKind
            ?? rootRule?.match.kind
            ?? profile.page?.kind,
        );
        if (!entityKind) {return [];}
        const semanticBindings = scopedBindings(profile, root.ruleId);
        const fallbackBindings = legacyEntity ? [] : semanticBindings;
        const fields = (legacyEntity
            ? legacyFields(legacyEntity, entityKind)
            : fallbackFields(fallbackBindings, entityKind))
            .map((field) => withEffect(field, effectForField(semanticBindings, field.fieldKey)));
        const actions = (legacyEntity
            ? legacyActions(legacyEntity, entityKind)
            : fallbackActions(fallbackBindings, entityKind))
            .map((action) => withEffect(action, effectForAction(semanticBindings, action.actionIntent)));
        const columns = legacyEntity ? legacyColumns(legacyEntity) : fallbackColumns(root);
        const rowActions = (legacyEntity
            ? legacyRowActions(legacyEntity)
            : fallbackRowActions(root, fallbackBindings))
            .map((action) => withEffect(action, effectForRowAction(root, semanticBindings, action.actionIntent)));
        const primaryKey = primaryKeyView(legacyEntity ?? root, columns);
        const label = text(root.displayName)
            ?? text(root.businessName)
            ?? text(legacyEntity?.name)
            ?? profile.name;
        return [{
            profileName: profile.name,
            businessTag,
            entityKind,
            label,
            fields: uniqueBy(fields, (item) => item.fieldKey),
            actions: uniqueBy(actions, (item) => item.actionIntent),
            rowActions: uniqueBy(rowActions, (item) => item.actionIntent),
            ...(primaryKey ? {primaryKey} : {}),
            columns: uniqueBy(columns, (item) => item.fieldKey),
            hasPagination: Boolean(legacyEntity?.pagination ?? root.pagination),
        } satisfies EntityRuleEntityView];
    });

export const entityRuleProfileApplies = (
    profile: WorkflowEntityRules,
    pageUrl: string,
): boolean => {
    const pattern = text(profile.page?.urlPattern);
    if (!pattern || !pageUrl) {return true;}
    try {
        return new RegExp(pattern).test(pageUrl);
    } catch {
        return false;
    }
};

const findLegacyEntity = (value: unknown, businessTag: string): Record<string, unknown> | null => {
    if (!isRecord(value) || !Array.isArray(value.entities)) {return null;}
    return value.entities
        .filter(isRecord)
        .find((entity) => entity.businessTag === businessTag) ?? null;
};

const legacyFields = (
    entity: Record<string, unknown>,
    entityKind: EntityRuleEntityKind,
): EntityRuleFieldView[] => {
    if (!Array.isArray(entity.annotations)) {return [];}
    return entity.annotations.filter(isRecord).flatMap((annotation) => {
        if (annotation.type !== 'field' || annotation.disposition === 'ignored') {return [];}
        const fieldKey = text(annotation.businessKey);
        if (!fieldKey) {return [];}
        return [{
            fieldKey,
            label: text(annotation.name) ?? fieldKey,
            targetKind: fieldTargetKind(entityKind),
        } satisfies EntityRuleFieldView];
    });
};

const legacyActions = (
    entity: Record<string, unknown>,
    entityKind: EntityRuleEntityKind,
): EntityRuleActionView[] => {
    if (!Array.isArray(entity.annotations)) {return [];}
    return entity.annotations.filter(isRecord).flatMap((annotation) => {
        if (annotation.type !== 'action' || annotation.disposition === 'ignored') {return [];}
        const actionIntent = text(annotation.businessKey);
        if (!actionIntent) {return [];}
        return [{
            actionIntent,
            label: text(annotation.name) ?? actionIntent,
            targetKind: actionTargetKind(entityKind),
        } satisfies EntityRuleActionView];
    });
};

const legacyRowActions = (entity: Record<string, unknown>): EntityRuleRowActionView[] =>
    nestedColumnActions(entity.columns);

const legacyColumns = (entity: Record<string, unknown>): EntityRuleColumnView[] => {
    if (!Array.isArray(entity.columns)) {return [];}
    const primaryKey = isRecord(entity.primaryKey) ? text(entity.primaryKey.fieldKey) : undefined;
    return entity.columns.filter(isRecord).flatMap((column) => {
        if (column.disposition === 'ignored') {return [];}
        const fieldKey = text(column.fieldKey);
        if (!fieldKey) {return [];}
        return [{
            fieldKey,
            label: text(column.name) ?? fieldKey,
            primaryKey: fieldKey === primaryKey,
            actionCount: Array.isArray(column.actions)
                ? column.actions.filter((action) => isRecord(action) && action.disposition !== 'ignored').length
                : 0,
        } satisfies EntityRuleColumnView];
    });
};

const fallbackFields = (
    bindings: readonly Record<string, unknown>[],
    entityKind: EntityRuleEntityKind,
): EntityRuleFieldView[] => bindings.flatMap((binding) => {
    const fieldKey = text(binding.fieldKey);
    if (!fieldKey) {return [];}
    return [{
        fieldKey,
        label: text(binding.fieldName) ?? fieldKey,
        targetKind: fieldTargetKind(entityKind),
    } satisfies EntityRuleFieldView];
});

const fallbackActions = (
    bindings: readonly Record<string, unknown>[],
    entityKind: EntityRuleEntityKind,
): EntityRuleActionView[] => bindings.flatMap((binding) => {
    if (binding.actionRole === 'row') {return [];}
    const actionIntent = text(binding.actionIntent);
    if (!actionIntent) {return [];}
    return [{
        actionIntent,
        label: text(binding.actionText) ?? actionIntent,
        targetKind: actionTargetKind(entityKind),
    } satisfies EntityRuleActionView];
});

const fallbackRowActions = (
    root: Record<string, unknown>,
    bindings: readonly Record<string, unknown>[],
): EntityRuleRowActionView[] => [
    ...bindings.flatMap((binding) => {
        if (binding.actionRole !== 'row') {return [];}
        const actionIntent = text(binding.actionIntent);
        if (!actionIntent) {return [];}
        return [{
            actionIntent,
            label: text(binding.actionText) ?? actionIntent,
            targetKind: 'table.row_action' as const,
        }];
    }),
    ...nestedColumnActions(root.columns),
];

const nestedColumnActions = (value: unknown): EntityRuleRowActionView[] => {
    if (!Array.isArray(value)) {return [];}
    return value.filter(isRecord).flatMap((column) =>
        Array.isArray(column.actions) ? column.actions.filter(isRecord).flatMap((action) => {
            if (action.disposition === 'ignored') {return [];}
            const actionIntent = text(action.actionIntent);
            if (!actionIntent) {return [];}
            return [{
                actionIntent,
                label: text(action.text) ?? actionIntent,
                targetKind: 'table.row_action' as const,
            }];
        }) : []);
};

const withEffect = <T extends object>(value: T, effect: EffectDeclaration | undefined): T & {effect?: EffectDeclaration} =>
    effect ? {...value, effect} : value;

const effectForField = (
    bindings: readonly Record<string, unknown>[],
    fieldKey: string,
): EffectDeclaration | undefined => readEffectDeclaration(
    bindings.find((binding) => binding.fieldKey === fieldKey)?.effect,
);

const effectForAction = (
    bindings: readonly Record<string, unknown>[],
    actionIntent: string,
): EffectDeclaration | undefined => readEffectDeclaration(
    bindings.find((binding) => binding.actionRole !== 'row' && binding.actionIntent === actionIntent)?.effect,
);

const effectForRowAction = (
    root: Record<string, unknown>,
    bindings: readonly Record<string, unknown>[],
    actionIntent: string,
): EffectDeclaration | undefined => {
    const binding = bindings.find((item) => item.actionRole === 'row' && item.actionIntent === actionIntent);
    if (binding) {return readEffectDeclaration(binding.effect);}
    for (const column of records(root.columns)) {
        const action = records(column.actions).find((item) => item.actionIntent === actionIntent);
        if (action) {return readEffectDeclaration(action.effect);}
    }
    return undefined;
};

const primaryKeyView = (
    entity: Record<string, unknown>,
    columns: readonly EntityRuleColumnView[],
): EntityRulePrimaryKeyView | undefined => {
    const primaryKey = isRecord(entity.primaryKey) ? text(entity.primaryKey.fieldKey) : undefined;
    if (!primaryKey) {return undefined;}
    const column = columns.find((candidate) => candidate.fieldKey === primaryKey);
    return {fieldKey: primaryKey, label: column?.label ?? primaryKey};
};

const fallbackColumns = (root: Record<string, unknown>): EntityRuleColumnView[] => {
    if (!Array.isArray(root.columns)) {return [];}
    const primaryKey = isRecord(root.primaryKey) ? text(root.primaryKey.fieldKey) : undefined;
    return root.columns.filter(isRecord).flatMap((column) => {
        const fieldKey = text(column.fieldKey);
        if (!fieldKey) {return [];}
        return [{
            fieldKey,
            label: text(column.name) ?? fieldKey,
            primaryKey: fieldKey === primaryKey,
            actionCount: Array.isArray(column.actions) ? column.actions.filter(isRecord).length : 0,
        } satisfies EntityRuleColumnView];
    });
};

const scopedBindings = (
    profile: WorkflowEntityRules,
    rootRuleId: string,
): Array<Record<string, unknown>> => {
    const rules = new Map(profile.match.rules.map((rule) => [rule.ruleId, rule]));
    const reachesRoot = (ruleId: string): boolean => {
        const visited = new Set<string>();
        let current: string | undefined = ruleId;
        while (current && !visited.has(current)) {
            if (current === rootRuleId) {return true;}
            visited.add(current);
            const rule = rules.get(current);
            if (!rule) {return false;}
            if (containsRule(rules, rule.ruleId, rootRuleId, new Set())) {return true;}
            current = rule.within;
        }
        return false;
    };
    return profile.annotation.bindings.filter((binding) => reachesRoot(binding.ruleId));
};

const containsRule = (
    rules: ReadonlyMap<string, WorkflowEntityRules['match']['rules'][number]>,
    containerRuleId: string,
    targetRuleId: string,
    visited: Set<string>,
): boolean => {
    if (visited.has(containerRuleId)) {return false;}
    visited.add(containerRuleId);
    const contained = rules.get(containerRuleId)?.contains;
    if (!contained) {return false;}
    return contained === targetRuleId || containsRule(rules, contained, targetRuleId, visited);
};

const fieldTargetKind = (kind: EntityRuleEntityKind): EntityRuleFieldView['targetKind'] =>
    kind === 'table' ? 'table.filter' : kind === 'form' ? 'form.field' : 'entity.field';

const actionTargetKind = (kind: EntityRuleEntityKind): EntityRuleActionView['targetKind'] =>
    kind === 'table' ? 'table.module_action' : kind === 'form' ? 'form.action' : 'entity.action';

const readEntityKind = (value: unknown): EntityRuleEntityKind | undefined =>
    typeof value === 'string'
        && ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'].includes(value)
        ? value as EntityRuleEntityKind
        : undefined;

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];

const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
        const value = key(item);
        if (seen.has(value)) {return false;}
        seen.add(value);
        return true;
    });
};
