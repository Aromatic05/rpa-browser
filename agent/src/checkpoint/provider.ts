import type { DslCheckpointProvider } from '../program/dsl/emit';
import type { Workflow } from '../workflow';
import { createWorkspaceCheckpointRuntime } from './runtime';

export const createWorkspaceCheckpointProvider = (workflow: Workflow): DslCheckpointProvider => {
    const runtime = createWorkspaceCheckpointRuntime(workflow);
    return {
        getCheckpoint: (id) => runtime.get(id)?.checkpoint || null,
        getCheckpointResolves: (id) => runtime.get(id)?.stepResolves || null,
        getCheckpointBody: (id) => {
            const item = runtime.get(id);
            return item?.bodyDsl === undefined ? null : {source: item.bodyDsl, stepResolves: item.stepResolves};
        },
        listCheckpoints: () => runtime.list().map((item) => item.checkpoint),
    };
};
