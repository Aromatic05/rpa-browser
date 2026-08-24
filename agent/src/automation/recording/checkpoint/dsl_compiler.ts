import {ActionError, ERROR_CODES} from '../../../interface/actions/results';
import {createDslEntityRulesResolver, createDslResolveResolver} from '../../../program/dsl/link';
import {validateDslSource} from '../../../program/dsl/runtime';
import {createWorkspaceEntityRulesProvider} from '../../snapshot/rules/runtime';
import {buildEntityRuleExportIndex} from '../../workflow';
import type {WorkspaceRouterInput} from '../../../app/runtime/workspace/router';
import type {StepResolve} from '../../runner/steps/types';
import type {CheckpointEntityRuleOption} from './types';

export type RecordedDslOperation =
    | {kind: 'entity'; action: 'fill' | 'type' | 'select'; member: string; value: string}
    | {kind: 'entity'; action: 'click'; member: string}
    | {kind: 'row_action'; actionIntent: string; primaryKey: string}
    | {kind: 'resolve'; action: 'fill' | 'type' | 'select'; symbol: string; value: string}
    | {kind: 'resolve'; action: 'click'; symbol: string}
    | {kind: 'snapshot'};

export const compileRecordedCheckpointDsl = (options: {
    workspace: WorkspaceRouterInput['workspace'];
    checkpointId: string;
    entity: CheckpointEntityRuleOption;
    operations: readonly RecordedDslOperation[];
    stepResolves: Record<string, StepResolve>;
    output?: 'table.currentRows' | 'table.rowCount';
}): string => {
    const artifact = options.workspace.workflow.get(options.entity.profileName, {kind: 'entity_rules'});
    if (artifact?.kind !== 'entity_rules') {
        throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, '所选业务标注不存在');
    }
    const exports = buildEntityRuleExportIndex(artifact);
    const entity = exports.index?.entities.find((candidate) => candidate.businessTag === options.entity.businessTag);
    if (!entity) {
        const details = exports.diagnostics.map((item) => item.message).join('; ');
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `所选业务区域无法生成稳定 DSL 引用${details ? `：${details}` : ''}`);
    }

    const hasResolve = options.operations.some((operation) => operation.kind === 'resolve');
    const lines = [
        `use entity_rules ${quote(options.entity.profileName)} as entity`,
        ...(hasResolve ? [`use resolves ${quote(options.checkpointId)} as recorded`] : []),
        ...options.operations.map((operation) => emitOperation(operation, entity.entityKey)),
        ...emitOutput(options.output, entity.entityKey),
    ];
    const source = lines.join('\n');
    const diagnostics = validateDslSource(
        source,
        createDslEntityRulesResolver(createWorkspaceEntityRulesProvider(options.workspace.workflow)),
        createDslResolveResolver(options.workspace.workflow, new Map([[options.checkpointId, options.stepResolves]])),
    ).diagnostics;
    if (diagnostics.length > 0) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `生成的检查点 DSL 无法链接：${diagnostics.map((item) => item.message).join('; ')}`);
    }
    return source;
};

const emitOperation = (operation: RecordedDslOperation, entityKey: string): string => {
    switch (operation.kind) {
        case 'entity':
            return operation.action === 'click'
                ? `click entity.${entityKey}.${identifier(operation.member)}`
                : `${operation.action} entity.${entityKey}.${identifier(operation.member)} with ${reference(operation.value)}`;
        case 'row_action':
            return `click entity.${entityKey}.row(${reference(operation.primaryKey)}).${identifier(operation.actionIntent)}`;
        case 'resolve':
            return operation.action === 'click'
                ? `click recorded.${identifier(operation.symbol)}`
                : `${operation.action} recorded.${identifier(operation.symbol)} with ${reference(operation.value)}`;
        case 'snapshot':
            return 'snapshot';
    }
};

const emitOutput = (output: 'table.currentRows' | 'table.rowCount' | undefined, entityKey: string): string[] => {
    if (!output) {return [];}
    const member = output === 'table.currentRows' ? 'currentRows' : 'rowCount';
    const name = output === 'table.currentRows' ? 'rows' : 'rowCount';
    return [`let checkpointOutput = query entity.${entityKey}.${member}`, `output ${name} = checkpointOutput`];
};

const identifier = (value: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `无法生成稳定 DSL 标识符：${value}`);
    }
    return value;
};

const reference = (value: string): string => {
    if (!/^(?:input|vars|output|failure)\.[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `无法生成稳定 DSL 引用：${value}`);
    }
    return value;
};

const quote = (value: string): string => JSON.stringify(value);
