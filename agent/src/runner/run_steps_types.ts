import type { StepName, StepResult as ExecStepResult, StepUnion } from './steps/types';
import type { Checkpoint as RunnerCheckpoint } from './checkpoint/types';
import type { RuntimeRegistry } from '../runtime/runtime_registry';
import type { RunnerPluginHost } from './hotreload/plugin_host';
import type { RunnerConfig } from '../config';

export type StepEvent =
    | {
          type: 'step.start';
          ts: number;
          workspaceId: string;
          stepId: string;
          name: StepName;
          argsSummary?: unknown;
      }
    | {
          type: 'step.end';
          ts: number;
          workspaceId: string;
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
};

export type SignalChannel = {
    items: Array<{ signal: RunSignal; ts: number; priority: number }>;
    cursor: number;
};

export type Checkpoint = {
    runId: string;
    workspaceId: string;
    status: RunStatus;
    cursor: number;
    updatedAt: number;
};

export type RunStepsDeps = {
    runtime: RuntimeRegistry;
    stepSinks?: StepSink[];
    config: RunnerConfig;
    pluginHost: RunnerPluginHost;
};

export type RunStepsRequest = {
    runId: string;
    workspaceId: string;
    stepsQueue: StepsQueue;
    resultPipe: ResultPipe;
    signalChannel: SignalChannel;
    stopOnError?: boolean;
    onCheckpoint?: (checkpoint: Checkpoint) => void | Promise<void>;
    checkpoints?: RunnerCheckpoint[];
    checkpointEnabled?: boolean;
    checkpointMaxAttempts?: number;
};
