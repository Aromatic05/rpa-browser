import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import type {AgentModelRuntime} from '../../src/agent/model/runtime';

/**
 * Deterministic scripted model runtime for the product smoke suite.
 *
 * The "model" is a pure script over the conversation: it reads only the tool
 * results the agent actually received (never the world), exactly like a real
 * model would, and emits the next assistant message. Every product assertion
 * in the smoke suite inspects the real browser DOM / service world, never the
 * model's self-report.
 */

export const PRODUCT_SMOKE_PROVIDER = 'product-smoke' as const;
export const PRODUCT_SMOKE_MODEL = 'deterministic-script' as const;

export type ProductFauxContext = {
    systemPrompt?: string;
    messages: readonly unknown[];
    tools?: readonly unknown[];
};

type ToolResult = {
    toolName: string;
    isError: boolean;
    text: string;
};

type AssistantMessage = ReturnType<typeof fauxAssistantMessage>;

export const assistant = (content: Parameters<typeof fauxAssistantMessage>[0]): AssistantMessage =>
    fauxAssistantMessage(content);

export const tool = (name: string, args: Record<string, unknown>): AssistantMessage =>
    assistant(fauxToolCall(name, args));

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
                ? String((block as {text: unknown}).text)
                : '',
        )
        .join('\n');
};

export const lastToolResult = (messages: readonly unknown[]): ToolResult | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {role?: string; toolName?: string; isError?: boolean; content?: unknown};
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

export const parseJson = <T>(text: string): T | null => {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
};

export const countToolCalls = (messages: readonly unknown[], name: string): number =>
    messages
        .filter((message) => (message as {role?: string}).role === 'assistant')
        .flatMap((message) => (message as {content?: unknown}).content ?? [])
        .filter((block): block is {type: string; name: string} =>
            Boolean(block && typeof block === 'object'
                && (block as {type?: string}).type === 'toolCall'
                && (block as {name?: string}).name === name),
        )
        .length;

export const rollbackAnchorId = (systemPrompt: string | undefined): string | null => {
    if (!systemPrompt) {
        return null;
    }
    const match = /rollbackAnchor is \{"id":"([^"]+)"/u.exec(systemPrompt);
    return match ? match[1] : null;
};

export type CaptureResolveTarget = {
    nodeId: string;
    meta: {pageEpoch: string; captureRevision: number};
};

export const parseCaptureResolveTarget = (text: string): CaptureResolveTarget | null => {
    const envelope = parseJson<{
        results?: Array<{data?: {target?: {nodeId?: string; meta?: {pageEpoch?: string; captureRevision?: number}}}}>;
    }>(text);
    const target = envelope?.results?.[0]?.data?.target;
    const nodeId = target?.nodeId;
    const pageEpoch = target?.meta?.pageEpoch;
    const captureRevision = target?.meta?.captureRevision;
    if (typeof nodeId !== 'string' || typeof pageEpoch !== 'string' || typeof captureRevision !== 'number') {
        return null;
    }
    return {nodeId, meta: {pageEpoch, captureRevision}};
};

export const parseExecuteProgramOutcome = (text: string): {status: string; pause?: {reason: string}} | null =>
    parseJson<{status: string; pause?: {reason: string}}>(text);

export type ScriptedModelHandle = {
    runtime: AgentModelRuntime;
    provider: string;
    model: string;
    requestCount: () => number;
    toolCallCount: () => number;
};

/**
 * One scripted "brain" responding to every model request. The script is a
 * pure function of the conversation context and may return a promise to hold
 * the stream open (used by cancellation workflows).
 */
export type ModelScript = (context: ProductFauxContext) => AssistantMessage | Promise<AssistantMessage>;

export const createScriptedModelRuntime = (
    script: ModelScript,
    maxTurns = 32,
): ScriptedModelHandle => {
    const faux = createFauxCore({provider: PRODUCT_SMOKE_PROVIDER, models: [{id: PRODUCT_SMOKE_MODEL}]});
    let requestCount = 0;
    let toolCallCount = 0;
    const countingScript: ModelScript = (context) => {
        requestCount += 1;
        const response = script(context);
        if (response instanceof Promise) {
            response.then((resolved) => {
                if (resolved.content?.some((block) => block.type === 'toolCall')) {
                    toolCallCount += 1;
                }
            }).catch(() => undefined);
            return response;
        }
        if (response.content?.some((block) => block.type === 'toolCall')) {
            toolCallCount += 1;
        }
        return response;
    };
    faux.setResponses(Array.from({length: maxTurns}, () => countingScript));
    const runtime: AgentModelRuntime = {
        resolve: (provider, model) =>
            provider === PRODUCT_SMOKE_PROVIDER && model === PRODUCT_SMOKE_MODEL
                ? {model: faux.getModel() as never, streamFn: faux.streamSimple}
                : null,
    };
    return {
        runtime,
        provider: PRODUCT_SMOKE_PROVIDER,
        model: PRODUCT_SMOKE_MODEL,
        requestCount: () => requestCount,
        toolCallCount: () => toolCallCount,
    };
};

