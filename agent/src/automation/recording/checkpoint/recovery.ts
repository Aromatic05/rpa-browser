import {ActionError, ERROR_CODES} from '../../../interface/actions/results';
import type {WorkspaceRouterInput} from '../../../app/runtime/workspace/router';
import type {Checkpoint, MatchRule} from '../../runner/checkpoint';
import type {StepName, StepResolve, StepUnion} from '../../runner/steps/types';
import type {WorkflowCheckpoint} from '../../workflow';
import type {RecordingEnhancementMap} from '../types';
import {entityCondition, entityRuleControl, persistRecordedStep, semanticBelongsToOption, uniqueCheckpointId, validateCheckpointName} from './common';
import {compileRecordedCheckpointDsl, type RecordedDslOperation} from './dsl_compiler';
import {requireCheckpointEntityRuleOption} from './options';
import {recordedValue} from './summary';
import type {CheckpointEntityRuleOption, CheckpointRecordSavePayload} from './types';
import {normalizeText} from './value';

export const buildRecordedRecoveryCheckpoint = (
    workspace: WorkspaceRouterInput['workspace'], steps: readonly StepUnion[], enrichments: RecordingEnhancementMap, payload: CheckpointRecordSavePayload,
): WorkflowCheckpoint => {
    const name = validateCheckpointName(workspace, payload);
    validateRecoveryPayload(payload);
    const option = requireCheckpointEntityRuleOption(workspace, '', payload);
    const checkpointId = uniqueCheckpointId(workspace, name, 'recovery');
    const input: Record<string, unknown> = {};
    const stepResolves: Record<string, StepResolve> = {};
    const operations = steps.map((step, index) => {
        const semantic = semanticHintsForStep(step.id, enrichments);
        if (semantic && semanticBelongsToOption(semantic, option)) {
            const operation = semanticOperation(step, index, option, semantic, input);
            if (operation) {return operation;}
        }
        return fallbackOperation(step, index, enrichments, stepResolves, input);
    });
    const checkpoint: Checkpoint = {
        id: checkpointId, kind: 'recovery', name, input,
        trigger: {matchRules: recoveryTriggerRules(option, payload), entityRules: entityRuleControl(option)},
        body: {language: 'dsl', source: 'body.dsl'},
        policy: {maxAttempts: 1, retryOriginal: payload.retryOriginal !== false}, enabled: true, priority: 0,
    };
    const bodyDsl = compileRecordedCheckpointDsl({workspace, checkpointId, entity: option, operations, stepResolves});
    return {kind: 'checkpoint', name: checkpointId, checkpoint, stepResolves, hints: {}, bodyDsl};
};

const recoveryTriggerRules = (option: CheckpointEntityRuleOption, payload: CheckpointRecordSavePayload): MatchRule[] => {
    const rules: MatchRule[] = [{entityExists: entityCondition(option)}];
    const value = (payload.triggerValue || '').trim();
    if (payload.triggerKind === 'not_found') {rules.push({errorCode: 'ERR_NOT_FOUND'});}
    if (payload.triggerKind === 'text_visible') {if (!value) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '触发文字不能为空');} rules.push({textVisible: value});}
    if (payload.triggerKind === 'url_includes') {if (!value) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '地址内容不能为空');} rules.push({urlIncludes: value});}
    const names: Partial<Record<NonNullable<CheckpointRecordSavePayload['operation']>, StepName>> = {click: 'browser.click', fill: 'browser.fill', select: 'browser.select_option', assert: 'browser.assert'};
    const name = payload.operation && payload.operation !== 'any' ? names[payload.operation] : undefined;
    if (name) {rules.push({stepName: name});}
    return rules;
};

const validateRecoveryPayload = (payload: CheckpointRecordSavePayload): void => {
    if (payload.triggerKind !== undefined && !new Set(['not_found', 'text_visible', 'url_includes']).has(payload.triggerKind)) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '触发条件无效');}
    if (payload.operation !== undefined && !new Set(['any', 'click', 'fill', 'select', 'assert']).has(payload.operation)) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '适用操作无效');}
    if (payload.retryOriginal !== undefined && typeof payload.retryOriginal !== 'boolean') {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '重试设置无效');}
    if ((payload.triggerValue || '').trim().length > 160) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '触发内容不能超过 160 个字符');}
};

const semanticOperation = (step: StepUnion, index: number, option: CheckpointEntityRuleOption, semantic: {fieldKey?: string; actionIntent?: string}, input: Record<string, unknown>): RecordedDslOperation | null => {
    if (['browser.fill', 'browser.type', 'browser.select_option'].includes(step.name)) {
        const fieldKey = normalizeText(semantic.fieldKey);
        if (!fieldKey || !option.fields.some((field) => field.fieldKey === fieldKey)) {return null;}
        const key = `recordedValue${String(index + 1)}`;
        input[key] = structuredClone(recordedValue(step));
        return {kind: 'entity', action: actionForStep(step), member: fieldKey, value: `input.${key}`};
    }
    if (step.name === 'browser.click') {
        const actionIntent = normalizeText(semantic.actionIntent);
        return actionIntent && option.actions.some((action) => action.actionIntent === actionIntent)
            ? {kind: 'entity', action: 'click', member: actionIntent}
            : null;
    }
    return null;
};

const fallbackOperation = (step: StepUnion, index: number, enrichments: RecordingEnhancementMap, resolves: Record<string, StepResolve>, input: Record<string, unknown>): RecordedDslOperation => {
    if (step.name === 'browser.snapshot') {return {kind: 'snapshot'};}
    const persisted = persistRecordedStep(step, index, enrichments, resolves);
    const resolveId = (persisted.args as {resolveId?: unknown}).resolveId;
    if (typeof resolveId !== 'string') {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `不支持将录制步骤 ${step.name} 生成为稳定 DSL；请先标注业务语义或提供元素解析`);}
    const symbol = `step${String(index + 1)}`;
    resolves[symbol] = resolves[resolveId];
    delete resolves[resolveId];
    if (step.name === 'browser.click') {return {kind: 'resolve', action: 'click', symbol};}
    if (step.name === 'browser.fill' || step.name === 'browser.type' || step.name === 'browser.select_option') {
        const key = `recordedValue${String(index + 1)}`;
        input[key] = structuredClone(recordedValue(step));
        return {kind: 'resolve', action: actionForStep(step), symbol, value: `input.${key}`};
    }
    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `不支持将录制步骤 ${step.name} 生成为稳定 DSL`);
};

const actionForStep = (step: StepUnion): 'fill' | 'type' | 'select' => {
    if (step.name === 'browser.fill') {return 'fill';}
    if (step.name === 'browser.type') {return 'type';}
    if (step.name === 'browser.select_option') {return 'select';}
    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '恢复输入步骤类型无效');
};

const semanticHintsForStep = (stepId: string, enrichments: RecordingEnhancementMap) => {
    const enhancement = Object.hasOwn(enrichments, stepId) ? enrichments[stepId] : undefined;
    return enhancement ? enhancement.semanticHints ?? enhancement.target?.semanticHints : undefined;
};
