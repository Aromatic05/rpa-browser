import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import type { Workflow, WorkflowCheckpoint } from '../workflow';
import { createWorkspaceCheckpointRuntime } from './runtime';
import { createWorkspaceCheckpointProvider } from './provider';
import type { DslCheckpointProvider } from '../dsl/emit/checkpoint_call';

export type CheckpointControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
    getProvider: (workflow: Workflow) => DslCheckpointProvider;
};

const requireCheckpointId = (payload: Record<string, unknown>): string => {
    const checkpointId = typeof payload.checkpointId === 'string' ? payload.checkpointId.trim() : '';
    if (!checkpointId) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpointId is required');
    }
    return checkpointId;
};

const requireCheckpoint = (payload: Record<string, unknown>): Checkpoint => {
    const checkpoint = payload.checkpoint as Checkpoint | undefined;
    if (!checkpoint || typeof checkpoint !== 'object' || typeof checkpoint.id !== 'string' || !checkpoint.id.trim()) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint payload is required');
    }
    return checkpoint;
};

const resolveStepResolves = (payload: Record<string, unknown>): Record<string, StepResolve> | undefined => {
    if (!Object.prototype.hasOwnProperty.call(payload, 'stepResolves')) {return undefined;}
    const stepResolves = payload.stepResolves;
    if (!stepResolves || typeof stepResolves !== 'object' || Array.isArray(stepResolves)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'stepResolves must be an object');
    }
    return stepResolves as Record<string, StepResolve>;
};

const resolveHints = (payload: Record<string, unknown>): WorkflowCheckpoint['hints'] | undefined => {
    if (!Object.prototype.hasOwnProperty.call(payload, 'hints')) {return undefined;}
    const hints = payload.hints;
    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'hints must be an object');
    }
    return hints as WorkflowCheckpoint['hints'];
};

const resolveBodyDsl = (payload: Record<string, unknown>): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(payload, 'bodyDsl')) {return undefined;}
    if (typeof payload.bodyDsl !== 'string') {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'bodyDsl must be a string');
    }
    return payload.bodyDsl;
};

export const createCheckpointControl = (): CheckpointControl => ({
    getProvider: (workflow) => createWorkspaceCheckpointProvider(workflow),
    handle: async (input) => {
        const { action, workspace } = input;
        const runtime = createWorkspaceCheckpointRuntime(workspace.workflow);

        if (!action.type.startsWith('checkpoint.')) {
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        }

        const payload = (action.payload || {}) as Record<string, unknown>;

        if (action.type === 'checkpoint.list') {
            const checkpoints = runtime.list();
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    checkpoints: checkpoints.map((item) => ({
                        checkpointId: item.name,
                        checkpoint: item.checkpoint,
                        stepResolves: item.stepResolves,
                        hints: item.hints,
                    })),
                }),
                events: [],
            };
        }

        if (action.type === 'checkpoint.get') {
            const checkpointId = requireCheckpointId(payload);
            const artifact = runtime.get(checkpointId);
            if (!artifact) {
                throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `checkpoint not found: ${checkpointId}`);
            }
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    checkpointId,
                    checkpoint: artifact.checkpoint,
                    stepResolves: artifact.stepResolves,
                    hints: artifact.hints,
                    ...(artifact.bodyDsl !== undefined ? {bodyDsl: artifact.bodyDsl} : {}),
                }),
                events: [],
            };
        }

        if (action.type === 'checkpoint.save') {
            const checkpoint = requireCheckpoint(payload);
            const checkpointId = requireCheckpointId({ checkpointId: checkpoint.id });
            if (checkpoint.id !== checkpointId) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint.id must not contain surrounding whitespace');
            }
            const artifact = runtime.save(
                checkpoint,
                resolveStepResolves(payload),
                resolveHints(payload),
                resolveBodyDsl(payload),
            );
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    checkpointId: artifact.name,
                    checkpoint: artifact.checkpoint,
                    stepResolves: artifact.stepResolves,
                    hints: artifact.hints,
                    saved: true,
                }),
                events: [],
            };
        }

        if (action.type === 'checkpoint.delete') {
            const checkpointId = requireCheckpointId(payload);
            const removed = runtime.delete(checkpointId);
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    checkpointId: removed.name,
                    deleted: true,
                }),
                events: [],
            };
        }

        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
});
