import {ActionError, ERROR_CODES} from '../../actions/results';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import type {Checkpoint} from '../../runner/checkpoint';
import type {CheckpointAction} from '../../runner/checkpoint/types';
import type {StepResolve, StepUnion} from '../../runner/steps/types';
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
import {recordedValue} from './summary';
import type {
    CheckpointEntityRuleOption,
    CheckpointProcedureMapping,
    CheckpointRecordSavePayload,
} from './types';
import {normalizeText} from './value';

export const buildRecordedProcedureCheckpoint = (
    workspace: WorkspaceRouterInput['workspace'],
    steps: readonly StepUnion[],
    enrichments: RecordingEnhancementMap,
    payload: CheckpointRecordSavePayload,
): WorkflowCheckpoint => {
    const name = validateCheckpointName(workspace, payload);
    const option = requireCheckpointEntityRuleOption(workspace, '', payload);
    const mappings = validateProcedureMappings(
        steps,
        option,
        mergeProcedureMappings(
            inferProcedureMappings(steps, enrichments, option),
            payload.mappings ?? [],
        ),
    );
    const checkpointId = uniqueCheckpointId(workspace, name, 'procedure');
    const entityRules = entityRuleControl(option);
    const input: Record<string, unknown> = {};
    const content: CheckpointAction[] = [];
    const stepResolves: Record<string, StepResolve> = {};

    steps.forEach((step, index) => {
        const mapping = mappings.get(step.id);
        if (mapping?.kind === 'input') {
            const field = option.fields.find((candidate) => candidate.fieldKey === mapping.fieldKey)!;
            const localKey = `target${String(index + 1)}`;
            content.push({
                type: 'query',
                args: {
                    op: 'entity.target',
                    businessTag: option.businessTag,
                    target: {kind: field.targetKind, fieldKey: field.fieldKey},
                },
                entityRules,
                saveAs: localKey,
            });
            const value = recordedValue(step);
            if (!Object.hasOwn(input, field.fieldKey)) {input[field.fieldKey] = structuredClone(value);}
            content.push({
                type: 'act',
                step: {
                    name: step.name as 'browser.fill' | 'browser.type' | 'browser.select_option',
                    args: parameterizedInputArgs(step, localKey, field.fieldKey),
                    entityRules,
                },
            });
            return;
        }
        if (mapping?.kind === 'action') {
            const action = option.actions.find((candidate) => candidate.actionIntent === mapping.actionIntent)!;
            const localKey = `target${String(index + 1)}`;
            content.push({
                type: 'query',
                args: {
                    op: 'entity.target',
                    businessTag: option.businessTag,
                    target: {kind: action.targetKind, actionIntent: action.actionIntent},
                },
                entityRules,
                saveAs: localKey,
            });
            content.push({
                type: 'act',
                step: {
                    name: 'browser.click',
                    args: {nodeId: {ref: `local.${localKey}.nodeId`}} as never,
                    entityRules,
                },
            });
            return;
        }
        const persisted = persistRecordedStep(step, index, enrichments, stepResolves);
        content.push({
            type: 'act',
            step: {
                name: persisted.name as Exclude<StepUnion['name'], 'browser.checkpoint'>,
                args: persisted.args,
                entityRules: persisted.entityRules ?? entityRules,
            },
        });
    });

    const outputKind = payload.outputKind ?? 'none';
    let output: Checkpoint['output'];
    if (outputKind !== 'none') {
        if (option.entityKind !== 'table') {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '当前业务区域不支持该输出');
        }
        content.push({
            type: 'query',
            args: {op: 'entity', businessTag: option.businessTag, query: outputKind},
            entityRules,
            saveAs: 'checkpointOutput',
        });
        output = outputKind === 'table.currentRows'
            ? {rows: {ref: 'local.checkpointOutput.value'}}
            : {rowCount: {ref: 'local.checkpointOutput.value'}};
    }

    const condition = entityCondition(option);
    const checkpoint: Checkpoint = {
        id: checkpointId,
        kind: 'procedure',
        name,
        input,
        trigger: {matchRules: [{entityExists: condition}], entityRules},
        prepare: [{
            type: 'act',
            step: {
                name: 'browser.assert',
                args: {entityExists: condition},
                entityRules,
            },
        }],
        content,
        ...(output ? {output} : {}),
        policy: {stopOnFailure: true},
        enabled: true,
        priority: 0,
    };
    return {kind: 'checkpoint', name: checkpointId, checkpoint, stepResolves, hints: {}};
};