const barrierOutcome = (text: string): {status: string; pause?: {reason: string}} | null => {
    const outcome = parseExecuteProgramOutcome(text);
    if (!outcome) {return null;}
    if (outcome.status === 'paused' && outcome.pause?.reason === 'barrier') {return outcome;}
    return null;
};

/**
 * Cross an unknown-risk commit barrier the way a real agent does when it
 * authorizes an unannotated mutation: debug.cross_barrier until terminal.
 */
export const crossingScript = (inner: ModelScript): ModelScript => (context) => {
    const last = lastToolResult(context.messages);
    if (last && (last.toolName === 'agent.execute_program' || last.toolName === 'debug.cross_barrier')) {
        const outcome = barrierOutcome(last.text);
        if (outcome) {
            return tool('debug.cross_barrier', {});
        }
        if (last.toolName === 'debug.cross_barrier') {
            return assistant('completed');
        }
    }
    return inner(context);
};

/**
 * Script: plan a plain DOM form task through snapshot -> capture_resolve ->
 * execute_program, optionally resolving a second field for multi-step forms.
 * The production workspace executor pauses unannotated mutations at an
 * unknown-risk barrier, so the script authorizes each barrier it hits.
 * Targets are resolved by explicit selector to stay deterministic.
 */
export const planFormProgramScript = (options: {
    fieldSelector: string;
    value: string;
    secondFieldSelector?: string;
    secondValue?: string;
    programSource?: string;
}): ModelScript => crossingScript(planFormProgramCoreScript(options));

const planFormProgramCoreScript = (options: {
    fieldSelector: string;
    value: string;
    secondFieldSelector?: string;
    secondValue?: string;
    programSource?: string;
}): ModelScript => {
    const {fieldSelector, value, secondFieldSelector, secondValue} = options;
    const singleSource = options.programSource ?? [
        'fill input.target with input.value',
        'output result = input.value',
    ].join('\n');
    const multiSource = options.programSource ?? [
        'let expected = compute eq(input.value, input.expected)',
        'ensure expected',
        'fill input.target with input.value',
        'fill input.target2 with input.value2',
        'output ok = expected',
    ].join('\n');
    let firstTarget: CaptureResolveTarget | null = null;
    let captureResolveCalls = 0;
    return (context) => {
        const last = lastToolResult(context.messages);
        if (!last) {
            return tool('browser.snapshot', {});
        }
        if (last.toolName === 'browser.snapshot') {
            return tool('browser.capture_resolve', {selector: fieldSelector});
        }
        if (last.toolName === 'browser.capture_resolve') {
            captureResolveCalls += 1;
            const target = parseCaptureResolveTarget(last.text);
            if (secondFieldSelector && captureResolveCalls === 1) {
                firstTarget = target;
                return tool('browser.capture_resolve', {selector: secondFieldSelector});
            }
            const second = secondFieldSelector ? target : null;
            const primary = secondFieldSelector && firstTarget ? firstTarget : target;
            const input: Record<string, unknown> = {target: primary, value};
            if (second) {
                // Multi-step programs pass logical node targets (no observed
                // revision) so the first effect does not drift the world
                // revision observed by the second effect.
                input.target = {nodeId: primary?.nodeId};
                input.target2 = {nodeId: second.nodeId};
                input.value2 = secondValue ?? value;
                input.expected = value;
            }
            return tool('agent.execute_program', {
                source: second ? multiSource : singleSource,
                input,
            });
        }
        if (last.toolName === 'agent.execute_program') {
            return assistant('completed');
        }
        return assistant('completed');
    };
};

/**
 * Script: read + plan, then execute a program that carries the observed world
 * revision. Used by the world-conflict workflows where the world moves between
 * the read and the transaction.
 */
export const planObservedProgramScript = (options: {
    fieldSelector: string;
    value: string;
    programSource?: string;
}): ModelScript => {
    const {fieldSelector, value} = options;
    const source = options.programSource ?? 'fill input.target with input.value\noutput result = input.value';
    return (context) => {
        const last = lastToolResult(context.messages);
        if (!last) {
            return tool('browser.snapshot', {});
        }
        if (last.toolName === 'browser.snapshot') {
            return tool('browser.capture_resolve', {selector: fieldSelector});
        }
        if (last.toolName === 'browser.capture_resolve') {
            const target = parseCaptureResolveTarget(last.text);
            return tool('agent.execute_program', {source, input: {target, value}});
        }
        if (last.toolName === 'agent.execute_program') {
            const outcome = parseExecuteProgramOutcome(last.text);
            if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
                return tool('debug.cross_barrier', {});
            }
            return assistant('observed');
        }
        return assistant('observed');
    };
};

