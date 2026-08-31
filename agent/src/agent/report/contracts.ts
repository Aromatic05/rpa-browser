import type {AgentProgramExecutionSummary} from '../execution/types';
import type {AgentToolClassification} from '../tools/policy';

export const AGENT_RUN_REPORT_SCHEMA = 'rpa.agent.run-report' as const;
export const AGENT_RUN_REPORT_SCHEMA_VERSION = 1 as const;

export type AgentRunReportSchemaId = `${typeof AGENT_RUN_REPORT_SCHEMA}/${typeof AGENT_RUN_REPORT_SCHEMA_VERSION}`;

export const AGENT_RUN_REPORT_SCHEMA_ID: AgentRunReportSchemaId = `${AGENT_RUN_REPORT_SCHEMA}/${AGENT_RUN_REPORT_SCHEMA_VERSION}`;

export type AgentReportExecutionMode = 'program' | 'react-baseline' | 'unknown';

export type AgentReportWorldRevision = Readonly<{
    pageEpoch: string;
    captureRevision: number;
}>;

export type AgentReportObservedWorldRevision = Readonly<{
    pageEpoch: string;
    captureRevision: number;
    freshness: 'missing' | 'dirty' | 'navigation' | 'fresh';
}>;

export type AgentReportError = Readonly<{
    code: string;
    message: string;
    details?: unknown;
}>;

export type AgentReportTerminalStatus =
    | 'completed'
    | 'paused'
    | 'failed'
    | 'aborted'
    | 'invalid';

export type AgentReportTerminal = Readonly<{
    status: AgentReportTerminalStatus;
    output?: string;
    error?: AgentReportError;
}>;

export type AgentReportRepairMetrics = Readonly<{
    rewindCalls: number;
    rollbackCalls: number;
    patchCalls: number;
    recomputeCalls: number;
    refreshCalls: number;
}>;

export type AgentReportToolMetrics = Readonly<{
    turns: number;
    toolCalls: number;
    readCalls: number;
    controlCalls: number;
    effectCalls: number;
    failedToolCalls: number;
    postErrorEffectCalls: number;
    repair: AgentReportRepairMetrics;
}>;

export type AgentReportToolCall = Readonly<{
    toolCallId: string;
    toolName: string;
    classification: AgentToolClassification;
    isError: boolean | null;
    startedAt: number;
    endedAt?: number;
    durationMs: number | null;
    args: unknown;
    redactedPaths: readonly string[];
    worldBefore: AgentReportObservedWorldRevision | null;
    worldAfter: AgentReportObservedWorldRevision | null;
}>;

export type AgentReportWorld = Readonly<{
    revisionsObserved: readonly AgentReportWorldRevision[];
}>;

export type AgentReportEffectStatus = 'succeeded' | 'failed';

export type AgentReportEffect = Readonly<{
    programIndex: number;
    sequence: number;
    stepName: string;
    status: AgentReportEffectStatus;
    worldChanged: boolean;
    worldBefore: AgentReportWorldRevision;
    worldAfter: AgentReportWorldRevision;
    compensates?: number;
    compensatedBy: readonly number[];
}>;

export type AgentReportEffectsAvailability = 'program-journal' | 'not-exposed';

export type AgentReportEffects = Readonly<{
    availability: AgentReportEffectsAvailability;
    worldEffectCalls: number | null;
    failedWorldChangingEffects: readonly AgentReportEffect[];
    compensationEffects: readonly AgentReportEffect[];
    records: readonly AgentReportEffect[];
}>;

export type AgentReportProgramStatus = AgentProgramExecutionSummary['status'];

export type AgentReportProgram = Readonly<{
    index: number;
    status: AgentReportProgramStatus;
    source: string;
    materializedSource?: string;
    inputKeys: readonly string[];
    output?: string;
    error?: AgentReportError;
    effectsExposed: boolean;
    effectCount: number | null;
}>;

export type AgentReportSavedArtifact = Readonly<{
    kind: 'program';
    name: string;
    artifactRevision: string;
}>;

export type AgentReportContextTurn = Readonly<{
    turn: number;
    chars: number;
    bytes: number;
    exceededBudget?: boolean;
}>;

export type AgentReportContextMetrics = Readonly<{
    lastChars: number;
    lastBytes: number;
    peakChars: number;
    peakBytes: number;
    turns: readonly AgentReportContextTurn[];
}>;

export type AgentRunReport = Readonly<{
    schema: typeof AGENT_RUN_REPORT_SCHEMA;
    schemaVersion: typeof AGENT_RUN_REPORT_SCHEMA_VERSION;
    run: Readonly<{
        provider: string;
        model: string;
        executionMode: AgentReportExecutionMode;
    }>;
    terminal: AgentReportTerminal;
    toolMetrics: AgentReportToolMetrics;
    world: AgentReportWorld;
    toolCalls: readonly AgentReportToolCall[];
    effects: AgentReportEffects;
    programs: readonly AgentReportProgram[];
    savedArtifacts: readonly AgentReportSavedArtifact[];
    context?: AgentReportContextMetrics;
    generatedAt?: string;
}>;

export type AgentRunReportOptions = Readonly<{
    generatedAt?: string;
}>;
