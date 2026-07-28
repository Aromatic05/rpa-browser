import type { Workflow } from '../../../workflow';
import type { WorkspaceEntityRulesProvider } from './contracts';

export const createWorkspaceEntityRulesProvider = (
    workflow: Workflow,
): WorkspaceEntityRulesProvider => ({
    availability: 'not-implemented',
    workflowName: workflow.name,
    reason: 'Snapshot V2 entity_rules provider is not implemented',
});
