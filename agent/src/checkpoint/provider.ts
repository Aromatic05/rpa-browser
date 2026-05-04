import type { DslCheckpointProvider } from '../dsl/emit';
import type { Workflow } from '../workflow';
import { createWorkspaceCheckpointRuntime } from './runtime';

export const createWorkspaceCheckpointProvider = (workflow: Workflow): DslCheckpointProvider => {
    const runtime = createWorkspaceCheckpointRuntime(workflow);
    return {
        getCheckpoint: (id) => runtime.get(id)?.checkpoint || null,
        getCheckpointResolves: (id) => runtime.get(id)?.stepResolves || null,
    };
};
