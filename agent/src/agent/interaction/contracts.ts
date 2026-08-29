import crypto from 'node:crypto';

export type InteractionId = string;
export type RunId = string;
export type SessionId = string;

export const INTERACTION_KINDS = [
    'irreversible-effect-approval',
    'recovery-confirmation',
    'user-input-clarification',
    'takeover',
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_STATUSES = ['pending', 'approved', 'denied', 'cancelled', 'expired'] as const;

export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

export type InteractionApproveDecision = Readonly<{
    kind: 'approve';
    approvedBy: string;
    approvedAt: number;
}>;

export type InteractionDenyDecision = Readonly<{
    kind: 'deny';
    deniedBy: string;
    deniedAt: number;
    reason: string;
}>;

export type InteractionCancelDecision = Readonly<{
    kind: 'cancel';
    cancelledBy: string;
    cancelledAt: number;
}>;

export type InteractionExpireDecision = Readonly<{
    kind: 'expire';
    expiredAt: number;
}>;

export type InteractionDecision =
    | InteractionApproveDecision
    | InteractionDenyDecision
    | InteractionCancelDecision
    | InteractionExpireDecision;

export type SanitizedEvidence = Readonly<{
    summary: string;
    effectName?: string;
    toolName?: string;
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
    tags?: ReadonlyArray<string>;
}>;

export type InteractionRecord = Readonly<{
    id: InteractionId;
    runId: RunId;
    sessionId: SessionId;
    kind: InteractionKind;
    status: InteractionStatus;
    createdAt: number;
    deadlineAt: number;
    revision: number;
    prompt: string;
    evidence: SanitizedEvidence;
    decision: InteractionDecision | null;
}>;

export type InteractionCreatedEvent = Readonly<{
    kind: 'created';
    id: InteractionId;
    runId: RunId;
    sessionId: SessionId;
    interactionKind: InteractionKind;
    createdAt: number;
    deadlineAt: number;
    prompt: string;
    evidence: SanitizedEvidence;
    revision: number;
}>;

export type InteractionDecidedEvent = Readonly<{
    kind: 'decided';
    id: InteractionId;
    decision: InteractionApproveDecision | InteractionDenyDecision;
    revision: number;
}>;

export type InteractionCancelledEvent = Readonly<{
    kind: 'cancelled';
    id: InteractionId;
    cancelledBy: string;
    cancelledAt: number;
    revision: number;
}>;

export type InteractionExpiredEvent = Readonly<{
    kind: 'expired';
    id: InteractionId;
    expiredAt: number;
    revision: number;
}>;

export type InteractionEvent =
    | InteractionCreatedEvent
    | InteractionDecidedEvent
    | InteractionCancelledEvent
    | InteractionExpiredEvent;

export class InteractionValidationError extends Error {
    readonly code = 'ERR_INTERACTION_VALIDATION';
}

export class InteractionConcurrencyError extends Error {
    readonly code = 'ERR_INTERACTION_CONCURRENCY';
}

export class InteractionStateError extends Error {
    readonly code = 'ERR_INTERACTION_STATE';
}

const DISALLOWED_EVIDENCE_KEYS = new Set([
    'rawArgs',
    'rawArgsHash',
    'scope',
    'arguments',
    'args',
    'parameters',
    'params',
    'payload',
    'requestBody',
    'context',
    'toolContext',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const assertString = (value: unknown, path: string): string => {
    if (typeof value !== 'string') {
        throw new InteractionValidationError(`${path} must be a string`);
    }
    return value;
};

const assertOptionalString = (value: unknown, path: string): string | undefined => {
    if (value === undefined) {return undefined;}
    return assertString(value, path);
};

const assertOptionalEnum = <T extends string>(
    value: unknown,
    path: string,
    allowed: ReadonlyArray<T>,
): T | undefined => {
    if (value === undefined) {return undefined;}
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw new InteractionValidationError(`${path} must be one of ${allowed.join(', ')}`);
    }
    return value as T;
};

const assertOptionalStringArray = (value: unknown, path: string): ReadonlyArray<string> | undefined => {
    if (value === undefined) {return undefined;}
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new InteractionValidationError(`${path} must be an array of strings`);
    }
    const tags: Array<string> = [];
    for (const item of value) {
        tags.push(String(item));
    }
    return Object.freeze(tags);
};

export const newInteractionId = (): InteractionId => crypto.randomUUID();

export const validateEvidence = (evidence: unknown): SanitizedEvidence => {
    if (!isPlainObject(evidence)) {
        throw new InteractionValidationError('evidence must be an object');
    }
    for (const key of Object.keys(evidence)) {
        if (DISALLOWED_EVIDENCE_KEYS.has(key)) {
            throw new InteractionValidationError(`evidence must not contain raw scope/tool args: ${key}`);
        }
    }
    const summary = assertString(evidence.summary, 'evidence.summary');
    if (summary.length === 0) {
        throw new InteractionValidationError('evidence.summary must not be empty');
    }
    return Object.freeze({
        summary,
        effectName: assertOptionalString(evidence.effectName, 'evidence.effectName'),
        toolName: assertOptionalString(evidence.toolName, 'evidence.toolName'),
        riskLevel: assertOptionalEnum(evidence.riskLevel, 'evidence.riskLevel', ['low', 'medium', 'high', 'critical'] as const),
        tags: assertOptionalStringArray(evidence.tags, 'evidence.tags'),
    });
};
