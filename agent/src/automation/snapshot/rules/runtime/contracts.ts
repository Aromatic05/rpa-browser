import type { EntityRuleExportResolution, WorkflowEntityRules } from '../../../workflow';

export type EntityRulesAvailability = 'ready';

export type WorkspaceEntityRulesProvider = {
    availability: EntityRulesAvailability;
    workflowName: string;
    listProfiles: () => string[];
    getProfile: (profileName: string) => WorkflowEntityRules | null;
    resolveExports: (profileName: string) => EntityRuleExportResolution;
};
