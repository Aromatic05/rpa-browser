import {measureTextSize, type AgentContextSize} from './measure';

export type ToolResultSizePolicyEntry = {
    /** Maximum model-visible serialized characters for this tool's result content. */
    maxVisibleChars?: number;
    /** Maximum model-visible serialized characters for this tool's error content. */
    errorMaxVisibleChars?: number;
    /** Keys preserved verbatim (identifiers required for follow-up resolution). */
    keepFields?: readonly string[];
};

export type ToolResultSizePolicy = Partial<Record<string, ToolResultSizePolicyEntry>>;

export const DEFAULT_TOOL_RESULT_IDENTIFIER_FIELDS: readonly string[] = [
    'id',
    'nodeId',
    'stepId',
    'captureId',
    'scopeId',
    'ref',
    'contentRef',
    'gen_ref',
    'refId',
    'resolveId',
    'tabName',
    'name',
    'role',
    'businessTag',
    'entityId',
    'controlId',
    'componentId',
    'pageEpoch',
    'captureRevision',
];

export const DEFAULT_TOOL_RESULT_MAX_VISIBLE_CHARS = 256_000;

export const DEFAULT_TOOL_RESULT_SIZES: ToolResultSizePolicy = {
    'browser.snapshot': {maxVisibleChars: 96_000},
    'browser.query': {maxVisibleChars: 48_000},
    'browser.capture_resolve': {maxVisibleChars: 32_000},
    'browser.get_content': {maxVisibleChars: 32_000},
};

export type AgentToolResultContent = {
    text: string;
    visibleChars: number;
    visibleBytes: number;
    originalChars: number;
    originalBytes: number;
    truncated: boolean;
};

const ENVELOPE_OVERHEAD_ESTIMATE = 512;

const truncateTextToFit = (value: string, budget: number): string => {
    const maxInner = Math.max(0, budget - 2);
    const points = Array.from(value);
    if (points.length <= maxInner) {return value;}
    let low = 0;
    let high = points.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const prefix = points.slice(0, mid).join('');
        if (JSON.stringify(prefix).length <= budget) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return points.slice(0, low).join('');
};

const preservesIdentity = (
    original: unknown,
    reduced: unknown,
    keepFields: readonly string[],
): boolean => {
    if (original === null || typeof original !== 'object' || Array.isArray(original)) {return true;}
    const reducedRecord = reduced as Record<string, unknown> | null | undefined;
    if (reducedRecord === null || typeof reducedRecord !== 'object') {return true;}
    const hadIdentity = keepFields.some((key) =>
        Object.prototype.hasOwnProperty.call(original, key));
    if (!hadIdentity) {return true;}
    return keepFields.some((key) =>
        Object.prototype.hasOwnProperty.call(reducedRecord, key));
};

const reduceNode = (value: unknown, budget: number, keepFields: readonly string[]): unknown => {
    if (budget <= 0) {
        return Array.isArray(value) ? [] : value !== null && typeof value === 'object' ? {} : value;
    }
    if (typeof value === 'string') {
        return JSON.stringify(value).length <= budget ? value : truncateTextToFit(value, budget);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        const reduced: unknown[] = [];
        let spent = 2;
        for (const item of value) {
            const remaining = budget - spent - 1;
            if (remaining <= 0) {break;}
            const itemValue = reduceNode(item, Math.max(0, remaining - 1), keepFields);
            if (JSON.stringify(itemValue).length <= 2) {break;}
            if (!preservesIdentity(item, itemValue, keepFields)) {break;}
            const cost = JSON.stringify(itemValue).length + 1;
            if (cost > remaining) {break;}
            reduced.push(itemValue);
            spent += cost;
        }
        return reduced;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const reduced: Record<string, unknown> = {};
        let spent = 2;
        const entries = Object.entries(record);
        const append = (key: string, item: unknown): void => {
            const remaining = budget - spent - 1;
            if (remaining <= 0) {return;}
            const keyOverhead = key.length + 4;
            const itemValue = reduceNode(item, Math.max(0, remaining - keyOverhead - 1), keepFields);
            const cost = JSON.stringify(itemValue).length + keyOverhead + 1;
            if (cost > remaining) {return;}
            reduced[key] = itemValue;
            spent += cost;
        };
        for (const [key, item] of entries) {
            if (keepFields.includes(key)) {append(key, item);}
        }
        for (const [key, item] of entries) {
            if (keepFields.includes(key)) {continue;}
            if (budget - spent - 1 <= 0) {break;}
            append(key, item);
        }
        return reduced;
    }
    return value;
};

