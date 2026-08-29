import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {createPausedDslDebugAgentTools, type PausedDslDebugAgentTools} from '../../debug/execution/agent_tools';
import {debuggerToolsForPause} from '../../debug/execution/agent_surface';
import type {AgentWorldRevision} from '../../trace/collector';
import type {
    AgentProgramEffectSummary,
    AgentProgramExecutionSummary,
} from '../types';
import type {AgentProgram, AgentProgramExecutionStart, AgentProgramExecutor} from './contracts';

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
        ...(record.compensates ? {compensates: record.compensates.effectSequence} : {}),
    })) ?? attempt.start.summary.effects ?? [];

const summarizeAttempt = (attempt: ProgramAttempt): AgentProgramExecutionSummary => {
    if (!attempt.debugger || !attempt.start.debug) {return attempt.start.summary;}
    const pause = attempt.debugger.readPause();
    const terminal = attempt.debugger.readTerminal();
    const base = attempt.start.summary;
    const effects = effectSummaries(attempt);
    if (pause) {return {...base, status: 'paused', effects};}
    if (!terminal) {return {...base, effects};}
    if (terminal.status === 'completed') {
        return {
            ...base,
            status: 'completed',
            text: JSON.stringify(terminal.output),
            error: undefined,
            effects,
        };
    }
    if (terminal.status === 'failed') {
        return {
            ...base,
            status: 'failed',
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
        text: 'program execution was aborted',
        error: {code: 'ERR_AGENT_PROGRAM_ABORTED', message: 'program execution was aborted'},
        effects,
    };
};

export type ProgramExecutionToolController = Readonly<{
    tool: AgentTool;
    start: (program: AgentProgram) => Promise<AgentProgramExecutionSummary>;
    readAttempts: () => readonly AgentProgramExecutionSummary[];
    readDebugTools: () => readonly AgentTool[] | null;
    readPause: () => ReturnType<PausedDslDebugAgentTools['readPause']>;
    readWorldRevision: () => AgentWorldRevision | null;
    hasStartedProgram: () => boolean;
}>;

export const createProgramExecutionTool = (options: {
    execute: AgentProgramExecutor;
}): ProgramExecutionToolController => {
    const attempts: ProgramAttempt[] = [];
    const latest = (): ProgramAttempt | undefined => attempts.at(-1);
    const latestDebugger = (): PausedDslDebugAgentTools | null => latest()?.debugger ?? null;
    const latestPause = () => latestDebugger()?.readPause() ?? null;
    const start = async (program: AgentProgram): Promise<AgentProgramExecutionSummary> => {
        const previous = latest();
        if (previous && summarizeAttempt(previous).status !== 'invalid') {
            throw new Error('a program execution already started; repair or rollback must remain inside its retained transaction');
        }
        const executionStart = await options.execute(program);
        const attempt: ProgramAttempt = {
            start: executionStart,
            ...(executionStart.debug
                ? {debugger: createPausedDslDebugAgentTools(executionStart.debug.session, executionStart.debug.pause)}
                : {}),
        };
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
        readDebugTools: () => {
            const debuggerTools = latestDebugger();
            const pause = latestPause();
            return debuggerTools && pause ? debuggerToolsForPause(debuggerTools.tools, pause) : null;
        },
        readPause: latestPause,
        readWorldRevision: () => latestDebugger()?.readWorldRevision() ?? null,
        hasStartedProgram: () => attempts.some((attempt) => summarizeAttempt(attempt).status !== 'invalid'),
    };
};
