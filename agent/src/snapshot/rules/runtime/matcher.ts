import type { EntityRuleConfig } from '../../../config';
import type {
    EntityRuleAnnotationBinding,
    EntityRuleMatchRecord,
    WorkflowEntityRules,
} from '../../../workflow';
import type { FormSnapshot } from '../../components/form/model/contracts';
import type { TableSnapshot } from '../../components/table/model/contracts';
import type { AnalysisDiagnostic } from '../../observation/model/contracts';
import { deepFreeze } from '../../observation/model/freeze';
import { matchFormComponentRules } from '../matching/form';
import { matchTableComponentRules } from '../matching/table';
import type {
    FormComponentMatchRule,
    FormComponentRuleBinding,
    TableComponentMatchRule,
    TableComponentRuleBinding,
} from '../model/contracts';
import type { StepEntityRulesControl } from '../model/selection';
import type { WorkspaceEntityRulesProvider } from './contracts';
import { resolveStepEntityRulesExecution } from './step_control';

export type EntityRuleProfileDomain = 'form' | 'table';

export type EntityRuleComponentSnapshots = {
    form?: FormSnapshot;
    table?: TableSnapshot;
};

export type EntityRuleRuntimeBinding = {
    ruleId: string;
    source: EntityRuleMatchRecord['source'];
    expect: EntityRuleMatchRecord['expect'];
    domain: EntityRuleProfileDomain;
    matchedComponentIds: string[];
    matchedNodeIds: string[];
    matchedFieldIds?: string[];
    matchedActionIds?: string[];
    matchedRowIds?: string[];
    matchedColumnIds?: string[];
    annotation?: EntityRuleAnnotationBinding;
    ok: boolean;
};

export type EntityRuleProfileMatchResult = {
    profileName: string;
    domain: EntityRuleProfileDomain;
    bindings: Readonly<Record<string, EntityRuleRuntimeBinding>>;
    diagnostics: readonly AnalysisDiagnostic[];
    ok: boolean;
};

export type EntityRulesExecutionResult = {
    status: 'disabled' | 'ready' | 'unavailable' | 'invalid';
    selection: 'disabled' | 'auto' | 'explicit';
    selectedProfiles: string[];
    strict: boolean;
    profiles: Readonly<Record<string, EntityRuleProfileMatchResult>>;
    diagnostics: readonly AnalysisDiagnostic[];
    ok: boolean;
};

export type ExecuteEntityRulesInput = {
    control?: StepEntityRulesControl;
    config: EntityRuleConfig;
    provider?: WorkspaceEntityRulesProvider | null;
    snapshots: EntityRuleComponentSnapshots;
};

const COMMON_MATCH_KEYS = new Set([
    'kind',
    'nameContains',
    'idEquals',
    'nameEquals',
    'roleEquals',
    'classContains',
    'textContains',
    'ariaContains',
]);
const TABLE_MATCH_KEYS = new Set([...COMMON_MATCH_KEYS, 'relation', 'keyHint']);
const STRING_MATCH_KEYS = [
    'nameContains',
    'idEquals',
    'nameEquals',
    'roleEquals',
    'classContains',
    'textContains',
    'ariaContains',
] as const;

export const executeEntityRules = (input: ExecuteEntityRulesInput): EntityRulesExecutionResult => {
    const resolution = resolveStepEntityRulesExecution(input.control, input.config, input.provider);
    if (resolution.status !== 'ready') {
        const diagnostics = resolution.reason
            ? [runtimeDiagnostic(
                  resolution.status === 'invalid'
                      ? 'entity-rules.execution.invalid'
                      : 'entity-rules.execution.unavailable',
                  resolution.reason,
              )]
            : [];
        return deepFreeze({
            status: resolution.status,
            selection: resolution.selection,
            selectedProfiles: resolution.profiles,
            strict: resolution.strict,
            profiles: {},
            diagnostics,
            ok: resolution.status === 'disabled',
        });
    }

    const provider = input.provider;
    if (!provider) {
        const diagnostic = runtimeDiagnostic(
            'entity-rules.execution.unavailable',
            'Snapshot V2 entity_rules provider is unavailable',
        );
        return deepFreeze({
            status: 'unavailable',
            selection: resolution.selection,
            selectedProfiles: resolution.profiles,
            strict: resolution.strict,
            profiles: {},
            diagnostics: [diagnostic],
            ok: false,
        });
    }

    const profiles: Record<string, EntityRuleProfileMatchResult> = {};
    const diagnostics: AnalysisDiagnostic[] = [];
    let invalid = false;
    for (const profileName of resolution.profiles) {
        const profile = provider.getProfile(profileName);
        if (!profile) {
            invalid = true;
            diagnostics.push(runtimeDiagnostic(
                'entity-rules.profile.missing',
                `entity_rules profile disappeared before matching: ${profileName}`,
            ));
            continue;
        }
        const matched = matchEntityRuleProfile(profile, input.snapshots);
        profiles[profileName] = matched.result;
        diagnostics.push(...matched.result.diagnostics);
        invalid ||= matched.invalid;
    }

    return deepFreeze({
        status: invalid ? 'invalid' : 'ready',
        selection: resolution.selection,
        selectedProfiles: resolution.profiles,
        strict: resolution.strict,
        profiles,
        diagnostics,
        ok: !invalid && Object.values(profiles).every((profile) => profile.ok),
    });
};

