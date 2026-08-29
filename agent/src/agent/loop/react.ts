import {
    Agent,
    type AgentEvent,
    type AgentOptions,
    type AgentTool,
    type StreamFn,
} from '@earendil-works/pi-agent-core';
import type {Api, Model} from '@earendil-works/pi-ai';

export type ReactAgentSessionOptions = {
    model: Model<Api>;
    streamFn: StreamFn;
    getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
    tools: AgentTool[];
    systemPrompt?: string;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    prepareNextTurnWithContext?: AgentOptions['prepareNextTurnWithContext'];
    beforeToolCall?: AgentOptions['beforeToolCall'];
    signal?: AbortSignal;
};

export const REACT_BASELINE_SYSTEM_PROMPT = [
    'You are a browser automation agent.',
    'Use the available browser tools to complete the user task.',
    'Observe the current state when needed, perform actions, and verify the result before finishing.',
].join(' ');

export type ReactAgentSession = {
    agent: Agent;
};

export const createReactAgentSession = (options: ReactAgentSessionOptions): ReactAgentSession => {
    const agent = new Agent({
        initialState: {
            model: options.model,
            tools: options.tools,
            systemPrompt: options.systemPrompt ?? REACT_BASELINE_SYSTEM_PROMPT,
        },
        streamFn: options.streamFn,
        getApiKey: options.getApiKey,
        toolExecution: 'sequential',
        prepareNextTurnWithContext: options.prepareNextTurnWithContext,
        beforeToolCall: options.beforeToolCall,
    });
    if (options.onEvent) {agent.subscribe(options.onEvent);}
    if (options.signal) {
        const signal = options.signal;
        signal.addEventListener('abort', () => {agent.abort();}, {once: true});
        agent.subscribe((event) => {
            if (event.type === 'agent_start' && signal.aborted) {agent.abort();}
        });
    }
    return {agent};
};
