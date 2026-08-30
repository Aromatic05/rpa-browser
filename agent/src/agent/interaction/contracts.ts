import crypto from 'node:crypto';

export type InteractionId = string;
export type RunId = string;
export type SessionId = string;

/**
 * Product interaction kinds. Each kind carries a typed, sanitized payload and a
 * kind-specific typed resolution; there is no generic free-form prompt blob.
 */
export const INTERACTION_KINDS = [
    'approval',
    'clarification',
    'recovery_decision',
    'takeover',
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_STATUSES = [
    'pending',
    'approved',
    'denied',
    'answered',
    'resolved',
    'cancelled',
    'expired',
] as const;

export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

/** Reversibility vocabulary shared with the execution effect semantics. */
export type EffectReversibility = 'unknown' | 'reversible' | 'compensatable' | 'irreversible';

export type ClarificationSchema = Readonly<{
    field: string;
    type: 'text' | 'number' | 'date' | 'select';
    allowed?: ReadonlyArray<string>;
    min?: number;
    max?: number;
    maxLength?: number;
    default?: unknown;
    /** When true and the request explicitly marks it safe, the default may be
     *  used on timeout; otherwise expiry is never an implicit submission. */
    safeOnTimeout?: boolean;
}>;

export type RecoveryOptionKind = 'retry' | 'repair' | 'rollback' | 'rewind' | 'terminate';

export type ProductRecoveryOption = Readonly<{
    id: string;
    kind: RecoveryOptionKind;
    label: string;
    eligible: boolean;
    block?: Readonly<{code: string; message: string}>;
}>;

export type GuidanceMode = 'manual' | 'teach' | 'annotate';
export type TeachKind = 'procedure' | 'recovery' | 'demonstration';

/** Kind-specific request payload. Sanitized: no CoT, raw tool args, program
 *  source, secrets, or internal execution ids. */
export type InteractionPayload =
    | Readonly<{kind: 'approval'; actionName: string; summary: string; risk: EffectReversibility}>
    | Readonly<{kind: 'clarification'; question: string; schema: ClarificationSchema}>
    | Readonly<{kind: 'recovery_decision'; failureSummary: string; options: ReadonlyArray<ProductRecoveryOption>}>
    | Readonly<{
        kind: 'takeover';
        reason: string;
        scope: 'workspace' | 'tab';
        guidanceModes: ReadonlyArray<GuidanceMode>;
        teachKind?: TeachKind;
    }>;

/** Kind-specific typed resolution. */
export type InteractionDecision =
    | Readonly<{kind: 'approve'; approvedAt: number}>
    | Readonly<{kind: 'deny'; deniedAt: number; reason: string; requestedAlternative?: string}>
    | Readonly<{kind: 'answer'; answeredAt: number; value: unknown}>
    | Readonly<{kind: 'choose'; chosenAt: number; optionId: string}>
    | Readonly<{kind: 'returnControl'; returnedAt: number; mode: GuidanceMode; savedReference?: string}>
    | Readonly<{kind: 'cancel'; cancelledAt: number; cancelledBy: string}>
    | Readonly<{kind: 'expire'; expiredAt: number}>;

/** Opaque internal linkage used by the session service to dedupe requests
 *  derived from the same retained program. Never projected to the product
 *  surface. */
export type InteractionInternal = Readonly<{
    programIndex?: number;
}>;

export type InteractionRecord = Readonly<{
    id: InteractionId;
    runId: RunId;
    sessionId: SessionId;
    kind: InteractionKind;
    status: InteractionStatus;
    /** Takeover stage while pending: offered -> active (human guidance). */
    stage?: 'offered' | 'active';
    createdAt: number;
    deadlineAt: number;
    revision: number;
    payload: InteractionPayload;
    decision: InteractionDecision | null;
    internal?: InteractionInternal;
}>;

export type InteractionCreatedEvent = Readonly<{
    kind: 'created';
    id: InteractionId;
    runId: RunId;
    sessionId: SessionId;
    interactionKind: InteractionKind;
    createdAt: number;
    deadlineAt: number;
    payload: InteractionPayload;
    internal?: InteractionInternal;
    revision: number;
}>;

export type InteractionDecidedEvent = Readonly<{
    kind: 'decided';
    id: InteractionId;
    decision: InteractionDecision;
    revision: number;
}>;

export type InteractionStagedEvent = Readonly<{
    kind: 'staged';
    id: InteractionId;
    stage: 'offered' | 'active';
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
    | InteractionStagedEvent
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

const assertString = (value: unknown, path: string): string => {
    if (typeof value !== 'string') {
        throw new InteractionValidationError(`${path} must be a string`);
    }
    return value;
};

const assertNonEmptyString = (value: unknown, path: string): string => {
    const text = assertString(value, path);
    if (text.trim().length === 0) {
        throw new InteractionValidationError(`${path} must not be empty`);
    }
    return text;
};

const assertOptionalBoolean = (value: unknown, path: string): boolean | undefined => {
    if (value === undefined) {return undefined;}
    if (typeof value !== 'boolean') {
        throw new InteractionValidationError(`${path} must be a boolean`);
    }
    return value;
};

const assertOptionalNumber = (value: unknown, path: string): number | undefined => {
    if (value === undefined) {return undefined;}
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InteractionValidationError(`${path} must be a finite number`);
    }
    return value;
};

const assertOptionalStringArray = (value: unknown, path: string): ReadonlyArray<string> | undefined => {
    if (value === undefined) {return undefined;}
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new InteractionValidationError(`${path} must be an array of strings`);
    }
    return Object.freeze(value.slice() as string[]);
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

const validateClarificationSchema = (schema: unknown): ClarificationSchema => {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new InteractionValidationError('clarification schema must be an object');
    }
    const record = schema as Record<string, unknown>;
    const field = assertNonEmptyString(record.field, 'schema.field');
    const type = assertOptionalEnum(record.type, 'schema.type', ['text', 'number', 'date', 'select'] as const);
    if (type === undefined) {
        throw new InteractionValidationError('schema.type is required');
    }
    const allowed = assertOptionalStringArray(record.allowed, 'schema.allowed');
    const min = assertOptionalNumber(record.min, 'schema.min');
    const max = assertOptionalNumber(record.max, 'schema.max');
    const maxLength = assertOptionalNumber(record.maxLength, 'schema.maxLength');
    if (type === 'select' && allowed === undefined) {
        throw new InteractionValidationError('select clarification requires schema.allowed');
    }
    if (type === 'number' && min !== undefined && max !== undefined && min > max) {
        throw new InteractionValidationError('schema.min must not exceed schema.max');
    }
    if (maxLength !== undefined && maxLength < 0) {
        throw new InteractionValidationError('schema.maxLength must be non-negative');
    }
    return Object.freeze({
        field,
        type,
        ...(allowed === undefined ? {} : {allowed}),
        ...(min === undefined ? {} : {min}),
        ...(max === undefined ? {} : {max}),
        ...(maxLength === undefined ? {} : {maxLength}),
        ...(record.default === undefined ? {} : {default: record.default}),
        ...(assertOptionalBoolean(record.safeOnTimeout, 'schema.safeOnTimeout') === undefined
            ? {}
            : {safeOnTimeout: record.safeOnTimeout as boolean}),
    });
};

