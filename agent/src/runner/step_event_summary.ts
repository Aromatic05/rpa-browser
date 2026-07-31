import type { StepUnion } from './steps/types';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|credential)/i;

export const summarizeStepArgs = (step: StepUnion): unknown => {
    const summary = redactSensitiveKeys(step.args) as Record<string, unknown>;
    if (step.name === 'browser.fill') {
        return { ...summary, value: REDACTED };
    }
    if (step.name === 'browser.type') {
        return { ...summary, text: REDACTED };
    }
    if (step.name === 'browser.select_option') {
        return { ...summary, values: REDACTED };
    }
    if (step.name === 'browser.query' && isRecord(summary.target) && isRecord(summary.target.primaryKey)) {
        return {
            ...summary,
            target: {
                ...summary.target,
                primaryKey: { ...summary.target.primaryKey, value: REDACTED },
            },
        };
    }
    if (step.name === 'browser.goto' && typeof summary.url === 'string') {
        return { ...summary, url: redactUrl(summary.url) };
    }
    return summary;
};

const redactSensitiveKeys = (value: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) {return REDACTED;}
    if (Array.isArray(value)) {return value.map((item) => redactSensitiveKeys(item));}
    if (!isRecord(value)) {return value;}
    return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSensitiveKeys(entryValue, entryKey)]),
    );
};

const redactUrl = (value: string): string => {
    try {
        const url = new URL(value);
        for (const key of url.searchParams.keys()) {
            if (SENSITIVE_KEY.test(key)) {url.searchParams.set(key, REDACTED);}
        }
        return url.toString();
    } catch {
        return value;
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
