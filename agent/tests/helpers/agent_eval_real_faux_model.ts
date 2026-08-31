import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentModelRuntime } from '../../src/agent/model/runtime';
import type { AgentFaultKind } from '../../src/agent/execution/eval/faults/contracts';
import type { AgentEvalMode } from '../../src/agent/execution/eval/contracts';
import type { AgentEvalRealFixtureTargets } from './agent_eval_real_worldview';

/**
 * Deterministic faux model runtime driving the production runners with no
 * external network. The "model" here is a scripted response factory: it reads
 * the conversation context (tool results) exactly as a real model would and
 * emits the next assistant message. No world state is read outside the tool
 * results the agent actually received.
 */

export const AGENT_EVAL_REAL_PROVIDER = 'agent-eval-real' as const;
export const AGENT_EVAL_REAL_MODEL = 'deterministic-faux' as const;

type ToolResult = { toolName: string; isError: boolean; text: string };

const contentText = (content: unknown): string => {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((block) =>
            block && typeof block === 'object' && 'text' in block
                ? String((block as { text: unknown }).text)
                : '',
        )
        .join('\n');
};

const lastToolResult = (messages: readonly unknown[]): ToolResult | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {
            role?: string;
            toolName?: string;
            isError?: boolean;
            content?: unknown;
        };
        if (message.role !== 'toolResult') {
            continue;
        }
        return {
            toolName: message.toolName ?? '',
            isError: message.isError === true,
            text: contentText(message.content),
        };
    }
    return null;
};

const parseJson = <T>(text: string): T | null => {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
};

const toolCalls = (messages: readonly unknown[]): readonly string[] =>
    messages
        .filter((message) => {
            const role = (message as { role?: string }).role;
            return role === 'assistant';
        })
        .flatMap((message) => (message as { content?: unknown }).content ?? [])
        .filter((block): block is { type: string; name: string } =>
            Boolean(
                block &&
                    typeof block === 'object' &&
                    (block as { type?: string }).type === 'toolCall',
            ),
        )
        .map((block) => block.name);

const countTool = (messages: readonly unknown[], name: string): number =>
    toolCalls(messages).filter((candidate) => candidate === name).length;

const rollbackAnchorId = (systemPrompt: string | undefined): string | null => {
    if (!systemPrompt) {
        return null;
    }
    const match = /rollbackAnchor is \{"id":"([^"]+)"/u.exec(systemPrompt);
    return match ? match[1] : null;
};

type FauxContext = {
    systemPrompt?: string;
    messages: readonly unknown[];
    tools?: readonly unknown[];
};

const assistant = (content: Parameters<typeof fauxAssistantMessage>[0]) =>
    fauxAssistantMessage(content);

const tool = (name: string, args: Record<string, unknown>) => assistant(fauxToolCall(name, args));

type ModelScriptOptions = {
    mode: AgentEvalMode;
    kind: AgentFaultKind;
    trialIndex: number;
    targets: AgentEvalRealFixtureTargets;
};

type SnapshotView = {
    page?: string;
    fields?: Array<{ key: string; nodeId: string; value: string }>;
    buttons?: Array<{ key: string; nodeId: string }>;
};

const nameValue = (view: SnapshotView | null): string | null =>
    view?.fields?.find((field) => field.key === 'name')?.value ?? null;

