import {contentText} from '@earendil-works/pi-ai';
import type {AgentOptions, AgentTool} from '@earendil-works/pi-agent-core';
import {createReactAgentSession} from '../loop/react';
import {getDefaultAgentModelRuntime, type AgentModelRuntime} from '../model/runtime';
import {classifyAgentToolCall, type AgentToolClassification} from '../tools/policy';
import {createAgentTraceCollector, type AgentWorldRevision} from '../trace/collector';
import type {AgentRunner} from './types';

export type CreateReactAgentRunnerDeps = {
    tools: AgentTool[];
    modelRuntime?: AgentModelRuntime;
    classifyToolCall?: (name: string, args: unknown) => AgentToolClassification;
    readWorldRevision?: () => AgentWorldRevision | null | Promise<AgentWorldRevision | null>;
    prepareNextTurnWithContext?: AgentOptions['prepareNextTurnWithContext'];
};

const lastAssistantText = (messages: readonly unknown[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {role?: string; content?: unknown};
        if (message.role !== 'assistant' || !message.content) {continue;}
        return contentText(message.content as Parameters<typeof contentText>[0]);
    }
    return '';
};

export const createReactAgentRunner = (deps: CreateReactAgentRunnerDeps): AgentRunner => ({
    run: async (request) => {
        const modelBinding = (deps.modelRuntime ?? getDefaultAgentModelRuntime()).resolve(request.provider, request.model);
        if (!modelBinding) {throw new Error(`model not found: ${request.provider}/${request.model}`);}
        const trace = createAgentTraceCollector({
            classifyToolCall: deps.classifyToolCall ?? classifyAgentToolCall,
            readWorldRevision: deps.readWorldRevision,
        });
        const session = createReactAgentSession({
            ...modelBinding,
            tools: deps.tools,
            systemPrompt: request.systemPrompt,
            onEvent: trace.handle,
            prepareNextTurnWithContext: deps.prepareNextTurnWithContext,
        });
        await session.agent.prompt(request.prompt);
        return {
            provider: request.provider,
            model: request.model,
            text: lastAssistantText(session.agent.state.messages),
            trace: trace.snapshot(),
        };
    },
});
