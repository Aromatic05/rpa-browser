import type {
    AnalysisDiagnostic,
    ObservationNodeId,
} from '../observation/contracts';

export type RuleExpectedCardinality = 'unique' | 'one_or_more';
export type FormComponentRuleSource = 'region' | 'group' | 'node';

export type FormComponentRuleMatch = {
    kind?: 'form';
    nameContains?: string;
    idEquals?: string;
    nameEquals?: string;
    roleEquals?: string;
    classContains?: string;
    textContains?: string;
    ariaContains?: string;
};

export type FormComponentMatchRule = {
    ruleId: string;
    source: FormComponentRuleSource;
    expect: RuleExpectedCardinality;
    within?: string;
    match: FormComponentRuleMatch;
};

export type FormComponentRuleBinding = {
    ruleId: string;
    source: FormComponentRuleSource;
    expect: RuleExpectedCardinality;
    matchedComponentIds: string[];
    matchedFieldIds: string[];
    matchedActionIds: string[];
    matchedNodeIds: ObservationNodeId[];
    ok: boolean;
};

export type FormComponentRuleMatchResult = {
    byRuleId: Readonly<Record<string, FormComponentRuleBinding>>;
    diagnostics: readonly AnalysisDiagnostic[];
};
