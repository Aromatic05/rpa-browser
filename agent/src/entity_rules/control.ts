import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { ControlPlaneResult } from '../runtime/control';
import type { WorkspaceControlInput } from '../runtime/workspace_control';
import type { WorkflowEntityRules } from '../workflow';
import { createWorkspaceEntityRulesRuntime } from './runtime';

export type EntityRulesControl = {
    handle: (input: WorkspaceControlInput) => Promise<ControlPlaneResult>;
};

const requireProfileName = (payload: Record<string, unknown>): string => {
    const profileName = typeof payload.profileName === 'string' ? payload.profileName.trim() : '';
    if (!profileName) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'profileName is required');
    }
    return profileName;
};

const requireEntityRulesArtifact = (payload: Record<string, unknown>): WorkflowEntityRules => {
    const artifact = payload.entityRules as WorkflowEntityRules | undefined;
    if (!artifact || artifact.kind !== 'entity_rules' || typeof artifact.name !== 'string' || !artifact.name.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'entityRules payload is required');
    }
    return artifact;
};

export const createEntityRulesControl = (): EntityRulesControl => ({
    handle: async (input) => {
        const { action, workspace } = input;
        if (!action.type.startsWith('entity_rules.')) {
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        }

        const runtime = createWorkspaceEntityRulesRuntime(workspace.workflow);
        const payload = (action.payload || {}) as Record<string, unknown>;

        if (action.type === 'entity_rules.list') {
            const profiles = runtime.list();
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    entityRules: profiles,
                }),
                events: [],
            };
        }

        if (action.type === 'entity_rules.get') {
            const profileName = requireProfileName(payload);
            const artifact = runtime.get(profileName);
            if (!artifact) {
                throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `entity_rules not found: ${profileName}`);
            }
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    profileName,
                    entityRules: artifact,
                }),
                events: [],
            };
        }

        if (action.type === 'entity_rules.save') {
            const artifact = requireEntityRulesArtifact(payload);
            const saved = runtime.save(artifact);
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    profileName: saved.name,
                    entityRules: saved,
                    saved: true,
                }),
                events: [],
            };
        }

        if (action.type === 'entity_rules.delete') {
            const profileName = requireProfileName(payload);
            runtime.delete(profileName);
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    profileName,
                    deleted: true,
                }),
                events: [],
            };
        }

        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
});
