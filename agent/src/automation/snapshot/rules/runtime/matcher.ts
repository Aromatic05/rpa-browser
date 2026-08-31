import type { EntityRuleConfig } from '../../../../platform/config';
import type {
    EntityRuleAnnotationBinding,
    WorkflowEntityRules,
} from '../../../workflow';
import type {ControlSnapshot} from '../../components/control/model/contracts';
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
import {
    buildSemanticLayer,
    createEmptySemanticLayer,
    type SemanticAnnotationRecord,
    type SemanticBindings,
    type SemanticSuggestions,
} from '../semantic';
import type { WorkspaceEntityRulesProvider } from './contracts';
import { resolveStepEntityRulesExecution } from './step_control';

export type EntityRuleProfileDomain = EntityRuleQueryDomain;

export type EntityRuleComponentSnapshots = {
    control?: ControlSnapshot;
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
    semanticBindings: SemanticBindings;
    semanticSuggestions: SemanticSuggestions;
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
    pageUrl?: string;
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

    const applicableProfiles = resolution.profiles.filter((profileName) => {
        const profile = provider.getProfile(profileName);
        return profile !== null && profileAppliesToUrl(profile, input.pageUrl);
    });
    const profiles: Record<string, EntityRuleProfileMatchResult> = {};
    const diagnostics: AnalysisDiagnostic[] = [];
    let invalid = false;
    for (const profileName of applicableProfiles) {
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
        selectedProfiles: applicableProfiles,
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
        domain: inferEntityRuleProfileDomain(profile),
        rules: profile.match.rules,
    });
    if (!compiled.ok) {
        const semanticLayer = createEmptySemanticLayer();
        return {
            invalid: true,
            result: {
                profileName: profile.name,
                domain: inferEntityRuleProfileDomain(profile),
                bindings: {},
                semanticBindings: semanticLayer.bindings,
                semanticSuggestions: semanticLayer.suggestions,
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
    const semanticLayer = buildSemanticLayer({
        execution,
        annotations: profile.annotation.bindings.map(toSemanticAnnotation),
        snapshots: compiled.plan.domain === 'form'
            ? {form: snapshots.form}
            : compiled.plan.domain === 'table'
                ? {table: snapshots.table}
                : {control: snapshots.control},
    });
    const snapshotMissing = execution.diagnostics.some((diagnostic) => diagnostic.code === 'query-plan.snapshot.missing');
    const semanticInvalid = Object.values(semanticLayer.bindings.byId).some((binding) =>
        binding.disposition === 'active' && binding.status === 'invalidated');
    const diagnostics = [
        ...semanticLayer.bindings.diagnostics,
        ...semanticLayer.suggestions.diagnostics,
    ];
    return {
        invalid: snapshotMissing || semanticInvalid,
        result: {
            profileName: profile.name,
            domain: compiled.plan.domain,
            bindings,
            semanticBindings: semanticLayer.bindings,
            semanticSuggestions: semanticLayer.suggestions,
            diagnostics,
            ok: execution.ok && !semanticInvalid,
        },
    };
};

export const inferEntityRuleProfileDomain = (profile: WorkflowEntityRules): EntityRuleProfileDomain => {
    if (profile.page?.kind === 'form' || profile.page?.kind === 'table') {return profile.page.kind;}
    if (profile.page) {return 'node';}
    if (profile.match.rules.some((rule) => rule.match.kind === 'table')) {return 'table';}
    if (profile.match.rules.some((rule) => rule.match.kind === 'form')) {return 'form';}
    return 'node';
};

const profileAppliesToUrl = (profile: WorkflowEntityRules, pageUrl: string | undefined): boolean => {
    const pattern = profile.page?.urlPattern;
    if (!pattern) {return true;}
    if (!pageUrl) {return false;}
    return new RegExp(pattern).test(pageUrl);
};

const toSemanticAnnotation = (annotation: EntityRuleAnnotationBinding): SemanticAnnotationRecord =>
    structuredClone(annotation);

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
