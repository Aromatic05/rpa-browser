import type {
    AnalysisDiagnostic,
    ObservationNodeId,
} from '../../observation/model/contracts';

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

export type TableComponentRuleSource = 'region' | 'group' | 'node';

export type TableComponentRuleKeyHintMatch = {
    headerContainsAll?: string[];
    primaryKeyCandidatesContains?: string[];
};

export type TableComponentRuleMatch = {
    kind?: 'table';
    nameContains?: string;
    idEquals?: string;
    nameEquals?: string;
    roleEquals?: string;
    classContains?: string;
    textContains?: string;
    ariaContains?: string;
    relation?: 'pagination';
    keyHint?: TableComponentRuleKeyHintMatch;
};

export type TableComponentMatchRule = {
    ruleId: string;
    source: TableComponentRuleSource;
    expect: RuleExpectedCardinality;
    within?: string;
    match: TableComponentRuleMatch;
};

export type TableComponentRuleBinding = {
    ruleId: string;
    source: TableComponentRuleSource;
    expect: RuleExpectedCardinality;
    matchedComponentIds: string[];
    matchedRowIds: string[];
    matchedColumnIds: string[];
    matchedNodeIds: ObservationNodeId[];
    ok: boolean;
};

export type TableComponentRuleMatchResult = {
    byRuleId: Readonly<Record<string, TableComponentRuleBinding>>;
    diagnostics: readonly AnalysisDiagnostic[];
};
