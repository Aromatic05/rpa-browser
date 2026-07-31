import type { Workflow, WorkflowEntityRules } from '../../../workflow';
import type { WorkspaceEntityRulesProvider } from './contracts';

export const createWorkspaceEntityRulesProvider = (
    workflow: Workflow,
): WorkspaceEntityRulesProvider => {
    const getProfile = (profileName: string): WorkflowEntityRules | null => {
        const artifact = workflow.get(profileName, { kind: 'entity_rules' });
        return artifact?.kind === 'entity_rules' ? artifact : null;
    };
    return {
        availability: 'ready',
        workflowName: workflow.name,
        listProfiles: () => workflow.list({ kind: 'entity_rules' })
            .map((item) => item.name)
            .filter((name) => getProfile(name) !== null)
            .sort((left, right) => left.localeCompare(right)),
        getProfile,
    };
};
