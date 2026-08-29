import type {AgentTool} from '@earendil-works/pi-agent-core';
import {createReactAgentRunner} from '../react_runner';
import type {AgentModelRuntime} from '../../model/runtime';
import {classifyAgentToolCall} from '../../tools/policy';
import {mergeAgentTraceSnapshots} from '../../trace/merge';
import type {AgentWorldRevision} from '../../trace/collector';
import type {AgentProgramExecutor} from './contracts';
import {createProgramExecutionTool, EXECUTE_PROGRAM_TOOL} from './tool';
import type {AgentRunner} from '../types';

export const PROGRAM_FIRST_SYSTEM_PROMPT = [
    'You are the planner and controller for a program-first browser automation agent.',
    'You may inspect the browser with the available read-only tools, but you must never perform browser mutations directly.',
    `All mutations must be expressed as DSL source and submitted through ${EXECUTE_PROGRAM_TOOL}.`,
    'The DSL supports query/let/compute, fill, click, control flow, checkpoints, output, and ensure invariants.',
    'Prefer logical queries or entity-rule references over fragile raw node identities when available.',
    'Put task values and explicit targets in the structured program input object rather than interpolating untrusted values into DSL source.',
    'For mutation tasks, encode a checkable postcondition with ensure when possible.',
    'A compile-invalid program may be revised and submitted again. After execution has started, do not start a fresh program: diagnosis, patching, rollback, rewind, and retry belong to the retained transactional debugger.',
    'Never claim a mutation succeeded unless execute_program reports completed. Read-only tasks may finish without executing a program.',
].join(' ');

export type CreateProgramFirstAgentRunnerOptions = {
    readTools: AgentTool[];
    executeProgram: AgentProgramExecutor;
    modelRuntime?: AgentModelRuntime;
    readWorldRevision?: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
};

export const createProgramFirstAgentRunner = (
    options: CreateProgramFirstAgentRunnerOptions,
): AgentRunner => ({
    run: async (request) => {
        if (request.source) {
            const program = await options.executeProgram({
                source: request.source,
                input: structuredClone(request.input ?? {}),
            }, request);
            return {
                provider: request.provider,
                model: request.model,
                text: program.text ?? program.error?.message ?? program.status,
                trace: program.trace ?? mergeAgentTraceSnapshots([]),
                executionMode: 'program',
                programs: [program],
            };
        }

        const execution = createProgramExecutionTool({request, execute: options.executeProgram});
        const planner = createReactAgentRunner({
            tools: [...options.readTools, execution.tool],
            modelRuntime: options.modelRuntime,
            readWorldRevision: options.readWorldRevision,
            classifyToolCall: (name, args) => name === EXECUTE_PROGRAM_TOOL
                ? 'control'
                : classifyAgentToolCall(name, args),
        });
        const result = await planner.run({
            ...request,
            systemPrompt: [PROGRAM_FIRST_SYSTEM_PROMPT, request.systemPrompt]
                .filter((value): value is string => Boolean(value))
                .join('\n\n'),
        });
        const programs = [...execution.attempts];
        return {
            ...result,
            trace: mergeAgentTraceSnapshots([
                result.trace,
                ...programs.flatMap((program) => program.trace ? [program.trace] : []),
            ]),
            executionMode: 'program',
            programs,
        };
    },
});
