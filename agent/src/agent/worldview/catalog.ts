import {readEffectDeclaration, UNKNOWN_EFFECT_SEMANTICS} from '../../effects/declaration';
import type {EffectSemantics} from '../../effects/contracts';
import {
    buildPageSessionEntityView,
    type PageSessionEntityRecord,
    type RuntimeEntityKind,
} from '../../runner/session/entity_view';
import type {BusinessQueryName} from '../../query/contracts';
import type {SemanticBusinessBinding} from '../../snapshot';
import {describeWorldView} from './descriptor';
import type {WorldView, WorldViewDescriptor} from './contracts';

export type WorldCatalogField = Readonly<{
    fieldKey: string;
    label?: string;
    targetKind: 'entity.field' | 'form.field' | 'table.filter';
    effect: EffectSemantics;
}>;

export type WorldCatalogAction = Readonly<{
    actionIntent: string;
    label?: string;
    targetKind: 'entity.action' | 'form.action' | 'table.module_action';
    effect: EffectSemantics;
}>;

export type WorldCatalogRowAction = Readonly<{
    actionIntent: string;
    label?: string;
    targetKind: 'table.row_action';
    effect: EffectSemantics;
}>;

export type WorldCatalogEntity = Readonly<{
    businessTag: string;
    kind: RuntimeEntityKind;
    label?: string;
    source: PageSessionEntityRecord['source'];
    profileNames: readonly string[];
    fields: readonly WorldCatalogField[];
    actions: readonly WorldCatalogAction[];
    rowActions: readonly WorldCatalogRowAction[];
    primaryKey?: Readonly<{fieldKey: string}>;
    queries: readonly BusinessQueryName[];
}>;

export type WorldCatalog = Readonly<{
    world: WorldViewDescriptor;
    entities: readonly WorldCatalogEntity[];
}>;

export const buildWorldCatalog = (view: WorldView): WorldCatalog => {
    const bindings = activeBindings(view);
    const byId = new Map(bindings.map((binding) => [binding.id, binding]));
    const entities = buildPageSessionEntityView(view.entry).entities
        .filter((entity): entity is PageSessionEntityRecord & {businessTag: string} => Boolean(entity.businessTag))
        .map((entity) => projectEntity(entity, (entity.bindingIds ?? []).flatMap((id) => byId.get(id) ?? [])));
    return Object.freeze({
        world: describeWorldView(view),
        entities: Object.freeze(entities),
    });
};

const projectEntity = (
    entity: PageSessionEntityRecord & {businessTag: string},
    bindings: readonly SemanticBusinessBinding[],
): WorldCatalogEntity => {
    const annotation = entity.annotation ?? {};
    const fields = memberRecords(annotation, fieldRecordKey(entity.kind)).flatMap((item) => {
        const fieldKey = text(item.fieldKey);
        if (!fieldKey) {return [];}
        const label = memberLabel(item);
        return [Object.freeze({
            fieldKey,
            ...(label ? {label} : {}),
            targetKind: fieldTargetKind(entity.kind),
            effect: effectFor(bindings, (binding) => binding.annotation.fieldKey === fieldKey),
        })];
    });
    const actions = memberRecords(annotation, actionRecordKey(entity.kind)).flatMap((item) => {
        const actionIntent = text(item.actionIntent);
        if (!actionIntent) {return [];}
        const label = memberLabel(item);
        return [Object.freeze({
            actionIntent,
            ...(label ? {label} : {}),
            targetKind: actionTargetKind(entity.kind),
            effect: effectFor(bindings, (binding) =>
                binding.annotation.actionIntent === actionIntent && binding.annotation.actionRole !== 'row'),
        })];
    });
    const rowActions = entity.kind === 'table'
        ? memberRecords(annotation, 'rowActions').flatMap((item) => {
            const actionIntent = text(item.actionIntent);
            if (!actionIntent) {return [];}
            const label = memberLabel(item);
            return [Object.freeze({
                actionIntent,
                ...(label ? {label} : {}),
                targetKind: 'table.row_action' as const,
                effect: rowActionEffect(bindings, actionIntent),
            })];
        })
        : [];
    const primaryKey = record(annotation.primaryKey);
    const fieldKey = text(primaryKey?.fieldKey);
    return Object.freeze({
        businessTag: entity.businessTag,
        kind: entity.kind,
        ...(entity.name ? {label: entity.name} : {}),
        source: entity.source,
        profileNames: Object.freeze(unique(bindings.map((binding) => binding.profileName))),
        fields: Object.freeze(fields),
        actions: Object.freeze(actions),
        rowActions: Object.freeze(rowActions),
        ...(fieldKey ? {primaryKey: Object.freeze({fieldKey})} : {}),
        queries: Object.freeze(queryCapabilities(entity)),
    });
};

