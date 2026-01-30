import type { DemoConfig } from './config_store';
import { createChatCompletion, type ChatMessage } from './openai_compat_client';
import { executeTool, getToolSpecs } from '../tool_registry';
import type { ToolRegistryDeps } from '../tool_registry';
import { ERROR_CODES } from '../runner/error_codes';
import { errorResult } from '../runner/results';

export type ToolEvent = {
    type: 'call' | 'result';
    name: string;
    payload: unknown;
    ts: number;
};

export type AgentLoopResult = {
    messages: ChatMessage[];
    toolEvents: ToolEvent[];
    finalAnswer: string;
};

const sanitizeResult = (result: any) => {
    if (!result || typeof result !== 'object') return result;
    const { tabToken, ...rest } = result as any;
    return rest;
};

const parseToolArgs = (raw: string) => {
    try {
        return { ok: true, data: JSON.parse(raw) };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
};

export const runAgentLoop = async (params: {
    message: string;
    config: DemoConfig;
    toolDeps: ToolRegistryDeps;
    maxRounds?: number;
}): Promise<AgentLoopResult> => {
    const { message, config, toolDeps } = params;
    const maxRounds = params.maxRounds ?? 12;

    const toolSpecs = getToolSpecs();
    const tools = toolSpecs.map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));

    const messages: ChatMessage[] = [
        {
            role: 'system',
            content:
                'You are a browser automation assistant. Use tools when needed. Do not ask for tabToken; tools operate on the active workspace.',
        },
        { role: 'user', content: message },
    ];

    const toolEvents: ToolEvent[] = [];
    let finalAnswer = '';

    for (let round = 0; round < maxRounds; round += 1) {
        const response = await createChatCompletion({
            apiBase: config.apiBase || 'http://127.0.0.1:11434',
            apiKey: config.apiKey,
            model: config.model || 'gpt-4.1-mini',
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            messages,
            tools,
        });

        const assistantMessage = response.message as ChatMessage;
        messages.push(assistantMessage);

        const toolCalls = assistantMessage.tool_calls || [];
        if (!toolCalls.length) {
            finalAnswer = assistantMessage.content || '';
            break;
        }

        for (const call of toolCalls) {
            const parsedArgs = parseToolArgs(call.function.arguments || '{}');
            toolEvents.push({ type: 'call', name: call.function.name, payload: parsedArgs.ok ? parsedArgs.data : call.function.arguments, ts: Date.now() });

            let result: any;
            if (!parsedArgs.ok) {
                result = errorResult('', ERROR_CODES.ERR_BAD_ARGS, 'invalid tool arguments', undefined, parsedArgs.error);
            } else {
                result = await executeTool(toolDeps, call.function.name, parsedArgs.data);
            }
            const sanitized = sanitizeResult(result);
            toolEvents.push({ type: 'result', name: call.function.name, payload: sanitized, ts: Date.now() });

            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(sanitized),
            });
        }
    }

    if (!finalAnswer) {
        finalAnswer = 'No final response produced.';
    }

    return { messages, toolEvents, finalAnswer };
};
