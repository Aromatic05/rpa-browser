import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {createPausedDslDebugAgentTools, type PausedDslDebugAgentTools} from '../../debug/execution/agent_tools';
import {debuggerToolsForPause} from '../../debug/execution/agent_surface';
import type {DslDebugAdvanceResult} from '../../debug/execution/contracts';
import type {DebugEffectRecord} from '../../debug/effects/contracts';
import type {AgentWorldRevision} from '../../trace/collector';
import type {
    AgentProgramEffectSummary,
    AgentProgramExecutionSummary,
    AgentProgramPause,
} from '../types';
import {
    summarizePause,
    type AgentProgram,
    type AgentProgramContinuationExporter,
    type AgentProgramExecutionStart,
    type AgentProgramExecutor,
} from './contracts';

export const EXECUTE_PROGRAM_TOOL = 'agent.execute_program';

type ExecuteProgramInput = {
    source: string;
    input?: Record<string, unknown>;
};

type ProgramAttempt = Readonly<{
    start: AgentProgramExecutionStart;
    debugger?: PausedDslDebugAgentTools;
}>;

const parameters = Type.Unsafe<ExecuteProgramInput>({
    type: 'object',
    additionalProperties: false,
    required: ['source'],
    properties: {
        source: {type: 'string', minLength: 1},
        input: {type: 'object', additionalProperties: true},
    },
});

const toolResult = (details: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(details)}],
    details,
});

const effectSummaries = (attempt: ProgramAttempt): readonly AgentProgramEffectSummary[] =>
    attempt.start.debug?.session.auditEffects().map((record) => Object.freeze({
        sequence: record.sequence,
        stepName: record.effect.stepName,
        status: record.outcome.status,
        worldBefore: structuredClone(record.worldBefore.revision),
        worldAfter: structuredClone(record.worldAfter.revision),
        ...(record.compensates ? {compensates: record.compensates.effectSequence} : {}),
    })) ?? attempt.start.summary.effects ?? [];

const summarizeAttempt = (attempt: ProgramAttempt): AgentProgramExecutionSummary => {
    const materializedSource = attempt.start.debug
        ? attempt.start.debug.session.materializeProgram()
        : attempt.start.summary.source;
    if (!attempt.debugger || !attempt.start.debug) {
        return {...attempt.start.summary, materializedSource};
    }
    const pause = attempt.debugger.readPause();
    const terminal = attempt.debugger.readTerminal();
    const base = attempt.start.summary;
    const effects = effectSummaries(attempt);
    if (pause) {
        return {
            ...base,
            status: 'paused',
            materializedSource,
            effects,
            pause: summarizePause(pause),
        };
    }
    if (!terminal) {return {...base, materializedSource, effects};}
    if (terminal.status === 'completed') {
        return {
            ...base,
            status: 'completed',
            materializedSource,
            text: JSON.stringify(terminal.output),
            error: undefined,
            effects,
        };
    }
    if (terminal.status === 'failed') {
        return {
            ...base,
            status: 'failed',
            materializedSource,
            text: terminal.failure.message,
            error: {
                code: terminal.failure.code,
                message: terminal.failure.message,
                ...(terminal.failure.details === undefined ? {} : {details: terminal.failure.details}),
            },
            effects,
        };
    }
    return {
        ...base,
        status: 'aborted',
        materializedSource,
        text: 'program execution was aborted',
        error: {code: 'ERR_AGENT_PROGRAM_ABORTED', message: 'program execution was aborted'},
        effects,
    };
};

export type AgentProgramContinueResult =
    | Readonly<{status: 'paused'; pause: AgentProgramPause}>
    | Readonly<{status: 'completed'; output: Readonly<Record<string, unknown>>}>
    | Readonly<{status: 'failed'; failure: Readonly<{code: string; message: string}>}>
    | Readonly<{status: 'aborted'}>
    | Readonly<{status: 'conflict'}>;

export type ProgramExecutionToolController = Readonly<{
    tool: AgentTool;
    start: (program: AgentProgram) => Promise<AgentProgramExecutionSummary>;
    readAttempts: () => readonly AgentProgramExecutionSummary[];
    readLatest: () => AgentProgramExecutionSummary | null;
    readMaterializedSource: () => string | null;
    readDebugTools: () => readonly AgentTool[] | null;
    readPause: () => ReturnType<PausedDslDebugAgentTools['readPause']>;
    readWorldRevision: () => AgentWorldRevision | null;
    readEffects: () => readonly DebugEffectRecord[];
    hasStartedProgram: () => boolean;
    hasCompletedProgram: () => boolean;
    exportContinuationImage: () => unknown;
    continuePaused: () => Promise<AgentProgramContinueResult>;
}>;

