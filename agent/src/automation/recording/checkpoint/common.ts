import {ActionError, ERROR_CODES} from '../../../interface/actions/results';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import type {StepEntityRulesControl} from '../../snapshot/rules/model';
import {isValidStepResolve, normalizeStepResolve} from '../../runner/steps/resolve_utils';
import type {EntityKind, StepName, StepResolve, StepUnion} from '../../runner/steps/types';
import type {WorkflowDummy} from '../../workflow';
import type {RecordingEnhancementMap} from '../types';
import type {CheckpointEntityRuleOption, CheckpointRecordKind, CheckpointRecordSavePayload} from './types';

const CHECKPOINT_DUMMY: WorkflowDummy = {kind: 'checkpoint'};
const CHECKPOINT_RESOLVE_STEPS: ReadonlySet<StepName> = new Set([
    'browser.take_screenshot',
    'browser.click',
    'browser.fill',
    'browser.type',
    'browser.select_option',
    'browser.hover',
    'browser.scroll',
    'browser.press_key',
]);

const checkpointIdBase = (name: string, kind: CheckpointRecordKind): string => {
    const ascii = name
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    const prefix = kind === 'procedure' ? 'procedure' : 'recovery';
    return ascii ? `${prefix}-${ascii}` : `${prefix}-${Date.now()}`;
};

export const uniqueCheckpointId = (
    workspace: WorkspaceRouterInput['workspace'],
    name: string,
    kind: CheckpointRecordKind,
): string => {
    const base = checkpointIdBase(name, kind);
    const existing = new Set(workspace.workflow.list(CHECKPOINT_DUMMY).map((item) => item.name));
    if (!existing.has(base)) {return base;}
    let suffix = 2;
    while (existing.has(`${base}-${suffix}`)) {suffix += 1;}
    return `${base}-${suffix}`;
};

export const validateCheckpointName = (
    workspace: WorkspaceRouterInput['workspace'],
    payload: CheckpointRecordSavePayload,
): string => {
    const name = (payload.name || '').trim();
    if (!name) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '检查点名称不能为空');}
    if (name.length > 80) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '检查点名称不能超过 80 个字符');
    }
    const duplicate = workspace.workflow.list(CHECKPOINT_DUMMY).some((item) => {
        const loaded = workspace.workflow.get(item.name, CHECKPOINT_DUMMY);
        return loaded?.kind === 'checkpoint' && (loaded.checkpoint.name || '').trim() === name;
    });
    if (duplicate) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '已有同名检查点，请换一个名称');
    }
    return name;
};

export const persistRecordedStep = (
    step: StepUnion,
    index: number,
    enrichments: RecordingEnhancementMap,
    stepResolves: Record<string, StepResolve>,
): StepUnion => {
    const args: Record<string, unknown> = structuredClone(step.args);
    const enhancement = Object.hasOwn(enrichments, step.id) ? enrichments[step.id] : undefined;
    const candidate = normalizeStepResolve(enhancement ? {
        hint: enhancement.resolveHint,
        policy: enhancement.resolvePolicy,
    } : undefined);
    if (candidate && isValidStepResolve(candidate) && CHECKPOINT_RESOLVE_STEPS.has(step.name)) {
        const resolveId = `recorded-${index + 1}`;
        args.resolveId = resolveId;
        stepResolves[resolveId] = candidate;
    }
    return {id: step.id, name: step.name, args, entityRules: step.entityRules} as StepUnion;
};

export const entityRuleControl = (option: CheckpointEntityRuleOption): StepEntityRulesControl => ({
    selection: 'explicit' as const,
    profiles: [option.profileName],
    strict: true,
});

export const entityCondition = (option: CheckpointEntityRuleOption): {
    query: string;
    kind: EntityKind;
    businessTag: string;
} => ({
    query: '',
    kind: option.entityKind,
    businessTag: option.businessTag,
});

export const semanticBelongsToOption = (
    semantic: {profileName?: string; businessTag?: string} | undefined,
    option: CheckpointEntityRuleOption,
): boolean => semantic?.profileName === option.profileName && semantic.businessTag === option.businessTag;
