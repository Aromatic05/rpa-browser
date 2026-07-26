import { replyAction } from '../../actions/action_protocol';
import { ActionError, ERROR_CODES } from '../../actions/results';
import type { ControlPlaneResult } from '../../runtime/control_plane';
import type { RuntimeWorkspace } from '../../runtime/workspace/workspace';
import type { RunStepsDeps } from '../../runner/run_steps';
import type { SnapshotPageIdentity } from '../../runner/steps/executors/snapshot/core/types';
import { ensureFreshEntityContext } from '../../runner/steps/executors/entity_context';
import { createWorkspaceEntityRulesProvider } from '../provider';
import { createWorkspaceEntityRulesRuntime, type WorkspaceEntityRulesRuntime } from '../runtime';
import { recognizeEntities } from './recognize';
import { pickFromFingerprint } from './picking';
import { buildOpenResult, detectStale, prepareSaveArtifact, runCheck } from './pipeline';
import { computeArtifactRevision, isRevisionConflict } from './revision';
import type { WorkflowEntityRules } from '../../workflow';
import type { CanvasDraft } from './types';
import type { PickFingerprint } from './runtime_types';

export type EntityRulesControlDeps = {
    runStepsDeps: RunStepsDeps;
};

type HandlerContext = {
    workspace: RuntimeWorkspace;
    payload: Record<string, unknown>;
    deps: EntityRulesControlDeps;
};

const requireFingerprint = (payload: Record<string, unknown>): PickFingerprint => {
    const fingerprint = payload.fingerprint as PickFingerprint | undefined;
    if (
        !fingerprint ||
        typeof fingerprint !== 'object' ||
        !fingerprint.point ||
        !fingerprint.tagName
    ) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'fingerprint is required');
    }
    return fingerprint;
};

const requireCanvasDraft = (payload: Record<string, unknown>): CanvasDraft => {
    const draft = payload.canvasDraft as CanvasDraft | undefined;
    if (!draft || typeof draft !== 'object' || !draft.page || !Array.isArray(draft.entities)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'canvasDraft is required');
    }
    return draft;
};

const requireProfileName = (payload: Record<string, unknown>): string => {
    const name = typeof payload.profileName === 'string' ? payload.profileName.trim() : '';
    if (!name) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'profileName is required');
    }
    return name;
};

const optionalRevision = (payload: Record<string, unknown>): string | null => {
    const value = payload.expectedRevision;
    if (value === null || value === undefined) {
        return null;
    }
    return typeof value === 'string' ? value : null;
};

const handleOpen = async (ctx: HandlerContext): Promise<Record<string, unknown>> => {
    const { workspace, deps } = ctx;
    const fresh = await ensureFreshEntityContext(
        deps.runStepsDeps,
        workspace.name,
        'annotator.open',
    );
    const provider = createWorkspaceEntityRulesProvider(workspace.workflow);
    const runtime = createWorkspaceEntityRulesRuntime(workspace.workflow);
    return buildOpenResult({
        snapshot: fresh.snapshot,
        finalEntityView: fresh.finalEntityView,
        pageIdentity: fresh.entry.pageIdentity,
        provider,
        getArtifact: (name) => runtime.get(name),
    }) as unknown as Record<string, unknown>;
};

const handlePick = async (ctx: HandlerContext): Promise<Record<string, unknown>> => {
    const { workspace, deps, payload } = ctx;
    const fingerprint = requireFingerprint(payload);
    const fresh = await ensureFreshEntityContext(
        deps.runStepsDeps,
        workspace.name,
        'annotator.pick',
    );
    const result = pickFromFingerprint(fresh.snapshot, fresh.finalEntityView, fingerprint);
    return result as unknown as Record<string, unknown>;
};

const handleRecognize = async (ctx: HandlerContext): Promise<Record<string, unknown>> => {
    const { workspace, deps, payload } = ctx;
    const existingDraft = payload.canvasDraft as CanvasDraft | undefined;
    const fresh = await ensureFreshEntityContext(
        deps.runStepsDeps,
        workspace.name,
        'annotator.recognize',
    );
    const result = recognizeEntities(fresh.snapshot, fresh.finalEntityView, existingDraft);
    return result as unknown as Record<string, unknown>;
};

