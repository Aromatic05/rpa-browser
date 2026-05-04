import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import type { Workflow, WorkflowCheckpoint, WorkflowDummy } from '../workflow';

const CHECKPOINT_DUMMY: WorkflowDummy = { kind: 'checkpoint' };

export type WorkspaceCheckpointRuntime = {
    list: () => WorkflowCheckpoint[];
    get: (checkpointId: string) => WorkflowCheckpoint | null;
    save: (checkpoint: Checkpoint, stepResolves?: Record<string, StepResolve>, hints?: WorkflowCheckpoint['hints']) => WorkflowCheckpoint;
    delete: (checkpointId: string) => WorkflowCheckpoint;
};

export const createWorkspaceCheckpointRuntime = (workflow: Workflow): WorkspaceCheckpointRuntime => {
    const list = (): WorkflowCheckpoint[] => {
        return workflow
            .list(CHECKPOINT_DUMMY)
            .map((item) => workflow.get(item.name, CHECKPOINT_DUMMY))
            .filter((item): item is WorkflowCheckpoint => item?.kind === 'checkpoint');
    };

    const get = (checkpointId: string): WorkflowCheckpoint | null => {
        const artifact = workflow.get(checkpointId, CHECKPOINT_DUMMY);
        if (!artifact || artifact.kind !== 'checkpoint') {
            return null;
        }
        return artifact;
    };

    const save = (
        checkpoint: Checkpoint,
        stepResolves: Record<string, StepResolve> = {},
        hints: WorkflowCheckpoint['hints'] = {},
    ): WorkflowCheckpoint => {
        if (checkpoint.id !== checkpoint.id.trim()) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint.id must not contain surrounding whitespace');
        }
        const artifact: WorkflowCheckpoint = {
            kind: 'checkpoint',
            name: checkpoint.id,
            checkpoint,
            stepResolves,
            hints,
        };
        if (artifact.name !== checkpoint.id) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint identity mismatch: artifact.name must equal checkpoint.id');
        }
        const saved = workflow.save(artifact);
        if (saved.kind !== 'checkpoint') {
            throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'unexpected checkpoint artifact kind after save');
        }
        return saved;
    };

    const remove = (checkpointId: string): WorkflowCheckpoint => {
        const existing = get(checkpointId);
        if (!existing) {
            throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `checkpoint not found: ${checkpointId}`);
        }
        workflow.delete(checkpointId, CHECKPOINT_DUMMY);
        return existing;
    };

    return { list, get, save, delete: remove };
};
