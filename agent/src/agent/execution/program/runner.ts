import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {
    AgentEvent,
    AgentMessage,
    AgentOptions,
    BeforeToolCallContext,
    PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core';
import {contentText, Type, type ToolResultMessage} from '@earendil-works/pi-ai';
import type {createReactAgentRunner, GovernedAgentRunResult} from '../react_runner';
import {createReactAgentSession, type ReactAgentSession} from '../../loop/react';
import {validateModelRequestedInteraction, type ModelRequestedInteraction} from '../../interaction';
import type {AgentModelRuntime} from '../../model/runtime';
import {getDefaultAgentModelRuntime} from '../../model/runtime';
import {classifyAgentToolCall, type AgentToolClassification} from '../../tools/policy';
import {classifyPausedDslDebugToolCall} from '../../debug/execution/tool_policy';
import {compactDebuggerSystemPromptForPause} from '../../debug/execution/agent_surface';
import {mergeAgentTraceSnapshots} from '../../trace/merge';
import {createAgentTraceCollector, type AgentWorldRevision} from '../../trace/collector';
import {
    createGovernanceController,
    SAFE_UNATTENDED_POLICY,
    type EffectObservation,
    type GovernanceController,
    type GovernancePolicy,
    type GovernanceStopReason,
} from '../../governance';
import {
    AgentContextBudgetExceededError,
    createAgentContextAccountant,
    type RunnerContextBudget,
} from '../../tools/context/budget';
import {measureProviderVisibleContext} from '../../tools/context/measure';
import {createRecoveryBudgetStore} from '../../debug/recovery/budget';
import {recoveryBudgetKey} from '../../debug/recovery/key';
import type {
    RecoveryBudgetAction,
    RecoveryBudgetLimits,
    RecoveryContext,
} from '../../debug/recovery/contracts';
import type {AgentProgramExecutor, AgentProgramExecutionStart} from './contracts';
import {createProgramExecutionTool, EXECUTE_PROGRAM_TOOL, type ProgramExecutionToolController} from './tool';
import type {AgentProgramSaver} from './persistence';
import {createProgramSaveTool, SAVE_PROGRAM_TOOL} from './save_tool';
import type {AgentProgramLibrary} from './library';
import {createProgramLibraryTools, LIST_PROGRAMS_TOOL, LOAD_PROGRAM_TOOL} from './library_tools';
import {PROGRAM_DSL_AUTHORING_GUIDE} from './authoring';
import {createKnowledgeTools, KNOWLEDGE_CATALOG_TOOL, KNOWLEDGE_INSPECT_TOOL} from '../knowledge';
import type {KnowledgeSeamDeps} from '../knowledge';
import type {
    AgentControlInput,
    AgentRunContinuation,
    AgentRunRequest,
} from '../types';

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
    `Prefer the workspace knowledge assets over raw selector guessing. Call ${KNOWLEDGE_CATALOG_TOOL} (read-only, explicit) to discover healthy Procedures and Page Knowledge assets relevant to the task before authoring. Then, for the assets you will reference, call ${KNOWLEDGE_INSPECT_TOOL} to read a Procedure input/output signature and its dependencies, requesting the DSL body only when you actually need to understand the implementation by passing includeBody: true, or to read a Page Knowledge sanitized entity schema.`,
    'Reference discovered assets directly in a SMALL top-level DSL: import a Page Knowledge profile with `use entity_rules "PROFILE" as alias`, call a Procedure with `use checkpoint "PROCEDURE" with { key: input.value }`, and keep concrete values in the structured program input. Never inline an inspected Procedure body or re-derive clone logic from it: reference it by its stable id.',
    'Do not guess businessTags, entity keys, field keys or action intents; take them exactly from an inspected Page Knowledge schema. Recovery applies automatically at runtime and Demonstration is replay-only: never load or replay them from the model.',
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
    knowledge?: KnowledgeSeamDeps;
    modelRuntime?: AgentModelRuntime;
    readWorldRevision?: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
    governancePolicy?: GovernancePolicy;
    governanceController?: GovernanceController;
    recoveryBudgetLimits?: RecoveryBudgetLimits;
    signal?: AbortSignal;
};

export type ProgramFirstAgentRunner = {
    run: (request: AgentRunRequest) => Promise<ProgramFirstAgentRunResult>;
    restore: (request: AgentRunRequest, start: AgentProgramExecutionStart) => Promise<ProgramFirstAgentRunResult>;
};