const matchEntityRuleProfile = (
    profile: WorkflowEntityRules,
    snapshots: EntityRuleComponentSnapshots,
): { result: EntityRuleProfileMatchResult; invalid: boolean } => {
    const compiled = compileProfile(profile);
    if (!compiled.ok) {
        const domain = compiled.domain ?? 'form';
        return {
            invalid: true,
            result: {
                profileName: profile.name,
                domain,
                bindings: {},
                diagnostics: compiled.diagnostics,
                ok: false,
            },
        };
    }

    const annotationByRuleId = new Map(profile.annotation.bindings.map((binding) => [binding.ruleId, binding]));
    if (compiled.domain === 'form') {
        if (!snapshots.form) {
            const diagnostic = runtimeDiagnostic(
                'entity-rules.profile.snapshot.missing',
                `form snapshot is unavailable for profile: ${profile.name}`,
            );
            return {
                invalid: true,
                result: {
                    profileName: profile.name,
                    domain: 'form',
                    bindings: {},
                    diagnostics: [diagnostic],
                    ok: false,
                },
            };
        }
        const matched = matchFormComponentRules(snapshots.form, compiled.rules as FormComponentMatchRule[]);
        const bindings = mapFormBindings(matched.byRuleId, annotationByRuleId);
        return {
            invalid: false,
            result: {
                profileName: profile.name,
                domain: 'form',
                bindings,
                diagnostics: matched.diagnostics,
                ok: Object.values(bindings).every((binding) => binding.ok),
            },
        };
    }

    if (!snapshots.table) {
        const diagnostic = runtimeDiagnostic(
            'entity-rules.profile.snapshot.missing',
            `table snapshot is unavailable for profile: ${profile.name}`,
        );
        return {
            invalid: true,
            result: {
                profileName: profile.name,
                domain: 'table',
                bindings: {},
                diagnostics: [diagnostic],
                ok: false,
            },
        };
    }
    const matched = matchTableComponentRules(snapshots.table, compiled.rules as TableComponentMatchRule[]);
    const bindings = mapTableBindings(matched.byRuleId, annotationByRuleId);
    return {
        invalid: false,
        result: {
            profileName: profile.name,
            domain: 'table',
            bindings,
            diagnostics: matched.diagnostics,
            ok: Object.values(bindings).every((binding) => binding.ok),
        },
    };
};

const compileProfile = (
    profile: WorkflowEntityRules,
): {
    ok: boolean;
    domain?: EntityRuleProfileDomain;
    rules: Array<FormComponentMatchRule | TableComponentMatchRule>;
    diagnostics: AnalysisDiagnostic[];
} => {
    const domains = new Set<EntityRuleProfileDomain>();
    for (const rule of profile.match.rules) {
        const kind = rule.match.kind;
        if (kind === 'form' || kind === 'table') {domains.add(kind);}
    }
    if (domains.size > 1) {
        return {
            ok: false,
            rules: [],
            diagnostics: [runtimeDiagnostic(
                'entity-rules.profile.domain.mixed',
                `entity_rules profile mixes form and table roots: ${profile.name}`,
            )],
        };
    }
    if (domains.size === 0) {
        return {
            ok: false,
            rules: [],
            diagnostics: [runtimeDiagnostic(
                'entity-rules.profile.domain.missing',
                `entity_rules profile has no form or table root: ${profile.name}`,
            )],
        };
    }

    const domain = [...domains][0];
    const diagnostics = profile.match.rules.flatMap((rule) => validateRuleMatch(profile.name, rule, domain));
    return {
        ok: diagnostics.length === 0,
        domain,
        rules: diagnostics.length === 0
            ? profile.match.rules.map((rule) => ({
                  ruleId: rule.ruleId,
                  source: rule.source,
                  expect: rule.expect,
                  within: rule.within,
                  match: structuredClone(rule.match),
              })) as Array<FormComponentMatchRule | TableComponentMatchRule>
            : [],
        diagnostics,
    };
};

