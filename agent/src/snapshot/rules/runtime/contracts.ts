export type EntityRulesAvailability = 'not-implemented';

export type WorkspaceEntityRulesProvider = {
    availability: EntityRulesAvailability;
    workflowName: string;
    reason: string;
};
