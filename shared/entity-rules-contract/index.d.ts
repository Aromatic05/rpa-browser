export declare const ENTITY_RULE_ENTITY_KINDS: readonly [
    'form',
    'table',
    'dialog',
    'list',
    'panel',
    'toolbar',
    'kv',
];

export type EntityRuleEntityKind = typeof ENTITY_RULE_ENTITY_KINDS[number];

export type EntityRuleFieldView = {
    fieldKey: string;
    label: string;
    targetKind: 'entity.field' | 'form.field' | 'table.filter';
};

export type EntityRuleActionView = {
    actionIntent: string;
    label: string;
    targetKind: 'entity.action' | 'form.action' | 'table.module_action';
};

export type EntityRuleRowActionView = {
    actionIntent: string;
    label: string;
    targetKind: 'table.row_action';
};

export type EntityRulePrimaryKeyView = {
    fieldKey: string;
    label: string;
};

export type EntityRuleColumnView = {
    fieldKey: string;
    label: string;
    primaryKey: boolean;
    actionCount: number;
};

export type EntityRuleEntityView = {
    profileName: string;
    businessTag: string;
    entityKind: EntityRuleEntityKind;
    label: string;
    fields: EntityRuleFieldView[];
    actions: EntityRuleActionView[];
    rowActions: EntityRuleRowActionView[];
    primaryKey?: EntityRulePrimaryKeyView;
    columns: EntityRuleColumnView[];
    hasPagination: boolean;
};

export type EntityRuleProfileSummary = {
    profileName: string;
    label: string;
    pageKind?: EntityRuleEntityKind;
    urlPattern?: string;
    entityCount: number;
    status?: 'ready' | 'invalid';
    error?: string;
};

export type EntityRuleProfileView = EntityRuleProfileSummary & {
    entities: EntityRuleEntityView[];
};

export type EntityRuleSelection = Pick<
    EntityRuleEntityView,
    'profileName' | 'businessTag' | 'entityKind'
>;
