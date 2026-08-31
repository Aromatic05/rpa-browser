import {contentText, type ToolResultMessage} from '@earendil-works/pi-ai';
import type {
    Agent,
    AgentEvent,
    AgentMessage,
    AgentOptions,
    AgentTool,
    BeforeToolCallContext,
    PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core';
import {createReactAgentSession, REACT_BASELINE_SYSTEM_PROMPT} from '../loop/react';
import {getDefaultAgentModelRuntime, type AgentModelRuntime} from '../model/runtime';
import {throwIfAgentModelRequestFailed} from '../model/failure';
import {classifyAgentToolCall, type AgentToolClassification} from '../tools/policy';
import {createAgentTraceCollector, type AgentTraceSnapshot, type AgentWorldRevision} from '../trace/collector';
import {
    createGovernanceController,
    SAFE_UNATTENDED_POLICY,
    type EffectObservation,
    type GovernanceApprovalRequest,
    type GovernanceController,
    type GovernancePolicy,
    type GovernanceStopReason,
} from '../governance';
import {
    AgentContextBudgetExceededError,
    createAgentContextAccountant,
    type RunnerContextBudget,
} from '../tools/context/budget';
import {measureProviderVisibleContext} from '../tools/context/measure';
import type {AgentRunControl, AgentRunRequest, AgentRunResult} from './types';

export type CreateReactAgentRunnerDeps = {
    tools: AgentTool[];
    modelRuntime?: AgentModelRuntime;
    classifyToolCall?: (name: string, args: unknown) => AgentToolClassification;
    readWorldRevision?: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
    prepareNextTurnWithContext?: AgentOptions['prepareNextTurnWithContext'];
    governance?: ReactRunnerGovernanceOptions;
    contextBudget?: RunnerContextBudget;
    signal?: AbortSignal;
};

export type ReactRunnerGovernanceOptions = {
    controller?: GovernanceController;
    policy?: GovernancePolicy;
    observeIrreversible?: (toolName: string, args: unknown) => EffectObservation | null;
    onBeforeTool?: (toolName: string, args: unknown) => void;
};

export type GovernedRunOutcome = Readonly<{
    stopReason?: GovernanceStopReason;
    pendingApproval?: GovernanceApprovalRequest;
}>;

export type GovernedAgentRunResult = AgentRunResult & {
    governance?: GovernedRunOutcome;
};

export type GovernedAgentRunner = {
    run: (request: AgentRunRequest, control?: AgentRunControl) => Promise<GovernedAgentRunResult>;
};

const lastAssistantText = (messages: readonly unknown[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {role?: string; content?: unknown};
        if (message.role !== 'assistant' || !message.content) {continue;}
        return contentText(message.content as Parameters<typeof contentText>[0]);
    }
    return '';
};

const evaluateTrace = (
    controller: GovernanceController,
    trace: AgentTraceSnapshot,
    now: number,
) => controller.recordTrace(trace, now);

const userMessageFromPrompt = (prompt: string): AgentMessage => ({
    role: 'user',
    content: [{type: 'text', text: prompt}],
    timestamp: Date.now(),
});

export const createReactAgentRunner = (deps: CreateReactAgentRunnerDeps): GovernedAgentRunner => ({
    run: async (request, runControl) => {
        const modelBinding = (deps.modelRuntime ?? getDefaultAgentModelRuntime()).resolve(request.provider, request.model);
        if (!modelBinding) {throw new Error(`model not found: ${request.provider}/${request.model}`);}
        const controller = deps.governance?.controller
            ?? createGovernanceController(deps.governance?.policy ?? SAFE_UNATTENDED_POLICY, Date.now());
        const accountant = createAgentContextAccountant(deps.contextBudget);
        const trace = createAgentTraceCollector({
            classifyToolCall: deps.classifyToolCall ?? classifyAgentToolCall,
            readWorldRevision: deps.readWorldRevision,
            context: () => accountant.account(),
        });
        const outcome: {stopReason?: GovernanceStopReason; pendingApproval?: GovernanceApprovalRequest} = {};
        const agentRef: {current: Agent | null} = {current: null};
        let batchToolResults: ToolResultMessage[] = [];
        let pausedByUser = false;

        const pauseRequested = (): boolean => runControl?.pauseRequested?.() === true;
        const pauseAtBoundary = (): void => {
            if (!pauseRequested()) {return;}
            pausedByUser = true;
            agentRef.current?.abort();
        };

        const stop = (reason: GovernanceStopReason): void => {
            if (outcome.stopReason === undefined && outcome.pendingApproval === undefined) {
                outcome.stopReason = reason;
            }
            agentRef.current?.abort();
        };

        const awaitApproval = (request_: GovernanceApprovalRequest): void => {
            if (outcome.stopReason === undefined && outcome.pendingApproval === undefined) {
                outcome.pendingApproval = request_;
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
                const decision = evaluateTrace(controller, trace.snapshot(), Date.now());
                if (decision.kind === 'stop') {stop(decision.reason);}
            }
        };

        const beforeToolCall: NonNullable<AgentOptions['beforeToolCall']> = async (
            context: BeforeToolCallContext,
        ) => {
            if (pauseRequested()) {
                pauseAtBoundary();
                return {block: true, reason: 'user paused the task'};
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
        }) => {
            batchToolResults.push({
                role: 'toolResult',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: result.content,
                details: result.details as unknown,
                isError,
                timestamp: Date.now(),
            });
            pauseAtBoundary();
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

        const systemPrompt = request.systemPrompt ?? REACT_BASELINE_SYSTEM_PROMPT;
        const initialSize = measureProviderVisibleContext(
            systemPrompt,
            [userMessageFromPrompt(request.prompt)],
            deps.tools,
        );
        if (initialSize.chars > accountant.budget.maxChars) {
            throw new AgentContextBudgetExceededError(initialSize, accountant.budget.maxChars, 0);
        }

        const session = createReactAgentSession({
            ...modelBinding,
            tools: deps.tools,
            systemPrompt: request.systemPrompt,
            onEvent,
            prepareNextTurnWithContext: prepareNextTurn,
            beforeToolCall,
            afterToolCall,
            signal: runControl?.signal ?? deps.signal,
        });
        agentRef.current = session.agent;
        const projectResult = (): GovernedAgentRunResult => {
            const controlledStop = outcome.stopReason !== undefined
                || outcome.pendingApproval !== undefined
                || pausedByUser
                || runControl?.signal?.aborted === true
                || deps.signal?.aborted === true;
            throwIfAgentModelRequestFailed({
                messages: session.agent.state.messages,
                stateErrorMessage: session.agent.state.errorMessage,
                controlledStop,
            });
            return {
                provider: request.provider,
                model: request.model,
                text: lastAssistantText(session.agent.state.messages),
                trace: trace.snapshot(),
                ...(outcome.stopReason !== undefined || outcome.pendingApproval !== undefined
                    ? {governance: {...outcome}}
                    : {}),
                ...(pausedByUser
                    ? {
                        pausedByUser: true,
                        continuation: {
                            resume: async () => {
                                pausedByUser = false;
                                await session.agent.continue();
                                return projectResult();
                            },
                        },
                    }
                    : {}),
            };
        };
        await session.agent.prompt(request.prompt);
        const overflow = accountant.overflow();
        if (overflow) {
            throw new AgentContextBudgetExceededError(
                {chars: overflow.chars, bytes: overflow.bytes},
                overflow.limitChars,
                overflow.turn,
            );
        }
        return projectResult();
    },
});