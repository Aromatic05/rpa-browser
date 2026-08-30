/**
 * Product projection helpers: pure derivation/validation utilities plus the
 * authoritative workspace-view sanitizer (re-exported). The sanitizers live in
 * `sanitize.ts` and never invent state — the UI only ever renders truthful,
 * sanitized data, and internal ids / raw artifact bodies never pass through.
 */
import type {
    ClarificationSchema,
    CommandPort,
    TaskLifecycleStatus,
    TaskOutcome,
    TaskPhase,
    WorkspaceProductView,
} from './contracts.js';
import { deriveTitle, sanitizeActivityEvent } from './sanitize.js';
import { sanitizeWorkspaceView } from './sanitizeWorkspace.js';

export { deriveTitle, sanitizeActivityEvent, sanitizeWorkspaceView };

/** Coarse relative time label used by the timeline and history lists. */
export const relativeTimeLabel = (at: number, now: number): string => {
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    if (seconds < 60) {
        return 'just now';
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${String(minutes)} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${String(hours)} h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${String(days)} d ago`;
};

export const isTerminalStatus = (status: TaskLifecycleStatus): status is TaskOutcome =>
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';

export const isActiveActivity = (view: WorkspaceProductView): boolean =>
    view.reservation === 'task' ||
    view.reservation === 'teach' ||
    view.reservation === 'annotate' ||
    view.reservation === 'playback';

export type WaitingKind = 'approval' | 'clarification' | 'recovery' | 'takeover';

export const interactionWaitingKind = (view: WorkspaceProductView): WaitingKind | null => {
    const task = view.activeTask;
    if (task === undefined) {
        return null;
    }
    if (task.status !== 'waiting_for_user' || task.interaction === undefined) {
        return null;
    }
    if (task.interaction.kind === 'approval') {
        return 'approval';
    }
    if (task.interaction.kind === 'clarification') {
        return 'clarification';
    }
    if (task.interaction.kind === 'recovery_decision') {
        return 'recovery';
    }
    return 'takeover';
};

const PHASE_LABELS: Record<TaskPhase, string> = {
    planning: 'Planning',
    observing: 'Observing',
    executing: 'Executing',
    recovering: 'Recovering',
    interacting: 'Interacting',
};

export const phaseLabel = (phase: TaskPhase): string => PHASE_LABELS[phase];

/** Client-side validation against the bounded clarification schema (spec §7.2). */
export const validateClarificationValue = (value: string, schema: ClarificationSchema): string | null => {
    if (schema.type === 'select') {
        return schema.allowed?.some((option) => option.value === value)
            ? null
            : 'Choose one of the allowed options.';
    }
    if (value.length === 0) {
        return 'This field is required.';
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `Must be at most ${String(schema.maxLength)} characters.`;
    }
    if (schema.type === 'number') {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return 'Enter a number.';
        }
        if (schema.min !== undefined && numeric < schema.min) {
            return `Must be at least ${String(schema.min)}.`;
        }
        if (schema.max !== undefined && numeric > schema.max) {
            return `Must be at most ${String(schema.max)}.`;
        }
    }
    if (schema.type === 'date') {
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) {
            return 'Enter a valid date.';
        }
        if (schema.min !== undefined && parsed < schema.min) {
            return 'Date is before the allowed range.';
        }
        if (schema.max !== undefined && parsed > schema.max) {
            return 'Date is after the allowed range.';
        }
    }
    return null;
};

/** The no-op command port used as the fallback default for standalone rendering. */
export const noopCommandPort = (): CommandPort => {
    const noop = (): void => undefined;
    return {
        startTask: noop,
        stopTask: noop,
        openTeach: noop,
        openAnnotate: noop,
        closeAnnotate: noop,
        openCurrentActivity: noop,
        startTeach: noop,
        stopTeach: noop,
        saveTeach: noop,
        discardTeach: noop,
        newTask: noop,
        retry: noop,
        saveAutomation: noop,
        viewDetails: noop,
        replayDemonstration: noop,
        editPageKnowledge: noop,
        selectHistoryEntry: noop,
        approve: noop,
        deny: noop,
        answerClarification: noop,
        chooseRecovery: noop,
        beginHumanGuidance: noop,
        returnControl: noop,
        reconnect: noop,
        navigate: noop,
        collapse: noop,
        openDeveloper: noop,
        closeDeveloper: noop,
        resize: noop,
    };
};