const effectFor = (
    bindings: readonly SemanticBusinessBinding[],
    predicate: (binding: SemanticBusinessBinding) => boolean,
): EffectSemantics => readEffectDeclaration(bindings.find(predicate)?.annotation.effect) ?? UNKNOWN_EFFECT_SEMANTICS;

const rowActionEffect = (
    bindings: readonly SemanticBusinessBinding[],
    actionIntent: string,
): EffectSemantics => {
    const direct = bindings.find((binding) =>
        binding.annotation.actionRole === 'row' && binding.annotation.actionIntent === actionIntent);
    const declared = readEffectDeclaration(direct?.annotation.effect);
    if (declared) {return declared;}
    for (const binding of bindings) {
        for (const column of records(binding.annotation.columns)) {
            const action = records(column.actions).find((candidate) => candidate.actionIntent === actionIntent);
            const nested = readEffectDeclaration(action?.effect);
            if (nested) {return nested;}
        }
    }
    return UNKNOWN_EFFECT_SEMANTICS;
};

const queryCapabilities = (entity: PageSessionEntityRecord): BusinessQueryName[] => {
    if (entity.kind === 'form') {return ['form.fields', 'form.actions'];}
    if (entity.kind !== 'table') {return [];}
    const queries: BusinessQueryName[] = [
        'table.rowCount',
        'table.headers',
        'table.primaryKey',
        'table.columns',
        'table.currentRows',
        'table.hasNextPage',
    ];
    if (record(record(entity.annotation?.pagination)?.nextAction)?.nodeId) {
        queries.push('table.nextPageTarget');
    }
    return queries;
};

const fieldRecordKey = (kind: RuntimeEntityKind): string =>
    kind === 'form' ? 'formFields' : kind === 'table' ? 'filterFields' : 'entityFields';

const actionRecordKey = (kind: RuntimeEntityKind): string =>
    kind === 'form' ? 'formActions' : kind === 'table' ? 'moduleActions' : 'entityActions';

const fieldTargetKind = (kind: RuntimeEntityKind): WorldCatalogField['targetKind'] =>
    kind === 'form' ? 'form.field' : kind === 'table' ? 'table.filter' : 'entity.field';

const actionTargetKind = (kind: RuntimeEntityKind): WorldCatalogAction['targetKind'] =>
    kind === 'form' ? 'form.action' : kind === 'table' ? 'table.module_action' : 'entity.action';

const memberRecords = (annotation: Readonly<Record<string, unknown>>, key: string): Record<string, unknown>[] =>
    records(annotation[key]);

const memberLabel = (value: Readonly<Record<string, unknown>>): string | undefined =>
    text(value.name) ?? text(value.text) ?? text(value.label);

const activeBindings = (view: WorldView): SemanticBusinessBinding[] =>
    Object.values(view.entry.semanticBindingsByProfile)
        .flatMap((bindings) => Object.values(bindings.byId))
        .filter((binding) => binding.status === 'active' && binding.disposition === 'active');

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
        ? value.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
        : [];

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();
