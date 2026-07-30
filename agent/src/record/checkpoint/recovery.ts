import {ActionError, ERROR_CODES} from '../../actions/results';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import type {Checkpoint, MatchRule} from '../../runner/checkpoint';
import type {CheckpointAction} from '../../runner/checkpoint/types';
import type {StepName, StepResolve, StepUnion} from '../../runner/steps/types';
import type {WorkflowCheckpoint} from '../../workflow';
import type {RecordingEnhancementMap} from '../types';
import {
    entityCondition,
    entityRuleControl,
    persistRecordedStep,
    semanticBelongsToOption,
    uniqueCheckpointId,
    validateCheckpointName,
} from './common';
import {requireCheckpointEntityRuleOption} from './options';
import type {CheckpointEntityRuleOption, CheckpointRecordSavePayload} from './types';
import {normalizeText} from './value';

export const buildRecordedRecoveryCheckpoint = (
    workspace: WorkspaceRouterInput['workspace'],
    steps: readonly StepUnion[],
    enrichments: RecordingEnhancementMap,
    payload: CheckpointRecordSavePayload,
): WorkflowCheckpoint => {
    const name = validateCheckpointName(workspace, payload);
    validateRecoveryPayload(payload);
    const option = requireCheckpointEntityRuleOption(workspace, '', payload);
    const checkpointId = uniqueCheckpointId(workspace, name, 'recovery');
    const entityRules = entityRuleControl(option);
    const stepResolves: Record<string, StepResolve> = {};
    const content: Array<StepUnion | CheckpointAction> = [];

    steps.forEach((step, index) => {
        const enhancement = Object.hasOwn(enrichments, step.id) ? enrichments[step.id] : undefined;
        const semantic = enhancement
            ? enhancement.semanticHints ?? enhancement.target?.semanticHints
            : undefined;
        if (semantic && semanticBelongsToOption(semantic, option)) {
            const semanticContent = recoverySemanticContent(step, index, option, semantic);
            if (semanticContent) {
                content.push(...semanticContent);
                return;
            }
        }
        const persisted = persistRecordedStep(step, index, enrichments, stepResolves);
        content.push({...persisted, entityRules: persisted.entityRules ?? entityRules});
    });

    const checkpoint: Checkpoint = {
        id: checkpointId,
        kind: 'recovery',
        name,
        trigger: {matchRules: recoveryTriggerRules(option, payload), entityRules},
        content,
        policy: {
            maxAttempts: 1,
            retryOriginal: payload.retryOriginal !== false,
            stopOnFailure: true,
        },
        enabled: true,
        priority: 0,
    };
    return {kind: 'checkpoint', name: checkpointId, checkpoint, stepResolves, hints: {}};
};

const recoveryTriggerRules = (
    option: CheckpointEntityRuleOption,
    payload: CheckpointRecordSavePayload,
): MatchRule[] => {
    const rules: MatchRule[] = [{entityExists: entityCondition(option)}];
    const kind = payload.triggerKind;
    const value = (payload.triggerValue || '').trim();
    if (kind === 'not_found') {
        rules.push({errorCode: 'ERR_NOT_FOUND'});
    } else if (kind === 'text_visible') {
        if (!value) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '触发文字不能为空');}
        rules.push({textVisible: value});
    } else if (kind === 'url_includes') {
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

const validateRecoveryPayload = (payload: CheckpointRecordSavePayload): void => {
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
};

const recoverySemanticContent = (
    step: StepUnion,
    index: number,
    option: CheckpointEntityRuleOption,
    semantic: {fieldKey?: string; actionIntent?: string},
): CheckpointAction[] | null => {
    const entityRules = entityRuleControl(option);
    const localKey = `target${String(index + 1)}`;
    if (['browser.fill', 'browser.type', 'browser.select_option'].includes(step.name)) {
        const fieldKey = normalizeText(semantic.fieldKey);
        const field = option.fields.find((candidate) => candidate.fieldKey === fieldKey);
        if (!field) {return null;}
        return [
            {
                type: 'query',
                args: {
                    op: 'entity.target',
                    businessTag: option.businessTag,
                    target: {kind: field.targetKind, fieldKey: field.fieldKey},
                },
                entityRules,
                saveAs: localKey,
            },
            {
                type: 'act',
                step: {
                    name: step.name as 'browser.fill' | 'browser.type' | 'browser.select_option',
                    args: fixedInputArgs(step, localKey),
                    entityRules,
                },
            },
        ];
    }
    if (step.name === 'browser.click') {
        const actionIntent = normalizeText(semantic.actionIntent);
        const action = option.actions.find((candidate) => candidate.actionIntent === actionIntent);
        if (!action) {return null;}
        return [
            {
                type: 'query',
                args: {
                    op: 'entity.target',
                    businessTag: option.businessTag,
                    target: {kind: action.targetKind, actionIntent: action.actionIntent},
                },
                entityRules,
                saveAs: localKey,
            },
            {
                type: 'act',
                step: {
                    name: 'browser.click',
                    args: {nodeId: {ref: `local.${localKey}.nodeId`}} as never,
                    entityRules,
                },
            },
        ];
    }
    return null;
};

const fixedInputArgs = (step: StepUnion, localKey: string): Record<string, unknown> => {
    const nodeId = {ref: `local.${localKey}.nodeId`};
    if (step.name === 'browser.fill') {return {nodeId, value: structuredClone(step.args.value)};}
    if (step.name === 'browser.type') {return {nodeId, text: structuredClone(step.args.text)};}
    if (step.name === 'browser.select_option') {
        return {nodeId, kind: step.args.kind, values: structuredClone(step.args.values)};
    }
    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '恢复输入步骤类型无效');
};
