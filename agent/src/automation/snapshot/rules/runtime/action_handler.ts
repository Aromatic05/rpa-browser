import { replyAction } from '../../../../interface/actions/action_protocol';
import { ActionError, ERROR_CODES } from '../../../../interface/actions/results';
import type { ControlPlaneResult } from '../../../runtime/control_plane';
import type { WorkspaceRouterInput } from '../../../runtime/workspace/router';
import {
    entityRulesArtifactRevision,
    validateWorkflowEntityRules,
    type Workflow,
    type WorkflowEntityRules,
} from '../../../workflow';
import {
    compileEntityRuleQueryPlan,
} from '../query';
import type { WorkspaceEntityRulesProvider } from './contracts';
import { createWorkspaceEntityRulesProvider } from './provider';
import {
    executeEntityRules,
    inferEntityRuleProfileDomain,
    type ExecuteEntityRulesInput,
    type EntityRulesExecutionResult,
} from './matcher';
import { executeEntityRulesOnPage } from './capture';
import {
    projectEntityRuleProfileSummary,
    projectEntityRuleProfileView,
} from './presentation';

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

const requireExecutableProfile = (value: unknown): WorkflowEntityRules => {
    const profile = validateWorkflowEntityRules(value);
    const compiled = compileEntityRuleQueryPlan({
        profileName: profile.name,
        domain: inferEntityRuleProfileDomain(profile),
        rules: profile.match.rules,
    });
    if (!compiled.ok) {
        throw new ActionError(
            ERROR_CODES.ERR_BAD_ARGS,
            `entity_rules profile is not executable: ${profile.name}`,
            {diagnostics: compiled.diagnostics},
        );
    }
    return profile;
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
                {
                    const profiles = workspace.workflow.list({ kind: 'entity_rules' });
                return {
                    reply: replyAction(action, {
                            profiles,
                            rules: profiles.map((item) => {
                                const profile = workspace.workflow.get(item.name, {kind: 'entity_rules'});
                                return profile?.kind === 'entity_rules'
                                    ? projectEntityRuleProfileSummary(profile)
                                    : {
                                        profileName: item.name,
                                        label: item.title || item.name,
                                        entityCount: 0,
                                        status: 'invalid' as const,
                                        error: '规则文件无效或迁移失败',
                                    };
                            }),
                    }),
                    events: [],
                };
                }
            case 'entity_rules.get': {
                const profileName = requireProfileName(payload);
                const profile = workspace.workflow.get(profileName, { kind: 'entity_rules' });
                if (profile?.kind !== 'entity_rules') {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `entity_rules profile not found: ${profileName}`);
                }
                return {
                    reply: replyAction(action, {
                        view: projectEntityRuleProfileView(profile),
                        artifactRevision: entityRulesArtifactRevision(profile),
                    }),
                    events: [],
                };
            }
            case 'entity_rules.save': {
                const profileName = requireProfileName(payload);
                const expectedRevision = readExpectedRevision(payload.expectedRevision);
                const profile = requireExecutableProfile({
                    kind: 'entity_rules',
                    name: profileName,
                    page: payload.page,
                    match: payload.match,
                    annotation: payload.annotation,
                });
                const saved = workspace.workflow.save(profile, {expectedRevision});
                if (saved.kind !== 'entity_rules') {
                    throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'workflow returned a non-entity_rules artifact');
                }
                return {
                    reply: replyAction(action, {
                        profileName: saved.name,
                        profile: saved,
                        artifactRevision: entityRulesArtifactRevision(saved),
                    }),
                    events: [],
                };
            }
            case 'entity_rules.delete': {
                const profileName = requireProfileName(payload);
                const exists = workspace.workflow.get(profileName, { kind: 'entity_rules' });
                if (!exists) {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `entity_rules profile not found: ${profileName}`);
                }
                const deleted = workspace.workflow.delete(
                    profileName,
                    { kind: 'entity_rules' },
                    {expectedRevision: readExpectedRevision(payload.expectedRevision)},
                );
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

const readExpectedRevision = (value: unknown): string | null | undefined => {
    if (value === undefined) {return undefined;}
    if (value === null) {return null;}
    if (typeof value !== 'string' || value.length === 0) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'expectedRevision must be a non-empty string or null');
    }
    return value;
};