export type ProgramFirstAgentRunResult = GovernedAgentRunResult & {
    executionMode: 'program';
};

const requestSystemPrompt = (request: AgentRunRequest): string => [
    PROGRAM_FIRST_SYSTEM_PROMPT,
    request.systemPrompt,
].filter((value): value is string => Boolean(value)).join('\n\n');

const controlSystemPrompt = (
    execution: ProgramExecutionToolController,
    request: AgentRunRequest,
    recovery: () => RecoveryContext,
): string => {
    const pause = execution.readPause();
    if (!pause) {return ACTIVE_PROGRAM_CONTROL_PROMPT;}
    return [
        ACTIVE_PROGRAM_CONTROL_PROMPT,
        request.systemPrompt,
        compactDebuggerSystemPromptForPause(pause, recovery()),
    ].filter((value): value is string => Boolean(value)).join('\n\n');
};

export const REQUEST_INTERACTION_TOOL = 'agent.request_interaction';

/**
 * Model-facing discriminator. Only the three allowed kinds are expressible;
 * `approval` is structurally absent because it is generated solely from an
 * objectively detected irreversible barrier. Every branch is closed
 * (`additionalProperties:false`) so no session/run/continuation/internal id can
 * be smuggled through the tool arguments. `validateModelRequestedInteraction`
 * remains the authoritative runtime validator.
 */
export const requestInteractionSchema = Type.Unsafe<Record<string, unknown>>({
    type: 'object',
    required: ['kind'],
    oneOf: [
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'question', 'schema'],
            properties: {
                kind: {const: 'clarification'},
                question: {type: 'string', minLength: 1},
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['field', 'type'],
                    properties: {
                        field: {type: 'string', minLength: 1},
                        type: {enum: ['text', 'number', 'date', 'select']},
                        allowed: {type: 'array', items: {type: 'string'}},
                        min: {type: 'number'},
                        max: {type: 'number'},
                        maxLength: {type: 'number'},
                        default: {},
                        safeOnTimeout: {type: 'boolean'},
                    },
                },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'failureSummary', 'options'],
            properties: {
                kind: {const: 'recovery_decision'},
                failureSummary: {type: 'string', minLength: 1},
                options: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['id', 'kind', 'label', 'eligible'],
                        properties: {
                            id: {type: 'string', minLength: 1},
                            kind: {enum: ['retry', 'repair', 'rollback', 'rewind', 'terminate']},
                            label: {type: 'string', minLength: 1},
                            eligible: {type: 'boolean'},
                            block: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['code', 'message'],
                                properties: {
                                    code: {type: 'string', minLength: 1},
                                    message: {type: 'string', minLength: 1},
                                },
                            },
                        },
                    },
                },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'reason', 'guidanceModes'],
            properties: {
                kind: {const: 'takeover'},
                reason: {type: 'string', minLength: 1},
                scope: {enum: ['workspace', 'tab']},
                guidanceModes: {type: 'array', minItems: 1, items: {enum: ['manual', 'teach', 'annotate']}},
                teachKind: {enum: ['procedure', 'recovery', 'demonstration']},
            },
        },
    ],
});

/**
 * Read/control-only request seam: the model asks for a bounded human
 * interaction (clarification / recovery decision / takeover) instead of a
 * generic message. It is intercepted in `beforeToolCall` and never executes; an
 * invalid payload is blocked with the validation error so the model can retry,
 * a valid payload pauses the run and the SessionManager creates the typed
 * InteractionRecord. It exposes no session/run/continuation ids to the model.
 */
export const requestInteractionTool: AgentTool = {
    name: REQUEST_INTERACTION_TOOL,
    label: REQUEST_INTERACTION_TOOL,
    description: [
        'Request a structured user interaction. Use it only when the task genuinely requires bounded human input:',
        '"clarification" (missing bounded information with a schema),',
        '"recovery_decision" (a failed step needs human judgment between explicit backend options), or',
        '"takeover" (manual/teach/annotate guidance such as 2FA).',
        'The task pauses for the user and resumes from the SAME retained execution after the answer.',
        '"approval" cannot be requested; it is generated only when an objectively irreversible effect is detected.',
        'Do not use it for routine recoverable DOM drift or to ask open-ended questions.',
    ].join(' '),
    parameters: requestInteractionSchema,
    execute: async () => {
        throw new Error(`${REQUEST_INTERACTION_TOOL} is intercepted before execution and pauses the task`);
    },
};