export const reduceJsonForModel = (value: unknown, budget: number, keepFields: readonly string[]): unknown =>
    reduceNode(value, budget, keepFields);

const buildEnvelope = (
    content: unknown,
    original: AgentContextSize,
    limitChars: number,
    withContent: boolean,
): {text: string; visible: AgentContextSize} => {
    let envelope: Record<string, unknown> = {
        truncated: true,
        reason: 'tool result exceeds model-visible budget',
        limitChars,
        originalChars: original.chars,
        originalBytes: original.bytes,
        visibleChars: 0,
        visibleBytes: 0,
    };
    if (withContent) {envelope.content = content;}
    for (let pass = 0; pass < 4; pass += 1) {
        const size = measureTextSize(JSON.stringify(envelope));
        if (envelope.visibleChars === size.chars && envelope.visibleBytes === size.bytes) {
            return {text: JSON.stringify(envelope), visible: size};
        }
        envelope = {...envelope, visibleChars: size.chars, visibleBytes: size.bytes};
    }
    const text = JSON.stringify(envelope);
    return {text, visible: measureTextSize(text)};
};

const applyEnvelope = (
    content: unknown,
    original: AgentContextSize,
    limitChars: number,
    withContent: boolean,
): AgentToolResultContent => {
    const {text, visible} = buildEnvelope(content, original, limitChars, withContent);
    return {
        text,
        visibleChars: visible.chars,
        visibleBytes: visible.bytes,
        originalChars: original.chars,
        originalBytes: original.bytes,
        truncated: true,
    };
};

export const serializeAgentToolResult = (
    toolName: string,
    value: unknown,
    policy: ToolResultSizePolicy = DEFAULT_TOOL_RESULT_SIZES,
): AgentToolResultContent => {
    let raw: string;
    try {
        raw = JSON.stringify(value);
    } catch {
        raw = String(value);
    }
    const original = measureTextSize(raw);
    const cap = policy[toolName]?.maxVisibleChars ?? DEFAULT_TOOL_RESULT_MAX_VISIBLE_CHARS;
    if (original.chars <= cap) {
        return {
            text: raw,
            visibleChars: original.chars,
            visibleBytes: original.bytes,
            originalChars: original.chars,
            originalBytes: original.bytes,
            truncated: false,
        };
    }
    const keepFields = policy[toolName]?.keepFields ?? DEFAULT_TOOL_RESULT_IDENTIFIER_FIELDS;
    let contentBudget = Math.max(0, cap - ENVELOPE_OVERHEAD_ESTIMATE);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const content = reduceJsonForModel(value, contentBudget, keepFields);
        const {text, visible} = buildEnvelope(content, original, cap, true);
        if (visible.chars <= cap) {
            return {
                text,
                visibleChars: visible.chars,
                visibleBytes: visible.bytes,
                originalChars: original.chars,
                originalBytes: original.bytes,
                truncated: true,
            };
        }
        const overflow = visible.chars - cap;
        contentBudget = Math.max(0, contentBudget - overflow - 64);
    }
    return applyEnvelope(null, original, cap, false);
};

export const DEFAULT_TOOL_RESULT_ERROR_MAX_VISIBLE_CHARS = 16_000;

export const serializeAgentToolError = (
    toolName: string,
    payload: unknown,
    policy: ToolResultSizePolicy = DEFAULT_TOOL_RESULT_SIZES,
): string => {
    const cap = policy[toolName]?.errorMaxVisibleChars ?? DEFAULT_TOOL_RESULT_ERROR_MAX_VISIBLE_CHARS;
    const capped = serializeAgentToolResult(toolName, payload, {
        ...policy,
        [toolName]: {
            ...(policy[toolName] ?? {}),
            maxVisibleChars: cap,
        },
    });
    return capped.text;
};