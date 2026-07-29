import {replyAction} from '../../actions/action_protocol';
import {ActionError, ERROR_CODES} from '../../actions/results';
import type {ControlPlaneResult} from '../../runtime/control_plane';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import {
    buildAnnotatorProjection,
    resolveAnnotatorPoint,
    type AnnotatorCheckReply,
    type AnnotatorDraft,
    type AnnotatorPickPayload,
    type AnnotatorPickReply,
    type AnnotatorProjectionReply,
    type AnnotatorSaveReply,
} from '../../snapshot/annotator';
import type {EntityRulesAnnotatorPort} from '../../snapshot/rules/runtime/action_handler';
import type {WorkflowEntityRules} from '../../workflow';
import type {RunStepsDeps} from '../run_steps_types';
import {ensureFreshPageSession} from '../session/capture';
import {
    evaluateAnnotatorDraft,
    projectAnnotatorEvaluation,
    workflowProfileToAnnotatorDraft,
} from './draft';

export type CreateRunnerAnnotatorControllerInput = {
    runStepsDeps: RunStepsDeps;
};

export const createRunnerAnnotatorController = (
    input: CreateRunnerAnnotatorControllerInput,
): EntityRulesAnnotatorPort => ({
    handle: async ({action, workspace}) => {
        const payload = requirePayload(action.payload);
        switch (action.type) {
            case 'entity_rules.annotator.open':
                assertAllowedKeys(payload, ['profileName']);
                return await projectReply(input.runStepsDeps, {action, workspace}, false, optionalProfileName(payload));
            case 'entity_rules.annotator.visualize':
                assertAllowedKeys(payload, ['profileName']);
                return await projectReply(input.runStepsDeps, {action, workspace}, true, optionalProfileName(payload));
            case 'entity_rules.annotator.recognize':
                assertAllowedKeys(payload, ['profileName', 'refresh']);
                assertOptionalBoolean(payload.refresh, 'refresh');
                return await projectReply(input.runStepsDeps, {action, workspace}, true, optionalProfileName(payload));
            case 'entity_rules.annotator.pick':
                assertAllowedKeys(payload, ['point']);
                return await pickReply(input.runStepsDeps, {action, workspace}, requirePoint(payload));
            case 'entity_rules.annotator.check':
                assertAllowedKeys(payload, ['draft']);
                return await checkReply(input.runStepsDeps, {action, workspace}, requireDraft(payload));
            case 'entity_rules.annotator.save':
                assertAllowedKeys(payload, ['draft']);
                return await saveReply(input.runStepsDeps, {action, workspace}, requireDraft(payload));
            default:
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported annotator action: ${action.type}`);
        }
    },
});

const projectReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    explicit: boolean,
    profileName: string | undefined,
): Promise<ControlPlaneResult> => {
    const {entry, binding} = await ensureFreshPageSession(deps, input.workspace.name, {explicit});
    const profile = profileName
        ? requireProfile(input.workspace.workflow.get(profileName, {kind: 'entity_rules'}), profileName)
        : undefined;
    const evaluation = profile
        ? evaluateAnnotatorDraft(entry, workflowProfileToAnnotatorDraft(profile), 'check')
        : undefined;
    const projectionEntry = evaluation ? projectAnnotatorEvaluation(entry, evaluation) : entry;
    const projection = buildAnnotatorProjection(
        projectionEntry,
        deps.pageSession.readSelection(binding.page),
    );
    const payload: AnnotatorProjectionReply = {
        projection,
        profile,
        validation: evaluation?.validation,
    };
    return {reply: replyAction(input.action, payload), events: []};
};

const checkReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    draft: AnnotatorDraft,
): Promise<ControlPlaneResult> => {
    const {entry, binding} = await ensureFreshPageSession(deps, input.workspace.name);
    const evaluation = evaluateAnnotatorDraft(entry, draft, 'check');
    const projection = buildAnnotatorProjection(
        projectAnnotatorEvaluation(entry, evaluation),
        deps.pageSession.readSelection(binding.page),
    );
    const payload: AnnotatorCheckReply = {projection, validation: evaluation.validation};
    return {reply: replyAction(input.action, payload), events: []};
};

const saveReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    draft: AnnotatorDraft,
): Promise<ControlPlaneResult> => {
    const current = await ensureFreshPageSession(deps, input.workspace.name);
    const checked = evaluateAnnotatorDraft(current.entry, draft, 'save');
    if (!checked.validation.ok || !checked.profile) {
        throw new ActionError(
            ERROR_CODES.ERR_BAD_ARGS,
            'annotator draft validation failed',
            {validation: checked.validation},
        );
    }
    const saved = input.workspace.workflow.save(checked.profile);
    if (saved.kind !== 'entity_rules') {
        throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'workflow returned a non-entity_rules artifact');
    }

    const refreshed = await ensureFreshPageSession(deps, input.workspace.name, {explicit: true});
    const reopened = evaluateAnnotatorDraft(
        refreshed.entry,
        workflowProfileToAnnotatorDraft(saved),
        'check',
    );
    const projection = buildAnnotatorProjection(
        projectAnnotatorEvaluation(refreshed.entry, reopened),
        deps.pageSession.readSelection(refreshed.binding.page),
    );
    const payload: AnnotatorSaveReply = {
        projection,
        validation: reopened.validation,
        profile: saved,
    };
    return {reply: replyAction(input.action, payload), events: []};
};

const pickReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: AnnotatorPickPayload,
): Promise<ControlPlaneResult> => {
    const current = await ensureFreshPageSession(deps, input.workspace.name);
    const pointResolution = resolveAnnotatorPoint(current.entry, payload.point);
    if (pointResolution.status !== 'resolved') {
        const projection = buildAnnotatorProjection(
            current.entry,
            deps.pageSession.readSelection(current.binding.page),
        );
        const replyPayload: AnnotatorPickReply = {
            projection,
            picked: pointResolution.status === 'ambiguous'
                ? {status: 'ambiguous', candidateNodeIds: [...pointResolution.candidateNodeIds]}
                : {status: 'not_found'},
        };
        return {reply: replyAction(input.action, replyPayload), events: []};
    }

    const confirmation = deps.pageSession.confirmSelection(current.binding.page, pointResolution.nodeId);
    if (!confirmation.ok) {
        const projection = buildAnnotatorProjection(
            current.entry,
            deps.pageSession.readSelection(current.binding.page),
        );
        const replyPayload: AnnotatorPickReply = {
            projection,
            picked: confirmation.reason === 'non-unique-identity'
                && confirmation.resolution?.status === 'ambiguous'
                ? {status: 'ambiguous', candidateNodeIds: [...confirmation.resolution.candidateNodeIds]}
                : {status: 'not_found'},
        };
        return {reply: replyAction(input.action, replyPayload), events: []};
    }

    const refreshed = await ensureFreshPageSession(deps, input.workspace.name, {explicit: true});
    const projection = buildAnnotatorProjection(
        refreshed.entry,
        deps.pageSession.readSelection(refreshed.binding.page),
    );
    const replyPayload: AnnotatorPickReply = {
        projection,
        picked: {
            status: 'resolved',
            nodeId: pointResolution.nodeId,
            anchor: {...confirmation.selection.anchor},
        },
    };
    return {reply: replyAction(input.action, replyPayload), events: []};
};

const requirePayload = (value: unknown): Record<string, unknown> => {
    if (value === undefined) {return {};}
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator payload must be an object');
    }
    return value as Record<string, unknown>;
};

const assertAllowedKeys = (payload: Readonly<Record<string, unknown>>, allowed: readonly string[]): void => {
    const allowedKeys = new Set(allowed);
    const unknown = Object.keys(payload).filter((key) => !allowedKeys.has(key));
    if (unknown.length > 0) {
        throw new ActionError(
            ERROR_CODES.ERR_BAD_ARGS,
            `unsupported annotator payload fields: ${unknown.join(', ')}`,
            {unknownFields: unknown},
        );
    }
};

const optionalProfileName = (payload: Readonly<Record<string, unknown>>): string | undefined => {
    if (payload.profileName === undefined) {return undefined;}
    if (typeof payload.profileName !== 'string' || !payload.profileName.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'profileName must be a non-empty string');
    }
    return payload.profileName.trim();
};

const requirePoint = (payload: Readonly<Record<string, unknown>>): AnnotatorPickPayload => {
    if (!payload.point || typeof payload.point !== 'object' || Array.isArray(payload.point)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator pick requires point');
    }
    const point = payload.point as Record<string, unknown>;
    assertAllowedKeys(point, ['x', 'y']);
    if (typeof point.x !== 'number' || !Number.isFinite(point.x)
        || typeof point.y !== 'number' || !Number.isFinite(point.y)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator point x and y must be finite numbers');
    }
    return {point: {x: point.x, y: point.y}};
};

const requireDraft = (payload: Readonly<Record<string, unknown>>): AnnotatorDraft => {
    if (!payload.draft || typeof payload.draft !== 'object' || Array.isArray(payload.draft)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator check/save requires draft');
    }
    const draft = payload.draft as Record<string, unknown>;
    assertAllowedKeys(draft, ['profileName', 'match', 'annotation']);
    if (typeof draft.profileName !== 'string' || !draft.profileName.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'draft.profileName must be a non-empty string');
    }
    return {
        profileName: draft.profileName.trim(),
        match: structuredClone(draft.match) as AnnotatorDraft['match'],
        annotation: structuredClone(draft.annotation) as AnnotatorDraft['annotation'],
    };
};

const assertOptionalBoolean = (value: unknown, field: string): void => {
    if (value !== undefined && typeof value !== 'boolean') {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `${field} must be a boolean`);
    }
};

const requireProfile = (
    profile: unknown,
    profileName: string,
): WorkflowEntityRules => {
    if (!profile || typeof profile !== 'object' || (profile as {kind?: unknown}).kind !== 'entity_rules') {
        throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `entity_rules profile not found: ${profileName}`);
    }
    return structuredClone(profile) as WorkflowEntityRules;
};
