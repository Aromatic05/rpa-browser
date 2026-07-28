import { ActionError, ERROR_CODES } from '../../../actions/results';
import type { ControlPlaneResult } from '../../../runtime/control_plane';
import type { WorkspaceRouterInput } from '../../../runtime/workspace/router';
import type { Workflow } from '../../../workflow';
import type { WorkspaceEntityRulesProvider } from './contracts';
import { createWorkspaceEntityRulesProvider } from './provider';

export type EntityRulesRuntime = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
    getProvider: (workflow: Workflow) => WorkspaceEntityRulesProvider;
};

export const createEntityRulesRuntime = (): EntityRulesRuntime => ({
    getProvider: (workflow) => createWorkspaceEntityRulesProvider(workflow),
    handle: async ({ action }) => {
        if (!action.type.startsWith('entity_rules.')) {
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        }
        throw new ActionError(
            ERROR_CODES.ERR_NOT_IMPLEMENTED,
            `entity_rules action is not implemented on Snapshot V2: ${action.type}`,
            { actionType: action.type },
        );
    },
});
