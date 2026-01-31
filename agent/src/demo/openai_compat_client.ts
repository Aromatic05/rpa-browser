export type ChatTool = {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
    };
};

export type ChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    name?: string;
};

export type ChatCompletionRequest = {
    apiBase: string;
    apiKey?: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    messages: ChatMessage[];
    tools?: ChatTool[];
    toolChoice?: 'auto' | { type: 'function'; function: { name: string } };
};

export type ChatCompletionResponse = {
    message: ChatMessage;
};

const buildChatUrl = (apiBase: string) => {
    const trimmed = apiBase.replace(/\/$/, '');
    if (trimmed.endsWith('/v1/chat/completions')) return trimmed;
    if (trimmed.endsWith('/chat/completions')) return trimmed;
    if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
    return `${trimmed}/v1/chat/completions`;
};

export const createChatCompletion = async (
    request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> => {
    const url = buildChatUrl(request.apiBase);
    const payload = {
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        messages: request.messages,
        tools: request.tools,
        tool_choice: request.toolChoice ?? (request.tools?.length ? 'auto' : undefined),
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`LLM request failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as any;
    const message = data?.choices?.[0]?.message;
    if (!message) {
        throw new Error('LLM response missing message');
    }
    return { message };
};