const validateApprovalPayload = (payload: Record<string, unknown>): InteractionPayload => {
    return Object.freeze({
        kind: 'approval' as const,
        actionName: assertNonEmptyString(payload.actionName, 'payload.actionName'),
        summary: assertNonEmptyString(payload.summary, 'payload.summary'),
        risk: assertOptionalEnum(
            payload.risk,
            'payload.risk',
            ['unknown', 'reversible', 'compensatable', 'irreversible'] as const,
        ) ?? 'unknown',
    });
};

const validateClarificationPayload = (payload: Record<string, unknown>): InteractionPayload => {
    return Object.freeze({
        kind: 'clarification' as const,
        question: assertNonEmptyString(payload.question, 'payload.question'),
        schema: validateClarificationSchema(payload.schema),
    });
};

const validateRecoveryOptions = (options: unknown): ReadonlyArray<ProductRecoveryOption> => {
    if (!Array.isArray(options) || options.length === 0) {
        throw new InteractionValidationError('recovery options must be a non-empty array');
    }
    return Object.freeze(options.map((option, index) => {
        if (option === null || typeof option !== 'object' || Array.isArray(option)) {
            throw new InteractionValidationError(`recovery option ${index} must be an object`);
        }
        const record = option as Record<string, unknown>;
        const id = assertNonEmptyString(record.id, `option[${index}].id`);
        const kind = assertOptionalEnum(
            record.kind,
            `option[${index}].kind`,
            ['retry', 'repair', 'rollback', 'rewind', 'terminate'] as const,
        );
        if (kind === undefined) {
            throw new InteractionValidationError(`option[${index}].kind is required`);
        }
        if (typeof record.eligible !== 'boolean') {
            throw new InteractionValidationError(`option[${index}].eligible must be a boolean`);
        }
        const label = assertNonEmptyString(record.label, `option[${index}].label`);
        const block = record.block;
        let sanitizedBlock: ProductRecoveryOption['block'];
        if (block !== undefined) {
            if (block === null || typeof block !== 'object' || Array.isArray(block)) {
                throw new InteractionValidationError(`option[${index}].block must be an object`);
            }
            const blockRecord = block as Record<string, unknown>;
            sanitizedBlock = Object.freeze({
                code: assertNonEmptyString(blockRecord.code, `option[${index}].block.code`),
                message: assertNonEmptyString(blockRecord.message, `option[${index}].block.message`),
            });
        }
        return Object.freeze({
            id,
            kind,
            label,
            eligible: record.eligible,
            ...(sanitizedBlock === undefined ? {} : {block: sanitizedBlock}),
        });
    }));
};