const baselineNext = (
    context: FauxContext,
    options: ModelScriptOptions,
): ReturnType<typeof assistant> => {
    const { kind, trialIndex, targets } = options;
    const nameNodeId = targets.field.name ?? '';
    const submitNodeId = targets.button.submit ?? '';
    const result = lastToolResult(context.messages);
    const snapshotCount = countTool(context.messages, 'browser.snapshot');
    const fillCount = countTool(context.messages, 'browser.fill');

    if (!result) {
        return tool('browser.snapshot', {});
    }

    if (result.toolName === 'browser.snapshot') {
        if (snapshotCount === 1) {
            return tool('browser.fill', { nodeId: nameNodeId, value: 'Alice' });
        }
        // verification snapshot after a failed fill
        const view = parseJson<SnapshotView>(result.text);
        const value = nameValue(view);
        switch (kind) {
            case 'mutation-report-error':
                return value === 'Alice'
                    ? tool('browser.click', { nodeId: submitNodeId })
                    : tool('browser.fill', { nodeId: nameNodeId, value: 'Alice' });
            case 'revision-drift':
            case 'epoch-navigation':
                return tool('browser.fill', { nodeId: nameNodeId, value: 'Alice' });
            case 'transactional-restore':
                return tool('browser.fill', { nodeId: nameNodeId, value: 'Before' });
            case 'compensation-partial-restore':
                return tool('browser.fill', { nodeId: nameNodeId, value: 'Before' });
            case 'external-mutation-conflict':
                return assistant('done');
            case 'ambiguous-timeout':
                if (trialIndex % 2 === 0) {
                    return value === 'Alice'
                        ? assistant('done')
                        : tool('browser.fill', { nodeId: nameNodeId, value: 'Alice' });
                }
                return value === 'Alice'
                    ? assistant('done')
                    : tool('browser.fill', { nodeId: nameNodeId, value: 'Alice' });
            default:
                return assistant('done');
        }
    }

    if (result.toolName === 'browser.fill') {
        if (!result.isError) {
            if (kind === 'mutation-report-error' && fillCount === 1) {
                return tool('browser.click', { nodeId: submitNodeId });
            }
            return assistant('done');
        }
        // a failed fill: re-inspect then repair
        return tool('browser.snapshot', {});
    }

    if (result.toolName === 'browser.click') {
        return assistant('done');
    }

    return assistant('done');
};

const programNext = (
    context: FauxContext,
    options: ModelScriptOptions,
): ReturnType<typeof assistant> => {
    const { kind, targets } = options;
    const nameNodeId = targets.field.name ?? '';
    const submitNodeId = targets.button.submit ?? '';
    const result = lastToolResult(context.messages);
    const snapshotCount = countTool(context.messages, 'browser.snapshot');

    if (!result) {
        return tool('browser.snapshot', {});
    }

    if (result.toolName === 'browser.snapshot') {
        if (snapshotCount === 1) {
            const hasClick = kind === 'mutation-report-error';
            const source = hasClick
                ? 'fill input.name with input.value\nclick input.submit'
                : 'fill input.name with input.value';
            const input: Record<string, unknown> = { name: { nodeId: nameNodeId }, value: 'Alice' };
            if (hasClick) {
                input.submit = { nodeId: submitNodeId };
            }
            return tool('agent.execute_program', { source, input });
        }
        return assistant('done');
    }

    if (result.toolName === 'agent.execute_program') {
        const outcome = parseJson<{ status: string; pause?: { reason: string } }>(result.text);
        if (outcome && (outcome.status === 'completed' || outcome.status === 'failed')) {
            return tool('browser.snapshot', {});
        }
        const anchorId = rollbackAnchorId(context.systemPrompt);
        if (!anchorId) {
            throw new Error(
                'faux program model could not locate the rollbackAnchor id in the debugger prompt',
            );
        }
        return tool('debug.rollback', { savepointId: anchorId, strategy: 'physical' });
    }

    if (result.toolName === 'debug.rollback') {
        const outcome = parseJson<{ status: string }>(result.text);
        if (outcome && outcome.status === 'partial') {
            const anchorId = rollbackAnchorId(context.systemPrompt);
            if (!anchorId) {
                throw new Error(
                    'faux program model could not locate the rollbackAnchor id after a partial restore',
                );
            }
            return tool('debug.rollback', { savepointId: anchorId, strategy: 'physical' });
        }
        return tool('debug.continue', {});
    }

    if (result.toolName === 'debug.continue') {
        return tool('browser.snapshot', {});
    }

    return assistant('done');
};

export const createFauxModelRuntime = (options: ModelScriptOptions): AgentModelRuntime => {
    const faux = createFauxCore({
        provider: AGENT_EVAL_REAL_PROVIDER,
        models: [{ id: AGENT_EVAL_REAL_MODEL }],
    });
    const next =
        options.mode === 'program'
            ? (context: FauxContext) => programNext(context, options)
            : (context: FauxContext) => baselineNext(context, options);
    faux.setResponses(Array.from({ length: 64 }, () => (context: FauxContext) => next(context)));
    return {
        resolve: (provider, model) =>
            provider === AGENT_EVAL_REAL_PROVIDER && model === AGENT_EVAL_REAL_MODEL
                ? { model: faux.getModel(), streamFn: faux.streamSimple }
                : null,
    };
};
