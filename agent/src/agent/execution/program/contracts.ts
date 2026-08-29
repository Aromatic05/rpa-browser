import type {DslDebugExecutionSession, PausedDslDebugExecution} from '../../debug/execution/contracts';
import type {AgentProgramExecutionSummary, AgentProgramPause} from '../types';

export type AgentProgram = Readonly<{
    source: string;
    input: Readonly<Record<string, unknown>>;
}>;

export type AgentProgramDebugHandle = Readonly<{
    session: DslDebugExecutionSession;
    pause: PausedDslDebugExecution;
}>;

export type AgentProgramExecutionStart = Readonly<{
    summary: AgentProgramExecutionSummary;
    debug?: AgentProgramDebugHandle;
}>;

export type AgentProgramExecutor = (
    program: AgentProgram,
) => Promise<AgentProgramExecutionStart>;

export const summarizePause = (pause: PausedDslDebugExecution): AgentProgramPause => {
    if (pause.reason === 'barrier' || pause.reason === 'effect') {
        return Object.freeze({
            reason: pause.reason,
            continuationId: pause.continuationId,
            stepName: pause.effect.stepName,
            risk: pause.effect.semantics.reversibility,
        });
    }
    if (pause.reason === 'failure') {
        return Object.freeze({
            reason: 'failure',
            continuationId: pause.continuationId,
            failure: Object.freeze({code: pause.failure.code, message: pause.failure.message}),
        });
    }
    return Object.freeze({
        reason: 'statement',
        continuationId: pause.continuationId,
    });
};
