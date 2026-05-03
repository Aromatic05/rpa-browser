import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceControlInput } from '../runtime/workspace_control';
import type { ControlPlaneResult } from '../runtime/control';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import { createWorkspaceCheckpointRuntime } from './runtime';

export type CheckpointControl = {
    handle: (input: WorkspaceControlInput) => Promise<ControlPlaneResult>;
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

const resolveStepResolves = (payload: Record<string, unknown>): Record<string, StepResolve> => {
    const stepResolves = payload.stepResolves;
    if (!stepResolves || typeof stepResolves !== 'object' || Array.isArray(stepResolves)) {
        return {};
    }
    return stepResolves as Record<string, StepResolve>;
};

const resolveHints = (payload: Record<string, unknown>) => {
    const hints = payload.hints;
    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
        return {};
    }
    return hints as Record<string, string>;
};

export const createCheckpointControl = (): CheckpointControl => ({
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
            const artifact = runtime.save(checkpoint, resolveStepResolves(payload), resolveHints(payload));
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
