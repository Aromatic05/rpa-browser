import type {AgentMessage} from '@earendil-works/pi-agent-core';

export type AgentContextSize = {
    /** Exact serialized character count (UTF-16 code units, JS string length). */
    chars: number;
    /** Exact serialized byte count (UTF-8). */
    bytes: number;
};

export const measureTextSize = (text: string): AgentContextSize => ({
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
});

export type ProviderVisibleTool = {
    name: string;
    description: string;
    parameters: unknown;
};

export type ProviderVisibleToolCall = {
    id: string;
    name: string;
    arguments: string;
};

export type ProviderVisibleContentBlock =
    | {type: 'text'; text: string}
    | {type: 'image'; mimeType: string; data: string}
    | {type: 'thinking'; thinking: string};

export type ProviderVisibleMessage =
    | {role: 'user' | 'assistant'; content: ProviderVisibleContentBlock[]; toolCalls?: ProviderVisibleToolCall[]}
    | {role: 'tool'; toolCallId: string; content: ProviderVisibleContentBlock[]};

export type ProviderVisibleContext = {
    systemPrompt: string;
    messages: ProviderVisibleMessage[];
    tools: ProviderVisibleTool[];
};

const projectContent = (content: unknown): ProviderVisibleContentBlock[] => {
    if (!Array.isArray(content)) {return [];}
    const blocks: ProviderVisibleContentBlock[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') {continue;}
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') {
            blocks.push({type: 'text', text: record.text});
        } else if (record.type === 'image' && typeof record.mimeType === 'string' && typeof record.data === 'string') {
            blocks.push({type: 'image', mimeType: record.mimeType, data: record.data});
        } else if (record.type === 'thinking' && typeof record.thinking === 'string') {
            blocks.push({type: 'thinking', thinking: record.thinking});
        }
    }
    return blocks;
};

const projectToolCalls = (content: unknown): ProviderVisibleToolCall[] => {
    if (!Array.isArray(content)) {return [];}
    const calls: ProviderVisibleToolCall[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') {continue;}
        const record = block as Record<string, unknown>;
        if (record.type !== 'toolCall' || typeof record.id !== 'string' || typeof record.name !== 'string') {
            continue;
        }
        let argumentsText: string;
        try {
            argumentsText = JSON.stringify(record.arguments ?? {});
        } catch {
            argumentsText = '{}';
        }
        calls.push({id: record.id, name: record.name, arguments: argumentsText});
    }
    return calls;
};

const projectMessage = (message: AgentMessage): ProviderVisibleMessage | null => {
    if (message.role === 'user') {
        return {role: 'user', content: projectContent(message.content)};
    }
    if (message.role === 'assistant') {
        const toolCalls = projectToolCalls(message.content);
        if (toolCalls.length > 0) {
            return {
                role: 'assistant',
                content: projectContent(message.content),
                toolCalls,
            };
        }
        return {role: 'assistant', content: projectContent(message.content)};
    }
    if (message.role === 'toolResult') {
        return {
            role: 'tool',
            toolCallId: (message as {toolCallId: string}).toolCallId,
            content: projectContent(message.content),
        };
    }
    return null;
};

export const projectProviderVisibleContext = (
    systemPrompt: string,
    messages: readonly AgentMessage[],
    tools: readonly ProviderVisibleTool[],
): ProviderVisibleContext => ({
    systemPrompt,
    messages: messages
        .map(projectMessage)
        .filter((message): message is ProviderVisibleMessage => message !== null),
    tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    })),
});

export const serializeProviderVisibleContext = (
    systemPrompt: string,
    messages: readonly AgentMessage[],
    tools: readonly ProviderVisibleTool[],
): string => JSON.stringify(projectProviderVisibleContext(systemPrompt, messages, tools));

export const measureProviderVisibleContext = (
    systemPrompt: string,
    messages: readonly AgentMessage[],
    tools: readonly ProviderVisibleTool[],
): AgentContextSize => measureTextSize(serializeProviderVisibleContext(systemPrompt, messages, tools));