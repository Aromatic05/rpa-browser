import {contentText} from '@earendil-works/pi-ai';
import type {
    Agent,
    AgentEvent,
    AgentOptions,
    AgentTool,
    BeforeToolCallContext,
} from '@earendil-works/pi-agent-core';
import {createReactAgentSession} from '../loop/react';
import {getDefaultAgentModelRuntime, type AgentModelRuntime} from '../model/runtime';
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
import type {AgentRunRequest, AgentRunResult} from './types';

export type CreateReactAgentRunnerDeps = {
    tools: AgentTool[];
    modelRuntime?: AgentModelRuntime;
    classifyToolCall?: (name: string, args: unknown) => AgentToolClassification;
    readWorldRevision?: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
    prepareNextTurnWithContext?: AgentOptions['prepareNextTurnWithContext'];
    governance?: ReactRunnerGovernanceOptions;
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
    run: (request: AgentRunRequest) => Promise<GovernedAgentRunResult>;
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

export const createReactAgentRunner = (deps: CreateReactAgentRunnerDeps): GovernedAgentRunner => ({
    run: async (request) => {
        const modelBinding = (deps.modelRuntime ?? getDefaultAgentModelRuntime()).resolve(request.provider, request.model);
        if (!modelBinding) {throw new Error(`model not found: ${request.provider}/${request.model}`);}
        const controller = deps.governance?.controller
            ?? createGovernanceController(deps.governance?.policy ?? SAFE_UNATTENDED_POLICY, Date.now());
        const trace = createAgentTraceCollector({
            classifyToolCall: deps.classifyToolCall ?? classifyAgentToolCall,
            readWorldRevision: deps.readWorldRevision,
        });
        const outcome: {stopReason?: GovernanceStopReason; pendingApproval?: GovernanceApprovalRequest} = {};
        const agentRef: {current: Agent | null} = {current: null};

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
            return undefined;
        };

        const session = createReactAgentSession({
            ...modelBinding,
            tools: deps.tools,
            systemPrompt: request.systemPrompt,
            onEvent,
            prepareNextTurnWithContext: deps.prepareNextTurnWithContext,
            beforeToolCall,
            signal: deps.signal,
        });
        agentRef.current = session.agent;
        await session.agent.prompt(request.prompt);
        return {
            provider: request.provider,
            model: request.model,
            text: lastAssistantText(session.agent.state.messages),
            trace: trace.snapshot(),
            ...(outcome.stopReason !== undefined || outcome.pendingApproval !== undefined
                ? {governance: {...outcome}}
                : {}),
        };
    },
});
