import {replyAction} from '../../../interface/actions/action_protocol';
import {ActionError, ERROR_CODES} from '../../../interface/actions/results';
import type {ControlPlaneResult} from '../../runtime/control_plane';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import {
    buildAnnotatorProjection,
    resolveAnnotatorPoint,
    type AnnotatorApplyPayload,
    type AnnotatorApplyReply,
    type AnnotatorCheckReply,
    type AnnotatorDraft,
    type AnnotatorPickPayload,
    type AnnotatorPickReply,
    type AnnotatorProjectionReply,
    type AnnotatorSaveReply,
} from '../../snapshot/annotator';
import type {EntityRulesAnnotatorPort} from '../../snapshot/rules/runtime/action_handler';
import {entityRulesArtifactRevision, type WorkflowEntityRules} from '../../workflow';
import type {RunStepsDeps} from '../run_steps_types';
import {ensureFreshPageSession} from '../session/capture';
import {
    evaluateAnnotatorDraft,
    projectAnnotatorEvaluation,
    workflowProfileToAnnotatorDraft,
} from './draft';
import {materializeAnnotatorTarget} from './materialize';
import {handleLegacyAnnotatorAction} from './legacy';

export type CreateRunnerAnnotatorControllerInput = {
    runStepsDeps: RunStepsDeps;
    runWorkspaceExecution?: <T>(actionType: string, run: () => Promise<T>) => Promise<T>;
};

