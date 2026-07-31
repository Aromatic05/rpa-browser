import type {EntityRulePageKind, WorkflowEntityRules} from './entity_rules';

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

export type EntityRuleExportEntry = {
    profileName: string;
    entityKey: string;
    businessTag: string;
    kind: EntityRulePageKind;
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
    const kind = entityKind(root.entityKind) ?? entityKind(rootRule?.match.kind);
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
    const fields = [...scoped.flatMap((binding) => symbol(binding.fieldKey, 'field', entityKey, binding.ruleId, diagnostics)),
        ...columnFields(root.columns, entityKey, ruleId, diagnostics)];
    const actions = scoped.flatMap((binding) => binding.actionRole === 'row' || binding.paginationRole
        ? [] : symbol(binding.actionIntent, 'action', entityKey, binding.ruleId, diagnostics));
    const primaryKey = primaryKeyFor(root.primaryKey, kind, root.columns, context, diagnostics);
    const rowActions = rowActionSymbols(root, scoped, primaryKey, entityKey, ruleId, diagnostics);
    const queries = querySymbols(kind, Boolean(root.pagination));
    return [{
        profileName: profile.name,
        entityKey,
        businessTag,
        kind,
        ...(primaryKey ? {primaryKey} : {}),
        members: uniqueMembers([...fields, ...actions, ...rowActions, ...queries], entityKey, diagnostics),
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

const rowActionSymbols = (root: Record<string, unknown>, scoped: readonly Record<string, unknown>[], primaryKey: EntityRuleExportEntry['primaryKey'], entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[]): EntityRuleExportMember[] => {
    const values = [
        ...scoped.filter((binding) => binding.actionRole === 'row').map((binding) => binding.actionIntent),
        ...arrayRecords(root.columns).flatMap((column) => arrayRecords(column.actions).map((action) => action.actionIntent)),
    ];
    if (values.length > 0 && !primaryKey) {
        diagnostics.push(diagnostic('malformed_primary_key', 'table row actions require a valid primaryKey', {entityKey, ruleId}));
        return [];
    }
    return values.flatMap((value) => {
        const member = text(value);
        if (!member) {return [];}
        if (!identifier.test(member)) {
            diagnostics.push(diagnostic('invalid_identifier', `rowAction symbol is not a valid identifier: ${member}`, {entityKey, ruleId}));
            return [];
        }
        return [{kind: 'rowAction' as const, symbol: member, rowPrimaryKey: primaryKey!.fieldKey}];
    });
};

const primaryKeyFor = (value: unknown, kind: EntityRulePageKind, columnsValue: unknown, context: {entityKey?: string; ruleId?: string}, diagnostics: EntityRuleExportDiagnostic[]): EntityRuleExportEntry['primaryKey'] | undefined => {
    if (value === undefined) {return undefined;}
    const fieldKey = isRecord(value) ? text(value.fieldKey) : undefined;
    const rawColumns = isRecord(value) && Array.isArray(value.columns) ? value.columns : undefined;
    const columns = rawColumns?.filter((key): key is string => typeof key === 'string');
    const knownColumns = new Set(arrayRecords(columnsValue).map((column) => text(column.fieldKey)).filter(Boolean));
    const invalidColumns = rawColumns !== undefined && (
        rawColumns.length === 0
        || columns!.length !== rawColumns.length
        || columns!.some((key) => !identifier.test(key))
        || new Set(columns ?? []).size !== columns!.length
        || (knownColumns.size > 0 && columns!.some((key) => !knownColumns.has(key)))
    );
    if (kind !== 'table' || !fieldKey || !identifier.test(fieldKey) || invalidColumns || (knownColumns.size > 0 && !knownColumns.has(fieldKey))) {
        diagnostics.push(diagnostic('malformed_primary_key', 'primaryKey must name a declared table column with valid identifiers', context));
        return undefined;
    }
    return {fieldKey, ...(columns ? {columns} : {})};
};

const columnFields = (value: unknown, entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[]): EntityRuleExportMember[] => arrayRecords(value)
    .flatMap((column) => symbol(column.fieldKey, 'field', entityKey, ruleId, diagnostics));

const symbol = (value: unknown, kind: 'field' | 'action', entityKey: string, ruleId: string | undefined, diagnostics: EntityRuleExportDiagnostic[]): EntityRuleExportMember[] => {
    const member = text(value);
    if (!member) {return [];}
    if (!identifier.test(member)) {
        diagnostics.push(diagnostic('invalid_identifier', `${kind} symbol is not a valid identifier: ${member}`, {entityKey, ruleId}));
        return [];
    }
    return [{kind, symbol: member}];
};

const querySymbols = (kind: EntityRulePageKind, paginated: boolean): EntityRuleExportMember[] => kind === 'table'
    ? ['currentRows', 'rowCount', ...(paginated ? ['hasNextPage', 'nextPageTarget'] : [])].map((symbol) => ({kind: 'query' as const, symbol}))
    : kind === 'form'
        ? ['fields', 'actions'].map((symbol) => ({kind: 'query' as const, symbol}))
        : [];

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