const tryValidateInteractionRequest = (
    args: unknown,
): {ok: true; payload: ModelRequestedInteraction} | {ok: false; error: string} => {
    try {
        return {ok: true, payload: validateModelRequestedInteraction(args)};
    } catch (error) {
        return {ok: false, error: error instanceof Error ? error.message : String(error)};
    }
};

const classifyProgramToolCall = (name: string, args: unknown) => {
    if (name === EXECUTE_PROGRAM_TOOL || name === SAVE_PROGRAM_TOOL || name === REQUEST_INTERACTION_TOOL) {return 'control' as const;}
    if (name === LIST_PROGRAMS_TOOL || name === LOAD_PROGRAM_TOOL || name === KNOWLEDGE_CATALOG_TOOL || name === KNOWLEDGE_INSPECT_TOOL) {return 'read' as const;}
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

const retainedContinuation = (
    execution: ProgramExecutionToolController,
    request: AgentRunRequest,
): AgentRunContinuation => ({
    // Export lazily at Session settle time so the image always describes the
    // current pause. Unsupported pauses return undefined and are deliberately
    // non-durable rather than capturing an older barrier.
    exportImage: () => safeExportContinuation(execution),
    resume: async () => {
        const outcome = await execution.continuePaused();
        const base = {
            provider: request.provider,
            model: request.model,
            text: '',
            trace: mergeAgentTraceSnapshots([]),
            executionMode: 'program' as const,
            programs: execution.readAttempts(),
        };
        if (outcome.status === 'completed') {
            return {...base, text: JSON.stringify(outcome.output)};
        }
        if (outcome.status === 'failed') {
            return {...base, text: outcome.failure.message};
        }
        if (outcome.status === 'aborted') {
            return {...base, text: 'program execution was aborted'};
        }
        if (outcome.status === 'conflict') {
            throw Object.assign(
                new Error('retained program continuation conflicted with the pinned world'),
                {code: 'ERR_AGENT_PROGRAM_CONFLICT'},
            );
        }
        return withContinuation(base, execution, request);
    },
});

const safeExportContinuation = (execution: ProgramExecutionToolController): unknown => {
    try { return execution.exportContinuationImage(); } catch { return undefined; }
};

const withContinuation = (
    base: ProgramFirstAgentRunResult,
    execution: ProgramExecutionToolController,
    request: AgentRunRequest,
): ProgramFirstAgentRunResult => {
    const pause = execution.readPause();
    if (!pause || pause.reason === 'failure') {return base;}
    return {...base, continuation: retainedContinuation(execution, request)};
};

const lastAssistantText = (messages: readonly unknown[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {role?: string; content?: unknown};
        if (message.role !== 'assistant' || !message.content) {continue;}
        return contentText(message.content as Parameters<typeof contentText>[0]);
    }
    return '';
};

const controlMessageFromInput = (input: AgentControlInput): AgentMessage => {
    let text: string;
    switch (input.kind) {
        case 'deny': {
            const alternative = input.requestedAlternative
                ? ` The user requested the alternative: "${input.requestedAlternative}".`
                : '';
            text = [
                `The user denied the pending effect "${input.effectName}".`,
                `Reason: ${input.reason}.`,
                `Choose a compliant alternative, ask for the missing information, or conclude that the task cannot be completed.`,
                `The denied effect MUST NOT be executed.${alternative}`,
            ].join(' ');
            break;
        }
        case 'clarification-answer': {
            text = [
                `The user answered the clarification "${input.question}" with:`,
                JSON.stringify(input.answer),
                'Continue the same task using this bounded answer.',
            ].join(' ');
            break;
        }
        case 'recovery-choice': {
            text = [
                `The user chose recovery option "${input.optionLabel}" (${input.optionId}).`,
                'Execute exactly that option against the retained run, then continue the task.',
            ].join(' ');
            break;
        }
        case 'takeover-return': {
            text = [
                'The user returned control after manual/teach/annotate guidance.',
                ...(input.savedReference ? [`A saved asset reference is available: ${input.savedReference}.`] : []),
                'Force a fresh World observation, refresh applicable semantic bindings, and replan from the current state.',
                'Do NOT replay effects assumed under the pre-guidance World revision.',
            ].join(' ');
            break;
        }
        case 'interaction-timeout': {
            text = [
                `The pending ${input.interactionKind} interaction expired without a resolution.`,
                `Reason: ${input.reason}.`,
                'Re-ask, choose an explicitly safe fallback, or fail with a clear user-facing explanation.',
                'Never execute an expired irreversible effect without a fresh approval.',
            ].join(' ');
            break;
        }
    }
    return {
        role: 'user' as const,
        content: [{type: 'text', text}],
        timestamp: Date.now(),
    };
};

export type RetainedControlLoop = {
    run: (request: AgentRunRequest) => Promise<ProgramFirstAgentRunResult>;
    attach: (request: AgentRunRequest) => void;
    control: (input: AgentControlInput) => Promise<ProgramFirstAgentRunResult>;
};

type RetainedControlLoopDeps = {
    tools: AgentTool[];
    modelRuntime?: AgentModelRuntime;
    classifyToolCall: (name: string, args: unknown) => AgentToolClassification;
    readWorldRevision: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
    prepareNextTurnWithContext?: AgentOptions['prepareNextTurnWithContext'];
    governance?: {
        controller?: GovernanceController;
        policy?: GovernancePolicy;
        observeIrreversible?: (toolName: string, args: unknown) => EffectObservation | null;
        onBeforeTool?: (toolName: string, args: unknown) => void;
    };
    contextBudget?: RunnerContextBudget;
    signal?: AbortSignal;
};

/**
 * Narrow retained Agent-control continuation seam.
 *
 * The program-first runner drives the same react agent session across the
 * initial run and any later typed control re-entry (denial, clarification
 * answer, recovery choice, takeover return, interaction timeout). The react
 * session, execution object/journal, trace, governance controller and context
 * accountant are retained: a control input re-prompts the SAME agent instead of
 * starting a second runner invocation or a second task.
 */
export const createRetainedControlLoop = (deps: RetainedControlLoopDeps): RetainedControlLoop => {
    let session: ReactAgentSession | null = null;
    let activeRequest: AgentRunRequest | null = null;
    const controller: GovernanceController = deps.governance?.controller
        ?? createGovernanceController(deps.governance?.policy ?? SAFE_UNATTENDED_POLICY, Date.now());
    const accountant = createAgentContextAccountant(deps.contextBudget);
    const trace = createAgentTraceCollector({
        classifyToolCall: deps.classifyToolCall,
        readWorldRevision: deps.readWorldRevision,
        context: () => accountant.account(),
    });
    const outcome: {
        stopReason?: GovernanceStopReason;
        pendingApproval?: {effectSequence: number; toolName: string};
        requestedInteraction?: ModelRequestedInteraction;
    } = {};
    const agentRef: {current: {abort: () => void} | null} = {current: null};
    let batchToolResults: ToolResultMessage[] = [];

    const resetOutcome = (): void => {
        outcome.stopReason = undefined;
        outcome.pendingApproval = undefined;
        outcome.requestedInteraction = undefined;
    };

    const stop = (reason: GovernanceStopReason): void => {
        if (outcome.stopReason === undefined && outcome.pendingApproval === undefined) {
            outcome.stopReason = reason;
        }
        agentRef.current?.abort();
    };

    const awaitApproval = (request: {effectSequence: number; toolName: string}): void => {
        if (outcome.stopReason === undefined && outcome.pendingApproval === undefined) {
            outcome.pendingApproval = request;
        }
        agentRef.current?.abort();
    };

    const onEvent = async (event: AgentEvent): Promise<void> => {
        if (event.type === 'turn_start') {batchToolResults = [];}
        await trace.handle(event);
        if (
            event.type === 'turn_end'
            || event.type === 'tool_execution_start'
            || event.type === 'tool_execution_end'
        ) {
            const decision = controller.recordTrace(trace.snapshot(), Date.now());
            if (decision.kind === 'stop') {stop(decision.reason);}
        }
    };

    const beforeToolCall: NonNullable<AgentOptions['beforeToolCall']> = async (
        context: BeforeToolCallContext,
    ) => {
        if (context.toolCall.name === REQUEST_INTERACTION_TOOL) {
            const requested = tryValidateInteractionRequest(context.args);
            if (!requested.ok) {
                return {block: true, reason: `invalid interaction request: ${requested.error}`};
            }
            outcome.requestedInteraction = requested.payload;
            agentRef.current?.abort();
            return {block: true, reason: 'interaction requested; the task pauses for the user'};
        }
        deps.governance?.onBeforeTool?.(context.toolCall.name, context.args);
        const effect = deps.governance?.observeIrreversible?.(context.toolCall.name, context.args);
        if (effect?.declaredIrreversible) {
            const decision = controller.checkIrreversible(effect, Date.now());
            if (decision.kind === 'stop') {
                stop(decision.reason);
                return {block: true, reason: `governance: ${decision.reason}`};
            }
            if (decision.kind === 'await-approval') {
                awaitApproval(decision.request);
                return {block: true, reason: 'governance: irreversible effect awaits human approval'};
            }
        }
        const decision = controller.evaluate(Date.now());
        if (decision.kind === 'stop') {
            stop(decision.reason);
            return {block: true, reason: `governance: ${decision.reason}`};
        }
        const current = accountant.checkBeforeTool(
            context.context.systemPrompt,
            context.context.messages,
            context.context.tools ?? [],
            batchToolResults,
        );
        if (accountant.overflow()) {
            agentRef.current?.abort();
            return {
                block: true,
                reason: `agent context budget exceeded: ${current.chars} chars / ${current.bytes} bytes exceeds limit ${accountant.budget.maxChars} chars`,
            };
        }
        return undefined;
    };

    const afterToolCall: NonNullable<AgentOptions['afterToolCall']> = async ({
        toolCall,
        result,
        isError,
    }: Parameters<NonNullable<AgentOptions['afterToolCall']>>[0]) => {
        batchToolResults.push({
            role: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            details: result.details as unknown,
            isError,
            timestamp: Date.now(),
        });
        return undefined;
    };

    const prepareNextTurn: NonNullable<AgentOptions['prepareNextTurnWithContext']> = async (
        context: PrepareNextTurnContext,
    ) => {
        const next = deps.prepareNextTurnWithContext
            ? await deps.prepareNextTurnWithContext(context)
            : undefined;
        const effective = next?.context ?? context.context;
        accountant.recordTurn(effective.systemPrompt, effective.messages, effective.tools ?? []);
        const overflow = accountant.overflow();
        if (overflow) {
            throw new AgentContextBudgetExceededError(
                {chars: overflow.chars, bytes: overflow.bytes},
                overflow.limitChars,
                overflow.turn,
            );
        }
        return next;
    };

    const ensureSession = async (request: AgentRunRequest, initialMessage: AgentMessage): Promise<ReactAgentSession> => {
        if (session) {return session;}
        const modelBinding = (deps.modelRuntime ?? getDefaultAgentModelRuntime()).resolve(request.provider, request.model);
        if (!modelBinding) {
            throw Object.assign(
                new Error(`model not found: ${request.provider}/${request.model}`),
                {code: 'ERR_AGENT_MODEL_UNAVAILABLE'},
            );
        }
        const systemPrompt = request.systemPrompt ?? ACTIVE_PROGRAM_CONTROL_PROMPT;
        const initialSize = measureProviderVisibleContext(
            systemPrompt,
            [initialMessage],
            deps.tools,
        );
        if (initialSize.chars > accountant.budget.maxChars) {
            throw new AgentContextBudgetExceededError(initialSize, accountant.budget.maxChars, 0);
        }
        session = createReactAgentSession({
            ...modelBinding,
            tools: deps.tools,
            systemPrompt: request.systemPrompt,
            onEvent,
            prepareNextTurnWithContext: prepareNextTurn,
            beforeToolCall,
            afterToolCall,
            signal: deps.signal,
        });
        return session;
    };

    const settleRun = (request: AgentRunRequest): ProgramFirstAgentRunResult => {
        const base: ProgramFirstAgentRunResult = {
            provider: request.provider,
            model: request.model,
            text: lastAssistantText(session?.agent.state.messages ?? []),
            trace: trace.snapshot(),
            executionMode: 'program',
        };
        const signals: {
            governance?: {stopReason?: GovernanceStopReason; pendingApproval?: {effectSequence: number; toolName: string}};
            requestedInteraction?: ModelRequestedInteraction;
        } = {};
        if (outcome.stopReason !== undefined || outcome.pendingApproval !== undefined) {
            signals.governance = {stopReason: outcome.stopReason, pendingApproval: outcome.pendingApproval};
        }
        if (outcome.requestedInteraction !== undefined) {
            signals.requestedInteraction = outcome.requestedInteraction;
        }
        return {...base, ...signals};
    };

    return {
        run: async (request) => {
            resetOutcome();
            const reactSession = await ensureSession(request, userMessageFromPrompt(request.prompt));
            activeRequest = request;
            agentRef.current = reactSession.agent;
            await reactSession.agent.prompt(request.prompt);
            const overflow = accountant.overflow();
            if (overflow) {
                throw new AgentContextBudgetExceededError(
                    {chars: overflow.chars, bytes: overflow.bytes},
                    overflow.limitChars,
                    overflow.turn,
                );
            }
            return settleRun(request);
        },
        attach: (request) => {
            if (activeRequest) {throw new Error('retained agent control loop is already attached to a task');}
            activeRequest = request;
        },
        control: async (input) => {
            if (!activeRequest) {
                throw new Error('retained agent control continuation is not running a task');
            }
            resetOutcome();
            const message = controlMessageFromInput(input);
            const reactSession = await ensureSession(activeRequest, message);
            agentRef.current = reactSession.agent;
            await reactSession.agent.prompt(message);
            const overflow = accountant.overflow();
            if (overflow) {
                throw new AgentContextBudgetExceededError(
                    {chars: overflow.chars, bytes: overflow.bytes},
                    overflow.limitChars,
                    overflow.turn,
                );
            }
            return settleRun(activeRequest);
        },
    };
};

const userMessageFromPrompt = (prompt: string): AgentMessage => ({
    role: 'user',
    content: [{type: 'text', text: prompt}],
    timestamp: Date.now(),
});

const recoveryActionForTool = (name: string): RecoveryBudgetAction | null => {
    if (name === 'debug.rollback') {return 'rollback';}
    if (name === 'debug.patch_program' || name === 'debug.patch_statement') {return 'repair';}
    if (name === 'debug.rewind') {return 'retry';}
    return null;
};

const prepareProgramContext = (
    execution: ProgramExecutionToolController,
    planningTools: readonly AgentTool[],
    terminalTools: readonly AgentTool[],
    knowledgeTools: readonly AgentTool[],
    request: AgentRunRequest,
    recovery: () => RecoveryContext,
) => ({context}: Parameters<NonNullable<Parameters<typeof createReactAgentRunner>[0]['prepareNextTurnWithContext']>>[0]) => {
    const debugTools = execution.readDebugTools();
    if (debugTools) {
        return {
            context: {
                ...context,
                tools: [...debugTools, ...knowledgeTools, requestInteractionTool],
                systemPrompt: controlSystemPrompt(execution, request, recovery),
            },
        };
    }
    if (execution.hasStartedProgram()) {
        return {
            context: {
                ...context,
                tools: [...terminalTools, requestInteractionTool],
                systemPrompt: [TERMINAL_PROGRAM_PROMPT, request.systemPrompt]
                    .filter((value): value is string => Boolean(value))
                    .join('\n\n'),
            },
        };
    }
    return {
        context: {
            ...context,
            tools: [...planningTools, requestInteractionTool],
            systemPrompt: requestSystemPrompt(request),
        },
    };
};

export const createProgramFirstAgentRunner = (
    options: CreateProgramFirstAgentRunnerOptions,
): ProgramFirstAgentRunner => {
    const run = async (request: AgentRunRequest, restoredStart?: AgentProgramExecutionStart): Promise<ProgramFirstAgentRunResult> => {
        const governance = options.governanceController
            ?? createGovernanceController(options.governancePolicy ?? SAFE_UNATTENDED_POLICY, Date.now());
        const budgetStore = createRecoveryBudgetStore(options.recoveryBudgetLimits);

        const execution = createProgramExecutionTool({
            execute: options.executeProgram,
            ...(restoredStart ? {seed: restoredStart} : {}),
            ...((options.executeProgram as typeof options.executeProgram & {exportContinuation?: (start: AgentProgramExecutionStart) => unknown}).exportContinuation
                ? {exportContinuation: (options.executeProgram as typeof options.executeProgram & {exportContinuation: (start: AgentProgramExecutionStart) => unknown}).exportContinuation}
                : {}),
        });
        const save = options.saveProgram
            ? createProgramSaveTool({execution, save: options.saveProgram})
            : null;
        const libraryTools = options.programLibrary
            ? createProgramLibraryTools(options.programLibrary)
            : [];
        const knowledgeTools = options.knowledge
            ? createKnowledgeTools(options.knowledge)
            : [];
        const planningTools = [...options.readTools, ...libraryTools, ...knowledgeTools, execution.tool, requestInteractionTool];
        const terminalTools = [...options.readTools, ...libraryTools, ...knowledgeTools, ...(save ? [save.tool] : []), requestInteractionTool];

        const recoveryContext = (): RecoveryContext => ({
            budget: budgetStore,
            effects: execution.readEffects(),
        });

        const observeIrreversible = (toolName: string): EffectObservation | null => {
            const pause = execution.readPause();
            if (!pause || (pause.reason !== 'barrier' && pause.reason !== 'effect')) {return null;}
            if (pause.effect.semantics.reversibility !== 'irreversible') {return null;}
            if (toolName !== 'debug.cross_barrier' && toolName !== 'debug.step' && toolName !== 'debug.continue') {return null;}
            return {
                sequence: (pause.rollbackAnchor?.effectSequence ?? 0) + 1,
                toolName: pause.effect.stepName,
                declaredIrreversible: true,
            };
        };

        const onBeforeTool = (toolName: string): void => {
            const pause = execution.readPause();
            if (pause?.reason !== 'failure') {return;}
            const action = recoveryActionForTool(toolName);
            if (!action) {return;}
            const key = recoveryBudgetKey(pause, action);
            if (key) {budgetStore.record(key, action);}
        };

        const reactGovernance = {
            controller: governance,
            observeIrreversible,
            onBeforeTool,
        };

        const composeResult = (loop: RetainedControlLoop) => (result: ProgramFirstAgentRunResult): ProgramFirstAgentRunResult => {
            const base = {
                ...result,
                executionMode: 'program' as const,
                programs: execution.readAttempts(),
                ...(save && save.readSaved().length > 0 ? {savedPrograms: save.readSaved()} : {}),
            };
            const resumed = withContinuation(base, execution, request);
            const pause = execution.readPause();
            if (!pause && !result.requestedInteraction) {return resumed;}
            return {
                ...resumed,
                control: {
                    control: async (input) => composeResult(loop)(await loop.control(input)),
                },
            };
        };

        if (restoredStart) {
            const debugTools = execution.readDebugTools();
            if (!debugTools) {throw new Error('restored program has no debugger tools');}
            const loop = createRetainedControlLoop({
                tools: [...debugTools, requestInteractionTool],
                modelRuntime: options.modelRuntime,
                classifyToolCall: classifyProgramToolCall,
                readWorldRevision: () => readProgramWorldRevision(execution, options.readWorldRevision),
                prepareNextTurnWithContext: prepareProgramContext(execution, planningTools, terminalTools, knowledgeTools, request, recoveryContext),
                governance: reactGovernance,
                signal: options.signal,
            });
            loop.attach(request);
            return composeResult(loop)({
                provider: request.provider,
                model: request.model,
                text: '',
                trace: mergeAgentTraceSnapshots([]),
                executionMode: 'program',
            });
        }
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
            const loop = createRetainedControlLoop({
                tools: [...debugTools, requestInteractionTool],
                modelRuntime: options.modelRuntime,
                classifyToolCall: classifyProgramToolCall,
                readWorldRevision: () => readProgramWorldRevision(execution, options.readWorldRevision),
                prepareNextTurnWithContext: prepareProgramContext(
                    execution,
                    planningTools,
                    terminalTools,
                    knowledgeTools,
                    request,
                    recoveryContext,
                ),
                governance: reactGovernance,
                signal: options.signal,
            });
            const result = await loop.run({
                ...request,
                systemPrompt: controlSystemPrompt(execution, request, recoveryContext),
            });
            return composeResult(loop)(result);
        }

        const loop = createRetainedControlLoop({
            tools: planningTools,
            modelRuntime: options.modelRuntime,
            readWorldRevision: () => readProgramWorldRevision(execution, options.readWorldRevision),
            classifyToolCall: classifyProgramToolCall,
            prepareNextTurnWithContext: prepareProgramContext(
                execution,
                planningTools,
                terminalTools,
                knowledgeTools,
                request,
                recoveryContext,
            ),
            governance: reactGovernance,
            signal: options.signal,
        });
        const result = await loop.run({
            ...request,
            systemPrompt: requestSystemPrompt(request),
        });
        return composeResult(loop)(result);
    };
    return {run, restore: (request, start) => run(request, start)};
};
