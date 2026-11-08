/**
 * Workspace-domain sanitizers: Teach/Annotate authoring, the Library summary,
 * history, and the authoritative WorkspaceProductView itself.
 */
import type {
    AnnotateView,
    AutomationSummary,
    BusinessArea,
    DemonstrationSummary,
    LibraryHealth,
    LibrarySummary,
    PageKnowledgeSummary,
    ProcedureSummary,
    RecoverySummary,
    StartError,
    TaskHistoryEntry,
    TeachKind,
    TeachView,
    WorkspaceProductView,
} from './contracts.js';
import {
    asBoolean,
    asNonEmptyString,
    asNumber,
    asString,
    asStringArray,
    isAnnotateStage,
    isConnection,
    isLibraryHealth,
    isOutcome,
    isRecord,
    isReservation,
    isStartErrorKind,
    isTeachKind,
    isTeachPhase,
} from './guards.js';
import { sanitizeTaskView } from './sanitize.js';
import { asRecordedFrameIssue } from '../../shared/recorded_frame_feedback.js';

const RESERVATION_OWNER: Record<string, WorkspaceProductView['reservation']> = {
    none: 'idle',
    task: 'task',
    standalone_teach: 'teach',
    standalone_annotate: 'annotate',
    playback: 'playback',
};

/**
 * The real backend workspace projection carries the reservation as
 * `{ owner, ownerTaskId?, humanControl }`. Accept both that shape and the
 * flattened enumeration; `none` maps to `idle`. Unknown owners settle to the
 * neutral idle baseline and never fabricate an active activity.
 */
export const sanitizeReservationValue = (raw: unknown): WorkspaceProductView['reservation'] => {
    if (typeof raw === 'string') {
        return isReservation(raw) ? raw : 'idle';
    }
    if (isRecord(raw)) {
        const owner = asString(raw.owner);
        if (owner && owner in RESERVATION_OWNER) {
            return RESERVATION_OWNER[owner];
        }
    }
    return 'idle';
};

export const sanitizeReservationTeachKind = (raw: unknown): TeachKind | undefined => {
    if (isRecord(raw) && isTeachKind(raw.teachKind)) {
        return raw.teachKind;
    }
    return undefined;
};

const sanitizeTeachReview = (raw: unknown): TeachView['review'] | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const summary = asNonEmptyString(raw.summary);
    if (!summary) {
        return undefined;
    }
    return {
        summary,
        stepSummaries: asStringArray(raw.stepSummaries),
        canSave: asBoolean(raw.canSave) ?? false,
    };
};

const sanitizeBusinessAreas = (raw: unknown): BusinessArea[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!isRecord(item)) {
            return [];
        }
        const profileName = asNonEmptyString(item.profileName);
        const label = asNonEmptyString(item.label);
        if (!profileName || !label) {
            return [];
        }
        return [{
            profileName,
            label,
            entityCount: asNumber(item.entityCount) ?? 0,
            selector: asNonEmptyString(item.selector),
        }];
    });
};

const sanitizeTeachView = (raw: unknown): TeachView | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const teachKind = isTeachKind(raw.teachKind) ? raw.teachKind : undefined;
    const phase = isTeachPhase(raw.phase) ? raw.phase : undefined;
    if (!teachKind || !phase) {
        return undefined;
    }
    return {
        teachKind,
        phase,
        stepCount: asNumber(raw.stepCount) ?? 0,
        businessAreas: sanitizeBusinessAreas(raw.businessAreas),
        selectedBusinessArea: asNonEmptyString(raw.selectedBusinessArea),
        unsavedAsset: asBoolean(raw.unsavedAsset) ?? false,
        interrupted: asBoolean(raw.interrupted),
        review: sanitizeTeachReview(raw.review),
    };
};

const sanitizeSavedSummary = (raw: unknown): AnnotateView['savedSummary'] | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const profileName = asNonEmptyString(raw.profileName);
    if (!profileName) {
        return undefined;
    }
    const entityCount = asNumber(raw.entityCount);
    return { profileName, ...(entityCount === undefined ? {} : { entityCount }) };
};

const sanitizeAnnotateView = (raw: unknown): AnnotateView | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    return {
        active: asBoolean(raw.active) ?? false,
        canvasOpen: asBoolean(raw.canvasOpen) ?? false,
        stage: isAnnotateStage(raw.stage) ? raw.stage : undefined,
        dirty: asBoolean(raw.dirty) ?? false,
        savedSummary: sanitizeSavedSummary(raw.savedSummary),
    };
};

const sanitizeAuthoring = (raw: unknown): WorkspaceProductView['authoring'] => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const teach = sanitizeTeachView(raw.teach);
    const annotate = sanitizeAnnotateView(raw.annotate);
    if (!teach && !annotate) {
        return undefined;
    }
    return { ...(teach ? { teach } : {}), ...(annotate ? { annotate } : {}) };
};

const sanitizeHealth = (raw: unknown): LibraryHealth | undefined =>
    isLibraryHealth(raw) ? raw : undefined;

