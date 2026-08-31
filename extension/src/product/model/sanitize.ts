/**
 * Task-domain sanitizers: the activity timeline, interaction request union, and
 * AgentTaskView. Unknown kinds, malformed shapes, and raw ids are dropped so a
 * task projection is always truthful and safe to render.
 */
import type {
    ActivityEvent,
    AgentTaskView,
    ClarificationSchema,
    GuidanceMode,
    InteractionRequest,
    RecoveryOption,
    TaskResultView,
} from './contracts.js';
import {
    asBoolean,
    asNonEmptyString,
    asNumber,
    asString,
    asStringArray,
    isGuidanceMode,
    isOutcome,
    isPhase,
    isRecoveryKind,
    isRecord,
    isStatus,
    isTeachKind,
} from './guards.js';

/** First non-empty line of the prompt, truncated to 64 chars with a trailing ellipsis (spec §5). */
export const deriveTitle = (prompt: string): string => {
    const firstLine =
        prompt
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? '';
    if (firstLine.length <= 64) {
        return firstLine;
    }
    return `${firstLine.slice(0, 64)}…`;
};

const fallbackGuidanceSummary = (mode: GuidanceMode): string => {
    if (mode === 'manual') {
        return 'Manual control returned';
    }
    if (mode === 'teach') {
        return 'Teaching finished';
    }
    return 'Annotation finished';
};

const ASSET_LABELS: Record<string, string> = {
    procedure: 'Procedure',
    recovery: 'Recovery',
    demonstration: 'Demonstration',
    page_knowledge: 'Page Knowledge',
    automation: 'Automation',
    asset: 'an asset',
};

