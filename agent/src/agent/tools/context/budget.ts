import type {AgentMessage} from '@earendil-works/pi-agent-core';
import {measureProviderVisibleContext, type AgentContextSize, type ProviderVisibleTool} from './measure';

export type RunnerContextBudget = {
    /** Hard cap on accumulated model-visible serialized characters (exact). */
    maxChars: number;
};

export const DEFAULT_RUNNER_CONTEXT_MAX_CHARS = 8_000_000;

export type AgentContextTurnRecord = {
    turn: number;
    chars: number;
    bytes: number;
    exceededBudget?: boolean;
};

export type AgentContextAccount = {
    turns: AgentContextTurnRecord[];
    lastChars: number;
    lastBytes: number;
    peakChars: number;
    peakBytes: number;
};

export type AgentContextOverflow = {
    chars: number;
    bytes: number;
    limitChars: number;
    turn: number;
};

export class AgentContextBudgetExceededError extends Error {
    readonly chars: number;
    readonly bytes: number;
    readonly limitChars: number;
    readonly turn: number;

    constructor(size: AgentContextSize, limitChars: number, turn: number) {
        super(
            `agent context budget exceeded: ${size.chars} chars / ${size.bytes} bytes exceeds limit ${limitChars} chars at turn ${turn}`,
        );
        this.name = 'AgentContextBudgetExceededError';
        this.chars = size.chars;
        this.bytes = size.bytes;
        this.limitChars = limitChars;
        this.turn = turn;
    }
}

export const emptyAgentContextAccount = (): AgentContextAccount => ({
    turns: [],
    lastChars: 0,
    lastBytes: 0,
    peakChars: 0,
    peakBytes: 0,
});

export type AgentContextAccountant = {
    budget: RunnerContextBudget;
    recordTurn: (
        systemPrompt: string,
        messages: readonly AgentMessage[],
        tools: readonly ProviderVisibleTool[],
    ) => AgentContextSize;
    checkBeforeTool: (
        systemPrompt: string,
        messages: readonly AgentMessage[],
        tools: readonly ProviderVisibleTool[],
        projected?: readonly AgentMessage[],
    ) => AgentContextSize;
    account: () => AgentContextAccount;
    overflow: () => AgentContextOverflow | null;
};

export const createAgentContextAccountant = (
    budget: RunnerContextBudget = {maxChars: DEFAULT_RUNNER_CONTEXT_MAX_CHARS},
): AgentContextAccountant => {
    let turn = 0;
    let overflow: AgentContextOverflow | null = null;
    const turns: AgentContextTurnRecord[] = [];
    let last: AgentContextSize = {chars: 0, bytes: 0};
    let peak: AgentContextSize = {chars: 0, bytes: 0};

    const noteOverflow = (size: AgentContextSize, atTurn: number): void => {
        if (overflow === null) {
            overflow = {chars: size.chars, bytes: size.bytes, limitChars: budget.maxChars, turn: atTurn};
        }
    };

    const recordTurn = (
        systemPrompt: string,
        messages: readonly AgentMessage[],
        tools: readonly ProviderVisibleTool[],
    ): AgentContextSize => {
        const size = measureProviderVisibleContext(systemPrompt, messages, tools);
        turn += 1;
        turns.push({
            turn,
            chars: size.chars,
            bytes: size.bytes,
            ...(size.chars > budget.maxChars ? {exceededBudget: true as const} : {}),
        });
        last = size;
        if (size.chars > peak.chars) {peak = size;}
        if (size.chars > budget.maxChars) {noteOverflow(size, turn);}
        return size;
    };

    const checkBeforeTool = (
        systemPrompt: string,
        messages: readonly AgentMessage[],
        tools: readonly ProviderVisibleTool[],
        projected: readonly AgentMessage[] = [],
    ): AgentContextSize => {
        const size = projected.length > 0
            ? measureProviderVisibleContext(systemPrompt, [...messages, ...projected], tools)
            : measureProviderVisibleContext(systemPrompt, messages, tools);
        if (size.chars > budget.maxChars) {noteOverflow(size, turn);}
        return size;
    };

    return {
        budget,
        recordTurn,
        checkBeforeTool,
        account: () => ({
            turns: turns.slice(),
            lastChars: last.chars,
            lastBytes: last.bytes,
            peakChars: peak.chars,
            peakBytes: peak.bytes,
        }),
        overflow: () => overflow,
    };
};

export const mergeAgentContextAccounts = (accounts: readonly AgentContextAccount[]): AgentContextAccount => {
    if (accounts.length === 0) {return emptyAgentContextAccount();}
    const last = accounts[accounts.length - 1] ?? emptyAgentContextAccount();
    const turns = accounts.flatMap((account) => account.turns);
    const peakChars = Math.max(0, ...accounts.map((account) => account.peakChars));
    const peak = accounts.find((account) => account.peakChars === peakChars) ?? emptyAgentContextAccount();
    return {
        turns,
        lastChars: last.lastChars,
        lastBytes: last.lastBytes,
        peakChars,
        peakBytes: peak.peakBytes,
    };
};