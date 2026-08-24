export type EffectReversibility =
    | 'unknown'
    | 'reversible'
    | 'compensatable'
    | 'irreversible';

export type EffectDeclaration = Readonly<{
    reversibility: EffectReversibility;
}>;

export type EffectSemanticSource = Readonly<{
    kind: 'entity_rules';
    profileName: string;
    entityKey: string;
    memberKind: 'field' | 'action' | 'rowAction';
    member: string;
}>;

export type EffectSemantics = EffectDeclaration & Readonly<{
    source?: EffectSemanticSource;
}>;
