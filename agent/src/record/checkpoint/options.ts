import {ActionError, ERROR_CODES} from '../../actions/results';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import type {EntityKind} from '../../runner/steps/types';
import type {WorkflowDummy, WorkflowEntityRules} from '../../workflow';
import type {
    CheckpointEntityRuleAction,
    CheckpointEntityRuleField,
    CheckpointEntityRuleOption,
} from './types';
import {isRecord, normalizeText, readEntityKind, uniqueBy} from './value';

const ENTITY_RULE_DUMMY: WorkflowDummy = {kind: 'entity_rules'};

export const checkpointEntityRuleOptions = (
    workspace: WorkspaceRouterInput['workspace'],
    pageUrl: string,
): CheckpointEntityRuleOption[] => workspace.workflow
    .list(ENTITY_RULE_DUMMY)
    .flatMap((item) => {
        const artifact = workspace.workflow.get(item.name, ENTITY_RULE_DUMMY);
        if (artifact?.kind !== 'entity_rules' || !profileApplies(artifact, pageUrl)) {return [];}
        return entityOptionsFromProfile(artifact);
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

const profileApplies = (profile: WorkflowEntityRules, pageUrl: string): boolean => {
    const pattern = profile.page?.urlPattern;
    if (!pattern || !pageUrl) {return true;}
    try {
        return new RegExp(pattern).test(pageUrl);
    } catch {
        return false;
    }
};

const entityOptionsFromProfile = (profile: WorkflowEntityRules): CheckpointEntityRuleOption[] => {
    const roots = profile.annotation.bindings.filter((binding) => normalizeText(binding.businessTag));
    return roots.flatMap((root) => {
        const businessTag = normalizeText(root.businessTag);
        if (!businessTag) {return [];}
        const legacyEntity = findLegacyEntity(root.legacyCanvas, businessTag);
        const entityKind = readEntityKind(legacyEntity?.kind ?? profile.page?.kind);
        if (!entityKind) {return [];}
        const fields = legacyEntity
            ? legacyFields(legacyEntity, entityKind)
            : fallbackFields(profile, entityKind);
        const actions = legacyEntity
            ? legacyActions(legacyEntity, entityKind)
            : fallbackActions(profile, entityKind);
        const label = normalizeText(root.displayName)
            ?? normalizeText(root.businessName)
            ?? normalizeText(legacyEntity?.name)
            ?? profile.name;
        return [{
            profileName: profile.name,
            businessTag,
            entityKind,
            label,
            fields: uniqueBy(fields, (item) => item.fieldKey),
            actions: uniqueBy(actions, (item) => item.actionIntent),
            outputs: entityKind === 'table'
                ? [
                    {kind: 'none', label: '无'},
                    {kind: 'table.currentRows', label: '当前列表数据'},
                    {kind: 'table.rowCount', label: '当前列表行数'},
                ]
                : [{kind: 'none', label: '无'}],
        } satisfies CheckpointEntityRuleOption];
    });
};

const findLegacyEntity = (value: unknown, businessTag: string): Record<string, unknown> | null => {
    if (!isRecord(value) || !Array.isArray(value.entities)) {return null;}
    const entities = value.entities.filter(isRecord);
    return entities.find((entity) => entity.businessTag === businessTag) ?? entities.at(0) ?? null;
};

const legacyFields = (
    entity: Record<string, unknown>,
    entityKind: EntityKind,
): CheckpointEntityRuleField[] => {
    if (!Array.isArray(entity.annotations)) {return [];}
    return entity.annotations.filter(isRecord).flatMap((annotation) => {
        if (annotation.type !== 'field' || annotation.disposition === 'ignored') {return [];}
        const fieldKey = normalizeText(annotation.businessKey);
        if (!fieldKey) {return [];}
        return [{
            fieldKey,
            label: normalizeText(annotation.name) ?? fieldKey,
            targetKind: fieldTargetKind(entityKind),
        } satisfies CheckpointEntityRuleField];
    });
};

const legacyActions = (
    entity: Record<string, unknown>,
    entityKind: EntityKind,
): CheckpointEntityRuleAction[] => {
    if (!Array.isArray(entity.annotations)) {return [];}
    return entity.annotations.filter(isRecord).flatMap((annotation) => {
        if (annotation.type !== 'action' || annotation.disposition === 'ignored') {return [];}
        const actionIntent = normalizeText(annotation.businessKey);
        if (!actionIntent) {return [];}
        return [{
            actionIntent,
            label: normalizeText(annotation.name) ?? actionIntent,
            targetKind: actionTargetKind(entityKind),
        } satisfies CheckpointEntityRuleAction];
    });
};

const fallbackFields = (
    profile: WorkflowEntityRules,
    entityKind: EntityKind,
): CheckpointEntityRuleField[] => profile.annotation.bindings.flatMap((binding) => {
    const fieldKey = normalizeText(binding.fieldKey);
    if (!fieldKey) {return [];}
    return [{
        fieldKey,
        label: normalizeText(binding.fieldName) ?? fieldKey,
        targetKind: fieldTargetKind(entityKind),
    } satisfies CheckpointEntityRuleField];
});

const fallbackActions = (
    profile: WorkflowEntityRules,
    entityKind: EntityKind,
): CheckpointEntityRuleAction[] => profile.annotation.bindings.flatMap((binding) => {
    const actionIntent = normalizeText(binding.actionIntent);
    if (!actionIntent) {return [];}
    return [{
        actionIntent,
        label: normalizeText(binding.actionText) ?? actionIntent,
        targetKind: actionTargetKind(entityKind),
    } satisfies CheckpointEntityRuleAction];
});

const fieldTargetKind = (kind: EntityKind): CheckpointEntityRuleField['targetKind'] =>
    kind === 'table' ? 'table.filter' : kind === 'form' ? 'form.field' : 'entity.field';

const actionTargetKind = (kind: EntityKind): CheckpointEntityRuleAction['targetKind'] =>
    kind === 'table' ? 'table.module_action' : kind === 'form' ? 'form.action' : 'entity.action';
