type AssistantTermination = Readonly<{
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
}>;

export class AgentModelRequestError extends Error {
    readonly code = 'ERR_AGENT_MODEL_REQUEST_FAILED';

    constructor(message: string) {
        super(message);
        this.name = 'AgentModelRequestError';
    }
}

const latestAssistant = (messages: readonly unknown[]): AssistantTermination | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (typeof message !== 'object' || message === null) {continue;}
        const candidate = message as AssistantTermination;
        if (candidate.role === 'assistant') {return candidate;}
    }
    return null;
};

const errorText = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/**
 * pi-agent-core deliberately resolves prompt()/continue() on provider/runtime
 * failures and reports them through the terminal assistant message instead.
 * Promote those failures back into the runner contract, while preserving
 * intentional aborts used for governance, interaction, user pause and Task stop.
 */
export const throwIfAgentModelRequestFailed = (input: Readonly<{
    messages: readonly unknown[];
    stateErrorMessage?: string;
    controlledStop: boolean;
}>): void => {
    const latest = latestAssistant(input.messages);
    const stopReason = typeof latest?.stopReason === 'string' ? latest.stopReason : undefined;
    const message = errorText(latest?.errorMessage)
        ?? errorText(input.stateErrorMessage)
        ?? 'model request failed';

    if (stopReason === 'error') {
        throw new AgentModelRequestError(message);
    }
    if (stopReason === 'aborted' && !input.controlledStop) {
        throw new AgentModelRequestError(message);
    }
    if (!latest && errorText(input.stateErrorMessage) && !input.controlledStop) {
        throw new AgentModelRequestError(message);
    }
};
