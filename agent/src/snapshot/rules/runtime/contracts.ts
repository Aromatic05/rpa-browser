import type { WorkflowEntityRules } from '../../../workflow';

export type EntityRulesAvailability = 'ready';

export type WorkspaceEntityRulesProvider = {
    availability: EntityRulesAvailability;
    workflowName: string;
    listProfiles: () => string[];
    getProfile: (profileName: string) => WorkflowEntityRules | null;
};