export const createRunnerAnnotatorController = (
    input: CreateRunnerAnnotatorControllerInput,
): EntityRulesAnnotatorPort => ({
    handle: async (routerInput) => {
        const run = async (): Promise<ControlPlaneResult> => {
            const {action, workspace} = routerInput;
            const rawPayload = requirePayload(action.payload);
            const protocol = requireAnnotatorProtocol(rawPayload);
            const payload = withoutAnnotatorProtocol(rawPayload);
            if (protocol === 'canvas-v1') {
                return await handleLegacyAnnotatorAction(
                    input.runStepsDeps,
                    {action, workspace},
                    payload,
                );
            }
            switch (action.type) {
                case 'entity_rules.annotator.open':
                    assertAllowedKeys(payload, ['profileName', 'tabName']);
                    return await projectReply(
                        input.runStepsDeps,
                        {action, workspace},
                        false,
                        optionalProfileName(payload),
                        optionalTabName(payload),
                    );
                case 'entity_rules.annotator.visualize':
                    assertAllowedKeys(payload, ['profileName', 'tabName']);
                    return await projectReply(
                        input.runStepsDeps,
                        {action, workspace},
                        true,
                        optionalProfileName(payload),
                        optionalTabName(payload),
                    );
                case 'entity_rules.annotator.recognize':
                    assertAllowedKeys(payload, ['profileName', 'refresh', 'tabName']);
                    assertOptionalBoolean(payload.refresh, 'refresh');
                    return await projectReply(
                        input.runStepsDeps,
                        {action, workspace},
                        true,
                        optionalProfileName(payload),
                        optionalTabName(payload),
                    );
                case 'entity_rules.annotator.pick':
                    assertAllowedKeys(payload, ['point', 'tabName']);
                    return await pickReply(
                        input.runStepsDeps,
                        {action, workspace},
                        requirePoint(payload),
                        optionalTabName(payload),
                    );
                case 'entity_rules.annotator.apply':
                    assertAllowedKeys(payload, ['draft', 'targetId', 'semantic', 'tabName']);
                    return await applyReply(
                        input.runStepsDeps,
                        {action, workspace},
                        requireApply(payload),
                        optionalTabName(payload),
                    );
                case 'entity_rules.annotator.check':
                    assertAllowedKeys(payload, ['draft', 'tabName']);
                    return await checkReply(
                        input.runStepsDeps,
                        {action, workspace},
                        requireDraft(payload),
                        optionalTabName(payload),
                    );
                case 'entity_rules.annotator.save':
                    assertAllowedKeys(payload, ['draft', 'tabName', 'expectedRevision']);
                    return await saveReply(
                        input.runStepsDeps,
                        {action, workspace},
                        requireDraft(payload),
                        optionalTabName(payload),
                        optionalExpectedRevision(payload),
                    );
                default:
                    throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported annotator action: ${action.type}`);
            }
        };
        return input.runWorkspaceExecution
            ? await input.runWorkspaceExecution(routerInput.action.type, run)
            : await run();
    },
});

const projectReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    explicit: boolean,
    profileName: string | undefined,
    tabName: string | undefined,
): Promise<ControlPlaneResult> => {
    const {entry, binding} = await ensureFreshPageSession(deps, input.workspace.name, {explicit, tabName});
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
        artifactRevision: profile ? entityRulesArtifactRevision(profile) : null,
    };
    return {reply: replyAction(input.action, payload), events: []};
};

const applyReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: AnnotatorApplyPayload,
    tabName: string | undefined,
): Promise<ControlPlaneResult> => {
    const current = await ensureFreshPageSession(deps, input.workspace.name, {tabName});
    let materialized;
    try {
        materialized = materializeAnnotatorTarget({
            entry: current.entry,
            draft: payload.draft,
            targetId: payload.targetId,
            semantic: payload.semantic,
            selection: deps.pageSession.readSelection(current.binding.page),
        });
    } catch (error) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, errorMessage(error));
    }
    if (!materialized.ok) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, materialized.message, materialized.details);
    }
    const evaluation = evaluateAnnotatorDraft(current.entry, materialized.draft, 'check');
    const projection = buildAnnotatorProjection(
        projectAnnotatorEvaluation(current.entry, evaluation),
        deps.pageSession.readSelection(current.binding.page),
    );
    const replyPayload: AnnotatorApplyReply = {
        draft: materialized.draft,
        projection,
        validation: evaluation.validation,
    };
    return {reply: replyAction(input.action, replyPayload), events: []};
};

const checkReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    draft: AnnotatorDraft,
    tabName: string | undefined,
): Promise<ControlPlaneResult> => {
    const {entry, binding} = await ensureFreshPageSession(deps, input.workspace.name, {tabName});
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
    tabName: string | undefined,
    expectedRevision: string | null | undefined,
): Promise<ControlPlaneResult> => {
    const current = await ensureFreshPageSession(deps, input.workspace.name, {tabName});
    const checked = evaluateAnnotatorDraft(current.entry, draft, 'save');
    if (!checked.validation.ok || !checked.profile) {
        throw new ActionError(
            ERROR_CODES.ERR_BAD_ARGS,
            'annotator draft validation failed',
            {validation: checked.validation},
        );
    }
    const saved = input.workspace.workflow.save(checked.profile, {expectedRevision});
    if (saved.kind !== 'entity_rules') {
        throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'workflow returned a non-entity_rules artifact');
    }

    const refreshed = await ensureFreshPageSession(deps, input.workspace.name, {explicit: true, tabName});
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
        artifactRevision: entityRulesArtifactRevision(saved),
    };
    return {reply: replyAction(input.action, payload), events: []};
};

const pickReply = async (
    deps: RunStepsDeps,
    input: Pick<WorkspaceRouterInput, 'action' | 'workspace'>,
    payload: AnnotatorPickPayload,
    tabName: string | undefined,
): Promise<ControlPlaneResult> => {
    const current = await ensureFreshPageSession(deps, input.workspace.name, {tabName});
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

    const refreshed = await ensureFreshPageSession(deps, input.workspace.name, {explicit: true, tabName});
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

type AnnotatorProtocol = 'projection-v1' | 'canvas-v1';

const requireAnnotatorProtocol = (payload: Readonly<Record<string, unknown>>): AnnotatorProtocol => {
    if (payload.annotatorProtocol === 'projection-v1' || payload.annotatorProtocol === 'canvas-v1') {
        return payload.annotatorProtocol;
    }
    if (payload.annotatorProtocol === undefined) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotatorProtocol is required');
    }
    const received = typeof payload.annotatorProtocol === 'string'
        ? payload.annotatorProtocol
        : Array.isArray(payload.annotatorProtocol)
            ? 'array'
            : typeof payload.annotatorProtocol;
    throw new ActionError(
        ERROR_CODES.ERR_BAD_ARGS,
        `unsupported annotator protocol: ${received}`,
    );
};

const withoutAnnotatorProtocol = (
    payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
    const {annotatorProtocol: _protocol, ...rest} = payload;
    return rest;
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

const optionalTabName = (payload: Readonly<Record<string, unknown>>): string | undefined => {
    if (payload.tabName === undefined) {return undefined;}
    if (typeof payload.tabName !== 'string' || !payload.tabName.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'tabName must be a non-empty string');
    }
    return payload.tabName.trim();
};

const optionalExpectedRevision = (
    payload: Readonly<Record<string, unknown>>,
): string | null | undefined => {
    if (payload.expectedRevision === undefined) {return undefined;}
    if (payload.expectedRevision === null) {return null;}
    if (typeof payload.expectedRevision !== 'string' || !payload.expectedRevision) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'expectedRevision must be a non-empty string or null');
    }
    return payload.expectedRevision;
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
    assertAllowedKeys(draft, ['profileName', 'page', 'match', 'annotation']);
    if (typeof draft.profileName !== 'string' || !draft.profileName.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'draft.profileName must be a non-empty string');
    }
    return {
        profileName: draft.profileName.trim(),
        page: draft.page === undefined ? undefined : structuredClone(draft.page) as AnnotatorDraft['page'],
        match: structuredClone(draft.match) as AnnotatorDraft['match'],
        annotation: structuredClone(draft.annotation) as AnnotatorDraft['annotation'],
    };
};

const requireApply = (payload: Readonly<Record<string, unknown>>): AnnotatorApplyPayload => {
    const draft = requireDraft(payload);
    if (typeof payload.targetId !== 'string' || !payload.targetId.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator apply requires targetId');
    }
    if (!payload.semantic || typeof payload.semantic !== 'object' || Array.isArray(payload.semantic)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator apply requires semantic');
    }
    return {
        draft,
        targetId: payload.targetId.trim(),
        semantic: requireSemantic(payload.semantic),
    };
};

const requireSemantic = (value: unknown): AnnotatorApplyPayload['semantic'] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator apply semantic must be an object');
    }
    const semantic = value as Record<string, unknown>;
    const displayName = optionalString(semantic.displayName, 'semantic.displayName');
    switch (semantic.kind) {
        case 'entity': {
            assertAllowedKeys(semantic, ['kind', 'businessTag', 'entityKey', 'displayName', 'entityKind']);
            const entityKind = semantic.entityKind === undefined
                ? undefined
                : requireEntityKind(semantic.entityKind);
            const entityKey = semantic.entityKey === undefined
                ? undefined
                : requireEntityKey(semantic.entityKey);
            return {
                kind: 'entity',
                businessTag: requiredString(semantic.businessTag, 'semantic.businessTag'),
                ...(entityKey ? {entityKey} : {}),
                ...(displayName ? {displayName} : {}),
                ...(entityKind ? {entityKind} : {}),
            };
        }
        case 'field':
            assertAllowedKeys(semantic, ['kind', 'fieldKey', 'displayName']);
            return {
                kind: 'field',
                fieldKey: requiredString(semantic.fieldKey, 'semantic.fieldKey'),
                ...(displayName ? {displayName} : {}),
            };
        case 'action':
            assertAllowedKeys(semantic, ['kind', 'actionIntent', 'displayName']);
            return {
                kind: 'action',
                actionIntent: requiredString(semantic.actionIntent, 'semantic.actionIntent'),
                ...(displayName ? {displayName} : {}),
            };
        case 'column': {
            assertAllowedKeys(semantic, ['kind', 'fieldKey', 'displayName', 'columnKind']);
            const columnKind = semantic.columnKind === undefined
                ? undefined
                : requireColumnKind(semantic.columnKind);
            return {
                kind: 'column',
                fieldKey: requiredString(semantic.fieldKey, 'semantic.fieldKey'),
                ...(displayName ? {displayName} : {}),
                ...(columnKind ? {columnKind} : {}),
            };
        }
        case 'primary-key':
            assertAllowedKeys(semantic, ['kind', 'fieldKey']);
            return {kind: 'primary-key', fieldKey: requiredString(semantic.fieldKey, 'semantic.fieldKey')};
        case 'table-action':
            assertAllowedKeys(semantic, ['kind', 'actionIntent', 'displayName']);
            return {
                kind: 'table-action',
                actionIntent: requiredString(semantic.actionIntent, 'semantic.actionIntent'),
                ...(displayName ? {displayName} : {}),
            };
        default:
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'annotator apply semantic.kind is invalid');
    }
};

const requiredString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `${field} must be a non-empty string`);
    }
    return value.trim();
};

const optionalString = (value: unknown, field: string): string | undefined => {
    if (value === undefined) {return undefined;}
    return requiredString(value, field);
};

const requireEntityKind = (value: unknown): NonNullable<Extract<AnnotatorApplyPayload['semantic'], {kind: 'entity'}>['entityKind']> => {
    const kinds = new Set(['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv']);
    if (typeof value !== 'string' || !kinds.has(value)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'semantic.entityKind is invalid');
    }
    return value as NonNullable<Extract<AnnotatorApplyPayload['semantic'], {kind: 'entity'}>['entityKind']>;
};

const requireEntityKey = (value: unknown): string => {
    const entityKey = requiredString(value, 'semantic.entityKey');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entityKey)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'semantic.entityKey must be a valid identifier');
    }
    return entityKey;
};

const requireColumnKind = (value: unknown): NonNullable<Extract<AnnotatorApplyPayload['semantic'], {kind: 'column'}>['columnKind']> => {
    const kinds = new Set(['text', 'number', 'date', 'status']);
    if (typeof value !== 'string' || !kinds.has(value)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'semantic.columnKind is invalid');
    }
    return value as NonNullable<Extract<AnnotatorApplyPayload['semantic'], {kind: 'column'}>['columnKind']>;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
