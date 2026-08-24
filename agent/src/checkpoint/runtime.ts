import { ActionError } from '../interface/actions/results';
import { ERROR_CODES } from '../interface/actions/results';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import type { Workflow, WorkflowCheckpoint, WorkflowDummy } from '../workflow';

const CHECKPOINT_DUMMY: WorkflowDummy = { kind: 'checkpoint' };

export type WorkspaceCheckpointRuntime = {
    list: () => WorkflowCheckpoint[];
    get: (checkpointId: string) => WorkflowCheckpoint | null;
    save: (
        checkpoint: Checkpoint,
        stepResolves?: Record<string, StepResolve>,
        hints?: WorkflowCheckpoint['hints'],
        bodyDsl?: string,
        expectedRevision?: string | null,
    ) => WorkflowCheckpoint;
    delete: (checkpointId: string, expectedRevision?: string | null) => WorkflowCheckpoint;
};

export type WorkspaceCheckpointRuntimeOptions = {
    validateBody?: (input: {
        checkpoint: Checkpoint;
        bodyDsl: string;
        stepResolves: Record<string, StepResolve>;
    }) => void;
};

export const createWorkspaceCheckpointRuntime = (
    workflow: Workflow,
    options: WorkspaceCheckpointRuntimeOptions = {},
): WorkspaceCheckpointRuntime => {
    const list = (): WorkflowCheckpoint[] => {
        return workflow
            .list(CHECKPOINT_DUMMY)
            .map((item) => workflow.get(item.name, CHECKPOINT_DUMMY))
            .filter((item): item is WorkflowCheckpoint => item !== null && item.kind === 'checkpoint');
    };

    const get = (checkpointId: string): WorkflowCheckpoint | null => {
        const artifact = workflow.get(checkpointId, CHECKPOINT_DUMMY);
        if (artifact?.kind !== 'checkpoint') {
            return null;
        }
        return artifact;
    };

    const save = (
        checkpoint: Checkpoint,
        stepResolves?: Record<string, StepResolve>,
        hints?: WorkflowCheckpoint['hints'],
        bodyDsl?: string,
        expectedRevision?: string | null,
    ): WorkflowCheckpoint => {
        if (checkpoint.id !== checkpoint.id.trim()) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint.id must not contain surrounding whitespace');
        }
        const needsExisting = stepResolves === undefined
            || hints === undefined
            || (bodyDsl === undefined && Boolean(checkpoint.body));
        const existing = needsExisting ? get(checkpoint.id) : null;
        const preservedBodyDsl = bodyDsl === undefined && checkpoint.body
            ? existing?.bodyDsl
            : undefined;
        const effectiveBodyDsl = bodyDsl ?? preservedBodyDsl;
        const effectiveStepResolves = stepResolves ?? existing?.stepResolves ?? {};
        if (checkpoint.body && effectiveBodyDsl !== undefined) {
            options.validateBody?.({checkpoint, bodyDsl: effectiveBodyDsl, stepResolves: effectiveStepResolves});
        }
        const artifact: WorkflowCheckpoint = {
            kind: 'checkpoint',
            name: checkpoint.id,
            checkpoint,
            stepResolves: effectiveStepResolves,
            hints: hints ?? existing?.hints ?? {},
            ...(effectiveBodyDsl !== undefined ? {bodyDsl: effectiveBodyDsl} : {}),
        };
        if (artifact.name !== checkpoint.id) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint identity mismatch: artifact.name must equal checkpoint.id');
        }
        const saved = workflow.save(artifact, {expectedRevision});
        if (saved.kind !== 'checkpoint') {
            throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'unexpected checkpoint artifact kind after save');
        }
        return saved;
    };

    const remove = (checkpointId: string, expectedRevision?: string | null): WorkflowCheckpoint => {
        const existing = get(checkpointId);
        if (!existing) {
            throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `checkpoint not found: ${checkpointId}`);
        }
        workflow.delete(checkpointId, CHECKPOINT_DUMMY, {expectedRevision});
        return existing;
    };

    return { list, get, save, delete: remove };
};
