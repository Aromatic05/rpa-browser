import type {EntityRulePageKind, WorkflowEntityRules} from './entity_rules';
import type {EffectDeclaration} from '../program/effects/contracts';
import {readEffectDeclaration} from '../program/effects/declaration';

export type EntityRuleExportDiagnostic = {
    code: string;
    message: string;
    entityKey?: string;
    ruleId?: string;
};

export type EntityRuleExportMember =
    | {kind: 'field'; symbol: string}
    | {kind: 'action'; symbol: string}
    | {kind: 'rowAction'; symbol: string; rowPrimaryKey: string}
    | {kind: 'query'; symbol: string};

export type EntityRuleExportField = {
    fieldKey: string;
    targetKind: 'form.field' | 'table.filter' | 'entity.field';
    effect?: EffectDeclaration;
};

export type EntityRuleExportAction = {
    actionIntent: string;
    targetKind: 'form.action' | 'table.module_action' | 'entity.action';
    effect?: EffectDeclaration;
};

export type EntityRuleExportRowAction = {
    actionIntent: string;
    targetKind: 'table.row_action';
    effect?: EffectDeclaration;
};

export type EntityRuleExportColumn = {
    fieldKey: string;
};

export type EntityRuleExportEntry = {
    profileName: string;
    entityKey: string;
    businessTag: string;
    kind: EntityRulePageKind;
    fields: readonly EntityRuleExportField[];
    actions: readonly EntityRuleExportAction[];
    columns: readonly EntityRuleExportColumn[];
    rowActions: readonly EntityRuleExportRowAction[];
    supportedQueries: readonly string[];
    primaryKey?: {fieldKey: string; columns?: readonly string[]};
    members: readonly EntityRuleExportMember[];
};

export type EntityRuleExportIndex = {
    profileName: string;
    entities: readonly EntityRuleExportEntry[];
    resolve: (entityKey: string, symbol: string) => EntityRuleExportMember | undefined;
};

export type EntityRuleExportResolution = {
    index: EntityRuleExportIndex | null;
    diagnostics: readonly EntityRuleExportDiagnostic[];
};

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const pageKinds = new Set<EntityRulePageKind>(['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv']);

export const buildEntityRuleExportIndex = (profile: WorkflowEntityRules): EntityRuleExportResolution => {
    const diagnostics: EntityRuleExportDiagnostic[] = [];
    const rules = new Map(profile.match.rules.map((rule) => [rule.ruleId, rule]));
    const roots = profile.annotation.bindings.filter((binding) =>
        typeof binding.entityKey === 'string'
        || typeof binding.businessTag === 'string'
        || typeof binding.entityKind === 'string'
        || binding.primaryKey !== undefined
        || binding.columns !== undefined,
    );
    const entries = roots.flatMap((root) => buildEntry(profile, root, rules, diagnostics));
    const byKey = new Map<string, EntityRuleExportEntry>();
    for (const entry of entries) {
        if (byKey.has(entry.entityKey)) {
            diagnostics.push(diagnostic('duplicate_entity_key', `duplicate entityKey: ${entry.entityKey}`, entry));
            continue;
        }
        byKey.set(entry.entityKey, entry);
    }
    if (diagnostics.length > 0) {return {index: null, diagnostics};}
    return {
        index: {
            profileName: profile.name,
            entities: [...byKey.values()],
            resolve: (entityKey, symbol) => byKey.get(entityKey)?.members.find((member) => member.symbol === symbol),
        },
        diagnostics,
    };
};

