import type { EntityRuleConfig } from '../../../config';
import type {
    EntityRuleAnnotationBinding,
    WorkflowEntityRules,
} from '../../../workflow';
import type { FormSnapshot } from '../../components/form/model/contracts';
import type { TableSnapshot } from '../../components/table/model/contracts';
import type { AnalysisDiagnostic } from '../../observation/model/contracts';
import { deepFreeze } from '../../observation/model/freeze';
import {
    compileEntityRuleQueryPlan,
    executeEntityRuleQueryPlan,
    type EntityRuleQueryBinding,
    type EntityRuleQueryDomain,
} from '../query';
import type { StepEntityRulesControl } from '../model/selection';
import type { WorkspaceEntityRulesProvider } from './contracts';
import { resolveStepEntityRulesExecution } from './step_control';

export type EntityRuleProfileDomain = EntityRuleQueryDomain;

export type EntityRuleComponentSnapshots = {
    form?: FormSnapshot;
    table?: TableSnapshot;
};

export type EntityRuleRuntimeBinding = EntityRuleQueryBinding & {
    annotation?: EntityRuleAnnotationBinding;
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
        const matched = executeEntityRuleProfile(profile, input.snapshots);
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

const executeEntityRuleProfile = (
    profile: WorkflowEntityRules,
    snapshots: EntityRuleComponentSnapshots,
): { result: EntityRuleProfileMatchResult; invalid: boolean } => {
    const compiled = compileEntityRuleQueryPlan({
        profileName: profile.name,
        rules: profile.match.rules,
    });
    if (!compiled.ok) {
        return {
            invalid: true,
            result: {
                profileName: profile.name,
                domain: inferProfileDomain(profile),
                bindings: {},
                diagnostics: compiled.diagnostics,
                ok: false,
            },
        };
    }

    const execution = executeEntityRuleQueryPlan(compiled.plan, snapshots, { purpose: 'runtime' });
    const annotationByRuleId = new Map(profile.annotation.bindings.map((binding) => [binding.ruleId, binding]));
    const bindings = Object.fromEntries(Object.entries(execution.byRuleId).map(([ruleId, binding]) => [ruleId, {
        ...structuredClone(binding),
        annotation: cloneAnnotation(annotationByRuleId.get(ruleId)),
    }]));
    const snapshotMissing = execution.diagnostics.some((diagnostic) => diagnostic.code === 'query-plan.snapshot.missing');
    return {
        invalid: snapshotMissing,
        result: {
            profileName: profile.name,
            domain: compiled.plan.domain,
            bindings,
            diagnostics: execution.diagnostics,
            ok: execution.ok,
        },
    };
};

const inferProfileDomain = (profile: WorkflowEntityRules): EntityRuleProfileDomain =>
    profile.match.rules.some((rule) => rule.match.kind === 'table') ? 'table' : 'form';

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
