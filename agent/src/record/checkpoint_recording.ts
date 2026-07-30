import {ActionError, ERROR_CODES} from '../actions/results';
import type {WorkspaceRouterInput} from '../runtime/workspace/router';
import type {Checkpoint, MatchRule} from '../runner/checkpoint';
import {isValidStepResolve, normalizeStepResolve} from '../runner/steps/resolve_utils';
import type {StepName, StepResolve, StepUnion} from '../runner/steps/types';
import type {WorkflowCheckpoint, WorkflowDummy} from '../workflow';
import type {RecordingEnhancementMap} from './types';

const CHECKPOINT_DUMMY: WorkflowDummy = {kind: 'checkpoint'};

export type CheckpointRecordSavePayload = {
    name?: string;
    triggerKind?: 'not_found' | 'text_visible' | 'url_includes';
    triggerValue?: string;
    operation?: 'any' | 'click' | 'fill' | 'select' | 'assert';
    retryOriginal?: boolean;
};

const RECORDED_STEP_LABELS: Partial<Record<StepName, string>> = {
    'browser.goto': '打开页面',
    'browser.reload': '刷新页面',
    'browser.click': '点击',
    'browser.fill': '填写',
    'browser.type': '输入',
    'browser.select_option': '选择',
    'browser.press_key': '按键',
    'browser.scroll': '滚动',
    'browser.hover': '悬停',
    'browser.drag_and_drop': '拖动',
};

export const checkpointStepSummary = (steps: readonly StepUnion[]): Array<{
    index: number;
    label: string;
}> => steps.map((step, index) => ({
    index: index + 1,
    label: RECORDED_STEP_LABELS[step.name] || '页面操作',
}));

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

const checkpointIdBase = (name: string): string => {
    const ascii = name
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    return ascii ? `recovery-${ascii}` : `recovery-${Date.now()}`;
};

const uniqueCheckpointId = (
    workspace: WorkspaceRouterInput['workspace'],
    name: string,
): string => {
    const base = checkpointIdBase(name);
    const existing = new Set(workspace.workflow.list(CHECKPOINT_DUMMY).map((item) => item.name));
    if (!existing.has(base)) {return base;}
    let suffix = 2;
    while (existing.has(`${base}-${suffix}`)) {suffix += 1;}
    return `${base}-${suffix}`;
};

const checkpointTriggerRules = (payload: CheckpointRecordSavePayload): MatchRule[] => {
    const rules: MatchRule[] = [];
    const kind = payload.triggerKind || 'not_found';
    const value = (payload.triggerValue || '').trim();
    if (kind === 'not_found') {
        rules.push({errorCode: 'ERR_NOT_FOUND'});
    } else if (kind === 'text_visible') {
        if (!value) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '触发文字不能为空');}
        rules.push({textVisible: value});
    } else {
        if (!value) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '地址内容不能为空');}
        rules.push({urlIncludes: value});
    }
    const operation: Partial<Record<NonNullable<CheckpointRecordSavePayload['operation']>, StepName>> = {
        click: 'browser.click',
        fill: 'browser.fill',
        select: 'browser.select_option',
        assert: 'browser.assert',
    };
    const stepName = payload.operation && payload.operation !== 'any'
        ? operation[payload.operation]
        : undefined;
    if (stepName) {rules.push({stepName});}
    return rules;
};

const validateCheckpointRecordPayload = (
    workspace: WorkspaceRouterInput['workspace'],
    payload: CheckpointRecordSavePayload,
): void => {
    const name = (payload.name || '').trim();
    if (!name) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '恢复步骤名称不能为空');}
    if (name.length > 80) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '恢复步骤名称不能超过 80 个字符');
    }
    const triggerKinds = new Set(['not_found', 'text_visible', 'url_includes']);
    if (payload.triggerKind !== undefined && !triggerKinds.has(payload.triggerKind)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '触发条件无效');
    }
    const operations = new Set(['any', 'click', 'fill', 'select', 'assert']);
    if (payload.operation !== undefined && !operations.has(payload.operation)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '适用操作无效');
    }
    if (payload.retryOriginal !== undefined && typeof payload.retryOriginal !== 'boolean') {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '重试设置无效');
    }
    if ((payload.triggerValue || '').trim().length > 160) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '触发内容不能超过 160 个字符');
    }
    const duplicate = workspace.workflow.list(CHECKPOINT_DUMMY).some((item) => {
        const loaded = workspace.workflow.get(item.name, CHECKPOINT_DUMMY);
        return loaded?.kind === 'checkpoint' && (loaded.checkpoint.name || '').trim() === name;
    });
    if (duplicate) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '已有同名恢复步骤，请换一个名称');
    }
};

export const buildRecordedCheckpoint = (
    workspace: WorkspaceRouterInput['workspace'],
    steps: readonly StepUnion[],
    enrichments: RecordingEnhancementMap,
    payload: CheckpointRecordSavePayload,
): WorkflowCheckpoint => {
    validateCheckpointRecordPayload(workspace, payload);
    const name = (payload.name || '').trim();
    if (!steps.length) {
        throw new ActionError(ERROR_CODES.ERR_RECORDING_EMPTY, '没有录制到恢复操作');
    }
    const checkpointId = uniqueCheckpointId(workspace, name);
    const stepResolves: Record<string, StepResolve> = {};
    const content = steps.map((step, index) => {
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
        return {
            id: step.id,
            name: step.name,
            args,
            entityRules: step.entityRules,
        } as StepUnion;
    });
    const checkpoint: Checkpoint = {
        id: checkpointId,
        kind: 'recovery',
        name,
        trigger: {matchRules: checkpointTriggerRules(payload)},
        content,
        policy: {
            maxAttempts: 1,
            retryOriginal: payload.retryOriginal !== false,
            stopOnFailure: true,
        },
        enabled: true,
        priority: 0,
    };
    return {
        kind: 'checkpoint',
        name: checkpointId,
        checkpoint,
        stepResolves,
        hints: {},
    };
};