const validateRecoveryDecisionPayload = (payload: Record<string, unknown>): InteractionPayload => {
    return Object.freeze({
        kind: 'recovery_decision' as const,
        failureSummary: assertNonEmptyString(payload.failureSummary, 'payload.failureSummary'),
        options: validateRecoveryOptions(payload.options),
    });
};

const validateTakeoverPayload = (payload: Record<string, unknown>): InteractionPayload => {
    const guidanceModes = assertOptionalStringArray(payload.guidanceModes, 'payload.guidanceModes');
    if (guidanceModes === undefined || guidanceModes.length === 0) {
        throw new InteractionValidationError('takeover payload.guidanceModes is required');
    }
    const modes: Array<'manual' | 'teach' | 'annotate'> = [];
    for (const mode of guidanceModes) {
        if (mode !== 'manual' && mode !== 'teach' && mode !== 'annotate') {
            throw new InteractionValidationError(`unsupported guidance mode: ${mode}`);
        }
        modes.push(mode);
    }
    const scope = assertOptionalEnum(payload.scope, 'payload.scope', ['workspace', 'tab'] as const) ?? 'workspace';
    return Object.freeze({
        kind: 'takeover' as const,
        reason: assertNonEmptyString(payload.reason, 'payload.reason'),
        scope,
        guidanceModes: Object.freeze(modes),
        ...(assertOptionalEnum(
            payload.teachKind,
            'payload.teachKind',
            ['procedure', 'recovery', 'demonstration'] as const,
        ) === undefined
            ? {}
            : {teachKind: payload.teachKind as TeachKind}),
    });
};

export const validateInteractionPayload = (payload: unknown): InteractionPayload => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new InteractionValidationError('payload must be an object');
    }
    const record = payload as Record<string, unknown>;
    const kind = assertOptionalEnum(record.kind, 'payload.kind', INTERACTION_KINDS);
    if (kind === undefined) {
        throw new InteractionValidationError('payload.kind is required');
    }
    switch (kind) {
        case 'approval': return validateApprovalPayload(record);
        case 'clarification': return validateClarificationPayload(record);
        case 'recovery_decision': return validateRecoveryDecisionPayload(record);
        case 'takeover': return validateTakeoverPayload(record);
    }
};

/** Kinds the retained Agent control loop may request directly. Approval is
 *  deliberately absent: it is generated only from an objectively detected
 *  irreversible barrier, never by the model. */
export const MODEL_REQUESTED_INTERACTION_KINDS: readonly InteractionKind[] = [
    'clarification',
    'recovery_decision',
    'takeover',
];

export type ModelRequestedInteraction = Exclude<InteractionPayload, {kind: 'approval'}>;

/**
 * Validates a model-requested interaction against the full payload contract and
 * then rejects `approval` at the product/governance boundary. The generic
 * `validateInteractionPayload` stays intact for the SessionManager.
 */
export const validateModelRequestedInteraction = (value: unknown): ModelRequestedInteraction => {
    const payload = validateInteractionPayload(value);
    if (payload.kind === 'approval') {
        throw new InteractionValidationError(
            'the model cannot request an approval; approval is generated only from an objectively detected irreversible barrier',
        );
    }
    return payload;
};

export type ClarificationAnswerCheck = Readonly<{
    ok: true;
    value: unknown;
}> | Readonly<{
    ok: false;
    error: string;
}>;

export const checkClarificationAnswer = (
    schema: ClarificationSchema,
    value: unknown,
): ClarificationAnswerCheck => {
    switch (schema.type) {
        case 'text': {
            if (typeof value !== 'string') {return {ok: false, error: `${schema.field} must be text`};}
            if (schema.maxLength !== undefined && value.length > schema.maxLength) {
                return {ok: false, error: `${schema.field} must be at most ${schema.maxLength} characters`};
            }
            return {ok: true, value};
        }
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value)) {return {ok: false, error: `${schema.field} must be a number`};}
            if (schema.min !== undefined && value < schema.min) {return {ok: false, error: `${schema.field} must be at least ${schema.min}`};}
            if (schema.max !== undefined && value > schema.max) {return {ok: false, error: `${schema.field} must be at most ${schema.max}`};}
            return {ok: true, value};
        }
        case 'date': {
            if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
                return {ok: false, error: `${schema.field} must be a date (YYYY-MM-DD)`};
            }
            return {ok: true, value};
        }
        case 'select': {
            if (typeof value !== 'string' || !(schema.allowed ?? []).includes(value)) {
                return {ok: false, error: `${schema.field} must be one of ${(schema.allowed ?? []).join(', ')}`};
            }
            return {ok: true, value};
        }
    }
};

export const decisionStatus = (decision: InteractionDecision): InteractionStatus => {
    switch (decision.kind) {
        case 'approve': return 'approved';
        case 'deny': return 'denied';
        case 'answer': return 'answered';
        case 'choose':
        case 'returnControl': return 'resolved';
        case 'cancel': return 'cancelled';
        case 'expire': return 'expired';
    }
};

export const newInteractionId = (): InteractionId => crypto.randomUUID();