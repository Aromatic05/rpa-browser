import type {ControlSnapshot} from '../../components/control/model/contracts';
import type { FormSnapshot } from '../../components/form/model/contracts';
import type { TableSnapshot } from '../../components/table/model/contracts';
import type {
    AnalysisDiagnostic,
    ObservationNodeId,
} from '../../observation/model/contracts';

export type EntityRuleQueryDomain = 'form' | 'table' | 'node';
export type EntityRuleQueryEntityKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';
export type EntityRuleQuerySource = 'region' | 'group' | 'node';
export type EntityRuleQueryExpect = 'unique' | 'one_or_more';
export type EntityRuleQueryInputRule = {
    ruleId: string;
    source: EntityRuleQuerySource;
    expect: EntityRuleQueryExpect;
    within?: string;
    contains?: string;
    match: Readonly<Record<string, unknown>>;
};
export type EntityRuleQueryPurpose = 'check' | 'save' | 'runtime';
export type QueryPlanTargetKind = 'query-plan' | 'form-component' | 'table-component' | 'node';

export type EntityRuleQueryKeyHint = {
    headerContainsAll?: string[];
    primaryKeyCandidatesContains?: string[];
};

export type EntityRuleQueryMatch = {
    kind?: EntityRuleQueryEntityKind;
    nameContains?: string;
    idEquals?: string;
    nameEquals?: string;
    roleEquals?: string;
    placeholderEquals?: string;
    classContains?: string;
    textContains?: string;
    ariaContains?: string;
    relation?: 'pagination';
    keyHint?: EntityRuleQueryKeyHint;
};

export type EntityRuleQueryPlanStep = {
    planStepId: string;
    order: number;
    ruleId: string;
    domain: EntityRuleQueryDomain;
    source: EntityRuleQuerySource;
    expect: EntityRuleQueryExpect;
    withinRuleId?: string;
    withinPlanStepId?: string;
    containsRuleId?: string;
    containsPlanStepId?: string;
    match: EntityRuleQueryMatch;
};

export type EntityRuleQueryPlan = {
    id: string;
    profileName: string;
    domain: EntityRuleQueryDomain;
    steps: readonly EntityRuleQueryPlanStep[];
};

export type QueryPlanDiagnostic = AnalysisDiagnostic & {
    profileName: string;
    planStepId?: string;
    ruleId?: string;
    targetKind: QueryPlanTargetKind;
};

export type QueryPlanCompileResult =
    | { ok: true; plan: EntityRuleQueryPlan; diagnostics: readonly [] }
    | { ok: false; diagnostics: readonly QueryPlanDiagnostic[] };

export type QueryPlanSnapshots = {
    control?: ControlSnapshot;
    form?: FormSnapshot;
    table?: TableSnapshot;
};

export type QueryPlanCardinality = {
    expected: EntityRuleQueryExpect;
    actual: number;
    status: 'satisfied' | 'missing' | 'multiple';
};

export type EntityRuleQueryBinding = {
    planStepId: string;
    ruleId: string;
    domain: EntityRuleQueryDomain;
    source: EntityRuleQuerySource;
    expect: EntityRuleQueryExpect;
    targetKind: Exclude<QueryPlanTargetKind, 'query-plan'>;
    matchedComponentIds: string[];
    matchedNodeIds: ObservationNodeId[];
    matchedFieldIds: string[];
    matchedActionIds: string[];
    matchedRowIds: string[];
    matchedColumnIds: string[];
    cardinality: QueryPlanCardinality;
    ok: boolean;
};

export type EntityRuleQueryExecutionResult = {
    planId: string;
    profileName: string;
    domain: EntityRuleQueryDomain;
    purpose: EntityRuleQueryPurpose;
    byRuleId: Readonly<Record<string, EntityRuleQueryBinding>>;
    diagnostics: readonly QueryPlanDiagnostic[];
    ok: boolean;
};
