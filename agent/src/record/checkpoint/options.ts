import {ActionError, ERROR_CODES} from '../../interface/actions/results';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import {
    entityRuleProfileApplies,
    projectEntityRuleEntities,
} from '../../snapshot/rules/runtime/presentation';
import type {WorkflowDummy} from '../../workflow';
import type {CheckpointEntityRuleOption} from './types';
import {normalizeText} from './value';

const ENTITY_RULE_DUMMY: WorkflowDummy = {kind: 'entity_rules'};

export const checkpointEntityRuleOptions = (
    workspace: WorkspaceRouterInput['workspace'],
    pageUrl: string,
): CheckpointEntityRuleOption[] => workspace.workflow
    .list(ENTITY_RULE_DUMMY)
    .flatMap((item) => {
        const artifact = workspace.workflow.get(item.name, ENTITY_RULE_DUMMY);
        if (artifact?.kind !== 'entity_rules' || !entityRuleProfileApplies(artifact, pageUrl)) {return [];}
        return projectEntityRuleEntities(artifact).map((entity) => ({
            profileName: entity.profileName,
            businessTag: entity.businessTag,
            entityKind: entity.entityKind,
            label: entity.label,
            fields: entity.fields,
            actions: entity.actions,
            rowActions: entity.rowActions,
            ...(entity.primaryKey ? {primaryKey: entity.primaryKey} : {}),
            outputs: entity.entityKind === 'table'
                ? [
                    {kind: 'none', label: '无'},
                    {kind: 'table.currentRows', label: '当前列表数据'},
                    {kind: 'table.rowCount', label: '当前列表行数'},
                ]
                : [{kind: 'none', label: '无'}],
        } satisfies CheckpointEntityRuleOption));
    });

export const requireCheckpointEntityRuleOption = (
    workspace: WorkspaceRouterInput['workspace'],
    pageUrl: string,
    selection: {profileName?: unknown; businessTag?: unknown; entityKind?: unknown},
): CheckpointEntityRuleOption => {
    const profileName = normalizeText(selection.profileName);
    const businessTag = normalizeText(selection.businessTag);
    if (!profileName || !businessTag) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '请选择要高亮和录制的业务区域');
    }
    const option = checkpointEntityRuleOptions(workspace, pageUrl).find((candidate) =>
        candidate.profileName === profileName
        && candidate.businessTag === businessTag
        && (!selection.entityKind || candidate.entityKind === selection.entityKind));
    if (!option) {
        throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, '所选业务标注在当前页面不可用');
    }
    return option;
};
