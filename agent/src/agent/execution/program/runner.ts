import type {AgentTool} from '@earendil-works/pi-agent-core';
import {createReactAgentRunner} from '../react_runner';
import type {AgentModelRuntime} from '../../model/runtime';
import {classifyAgentToolCall} from '../../tools/policy';
import {classifyPausedDslDebugToolCall} from '../../debug/execution/tool_policy';
import {compactDebuggerSystemPromptForPause} from '../../debug/execution/agent_surface';
import {mergeAgentTraceSnapshots} from '../../trace/merge';
import type {AgentWorldRevision} from '../../trace/collector';
import type {AgentProgramExecutor} from './contracts';
import {createProgramExecutionTool, EXECUTE_PROGRAM_TOOL, type ProgramExecutionToolController} from './tool';
import type {AgentProgramSaver} from './persistence';
import {createProgramSaveTool, SAVE_PROGRAM_TOOL} from './save_tool';
import type {AgentProgramLibrary} from './library';
import {createProgramLibraryTools, LIST_PROGRAMS_TOOL, LOAD_PROGRAM_TOOL} from './library_tools';
import {PROGRAM_DSL_AUTHORING_GUIDE} from './authoring';
import type {AgentRunRequest, AgentRunner} from '../types';

export const PROGRAM_FIRST_SYSTEM_PROMPT = [
    'You are the planner and controller for a program-first browser automation agent.',
    'You may inspect the browser with the available read-only tools, but you must never perform browser mutations directly.',
    `All mutations must be expressed as DSL source and submitted through ${EXECUTE_PROGRAM_TOOL}.`,
    'The DSL supports query/let/compute, fill, click, control flow, checkpoints, output, and ensure invariants.',
    'Prefer logical queries or entity-rule references over fragile raw node identities when available.',
    'For a normal single-page task, inspect the active page directly; do not list tabs unless tab identity matters.',
    'Treat browser.snapshot as the default first read. Do not follow it with browser.get_page_info unless page metadata is actually needed.',
    'Never guess a businessTag. If the page has no explicit business annotation, resolve an observed DOM/ARIA target with browser.capture_resolve instead of browser.query.',
    'Put task values and explicit targets in the structured program input object rather than interpolating untrusted values into DSL source.',
    'For mutation tasks, encode a checkable postcondition with ensure when possible.',
    'A compile-invalid program may be revised and submitted again. After execution has started, do not start a fresh program: diagnosis, patching, rollback, rewind, and retry stay in the same retained transaction through debug.* tools.',
    'Never claim a mutation succeeded unless the retained program reports completed and the resulting browser state is verified when practical.',
    `Program source is never persisted automatically. If and only if the user explicitly asks to save or publish the completed Program, use ${SAVE_PROGRAM_TOOL} after completion.`,
    `Use ${LIST_PROGRAMS_TOOL} and ${LOAD_PROGRAM_TOOL} to inspect persisted workspace DSL Programs. To edit one, load its source and artifactRevision, submit the edited source through ${EXECUTE_PROGRAM_TOOL}, verify it, then use ${SAVE_PROGRAM_TOOL} with the loaded artifactRevision only when the user explicitly requested overwrite/publish.`,
    PROGRAM_DSL_AUTHORING_GUIDE,
].join(' ');

const TERMINAL_PROGRAM_PROMPT = [
    'You are verifying the result of a program-first browser task. The retained program transaction is terminal.',
    'Do not start another program.',
    `Use browser read tools to verify the resulting state. ${SAVE_PROGRAM_TOOL} may also be available, but call it only when the user explicitly asked to save or publish this Program.`,
    'A save conflict returns currentRevision without writing. Do not overwrite an existing artifact unless the user requested that overwrite; an approved retry must pass the observed currentRevision as expectedRevision.',
].join(' ');

const ACTIVE_PROGRAM_CONTROL_PROMPT = [
    'You are controlling the retained transaction for the user task.',
    'Do not generate or submit a second program.',
    'Use only the available debug.* controls to decide how the current retained execution should proceed.',
].join(' ');

export type CreateProgramFirstAgentRunnerOptions = {
    readTools: AgentTool[];
    executeProgram: AgentProgramExecutor;
    programLibrary?: AgentProgramLibrary;
    saveProgram?: AgentProgramSaver;
    modelRuntime?: AgentModelRuntime;
    readWorldRevision?: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
};

const requestSystemPrompt = (request: AgentRunRequest): string => [
    PROGRAM_FIRST_SYSTEM_PROMPT,
    request.systemPrompt,
].filter((value): value is string => Boolean(value)).join('\n\n');