const buildEntry = (
    profile: WorkflowEntityRules,
    root: Record<string, unknown>,
    rules: ReadonlyMap<string, WorkflowEntityRules['match']['rules'][number]>,
    diagnostics: EntityRuleExportDiagnostic[],
): EntityRuleExportEntry[] => {
    const ruleId = text(root.ruleId);
    const entityKey = text(root.entityKey);
    const businessTag = text(root.businessTag);
    const rootRule = ruleId ? rules.get(ruleId) : undefined;
    const kind = entityKind(root.entityKind) ?? entityKind(rootRule?.match.kind) ?? entityKind(profile.page?.kind);
    const context = {entityKey, ruleId};
    if (!entityKey) {
        diagnostics.push(diagnostic('missing_entity_key', 'business entity root has no entityKey and is not exportable', context));
    } else if (!identifier.test(entityKey)) {
        diagnostics.push(diagnostic('invalid_identifier', `entityKey is not a valid identifier: ${entityKey}`, context));
    }
    if (!businessTag) {diagnostics.push(diagnostic('missing_business_tag', 'business entity root has no businessTag', context));}
    if (!kind) {diagnostics.push(diagnostic('missing_entity_kind', 'business entity root has no entity kind', context));}
    if (!entityKey || !businessTag || !kind) {return [];}

    const scoped = profile.annotation.bindings.filter((binding) => binding.ruleId !== ruleId && belongsToRoot(binding.ruleId, ruleId, rules));
    const fields = uniqueFields(
        scoped.flatMap((binding) => field(binding.fieldKey, kind, entityKey, binding.ruleId, diagnostics, binding.effect)),
    );
    const actions = uniqueActions(scoped.flatMap((binding) => binding.actionRole === 'row' || binding.paginationRole
        ? [] : action(binding.actionIntent, kind, entityKey, binding.ruleId, diagnostics, binding.effect)));
    const columns = uniqueColumns(columnFields(root.columns, entityKey, ruleId, diagnostics));
    const primaryKey = primaryKeyFor(root.primaryKey, kind, root.columns, context, diagnostics);
    const rowActions = uniqueRowActions(rowActionSymbols(root, scoped, primaryKey, entityKey, ruleId, diagnostics));
    const supportedQueries = querySymbols(kind, Boolean(root.pagination));
    const members = uniqueMembers([
        ...fields.map((item) => ({kind: 'field' as const, symbol: item.fieldKey})),
        ...actions.map((item) => ({kind: 'action' as const, symbol: item.actionIntent})),
        ...rowActions.map((item) => ({kind: 'rowAction' as const, symbol: item.actionIntent, rowPrimaryKey: primaryKey!.fieldKey})),
        ...supportedQueries.map((query) => ({kind: 'query' as const, symbol: query.slice(query.indexOf('.') + 1)})),
    ], entityKey, diagnostics);
    return [{
        profileName: profile.name,
        entityKey,
        businessTag,
        kind,
        fields,
        actions,
        columns,
        rowActions,
        supportedQueries,
        ...(primaryKey ? {primaryKey} : {}),
        members,
    }];
};

const uniqueMembers = (
    members: EntityRuleExportMember[], entityKey: string, diagnostics: EntityRuleExportDiagnostic[],
): EntityRuleExportMember[] => {
    const bySymbol = new Map<string, EntityRuleExportMember>();
    for (const member of members) {
        const existing = bySymbol.get(member.symbol);
        if (!existing) {bySymbol.set(member.symbol, member); continue;}
        if (existing.kind === member.kind && existing.kind === 'field') {continue;}
        diagnostics.push(diagnostic('ambiguous_member_symbol', `member symbol is ambiguous: ${entityKey}.${member.symbol}`, {entityKey}));
    }
    return [...bySymbol.values()];
};

const rowActionSymbols = (root: Record<string, unknown>, scoped: readonly Record<string, unknown>[], primaryKey: EntityRuleExportEntry['primaryKey'], entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[]): EntityRuleExportRowAction[] => {
    const values = [
        ...scoped.filter((binding) => binding.actionRole === 'row').map((binding) => ({
            actionIntent: binding.actionIntent,
            effect: binding.effect,
        })),
        ...arrayRecords(root.columns).flatMap((column) => arrayRecords(column.actions).map((action) => ({
            actionIntent: action.actionIntent,
            effect: action.effect,
        }))),
    ];
    if (values.length > 0 && !primaryKey) {
        diagnostics.push(diagnostic('malformed_primary_key', 'table row actions require a valid primaryKey', {entityKey, ruleId}));
        return [];
    }
    return values.flatMap((value) => {
        const member = text(value.actionIntent);
        if (!member) {return [];}
        if (!identifier.test(member)) {
            diagnostics.push(diagnostic('invalid_identifier', `rowAction symbol is not a valid identifier: ${member}`, {entityKey, ruleId}));
            return [];
        }
        const effect = readEffectDeclaration(value.effect);
        return [{
            actionIntent: member,
            targetKind: 'table.row_action' as const,
            ...(effect ? {effect} : {}),
        }];
    });
};

