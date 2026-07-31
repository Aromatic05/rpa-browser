export type DslEntityRulesEntityKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';

export type DslEntityRulesProfile = {
    profileName: string;
    entities: readonly {
        entityKey: string;
        businessTag: string;
        kind: DslEntityRulesEntityKind;
        fields: readonly {fieldKey: string}[];
        actions: readonly {actionIntent: string}[];
        rowActions?: readonly {actionIntent: string}[];
        supportedQueries: readonly string[];
        primaryKey?: {fieldKey: string};
    }[];
};

export type DslEntityRulesResolver = {
    resolveProfile: (profileName: string) => DslEntityRulesProfile | null;
};
