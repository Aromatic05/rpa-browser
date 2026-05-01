import fs from 'node:fs';
import YAML from 'yaml';
import { runDslSource } from '../dsl/runtime';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import type { DslCheckpointProvider } from '../dsl/emit';
import type { RunStepsDeps } from '../runner/run_steps';
import type { Checkpoint } from '../runner/checkpoint';
import type { CheckpointResolveFile, SingleCheckpointFile } from '../runner/serialization/types';
import { validateCheckpointResolveFileForSerialization, validateSingleCheckpointFileForSerialization } from '../runner/serialization/types';
import { loadWorkflow } from './loader';
import { resolveWorkflowWorkspace, type ResolveWorkflowWorkspaceDeps } from './workspace_binding';
import type { RunWorkflowRequest, RunWorkflowResult, WorkflowCheckpointRegistry } from './types';

export type RunWorkflowDeps = ResolveWorkflowWorkspaceDeps & {
    runStepsDeps: RunStepsDeps;
    workflowsDir?: string;
};

const loadCheckpointRegistry = (scene: string, checkpoints: ReturnType<typeof loadWorkflow>['checkpoints']): WorkflowCheckpointRegistry => {
    const checkpointsById = new Map<string, Checkpoint>();
    const stepResolvesById = new Map<string, CheckpointResolveFile['resolves']>();

    for (const entry of checkpoints) {
        if (!fs.existsSync(entry.checkpointPath)) {
            throw new DslRuntimeError(
                `workflow checkpoint not found: scene=${scene} rel=${entry.directory}/checkpoint.yaml`,
                'ERR_WORKFLOW_CHECKPOINT_NOT_FOUND',
            );
        }
        const checkpointFile = YAML.parse(fs.readFileSync(entry.checkpointPath, 'utf8')) as SingleCheckpointFile;
        validateSingleCheckpointFileForSerialization(checkpointFile);
        checkpointsById.set(entry.id, checkpointFile.checkpoint);

        if (fs.existsSync(entry.checkpointResolvePath)) {
            const resolveFile = YAML.parse(fs.readFileSync(entry.checkpointResolvePath, 'utf8')) as CheckpointResolveFile;
            validateCheckpointResolveFileForSerialization(resolveFile);
            stepResolvesById.set(entry.id, resolveFile.resolves || {});
        }
    }

    return { checkpointsById, stepResolvesById };
};

const buildWorkflowCheckpointProvider = (scene: string, registry: WorkflowCheckpointRegistry): DslCheckpointProvider => ({
    getCheckpoint: (id: string) => {
        if (!registry.checkpointsById.has(id)) {
            throw new DslRuntimeError(
                `workflow checkpoint not declared: scene=${scene} checkpoint=${id}`,
                'ERR_WORKFLOW_CHECKPOINT_NOT_DECLARED',
            );
        }
        return registry.checkpointsById.get(id) || null;
    },
    getCheckpointResolves: (id: string) => registry.stepResolvesById.get(id) || null,
});

export const runWorkflow = async (request: RunWorkflowRequest, deps: RunWorkflowDeps): Promise<RunWorkflowResult> => {
    const loaded = loadWorkflow(request.scene, deps.workflowsDir);
    const resolvedWorkspace = await resolveWorkflowWorkspace(
        {
            pageRegistry: deps.pageRegistry,
            restoreWorkspace: deps.restoreWorkspace,
        },
        {
            scene: request.scene,
            binding: loaded.workspaceBinding,
        },
    );
    const checkpointRegistry = loadCheckpointRegistry(request.scene, loaded.checkpoints);
    const checkpointProvider = buildWorkflowCheckpointProvider(request.scene, checkpointRegistry);
    const input = (request.input || loaded.inputsExample || {}) as Record<string, unknown>;

    const result = await runDslSource(loaded.dslSource, {
        workspaceName: resolvedWorkspace.workspaceName,
        deps: deps.runStepsDeps,
        input,
        checkpointProvider,
    });

    return {
        scene: request.scene,
        workflowRoot: loaded.rootDir,
        workspaceName: resolvedWorkspace.workspaceName,
        tabName: resolvedWorkspace.tabName,
        tabName: resolvedWorkspace.tabName,
        scope: result.scope,
        diagnostics: result.diagnostics,
    };
};
