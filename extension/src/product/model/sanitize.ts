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

const sanitizeTimeline = (raw: unknown): ActivityEvent[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    const events: ActivityEvent[] = [];
    for (const item of raw) {
        if (!isRecord(item)) {
            continue;
        }
        const kind = asString(item.kind);
        const at = asNumber(item.at) ?? 0;
        if (kind === 'phase_changed' && isPhase(item.phase)) {
            events.push({ kind: 'phase_changed', phase: item.phase, at });
            continue;
        }
        if (kind === 'human_guidance_started' && isGuidanceMode(item.mode)) {
            const summary = asNonEmptyString(item.summary);
            if (summary) {
                events.push({ kind: 'human_guidance_started', mode: item.mode, summary, at });
            }
            continue;
        }
        if (kind === 'human_guidance_completed' && isGuidanceMode(item.mode)) {
            const summary = asNonEmptyString(item.summary);
            if (summary) {
                events.push({ kind: 'human_guidance_completed', mode: item.mode, summary, at });
            }
            continue;
        }
        if (kind === 'effect_applied') {
            const status = item.status;
            const summary = asNonEmptyString(item.summary);
            if ((status === 'ok' || status === 'failed') && summary) {
                events.push({ kind: 'effect_applied', summary, status, at });
            }
            continue;
        }
        if (kind === 'task_terminated' && isOutcome(item.outcome)) {
            events.push({ kind: 'task_terminated', outcome: item.outcome, at });
            continue;
        }
        if (kind === 'report_ready') {
            events.push({ kind: 'report_ready', at });
            continue;
        }
        const summary =
            kind === 'task_created' ||
            kind === 'activity' ||
            kind === 'interaction_requested' ||
            kind === 'interaction_resolved' ||
            kind === 'world_conflict'
                ? asNonEmptyString(item.summary)
                : undefined;
        if (!summary) {
            continue;
        }
        if (
            kind === 'task_created' ||
            kind === 'interaction_requested' ||
            kind === 'interaction_resolved' ||
            kind === 'world_conflict'
        ) {
            events.push({ kind, summary, at });
        } else {
            events.push({ kind: 'activity', summary, at });
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
        const effectName = asNonEmptyString(raw.effectName);
        if (!effectName) {
            return null;
        }
        return {
            kind,
            interactionToken,
            effectName,
            risk: asString(raw.risk) ?? '',
            evidence: asString(raw.evidence),
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
            activeMode: isGuidanceMode(raw.activeMode) ? raw.activeMode : undefined,
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
        output: asString(raw.output),
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