const validateRuleMatch = (
    profileName: string,
    rule: EntityRuleMatchRecord,
    domain: EntityRuleProfileDomain,
): AnalysisDiagnostic[] => {
    const diagnostics: AnalysisDiagnostic[] = [];
    const allowedKeys = domain === 'table' ? TABLE_MATCH_KEYS : COMMON_MATCH_KEYS;
    const unsupported = Object.keys(rule.match).filter((key) => !allowedKeys.has(key));
    if (unsupported.length > 0) {
        diagnostics.push(runtimeDiagnostic(
            'entity-rules.profile.match.unsupported',
            `unsupported match conditions in ${profileName}/${rule.ruleId}: ${unsupported.join(', ')}`,
        ));
    }
    if (rule.match.kind !== undefined && rule.match.kind !== domain) {
        diagnostics.push(runtimeDiagnostic(
            'entity-rules.profile.domain.mixed',
            `rule ${profileName}/${rule.ruleId} targets ${String(rule.match.kind)} inside a ${domain} profile`,
        ));
    }
    for (const key of STRING_MATCH_KEYS) {
        const value = rule.match[key];
        if (value !== undefined && typeof value !== 'string') {
            diagnostics.push(runtimeDiagnostic(
                'entity-rules.profile.match.invalid',
                `match condition ${profileName}/${rule.ruleId}.${key} must be a string`,
            ));
        }
    }
    if (domain === 'table') {
        const relation = rule.match.relation;
        if (relation !== undefined && relation !== 'pagination') {
            diagnostics.push(runtimeDiagnostic(
                'entity-rules.profile.match.invalid',
                `match condition ${profileName}/${rule.ruleId}.relation is invalid`,
            ));
        }
        if (rule.match.keyHint !== undefined && !validKeyHint(rule.match.keyHint)) {
            diagnostics.push(runtimeDiagnostic(
                'entity-rules.profile.match.invalid',
                `match condition ${profileName}/${rule.ruleId}.keyHint is invalid`,
            ));
        }
    }
    return diagnostics;
};

const validKeyHint = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return false;}
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'headerContainsAll' && key !== 'primaryKeyCandidatesContains')) {
        return false;
    }
    return ['headerContainsAll', 'primaryKeyCandidatesContains'].every((key) => {
        const item = record[key];
        return item === undefined || (Array.isArray(item) && item.every((entry) => typeof entry === 'string'));
    });
};

const mapFormBindings = (
    bindings: Readonly<Record<string, FormComponentRuleBinding>>,
    annotationByRuleId: ReadonlyMap<string, EntityRuleAnnotationBinding>,
): Readonly<Record<string, EntityRuleRuntimeBinding>> => Object.fromEntries(
    Object.entries(bindings).map(([ruleId, binding]) => [ruleId, {
        ruleId,
        source: binding.source,
        expect: binding.expect,
        domain: 'form' as const,
        matchedComponentIds: [...binding.matchedComponentIds],
        matchedNodeIds: [...binding.matchedNodeIds],
        matchedFieldIds: [...binding.matchedFieldIds],
        matchedActionIds: [...binding.matchedActionIds],
        annotation: cloneAnnotation(annotationByRuleId.get(ruleId)),
        ok: binding.ok,
    }]),
);

const mapTableBindings = (
    bindings: Readonly<Record<string, TableComponentRuleBinding>>,
    annotationByRuleId: ReadonlyMap<string, EntityRuleAnnotationBinding>,
): Readonly<Record<string, EntityRuleRuntimeBinding>> => Object.fromEntries(
    Object.entries(bindings).map(([ruleId, binding]) => [ruleId, {
        ruleId,
        source: binding.source,
        expect: binding.expect,
        domain: 'table' as const,
        matchedComponentIds: [...binding.matchedComponentIds],
        matchedNodeIds: [...binding.matchedNodeIds],
        matchedRowIds: [...binding.matchedRowIds],
        matchedColumnIds: [...binding.matchedColumnIds],
        annotation: cloneAnnotation(annotationByRuleId.get(ruleId)),
        ok: binding.ok,
    }]),
);

const cloneAnnotation = (
    annotation: EntityRuleAnnotationBinding | undefined,
): EntityRuleAnnotationBinding | undefined => annotation ? structuredClone(annotation) : undefined;

const runtimeDiagnostic = (code: string, message: string): AnalysisDiagnostic => ({
    code,
    severity: 'error',
    stage: 'entity-rules-runtime',
    status: 'rejected',
    nodeIds: [],
    evidence: [],
    message,
});
