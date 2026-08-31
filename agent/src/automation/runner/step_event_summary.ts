import type { StepUnion } from './steps/types';
import { createRedactionPolicy, type RedactionPolicy } from '../../security/redaction';

const REDACTED = '[REDACTED]';

export const summarizeStepArgs = (step: StepUnion, redact?: RedactionPolicy): unknown => {
    const policy = redact ?? createRedactionPolicy({ placeholder: REDACTED });
    const summary = policy.redact(step.args).value as Record<string, unknown>;
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
    return summary;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);