import type { WorkflowManifest, WorkflowWorkspaceBinding } from './types';

type ValidationResult<T> = { ok: true; value: T } | { ok: false; diagnostics: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const validateWorkflowManifest = (raw: unknown): ValidationResult<WorkflowManifest> => {
    const diagnostics: string[] = [];
    if (!isRecord(raw)) {
        return { ok: false, diagnostics: ['workflow manifest must be an object'] };
    }
    if (raw.version !== 1) {
        diagnostics.push('workflow.version must be 1');
    }
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
        diagnostics.push('workflow.id is required');
    }
    if (!isRecord(raw.entry) || typeof raw.entry.dsl !== 'string' || raw.entry.dsl.length === 0) {
        diagnostics.push('workflow.entry.dsl is required');
    }
    if (isRecord(raw.entry) && raw.entry.inputs !== undefined && typeof raw.entry.inputs !== 'string') {
        diagnostics.push('workflow.entry.inputs must be a string path');
    }
    if (raw.inputs !== undefined) {
        diagnostics.push('workflow.inputs is not allowed; use workflow.entry.inputs');
    }
    if (raw.records !== undefined && (!Array.isArray(raw.records) || raw.records.some((item) => typeof item !== 'string'))) {
        diagnostics.push('workflow.records must be an array of string paths');
    }
    if (raw.checkpoints !== undefined && (!Array.isArray(raw.checkpoints) || raw.checkpoints.some((item) => typeof item !== 'string'))) {
        diagnostics.push('workflow.checkpoints must be an array of string paths');
    }
    if (raw.workspace !== undefined) {
        if (!isRecord(raw.workspace)) {
            diagnostics.push('workflow.workspace must be an object');
        } else if (raw.workspace.binding !== undefined && typeof raw.workspace.binding !== 'string') {
            diagnostics.push('workflow.workspace.binding must be a string path');
        }
    }
    if (diagnostics.length > 0) {
        return { ok: false, diagnostics };
    }
    return { ok: true, value: raw as WorkflowManifest };
};

export const validateWorkflowWorkspaceBinding = (raw: unknown): ValidationResult<WorkflowWorkspaceBinding> => {
    const diagnostics: string[] = [];
    if (!isRecord(raw)) {
        return { ok: false, diagnostics: ['workspace binding must be an object'] };
    }
    if (raw.version !== 1) {
        diagnostics.push('workspace binding version must be 1');
    }
    if (!isRecord(raw.workspace)) {
        diagnostics.push('workspace config is required');
    } else {
        if (!['restoreOrCreate', 'createOnly', 'restoreOnly'].includes(String(raw.workspace.strategy || ''))) {
            diagnostics.push('workspace.strategy must be restoreOrCreate | createOnly | restoreOnly');
        }
        if (raw.workspace.entryUrl !== undefined && typeof raw.workspace.entryUrl !== 'string') {
            diagnostics.push('workspace.entryUrl must be a string');
        }
        if (raw.workspace.expectedTabs !== undefined) {
            if (!Array.isArray(raw.workspace.expectedTabs)) {
                diagnostics.push('workspace.expectedTabs must be an array');
            } else {
                for (const tab of raw.workspace.expectedTabs) {
                    if (!isRecord(tab) || typeof tab.ref !== 'string' || tab.ref.length === 0) {
                        diagnostics.push('workspace.expectedTabs[].ref is required');
                        continue;
                    }
                    if (tab.urlIncludes !== undefined && typeof tab.urlIncludes !== 'string') {
                        diagnostics.push('workspace.expectedTabs[].urlIncludes must be a string');
                    }
                    if (tab.exactUrl !== undefined && typeof tab.exactUrl !== 'string') {
                        diagnostics.push('workspace.expectedTabs[].exactUrl must be a string');
                    }
                }
            }
        }
    }
    if (diagnostics.length > 0) {
        return { ok: false, diagnostics };
    }
    return { ok: true, value: raw as WorkflowWorkspaceBinding };
};