const inferProcedureMappings = (
    steps: readonly StepUnion[],
    enrichments: RecordingEnhancementMap,
    option: CheckpointEntityRuleOption,
): CheckpointProcedureMapping[] => {
    const result: CheckpointProcedureMapping[] = [];
    for (const step of steps) {
        const enhancement = Object.hasOwn(enrichments, step.id) ? enrichments[step.id] : undefined;
        const semantic = enhancement
            ? enhancement.semanticHints ?? enhancement.target?.semanticHints
            : undefined;
        if (!semanticBelongsToOption(semantic, option)) {continue;}
        if (['browser.fill', 'browser.type', 'browser.select_option'].includes(step.name)) {
            const fieldKey = normalizeText(semantic?.fieldKey);
            if (fieldKey && option.fields.some((field) => field.fieldKey === fieldKey)) {
                result.push({stepId: step.id, kind: 'input', fieldKey});
            }
            continue;
        }
        if (step.name === 'browser.click') {
            const actionIntent = normalizeText(semantic?.actionIntent);
            if (actionIntent && option.actions.some((action) => action.actionIntent === actionIntent)) {
                result.push({stepId: step.id, kind: 'action', actionIntent});
            }
        }
    }
    return result;
};

const mergeProcedureMappings = (
    inferred: readonly CheckpointProcedureMapping[],
    overrides: readonly CheckpointProcedureMapping[],
): CheckpointProcedureMapping[] => {
    const merged = new Map<string, CheckpointProcedureMapping>();
    for (const mapping of inferred) {merged.set(mapping.stepId, structuredClone(mapping));}
    for (const mapping of overrides) {merged.set(mapping.stepId, structuredClone(mapping));}
    return [...merged.values()];
};

const validateProcedureMappings = (
    steps: readonly StepUnion[],
    option: CheckpointEntityRuleOption,
    mappings: readonly CheckpointProcedureMapping[],
): Map<string, CheckpointProcedureMapping> => {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const result = new Map<string, CheckpointProcedureMapping>();
    for (const mapping of mappings) {
        const step = byId.get(mapping.stepId);
        if (!step || result.has(mapping.stepId)) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '检查点步骤映射无效');
        }
        if (mapping.kind === 'input') {
            if (!['browser.fill', 'browser.type', 'browser.select_option'].includes(step.name)) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '只有填写和选择操作可以作为输入');
            }
            if (!option.fields.some((field) => field.fieldKey === mapping.fieldKey)) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '输入字段不属于所选业务区域');
            }
        } else {
            if (step.name !== 'browser.click') {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '只有点击操作可以映射为业务操作');
            }
            if (!option.actions.some((action) => action.actionIntent === mapping.actionIntent)) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '业务操作不属于所选业务区域');
            }
        }
        result.set(mapping.stepId, structuredClone(mapping));
    }
    return result;
};

const parameterizedInputArgs = (
    step: StepUnion,
    localKey: string,
    inputKey: string,
): Record<string, unknown> => {
    const nodeId = {ref: `local.${localKey}.nodeId`};
    const input = {ref: `input.${inputKey}`};
    if (step.name === 'browser.fill') {return {nodeId, value: input};}
    if (step.name === 'browser.type') {return {nodeId, text: input};}
    if (step.name === 'browser.select_option') {
        return {nodeId, kind: step.args.kind, values: input};
    }
    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '输入步骤类型无效');
};