export const createProgramExecutionTool = (options: {
    execute: AgentProgramExecutor;
    seed?: AgentProgramExecutionStart;
    exportContinuation?: AgentProgramContinuationExporter;
}): ProgramExecutionToolController => {
    const attempts: ProgramAttempt[] = [];
    const latest = (): ProgramAttempt | undefined => attempts.at(-1);
    const latestDebugger = (): PausedDslDebugAgentTools | null => latest()?.debugger ?? null;
    const latestPause = () => latestDebugger()?.readPause() ?? null;
    const retain = (executionStart: AgentProgramExecutionStart): ProgramAttempt => ({
        start: {
            ...executionStart,
            summary: {
                ...executionStart.summary,
                input: structuredClone(executionStart.summary.input),
            },
        },
        ...(executionStart.debug
            ? {debugger: createPausedDslDebugAgentTools(executionStart.debug.session, executionStart.debug.pause)}
            : {}),
    });
    if (options.seed) {attempts.push(retain(options.seed));}
    const start = async (program: AgentProgram): Promise<AgentProgramExecutionSummary> => {
        const previous = latest();
        if (previous && summarizeAttempt(previous).status !== 'invalid') {
            throw new Error('a program execution already started; repair or rollback must remain inside its retained transaction');
        }
        const executionStart: AgentProgramExecutionStart = await options.execute({
            source: program.source,
            input: structuredClone(program.input),
        });
        const attempt = retain({
            ...executionStart,
            summary: {...executionStart.summary, input: structuredClone(program.input)},
        });
        attempts.push(attempt);
        return summarizeAttempt(attempt);
    };
    const tool: AgentTool = {
        name: EXECUTE_PROGRAM_TOOL,
        label: EXECUTE_PROGRAM_TOOL,
        description: 'Execute one browser DSL program inside a retained transaction. Browser mutations are allowed only here. A compile-invalid program may be corrected and resubmitted. Once execution starts, this same Agent session receives debug.* control tools for the retained transaction; do not submit a second program.',
        parameters,
        execute: async (_toolCallId, params) => {
            const input = params as ExecuteProgramInput;
            const source = input.source.trim();
            if (!source) {throw new Error('program source is required');}
            const summary = await start({
                source,
                input: structuredClone(input.input ?? {}),
            });
            const pause = latestDebugger()?.readPause();
            return toolResult({
                status: summary.status,
                ...(summary.text ? {text: summary.text} : {}),
                ...(summary.error ? {error: summary.error} : {}),
                ...(pause ? {pause: {reason: pause.reason, location: pause.location}} : {}),
                effects: summary.effects,
            });
        },
    };
    return {
        tool,
        start,
        readAttempts: () => attempts.map(summarizeAttempt),
        readLatest: () => {
            const attempt = latest();
            return attempt ? summarizeAttempt(attempt) : null;
        },
        readMaterializedSource: () => {
            const attempt = latest();
            return attempt ? summarizeAttempt(attempt).materializedSource ?? null : null;
        },
        readDebugTools: () => {
            const debuggerTools = latestDebugger();
            const pause = latestPause();
            return debuggerTools && pause ? debuggerToolsForPause(debuggerTools.tools, pause) : null;
        },
        readPause: latestPause,
        readWorldRevision: () => latestDebugger()?.readWorldRevision() ?? null,
        readEffects: () => latest()?.start.debug?.session.auditEffects() ?? [],
        hasStartedProgram: () => attempts.some((attempt) => summarizeAttempt(attempt).status !== 'invalid'),
        hasCompletedProgram: () => latest() ? summarizeAttempt(latest()!).status === 'completed' : false,
        exportContinuationImage: () => {
            const attempt = latest();
            if (!attempt || !options.exportContinuation) {
                throw new Error('retained program continuation is not durably exportable');
            }
            return options.exportContinuation(attempt.start);
        },
        continuePaused: async () => {
            const attempt = latest();
            const debuggerTools = attempt?.debugger;
            const pause = debuggerTools?.readPause();
            if (!attempt || !debuggerTools || !pause) {
                throw new Error('no retained paused program to continue');
            }
            if (pause.reason === 'failure') {
                throw new Error('failure pauses are not resumable by approval');
            }
            const toolName = pause.reason === 'barrier' ? 'debug.cross_barrier' : 'debug.continue';
            const tool = debuggerTools.tools.find((candidate) => candidate.name === toolName);
            if (!tool) {throw new Error(`retained execution has no ${toolName} tool`);}
            const outcome = await tool.execute('hitl-approval', {});
            const details = outcome.details as DslDebugAdvanceResult;
            if (details.status === 'paused' || details.status === 'barrier' || details.status === 'recompute_required') {
                return {status: 'paused' as const, pause: summarizePause(details.pause)};
            }
            if (details.status === 'completed') {return {status: 'completed' as const, output: details.output};}
            if (details.status === 'failed') {
                return {status: 'failed' as const, failure: {code: details.failure.code, message: details.failure.message}};
            }
            if (details.status === 'conflict') {return {status: 'conflict' as const};}
            return {status: 'aborted' as const};
        },
    };
};
