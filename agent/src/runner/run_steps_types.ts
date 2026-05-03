import type { StepName, StepResolve, StepResult as ExecStepResult, StepUnion } from './steps/types';
import type { Checkpoint as RunnerCheckpoint } from './checkpoint/types';
import type { ExecutionBindings } from '../runtime/execution/bindings';
import type { RunnerPluginHost } from './hotreload/plugin_host';
import type { RunnerConfig } from '../config';
import type { WorkspaceEntityRulesProvider } from '../entity_rules/provider';

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
    stepSinks?: StepSink[];
    config: RunnerConfig;
    pluginHost: RunnerPluginHost;
    resolveEntityRulesProvider?: (workspaceName: string) => WorkspaceEntityRulesProvider | null;
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