/**
 * Script: recover from a reversible runtime failure by physical rollback to
 * the pre-effect anchor, then terminalize the original failure. Demonstrates
 * failure -> rollback -> physical restore.
 */
export const rollbackRestoreScript = (options: {
    source: string;
    input: Record<string, unknown>;
}): ModelScript => {
    const {source, input} = options;
    return (context) => {
        const last = lastToolResult(context.messages);
        if (!last) {
            return tool('agent.execute_program', {source, input});
        }
        if (last.toolName === 'agent.execute_program') {
            const outcome = parseExecuteProgramOutcome(last.text);
            if (outcome && (outcome.status === 'completed' || outcome.status === 'failed')) {
                return assistant('terminal');
            }
            const anchor = rollbackAnchorId(context.systemPrompt);
            if (!anchor) {
                throw new Error('rollbackRestoreScript could not locate the rollbackAnchor in the debugger prompt');
            }
            return tool('debug.rollback', {savepointId: anchor, strategy: 'physical'});
        }
        if (last.toolName === 'debug.rollback') {
            const outcome = parseJson<{status: string}>(last.text);
            if (outcome && outcome.status === 'partial') {
                const anchor = rollbackAnchorId(context.systemPrompt);
                return tool('debug.rollback', {savepointId: anchor ?? 'unknown-anchor', strategy: 'physical'});
            }
            return tool('debug.continue', {});
        }
        if (last.toolName === 'debug.continue') {
            return assistant('terminal');
        }
        return assistant('terminal');
    };
};

/**
 * Script: recover from a reversible runtime failure by rewinding to the
 * failing statement savepoint, patching the statement, then continuing the
 * same retained transaction. Demonstrates failure -> rewind -> repair.
 */
export const rewindRepairScript = (options: {
    source: string;
    input: Record<string, unknown>;
    patchSource: string;
}): ModelScript => {
    const {source, input, patchSource} = options;
    let programId = '';
    let path = '';
    return (context) => {
        const last = lastToolResult(context.messages);
        if (!last) {
            return tool('agent.execute_program', {source, input});
        }
        if (last.toolName === 'agent.execute_program') {
            const outcome = parseExecuteProgramOutcome(last.text);
            if (outcome && (outcome.status === 'completed' || outcome.status === 'failed')) {
                return assistant('terminal');
            }
            return tool('debug.execution', {});
        }
        if (last.toolName === 'debug.execution') {
            const state = parseJson<{pause?: {location?: {programId?: string; path?: string}}}>(last.text);
            programId = state?.pause?.location?.programId ?? '';
            path = state?.pause?.location?.path ?? '';
            return tool('debug.rewind_plan', {});
        }
        if (last.toolName === 'debug.rewind_plan') {
            const plan = parseJson<{candidates?: Array<{savepointId: string; exact?: boolean}>}>(last.text);
            const candidate = plan?.candidates?.find((entry) => entry.exact) ?? plan?.candidates?.[0];
            if (!candidate) {
                throw new Error('rewindRepairScript found no rewind candidate');
            }
            return tool('debug.rewind', {savepointId: candidate.savepointId, strategy: 'physical'});
        }
        if (last.toolName === 'debug.rewind') {
            const outcome = parseJson<{status: string}>(last.text);
            if (outcome?.status === 'conflict') {
                return tool('debug.refresh', {});
            }
            return tool('debug.patch_program', {programId, path, source: patchSource});
        }
        if (last.toolName === 'debug.patch_program') {
            const outcome = parseJson<{status: string}>(last.text);
            if (outcome?.status === 'rewind_required') {
                return tool('debug.rewind_plan', {});
            }
            return tool('debug.continue', {});
        }
        if (last.toolName === 'debug.continue') {
            return assistant('terminal');
        }
        if (last.toolName === 'debug.refresh') {
            return tool('debug.execution', {});
        }
        return assistant('terminal');
    };
};

/**
 * Script: authorize unknown-risk barriers as a real agent would. Used with
 * source-driven runs, where the model's first debugger turn arrives with no
 * tool history (the program was started directly from request.source), and the
 * pause is already a barrier. Crosses until terminal so the guarded mutation
 * reaches the world-conflict check at effect execution time.
 */
export const crossBarrierScript: ModelScript = (context) => {
    const last = lastToolResult(context.messages);
    if (!last) {
        return tool('debug.cross_barrier', {});
    }
    if (last.toolName === 'debug.cross_barrier') {
        const outcome = parseExecuteProgramOutcome(last.text);
        if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
            return tool('debug.cross_barrier', {});
        }
    }
    return assistant('done');
};

/**
 * A model that simply answers text and never calls tools. Used by
 * source-driven runs that complete (or pause for HITL) without planning.
 */
export const silentModelScript: ModelScript = () => assistant('done');