const guidanceCompletedSummary = (base: string, kind?: string, ref?: string): string => {
    if (!kind) {
        return base;
    }
    const label = ASSET_LABELS[kind] ?? 'an asset';
    const sanitizedRef = ref && ref.length <= 120 && !/[[\]{}<>`"'\\]/u.test(ref) ? ref : undefined;
    return sanitizedRef ? `${base} · saved ${label} “${sanitizedRef}”` : `${base} · saved ${label}`;
};

const activitySummaryOf = (kind: string | undefined, item: Record<string, unknown>): string | undefined =>
    asNonEmptyString(item.summary)
    ?? (kind === 'task_created'
        ? asNonEmptyString(item.promptSummary)
        : kind === 'interaction_requested'
          ? asNonEmptyString(item.headline)
          : kind === 'interaction_resolved'
            ? asNonEmptyString(item.decisionSummary)
            : kind === 'human_guidance_started'
              ? asNonEmptyString(item.purpose)
              : undefined);

/**
 * Sanitize one backend activity event into the typed `ActivityEvent`. Accepts
 * the real `/agent/product` event field names (`promptSummary`, `headline`,
 * `decisionSummary`, `purpose`) plus the generic `summary` field, so the
 * backend event stream maps 1:1 without fabricating anything.
 */
export const sanitizeActivityEvent = (raw: unknown): ActivityEvent | null => {
    if (!isRecord(raw)) {
        return null;
    }
    const kind = asString(raw.kind);
    const at = asNumber(raw.at) ?? 0;
    if (kind === 'phase_changed' && isPhase(raw.phase)) {
        return { kind: 'phase_changed', phase: raw.phase, at };
    }
    if (kind === 'human_guidance_started' && isGuidanceMode(raw.mode)) {
        const summary = activitySummaryOf(kind, raw);
        if (!summary) {
            return null;
        }
        return { kind: 'human_guidance_started', mode: raw.mode, summary, at };
    }
    if (kind === 'human_guidance_completed' && isGuidanceMode(raw.mode)) {
        const base = activitySummaryOf(kind, raw) ?? fallbackGuidanceSummary(raw.mode);
        const assetKind = asNonEmptyString(raw.savedAssetKind);
        const assetRef = asNonEmptyString(raw.savedAssetRef);
        return {
            kind: 'human_guidance_completed',
            mode: raw.mode,
            summary: guidanceCompletedSummary(base, assetKind, assetRef),
            ...(assetKind ? { savedAssetKind: assetKind } : {}),
            ...(assetRef ? { savedAssetRef: assetRef } : {}),
            at,
        };
    }
    if (kind === 'effect_applied') {
        const status = raw.status;
        const summary = asNonEmptyString(raw.summary);
        if ((status === 'ok' || status === 'succeeded' || status === 'failed') && summary) {
            return { kind: 'effect_applied', summary, status: status === 'failed' ? 'failed' : 'ok', at };
        }
        return null;
    }
    if (kind === 'task_terminated' && isOutcome(raw.outcome)) {
        return { kind: 'task_terminated', outcome: raw.outcome, at };
    }
    if (kind === 'report_ready') {
        return { kind: 'report_ready', at };
    }
    if (kind === 'world_conflict') {
        const expected = asNonEmptyString(raw.expected);
        const actual = asNonEmptyString(raw.actual);
        const summary =
            asNonEmptyString(raw.summary)
            ?? (expected && actual ? `${expected} → observed ${actual}` : undefined);
        if (!summary) {
            return null;
        }
        return { kind: 'world_conflict', summary, at };
    }
const summary = activitySummaryOf(kind, raw);
    if (!summary) {
        return null;
    }
    if (kind === 'task_created' || kind === 'interaction_requested' || kind === 'interaction_resolved') {
        return { kind, summary, at };
    }
    return { kind: 'activity', summary, at };
};

const sanitizeTimeline = (raw: unknown): ActivityEvent[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    const events: ActivityEvent[] = [];
    for (const item of raw) {
        const sanitized = sanitizeActivityEvent(item);
        if (sanitized) {
            events.push(sanitized);
        }
    }
    return events;
};

const sanitizeSchema = (raw: unknown): ClarificationSchema | null => {
    if (!isRecord(raw)) {
        return null;
    }
    const field = asNonEmptyString(raw.field);
    const type = raw.type;
    if (!field || (type !== 'text' && type !== 'number' && type !== 'date' && type !== 'select')) {
        return null;
    }
    const allowed = Array.isArray(raw.allowed)
        ? raw.allowed.flatMap((item) => {
              if (typeof item === 'string') {
                  const value = asNonEmptyString(item);
                  return value ? [{ value, label: value }] : [];
              }
              if (!isRecord(item)) {
                  return [];
              }
              const value = asNonEmptyString(item.value);
              const label = asNonEmptyString(item.label);
              return value ? [{ value, label: label ?? value }] : [];
          })
        : undefined;
    if (type === 'select' && (!allowed || allowed.length === 0)) {
        return null;
    }
    return {
        field,
        type,
        allowed,
        min: asNumber(raw.min),
        max: asNumber(raw.max),
        maxLength: asNumber(raw.maxLength),
        default: asString(raw.default),
    };
};

const sanitizeRecoveryOptions = (raw: unknown): RecoveryOption[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!isRecord(item)) {
            return [];
        }
        const id = asNonEmptyString(item.id);
        const kind = item.kind;
        const label = asNonEmptyString(item.label);
        if (!id || !isRecoveryKind(kind) || !label) {
            return [];
        }
        const eligible = asBoolean(item.eligible) ?? false;
        const block = eligible ? undefined : asNonEmptyString(item.block);
        return [{ id, kind, label, eligible, block }];
    });
};

const sanitizeGuidanceModes = (raw: unknown): GuidanceMode[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter(isGuidanceMode);
};

const approvalRiskSummary = (raw: unknown): string => {
    const risk = asString(raw);
    switch (risk) {
        case undefined: return '';
        case 'unknown': return 'Safety has not been classified for this action.';
        case 'reversible': return 'This action is expected to be reversible.';
        case 'compensatable': return 'A compensating action may be available, but exact restoration is not guaranteed.';
        case 'irreversible': return 'This action may not be undoable.';
        default: return risk;
    }
};

const sanitizeInteraction = (raw: unknown): InteractionRequest | null => {
    if (!isRecord(raw)) {
        return null;
    }
    const kind = asString(raw.kind);
    const interactionToken = asNonEmptyString(raw.interactionToken);
    if (!interactionToken) {
        return null;
    }
    if (kind === 'approval') {
        const effectName = asNonEmptyString(raw.effectName) ?? asNonEmptyString(raw.actionName);
        if (!effectName) {
            return null;
        }
        return {
            kind,
            interactionToken,
            effectName,
            risk: approvalRiskSummary(raw.risk),
            evidence: asString(raw.evidence) ?? asString(raw.summary),
            details: asStringArray(raw.details),
        };
    }
    if (kind === 'clarification') {
        const question = asNonEmptyString(raw.question);
        const schema = sanitizeSchema(raw.schema);
        if (!question || !schema) {
            return null;
        }
        return { kind, interactionToken, question, schema };
    }
    if (kind === 'recovery_decision') {
        const failureSummary = asNonEmptyString(raw.failureSummary);
        const options = sanitizeRecoveryOptions(raw.options);
        if (!failureSummary || options.length === 0) {
            return null;
        }
        return {
            kind,
            interactionToken,
            failureSummary,
            evidence: asString(raw.evidence),
            details: asStringArray(raw.details),
            options,
            recommendedOptionId: asNonEmptyString(raw.recommendedOptionId),
        };
    }
    if (kind === 'takeover') {
        const reason = asNonEmptyString(raw.reason);
        const scope = raw.scope === 'tab' ? 'tab' : raw.scope === 'workspace' ? 'workspace' : undefined;
        const guidanceModes = sanitizeGuidanceModes(raw.guidanceModes);
        if (!reason || !scope || guidanceModes.length === 0) {
            return null;
        }
        return {
            kind,
            interactionToken,
            reason,
            scope,
            guidanceModes,
            stage: raw.stage === 'active' ? 'active' : raw.stage === 'offered' ? 'offered' : undefined,
            activeMode: isGuidanceMode(raw.activeMode) ? raw.activeMode : undefined,
            teachKind: isTeachKind(raw.teachKind) ? raw.teachKind : undefined,
        };
    }
    return null;
};

const sanitizeResult = (raw: unknown): TaskResultView | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const outcome = isOutcome(raw.outcome) ? raw.outcome : undefined;
    if (!outcome) {
        return undefined;
    }
    return {
        outcome,
        output: asString(raw.output) ?? asString(raw.summary),
        errorMessage: asString(raw.errorMessage),
        effectsCount: asNumber(raw.effectsCount) ?? 0,
        reportAvailable: asBoolean(raw.reportAvailable) ?? false,
        saveEligible: asBoolean(raw.saveEligible) ?? false,
        recoverySummary: asString(raw.recoverySummary),
    };
};

const sanitizeDevOverride = (raw: unknown): AgentTaskView['devOverride'] | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const model = asString(raw.model);
    const executionMode = asString(raw.executionMode);
    if (!model && !executionMode) {
        return undefined;
    }
    return { model, executionMode };
};

/** Sanitize one AgentTaskView (AgentProductInteraction §12.1). */
export const sanitizeTaskView = (raw: unknown): AgentTaskView | null => {
    if (!isRecord(raw)) {
        return null;
    }
    const taskId = asNonEmptyString(raw.taskId);
    const status = isStatus(raw.status) ? raw.status : undefined;
    if (!taskId || !status) {
        return null;
    }
    const promptSummary = asString(raw.promptSummary) ?? '';
    const title = asNonEmptyString(raw.title) ?? deriveTitle(promptSummary);
    return {
        taskId,
        status,
        phase: isPhase(raw.phase) ? raw.phase : undefined,
        interaction: sanitizeInteraction(raw.interaction) ?? undefined,
        title,
        promptSummary,
        timeline: sanitizeTimeline(raw.timeline),
        result: sanitizeResult(raw.result),
        error: isRecord(raw.error) && asNonEmptyString(raw.error.message)
            ? { code: asString(raw.error.code), message: asString(raw.error.message) ?? '' }
            : undefined,
        reportAvailable: asBoolean(raw.reportAvailable) ?? false,
        resumable: asBoolean(raw.resumable) ?? false,
        devOverride: sanitizeDevOverride(raw.devOverride),
    };
};