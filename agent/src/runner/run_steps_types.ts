import type { StepName, StepResolve, StepResult as ExecStepResult, StepUnion } from './steps/types';
import type { Checkpoint as RunnerCheckpoint } from './checkpoint/types';
import type { ExecutionBindings } from '../runtime/execution/bindings';
import type { RunnerPluginHost } from './hotreload/plugin_host';
import type { RunnerConfig } from '../config';
import type { RuntimeWorkspace } from '../runtime/workspace/workspace';
import type { Action } from '../actions/action_protocol';
import type { Page } from 'playwright';
import type { WorkspaceEntityRulesProvider } from '../snapshot/rules';
import type { PageSnapshotSessionPort } from '../snapshot/session';
import type { SnapshotProjectionBaselinePort } from '../snapshot/projection';

export type StepEvent =
    | {
          type: 'step.start';
          ts: number;
          workspaceName: string;
          stepId: string;
          name: StepName;
          argsSummary?: unknown;
      }
    | {
          type: 'step.end';
          ts: number;
          workspaceName: string;
          stepId: string;
          name: StepName;
          ok: boolean;
          durationMs: number;
          error?: ExecStepResult['error'];
      };

export type StepSink = {
    write: (event: StepEvent) => void | Promise<void>;
};

export type RunStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'halted';
export type RunSignal = 'halt' | 'suspend' | 'continue' | 'flush' | 'checkpoint';

export type StepsQueue = {
    items: StepUnion[];
    cursor: number;
    closed: boolean;
};

export type StepResult = {
    runId: string;
    cursor: number;
    stepId: string;
    ok: boolean;
    data?: ExecStepResult['data'];
    error?: ExecStepResult['error'];
    ts: number;
};

export type ResultPipe = {
    items: StepResult[];
    waiters: Set<() => void>;
};

export type SignalChannel = {
    items: Array<{ signal: RunSignal; ts: number; priority: number }>;
    cursor: number;
};

export type Checkpoint = {
    runId: string;
    workspaceName: string;
    status: RunStatus;
    cursor: number;
    updatedAt: number;
};

export type RunStepsDeps = {
    runtime: ExecutionBindings;
    pageSession: PageSnapshotSessionPort<Page>;
    snapshotProjection: SnapshotProjectionBaselinePort<Page>;
    resolveWorkspace: (workspaceName: string) => RuntimeWorkspace;
    dispatchAction: (action: Action) => Promise<Action>;
    resolveEntityRulesProvider?: (workspaceName: string) => WorkspaceEntityRulesProvider | null;
    stepSinks?: StepSink[];
    config: RunnerConfig;
    pluginHost: RunnerPluginHost;
};

export type RunStepsRequest = {
    runId: string;
    workspaceName: string;
    stepsQueue: StepsQueue;
    resultPipe: ResultPipe;
    signalChannel: SignalChannel;
    stepResolves?: Record<string, StepResolve>;
    stopOnError?: boolean;
    onCheckpoint?: (checkpoint: Checkpoint) => void | Promise<void>;
    checkpoints?: RunnerCheckpoint[];
    checkpointEnabled?: boolean;
    checkpointMaxAttempts?: number;
};