const controlSystemPrompt = (
    execution: ProgramExecutionToolController,
    request: AgentRunRequest,
): string => {
    const pause = execution.readPause();
    if (!pause) {return ACTIVE_PROGRAM_CONTROL_PROMPT;}
    return [
        ACTIVE_PROGRAM_CONTROL_PROMPT,
        request.systemPrompt,
        compactDebuggerSystemPromptForPause(pause),
    ].filter((value): value is string => Boolean(value)).join('\n\n');
};

const classifyProgramToolCall = (name: string, args: unknown) => {
    if (name === EXECUTE_PROGRAM_TOOL || name === SAVE_PROGRAM_TOOL) {return 'control' as const;}
    if (name === LIST_PROGRAMS_TOOL || name === LOAD_PROGRAM_TOOL) {return 'read' as const;}
    if (name.startsWith('debug.')) {return classifyPausedDslDebugToolCall(name);}
    return classifyAgentToolCall(name, args);
};

const readProgramWorldRevision = async (
    execution: ProgramExecutionToolController,
    fallback?: CreateProgramFirstAgentRunnerOptions['readWorldRevision'],
): Promise<AgentWorldRevision | null> => {
    const debugRevision = execution.readWorldRevision();
    if (debugRevision) {return debugRevision;}
    return fallback ? await fallback() : null;
};

const prepareProgramContext = (
    execution: ProgramExecutionToolController,
    planningTools: readonly AgentTool[],
    terminalTools: readonly AgentTool[],
    request: AgentRunRequest,
) => ({context}: Parameters<NonNullable<Parameters<typeof createReactAgentRunner>[0]['prepareNextTurnWithContext']>>[0]) => {
    const debugTools = execution.readDebugTools();
    if (debugTools) {
        return {
            context: {
                ...context,
                tools: [...debugTools],
                systemPrompt: controlSystemPrompt(execution, request),
            },
        };
    }
    if (execution.hasStartedProgram()) {
        return {
            context: {
                ...context,
                tools: [...terminalTools],
                systemPrompt: [TERMINAL_PROGRAM_PROMPT, request.systemPrompt]
                    .filter((value): value is string => Boolean(value))
                    .join('\n\n'),
            },
        };
    }
    return {
        context: {
            ...context,
            tools: [...planningTools],
            systemPrompt: requestSystemPrompt(request),
        },
    };
};

export const createProgramFirstAgentRunner = (
    options: CreateProgramFirstAgentRunnerOptions,
): AgentRunner => ({
    run: async (request) => {
        const execution = createProgramExecutionTool({execute: options.executeProgram});
        const save = options.saveProgram
            ? createProgramSaveTool({execution, save: options.saveProgram})
            : null;
        const libraryTools = options.programLibrary
            ? createProgramLibraryTools(options.programLibrary)
            : [];
        const planningTools = [...options.readTools, ...libraryTools, execution.tool];
        const terminalTools = [...options.readTools, ...libraryTools, ...(save ? [save.tool] : [])];

        if (request.source) {
            const first = await execution.start({
                source: request.source,
                input: structuredClone(request.input ?? {}),
            });
            if (first.status !== 'paused') {
                return {
                    provider: request.provider,
                    model: request.model,
                    text: first.text ?? first.error?.message ?? first.status,
                    trace: mergeAgentTraceSnapshots([]),
                    executionMode: 'program',
                    programs: execution.readAttempts(),
                };
            }
            const debugTools = execution.readDebugTools();
            if (!debugTools) {throw new Error('program paused without debugger tools');}
            const runner = createReactAgentRunner({
                tools: [...debugTools],
                modelRuntime: options.modelRuntime,
                classifyToolCall: classifyProgramToolCall,
                readWorldRevision: () => readProgramWorldRevision(execution, options.readWorldRevision),
                prepareNextTurnWithContext: prepareProgramContext(
                    execution,
                    planningTools,
                    terminalTools,
                    request,
                ),
            });
            const result = await runner.run({
                ...request,
                systemPrompt: controlSystemPrompt(execution, request),
            });
            return {
                ...result,
                executionMode: 'program',
                programs: execution.readAttempts(),
                ...(save && save.readSaved().length > 0 ? {savedPrograms: save.readSaved()} : {}),
            };
        }

        const runner = createReactAgentRunner({
            tools: planningTools,
            modelRuntime: options.modelRuntime,
            readWorldRevision: () => readProgramWorldRevision(execution, options.readWorldRevision),
            classifyToolCall: classifyProgramToolCall,
            prepareNextTurnWithContext: prepareProgramContext(
                execution,
                planningTools,
                terminalTools,
                request,
            ),
        });
        const result = await runner.run({
            ...request,
            systemPrompt: requestSystemPrompt(request),
        });
        return {
            ...result,
            executionMode: 'program',
            programs: execution.readAttempts(),
            ...(save && save.readSaved().length > 0 ? {savedPrograms: save.readSaved()} : {}),
        };
    },
});
