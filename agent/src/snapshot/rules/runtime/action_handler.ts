import { replyAction } from '../../../actions/action_protocol';
import { ActionError, ERROR_CODES } from '../../../actions/results';
import type { ControlPlaneResult } from '../../../runtime/control_plane';
import type { WorkspaceRouterInput } from '../../../runtime/workspace/router';
import type {
    EntityRuleAnnotationArtifact,
    EntityRuleMatchArtifact,
    Workflow,
    WorkflowEntityRules,
} from '../../../workflow';
import type { WorkspaceEntityRulesProvider } from './contracts';
import { createWorkspaceEntityRulesProvider } from './provider';
import { executeEntityRules, type ExecuteEntityRulesInput, type EntityRulesExecutionResult } from './matcher';
import { executeEntityRulesOnPage } from './capture';

export type EntityRulesAnnotatorPort = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

export type CreateEntityRulesRuntimeOptions = {
    annotator?: EntityRulesAnnotatorPort;
};

export type EntityRulesRuntime = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
    getProvider: (workflow: Workflow) => WorkspaceEntityRulesProvider;
    execute: (input: ExecuteEntityRulesInput) => EntityRulesExecutionResult;
    executePage: typeof executeEntityRulesOnPage;
};

export const createEntityRulesRuntime = (
    options: CreateEntityRulesRuntimeOptions = {},
): EntityRulesRuntime => ({
    getProvider: (workflow) => createWorkspaceEntityRulesProvider(workflow),
    execute: executeEntityRules,
    executePage: executeEntityRulesOnPage,
    handle: async (routerInput) => {
        const {action, workspace} = routerInput;
        const payload = (action.payload ?? {}) as Record<string, unknown>;
        switch (action.type) {
            case 'entity_rules.list':
                return {
                    reply: replyAction(action, {
                        profiles: workspace.workflow.list({ kind: 'entity_rules' }),
                    }),
                    events: [],
                };
            case 'entity_rules.get': {
                const profileName = requireProfileName(payload);
                const profile = workspace.workflow.get(profileName, { kind: 'entity_rules' });
                if (profile?.kind !== 'entity_rules') {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `entity_rules profile not found: ${profileName}`);
                }
                return {
                    reply: replyAction(action, { profile }),
                    events: [],
                };
            }
            case 'entity_rules.save': {
                const profileName = requireProfileName(payload);
                const saved = workspace.workflow.save({
                    kind: 'entity_rules',
                    name: profileName,
                    page: payload.page as WorkflowEntityRules['page'],
                    match: payload.match as EntityRuleMatchArtifact,
                    annotation: payload.annotation as EntityRuleAnnotationArtifact,
                } satisfies WorkflowEntityRules);
                if (saved.kind !== 'entity_rules') {
                    throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'workflow returned a non-entity_rules artifact');
                }
                return {
                    reply: replyAction(action, { profileName: saved.name, profile: saved }),
                    events: [],
                };
            }
            case 'entity_rules.delete': {
                const profileName = requireProfileName(payload);
                const exists = workspace.workflow.get(profileName, { kind: 'entity_rules' });
                if (!exists) {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `entity_rules profile not found: ${profileName}`);
                }
                const deleted = workspace.workflow.delete(profileName, { kind: 'entity_rules' });
                return {
                    reply: replyAction(action, { profileName, deleted }),
                    events: [],
                };
            }
            default:
                if (action.type.startsWith('entity_rules.annotator.')) {
                    if (!options.annotator) {
                        throw new ActionError(
                            ERROR_CODES.ERR_NOT_IMPLEMENTED,
                            `entity_rules annotator controller is unavailable: ${action.type}`,
                            {actionType: action.type},
                        );
                    }
                    return await options.annotator.handle(routerInput);
                }
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        }
    },
});

const requireProfileName = (payload: Readonly<Record<string, unknown>>): string => {
    const profileName = typeof payload.profileName === 'string' ? payload.profileName.trim() : '';
    if (!profileName) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'profileName is required');
    }
    return profileName;
};
