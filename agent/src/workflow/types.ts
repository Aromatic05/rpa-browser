import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';

export type WorkflowManifest = {
    version: 1;
    id: string;
    name?: string;
    entry: {
        dsl: string;
        inputs?: string;
    };
    records?: string[];
    checkpoints?: string[];
    workspace?: {
        binding?: string;
    };
};

export type WorkflowWorkspaceTabExpectation = {
    ref: string;
    urlIncludes?: string;
    exactUrl?: string;
};

export type WorkflowWorkspaceBinding = {
    version: 1;
    workspace: {
        strategy: 'restoreOrCreate' | 'createOnly' | 'restoreOnly';
        entryUrl?: string;
        expectedTabs?: WorkflowWorkspaceTabExpectation[];
    };
};

export type WorkflowCheckpointEntry = {
    id: string;
    directory: string;
    checkpointPath: string;
    checkpointResolvePath: string;
    checkpointHintsPath: string;
};

export type WorkflowLoadResult = {
    scene: string;
    rootDir: string;
    manifestPath: string;
    manifest: WorkflowManifest;
    dslPath: string;
    dslSource: string;
    inputsPath?: string;
    inputsExample?: unknown;
    workspaceBindingPath?: string;
    workspaceBinding?: WorkflowWorkspaceBinding;
    records: string[];
    checkpoints: WorkflowCheckpointEntry[];
};

export type RunWorkflowRequest = {
    scene: string;
    input?: Record<string, unknown>;
};

export type RunWorkflowResult = {
    scene: string;
    workflowRoot: string;
    workspaceName: string;
    tabName: string;
    tabName: string;
    scope: {
        input: Record<string, unknown>;
        vars: Record<string, unknown>;
        output: Record<string, unknown>;
    };
    diagnostics: Array<{ code: string; message: string; path?: string }>;
};

export type WorkflowCheckpointRegistry = {
    checkpointsById: Map<string, Checkpoint>;
    stepResolvesById: Map<string, Record<string, StepResolve>>;
};