const primaryKeyFor = (value: unknown, kind: EntityRulePageKind, columnsValue: unknown, context: {entityKey?: string; ruleId?: string}, diagnostics: EntityRuleExportDiagnostic[]): EntityRuleExportEntry['primaryKey'] | undefined => {
    if (value === undefined) {return undefined;}
    const fieldKey = isRecord(value) ? text(value.fieldKey) : undefined;
    const rawColumns = isRecord(value) && Array.isArray(value.columns) ? value.columns : undefined;
    const columns = rawColumns?.map((column) => text(column)).filter((column): column is string => Boolean(column));
    const knownColumns = new Set(arrayRecords(columnsValue).map((column) => text(column.fieldKey)).filter(Boolean));
    const invalidColumns = rawColumns !== undefined && (
        rawColumns.length === 0
        || columns!.length !== rawColumns.length
        || new Set(columns).size !== columns!.length
    );
    if (kind !== 'table' || !fieldKey || !identifier.test(fieldKey) || invalidColumns || (knownColumns.size > 0 && !knownColumns.has(fieldKey))) {
        diagnostics.push(diagnostic('malformed_primary_key', 'primaryKey must name a declared table column and use non-empty column labels', context));
        return undefined;
    }
    return {fieldKey, ...(columns ? {columns} : {})};
};

const columnFields = (value: unknown, entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[]): EntityRuleExportColumn[] => arrayRecords(value)
    .flatMap((column) => {
        const fieldKey = checkedIdentifier(column.fieldKey, 'column', entityKey, ruleId, diagnostics);
        return fieldKey ? [{fieldKey}] : [];
    });

const field = (value: unknown, kind: EntityRulePageKind, entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[], effectValue?: unknown): EntityRuleExportField[] => {
    const fieldKey = checkedIdentifier(value, 'field', entityKey, ruleId, diagnostics);
    const effect = readEffectDeclaration(effectValue);
    return fieldKey ? [{
        fieldKey,
        targetKind: kind === 'table' ? 'table.filter' : kind === 'form' ? 'form.field' : 'entity.field',
        ...(effect ? {effect} : {}),
    }] : [];
};

const action = (value: unknown, kind: EntityRulePageKind, entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[], effectValue?: unknown): EntityRuleExportAction[] => {
    const actionIntent = checkedIdentifier(value, 'action', entityKey, ruleId, diagnostics);
    const effect = readEffectDeclaration(effectValue);
    return actionIntent ? [{
        actionIntent,
        targetKind: kind === 'table' ? 'table.module_action' : kind === 'form' ? 'form.action' : 'entity.action',
        ...(effect ? {effect} : {}),
    }] : [];
};

const checkedIdentifier = (value: unknown, kind: string, entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[]): string | undefined => {
    const member = text(value);
    if (!member) {return undefined;}
    if (!identifier.test(member)) {
        diagnostics.push(diagnostic('invalid_identifier', `${kind} symbol is not a valid identifier: ${member}`, {entityKey, ruleId}));
        return undefined;
    }
    return member;
};

const querySymbols = (kind: EntityRulePageKind, paginated: boolean): string[] => kind === 'table'
    ? ['table.currentRows', 'table.rowCount', ...(paginated ? ['table.hasNextPage', 'table.nextPageTarget'] : [])]
    : kind === 'form'
        ? ['form.fields', 'form.actions']
        : [];

const uniqueFields = (values: EntityRuleExportField[]): EntityRuleExportField[] => uniqueBy(values, (item) => item.fieldKey);
const uniqueActions = (values: EntityRuleExportAction[]): EntityRuleExportAction[] => uniqueBy(values, (item) => item.actionIntent);
const uniqueColumns = (values: EntityRuleExportColumn[]): EntityRuleExportColumn[] => uniqueBy(values, (item) => item.fieldKey);
const uniqueRowActions = (values: EntityRuleExportRowAction[]): EntityRuleExportRowAction[] => uniqueBy(values, (item) => item.actionIntent);
const uniqueBy = <T>(values: readonly T[], key: (value: T) => string): T[] => [...new Map(values.map((value) => [key(value), value])).values()];

const belongsToRoot = (ruleId: unknown, rootRuleId: string | undefined, rules: ReadonlyMap<string, WorkflowEntityRules['match']['rules'][number]>): boolean => {
    if (typeof ruleId !== 'string' || !rootRuleId) {return false;}
    const seen = new Set<string>();
    let current = rules.get(ruleId);
    while (current && !seen.has(current.ruleId)) {
        if (current.within === rootRuleId || current.contains === rootRuleId) {return true;}
        seen.add(current.ruleId);
        current = rules.get(current.within ?? current.contains ?? '');
    }
    return false;
};

const diagnostic = (suffix: string, message: string, context: {entityKey?: string; ruleId?: string}): EntityRuleExportDiagnostic => ({code: `entity_rule_exports.${suffix}`, message, ...(context.entityKey ? {entityKey: context.entityKey} : {}), ...(context.ruleId ? {ruleId: context.ruleId} : {})});
const entityKind = (value: unknown): EntityRulePageKind | undefined => typeof value === 'string' && pageKinds.has(value as EntityRulePageKind) ? value as EntityRulePageKind : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const arrayRecords = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