const sanitizeAutomations = (raw: unknown): AutomationSummary[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!isRecord(item)) {
            return [];
        }
        const name = asNonEmptyString(item.name);
        if (!name) {
            return [];
        }
        return [{ name, description: asString(item.description), status: asString(item.status), health: sanitizeHealth(item.health) }];
    });
};

const sanitizeNames = (raw: unknown): Array<{ name: string; health?: LibraryHealth }> => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!isRecord(item)) {
            return [];
        }
        const name = asNonEmptyString(item.name);
        if (!name) {
            return [];
        }
        const health = sanitizeHealth(item.health);
        return [{ name, ...(health ? { health } : {}) }];
    });
};

const sanitizeProcedures = (raw: unknown): ProcedureSummary[] => sanitizeNames(raw);

const sanitizeRecoveries = (raw: unknown): RecoverySummary[] => sanitizeNames(raw);

const sanitizeDemonstrations = (raw: unknown): DemonstrationSummary[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!isRecord(item)) {
            return [];
        }
        const name = asNonEmptyString(item.name);
        if (!name) {
            return [];
        }
        return [{ name, stepCount: asNumber(item.stepCount) ?? 0, health: sanitizeHealth(item.health) }];
    });
};

const sanitizePageKnowledge = (raw: unknown): PageKnowledgeSummary[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!isRecord(item)) {
            return [];
        }
        const profileName = asNonEmptyString(item.profileName);
        const label = asNonEmptyString(item.label);
        if (!profileName || !label) {
            return [];
        }
        return [
            {
                profileName,
                label,
                pageKind: asString(item.pageKind),
                urlPattern: asString(item.urlPattern),
                entityCount: asNumber(item.entityCount) ?? 0,
                health: sanitizeHealth(item.health),
            },
        ];
    });
};

const sanitizeLibrary = (raw: unknown): LibrarySummary => {
    const record = isRecord(raw) ? raw : {};
    return {
        automations: sanitizeAutomations(record.automations),
        procedures: sanitizeProcedures(record.procedures),
        recoveries: sanitizeRecoveries(record.recoveries),
        demonstrations: sanitizeDemonstrations(record.demonstrations),
        pageKnowledge: sanitizePageKnowledge(record.pageKnowledge),
    };
};

const sanitizeHistory = (raw: unknown): TaskHistoryEntry[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!isRecord(item)) {
            return [];
        }
        const taskId = asNonEmptyString(item.taskId);
        const outcome = isOutcome(item.outcome) ? item.outcome : undefined;
        const title = asNonEmptyString(item.title);
        if (!taskId || !outcome || !title) {
            return [];
        }
        return [{ taskId, outcome, title, endedAt: asNumber(item.endedAt) ?? 0 }];
    });
};

const sanitizeStartError = (raw: unknown): StartError | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }
    const kind = isStartErrorKind(raw.kind) ? raw.kind : undefined;
    const message = asNonEmptyString(raw.message);
    if (!kind || !message) {
        return undefined;
    }
    return { kind, message };
};

/**
 * Normalize a raw backend workspace projection into the typed product view.
 * Malformed or missing optional fields settle to the neutral baseline; the
 * result never contains internal ids or raw artifact bodies.
 */
export const sanitizeWorkspaceView = (raw: unknown): WorkspaceProductView => {
    const record = isRecord(raw) ? raw : {};
    const authoring = sanitizeAuthoring(record.authoring);
    const activeTask = sanitizeTaskView(record.activeTask);
    const playback = isRecord(record.playback) ? record.playback : {};
    const phase = playback.phase;
    const failure = isRecord(playback.failure) ? playback.failure : undefined;
    const count = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    return {
        workspace: asNonEmptyString(record.workspace) ?? '',
        modelConfigured: asBoolean(record.modelConfigured) ?? undefined,
        reservation: sanitizeReservationValue(record.reservation),
        reservationTeachKind: sanitizeReservationTeachKind(record.reservation),
        connection: isConnection(record.connection) ? record.connection : 'connected',
        activeTask: activeTask ?? undefined,
        playbackAvailable: asBoolean(record.playbackAvailable) ?? undefined,
        playback: phase === 'running' || phase === 'completed' || phase === 'failed' || phase === 'canceled'
            ? {
                phase,
                recordingName: asNonEmptyString(playback.recordingName)?.slice(0, 120),
                completed: count(playback.completed) ?? 0,
                total: count(playback.total) ?? 0,
                ...(failure ? {failure: {
                    index: count(failure.index),
                    code: typeof failure.code === 'string' && /^ERR_[A-Z0-9_]{1,60}$/.test(failure.code) ? failure.code : undefined,
                    fallbackConflict: failure.fallbackConflict === true,
                    frameIssue: asRecordedFrameIssue(failure.frameIssue),
                }} : {}),
            }
            : undefined,
        authoring,
        librarySummary: sanitizeLibrary(record.librarySummary),
        libraryUnavailable: asBoolean(record.libraryUnavailable) ?? undefined,
        history: sanitizeHistory(record.history),
        startError: sanitizeStartError(record.startError),
        reconnectAttempts: asNumber(record.reconnectAttempts),
        lastKnownAt: asNumber(record.lastKnownAt),
    };
};
