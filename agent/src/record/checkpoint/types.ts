import type {EntityKind, StepName} from '../../runner/steps/types';

export type CheckpointRecordKind = 'procedure' | 'recovery';
export type CheckpointProcedureOutputKind = 'none' | 'table.currentRows' | 'table.rowCount';

export type CheckpointProcedureMapping =
    | {stepId: string; kind: 'input'; fieldKey: string}
    | {stepId: string; kind: 'action'; actionIntent: string}
    | {
        stepId: string;
        kind: 'row_action';
        actionIntent: string;
        primaryKeyFieldKey: string;
        inputKey: string;
    };

export type CheckpointRecordSavePayload = {
    kind?: CheckpointRecordKind;
    name?: string;
    profileName?: string;
    businessTag?: string;
    entityKind?: EntityKind;
    mappings?: readonly CheckpointProcedureMapping[];
    outputKind?: CheckpointProcedureOutputKind;
    triggerKind?: 'not_found' | 'text_visible' | 'url_includes';
    triggerValue?: string;
    operation?: 'any' | 'click' | 'fill' | 'select' | 'assert';
    retryOriginal?: boolean;
};

export type CheckpointEntityRuleField = {
    fieldKey: string;
    label: string;
    targetKind: 'entity.field' | 'form.field' | 'table.filter';
};

export type CheckpointEntityRuleAction = {
    actionIntent: string;
    label: string;
    targetKind: 'entity.action' | 'form.action' | 'table.module_action';
};

export type CheckpointEntityRuleRowAction = {
    actionIntent: string;
    label: string;
    targetKind: 'table.row_action';
};

export type CheckpointEntityRulePrimaryKey = {
    fieldKey: string;
    label: string;
};

export type CheckpointEntityRuleOutput = {
    kind: CheckpointProcedureOutputKind;
    label: string;
};

export type CheckpointEntityRuleOption = {
    profileName: string;
    businessTag: string;
    entityKind: EntityKind;
    label: string;
    fields: CheckpointEntityRuleField[];
    actions: CheckpointEntityRuleAction[];
    rowActions: CheckpointEntityRuleRowAction[];
    primaryKey?: CheckpointEntityRulePrimaryKey;
    outputs: CheckpointEntityRuleOutput[];
};

export type CheckpointRecordedStepSummary = {
    index: number;
    stepId: string;
    stepName: StepName;
    label: string;
    recordedValue?: unknown;
    profileName?: string;
    businessTag?: string;
    fieldKey?: string;
    fieldHint?: string;
    actionHint?: string;
    actionRole?: 'row';
    rowPrimaryKey?: {fieldKey: string; value: string};
};
