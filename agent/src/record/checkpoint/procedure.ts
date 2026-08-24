import {ActionError, ERROR_CODES} from '../../interface/actions/results';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import type {Checkpoint} from '../../runner/checkpoint';
import type {StepResolve, StepUnion} from '../../runner/steps/types';
import type {WorkflowCheckpoint} from '../../workflow';
import type {RecordingEnhancementMap} from '../types';
import {persistRecordedStep, entityCondition, entityRuleControl, semanticBelongsToOption, uniqueCheckpointId, validateCheckpointName} from './common';
import {compileRecordedCheckpointDsl, type RecordedDslOperation} from './dsl_compiler';
import {requireCheckpointEntityRuleOption} from './options';
import {recordedValue} from './summary';
import type {CheckpointEntityRuleOption, CheckpointProcedureMapping, CheckpointRecordSavePayload} from './types';
import {normalizeText} from './value';

export const buildRecordedProcedureCheckpoint = (
    workspace: WorkspaceRouterInput['workspace'], steps: readonly StepUnion[], enrichments: RecordingEnhancementMap, payload: CheckpointRecordSavePayload,
): WorkflowCheckpoint => {
    const name = validateCheckpointName(workspace, payload);
    const option = requireCheckpointEntityRuleOption(workspace, '', payload);
    const mappings = validateProcedureMappings(steps, option, mergeProcedureMappings(inferProcedureMappings(steps, enrichments, option), payload.mappings ?? []));
    const checkpointId = uniqueCheckpointId(workspace, name, 'procedure');
    const input: Record<string, unknown> = {};
    const stepResolves: Record<string, StepResolve> = {};
    const operations: RecordedDslOperation[] = [];

    steps.forEach((step, index) => {
        const mapping = mappings.get(step.id);
        if (mapping?.kind === 'input') {
            if (!Object.hasOwn(input, mapping.fieldKey)) {input[mapping.fieldKey] = structuredClone(recordedValue(step));}
            operations.push({kind: 'entity', action: actionForStep(step), member: mapping.fieldKey, value: `input.${mapping.fieldKey}`});
            return;
        }
        if (mapping?.kind === 'action') {
            operations.push({kind: 'entity', action: 'click', member: mapping.actionIntent});
            return;
        }
        if (mapping?.kind === 'row_action') {
            const semantic = semanticHintsForStep(step.id, enrichments);
            if (!Object.hasOwn(input, mapping.inputKey)) {
                input[mapping.inputKey] = semantic?.rowPrimaryKey?.fieldKey === mapping.primaryKeyFieldKey ? semantic.rowPrimaryKey.value : '';
            }
            operations.push({kind: 'row_action', actionIntent: mapping.actionIntent, primaryKey: `input.${mapping.inputKey}`});
            return;
        }
        if (step.name === 'browser.scroll' && mappings.size > 0) {return;}
        operations.push(fallbackOperation(step, index, enrichments, stepResolves, input));
    });

    const output = payload.outputKind === 'none' || payload.outputKind === undefined ? undefined : payload.outputKind;
    if (output && option.entityKind !== 'table') {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '当前业务区域不支持该输出');}
    const checkpoint: Checkpoint = {
        id: checkpointId, kind: 'procedure', name, input,
        trigger: {matchRules: [{entityExists: entityCondition(option)}], entityRules: entityRuleControl(option)},
        body: {language: 'dsl', source: 'body.dsl'}, enabled: true, priority: 0,
    };
    const bodyDsl = compileRecordedCheckpointDsl({workspace, checkpointId, entity: option, operations, stepResolves, output});
    return {kind: 'checkpoint', name: checkpointId, checkpoint, stepResolves, hints: {}, bodyDsl};
};

const actionForStep = (step: StepUnion): 'fill' | 'type' | 'select' => {
    if (step.name === 'browser.fill') {return 'fill';}
    if (step.name === 'browser.type') {return 'type';}
    if (step.name === 'browser.select_option') {return 'select';}
    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '输入步骤类型无效');
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

const inferProcedureMappings = (steps: readonly StepUnion[], enrichments: RecordingEnhancementMap, option: CheckpointEntityRuleOption): CheckpointProcedureMapping[] => steps.flatMap<CheckpointProcedureMapping>((step) => {
    const semantic = semanticHintsForStep(step.id, enrichments);
    if (!semanticBelongsToOption(semantic, option)) {return [];}
    if (['browser.fill', 'browser.type', 'browser.select_option'].includes(step.name) && normalizeText(semantic?.fieldKey) && option.fields.some((field) => field.fieldKey === semantic!.fieldKey)) {
        return [{stepId: step.id, kind: 'input' as const, fieldKey: semantic!.fieldKey!}];
    }
    if (step.name === 'browser.click' && semantic?.actionRole === 'row' && semantic.actionIntent && semantic.rowPrimaryKey && option.primaryKey?.fieldKey === semantic.rowPrimaryKey.fieldKey && option.rowActions.some((action) => action.actionIntent === semantic.actionIntent)) {
        return [{stepId: step.id, kind: 'row_action' as const, actionIntent: semantic.actionIntent, primaryKeyFieldKey: semantic.rowPrimaryKey.fieldKey, inputKey: semantic.rowPrimaryKey.fieldKey}];
    }
    if (step.name === 'browser.click' && normalizeText(semantic?.actionIntent) && option.actions.some((action) => action.actionIntent === semantic!.actionIntent)) {
        return [{stepId: step.id, kind: 'action' as const, actionIntent: semantic!.actionIntent!}];
    }
    return [];
});

const mergeProcedureMappings = (inferred: readonly CheckpointProcedureMapping[], overrides: readonly CheckpointProcedureMapping[]): CheckpointProcedureMapping[] => {
    const result = new Map<string, CheckpointProcedureMapping>();
    for (const mapping of inferred) {result.set(mapping.stepId, structuredClone(mapping));}
    for (const mapping of overrides) {result.set(mapping.stepId, structuredClone(mapping));}
    return [...result.values()];
};

const validateProcedureMappings = (steps: readonly StepUnion[], option: CheckpointEntityRuleOption, mappings: readonly CheckpointProcedureMapping[]): Map<string, CheckpointProcedureMapping> => {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const result = new Map<string, CheckpointProcedureMapping>();
    for (const mapping of mappings) {
        const step = byId.get(mapping.stepId);
        if (!step || result.has(mapping.stepId)) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '检查点步骤映射无效');}
        if (mapping.kind === 'input' && (!['browser.fill', 'browser.type', 'browser.select_option'].includes(step.name) || !option.fields.some((field) => field.fieldKey === mapping.fieldKey))) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '输入字段不属于所选业务区域');}
        if (mapping.kind === 'action' && (step.name !== 'browser.click' || !option.actions.some((action) => action.actionIntent === mapping.actionIntent))) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '业务操作不属于所选业务区域');}
        if (mapping.kind === 'row_action' && (step.name !== 'browser.click' || option.entityKind !== 'table' || mapping.primaryKeyFieldKey !== option.primaryKey?.fieldKey || !option.rowActions.some((action) => action.actionIntent === mapping.actionIntent) || !normalizeText(mapping.inputKey))) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '行操作映射无效');}
        result.set(mapping.stepId, structuredClone(mapping));
    }
    return result;
};

const semanticHintsForStep = (stepId: string, enrichments: RecordingEnhancementMap) => {
    const enhancement = Object.hasOwn(enrichments, stepId) ? enrichments[stepId] : undefined;
    return enhancement ? enhancement.semanticHints ?? enhancement.target?.semanticHints : undefined;
};