const handleCheck = async (ctx: HandlerContext): Promise<Record<string, unknown>> => {
    const { workspace, deps, payload } = ctx;
    const draft = requireCanvasDraft(payload);
    const fresh = await ensureFreshEntityContext(
        deps.runStepsDeps,
        workspace.name,
        'annotator.check',
    );
    const result = runCheck(fresh.snapshot, draft, fresh.entry.pageIdentity.url);
    return result as unknown as Record<string, unknown>;
};

const handleSave = async (ctx: HandlerContext): Promise<Record<string, unknown>> => {
    const { workspace, deps, payload } = ctx;
    const draft = requireCanvasDraft(payload);
    const profileName = requireProfileName(payload);
    const expectedRevision = optionalRevision(payload);

    const fresh = await ensureFreshEntityContext(
        deps.runStepsDeps,
        workspace.name,
        'annotator.save',
    );
    const runtime = createWorkspaceEntityRulesRuntime(workspace.workflow);
    return executeSave(runtime, fresh.entry.pageIdentity, draft, profileName, expectedRevision);
};

export const executeSave = (
    runtime: WorkspaceEntityRulesRuntime,
    pageIdentity: SnapshotPageIdentity,
    draft: CanvasDraft,
    profileName: string,
    expectedRevision: string | null,
): {
    profileName: string;
    entityRules: WorkflowEntityRules;
    artifactRevision: string;
    saved: true;
} => {
    const preparation = prepareSaveArtifact(draft, profileName);
    if (!preparation.ok) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, preparation.errors.join('; '));
    }

    const currentStored = runtime.get(profileName);
    if (isRevisionConflict(currentStored, expectedRevision)) {
        throw new ActionError(
            ERROR_CODES.ERR_CONFLICT,
            'entity_rules artifact revision conflict: stored artifact changed since open',
        );
    }

    if (detectStale(pageIdentity.url, draft)) {
        throw new ActionError(
            ERROR_CODES.ERR_STALE,
            'page identity changed since open; re-check before save',
        );
    }

    const saved = runtime.save(preparation.artifact);
    const artifactRevision = computeArtifactRevision(saved);
    return {
        profileName: saved.name,
        entityRules: saved,
        artifactRevision,
        saved: true,
    };
};

const HANDLERS: Record<string, (ctx: HandlerContext) => Promise<Record<string, unknown>>> = {
    'entity_rules.annotator.open': handleOpen,
    'entity_rules.annotator.pick': handlePick,
    'entity_rules.annotator.recognize': handleRecognize,
    'entity_rules.annotator.check': handleCheck,
    'entity_rules.annotator.save': handleSave,
};

export const isAnnotatorAction = (actionType: string): boolean =>
    actionType.startsWith('entity_rules.annotator.');

export const dispatchAnnotatorAction = async (
    actionType: string,
    workspace: RuntimeWorkspace,
    payload: Record<string, unknown>,
    deps: EntityRulesControlDeps,
): Promise<Record<string, unknown>> => {
    const handler = HANDLERS[actionType];
    if (!handler) {
        throw new ActionError(
            ERROR_CODES.ERR_UNSUPPORTED,
            `unsupported annotator action: ${actionType}`,
        );
    }
    return await handler({ workspace, payload, deps });
};

export const handleAnnotatorAction = async (
    action: { type: string; payload?: unknown },
    workspace: RuntimeWorkspace,
    deps: EntityRulesControlDeps,
    request: Parameters<typeof replyAction>[0],
): Promise<ControlPlaneResult> => {
    const payload = (action.payload || {}) as Record<string, unknown>;
    const data = await dispatchAnnotatorAction(action.type, workspace, payload, deps);
    return {
        reply: replyAction(request, data),
        events: [],
    };
};
