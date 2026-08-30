/**
 * Narrowing guards for unknown backend values. Pure type guards only; every
 * sanitizer module relies on these so the product projection boundary can never
 * leak unknown kinds or malformed shapes.
 */
import type {
    AnnotateStage,
    GuidanceMode,
    LibraryHealth,
    RecoveryOption,
    StartErrorKind,
    TeachKind,
    TeachPhase,
    TaskLifecycleStatus,
    TaskOutcome,
    TaskPhase,
    WorkspaceProductView,
    WorkspaceReservation,
} from './contracts.js';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const asNonEmptyString = (value: unknown): string | undefined => {
    const trimmed = asString(value)?.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed;
};

export const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

export const asStringArray = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        const s = asNonEmptyString(item);
        return s ? [s] : [];
    });
};

const RESERVATIONS: ReadonlyArray<WorkspaceReservation> = ['idle', 'task', 'teach', 'annotate', 'playback'];
export const isReservation = (value: unknown): value is WorkspaceReservation =>
    typeof value === 'string' && RESERVATIONS.some((reservation) => reservation === value);

const CONNECTIONS = ['connected', 'disconnected'] as const;
export const isConnection = (value: unknown): value is WorkspaceProductView['connection'] =>
    typeof value === 'string' && CONNECTIONS.some((connection) => connection === value);

const STATUSES: ReadonlyArray<TaskLifecycleStatus> = [
    'draft',
    'running',
    'waiting_for_user',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
];
export const isStatus = (value: unknown): value is TaskLifecycleStatus =>
    typeof value === 'string' && STATUSES.some((status) => status === value);

const PHASES: ReadonlyArray<TaskPhase> = ['planning', 'observing', 'executing', 'recovering', 'interacting'];
export const isPhase = (value: unknown): value is TaskPhase =>
    typeof value === 'string' && PHASES.some((phase) => phase === value);

const OUTCOMES: ReadonlyArray<TaskOutcome> = ['completed', 'failed', 'cancelled', 'interrupted'];
export const isOutcome = (value: unknown): value is TaskOutcome =>
    typeof value === 'string' && OUTCOMES.some((outcome) => outcome === value);

const GUIDANCE_MODES: ReadonlyArray<GuidanceMode> = ['manual', 'teach', 'annotate'];
export const isGuidanceMode = (value: unknown): value is GuidanceMode =>
    typeof value === 'string' && GUIDANCE_MODES.some((mode) => mode === value);

const RECOVERY_KINDS: ReadonlyArray<RecoveryOption['kind']> = ['retry', 'repair', 'rollback', 'rewind', 'terminate'];
export const isRecoveryKind = (value: unknown): value is RecoveryOption['kind'] =>
    typeof value === 'string' && RECOVERY_KINDS.some((kind) => kind === value);

const TEACH_KINDS: ReadonlyArray<TeachKind> = ['procedure', 'recovery', 'demonstration'];
export const isTeachKind = (value: unknown): value is TeachKind =>
    typeof value === 'string' && TEACH_KINDS.some((kind) => kind === value);

const TEACH_PHASES: ReadonlyArray<TeachPhase> = ['setup', 'recording', 'review', 'saving'];
export const isTeachPhase = (value: unknown): value is TeachPhase =>
    typeof value === 'string' && TEACH_PHASES.some((phase) => phase === value);

const ANNOTATE_STAGES: ReadonlyArray<AnnotateStage> = ['scope', 'recognize', 'review', 'edit'];
export const isAnnotateStage = (value: unknown): value is AnnotateStage =>
    typeof value === 'string' && ANNOTATE_STAGES.some((stage) => stage === value);

const LIBRARY_HEALTHS: ReadonlyArray<LibraryHealth> = ['ready', 'needs_review', 'broken', 'unknown'];
export const isLibraryHealth = (value: unknown): value is LibraryHealth =>
    typeof value === 'string' && LIBRARY_HEALTHS.some((health) => health === value);

const START_ERROR_KINDS: ReadonlyArray<StartErrorKind> = ['service', 'auth', 'workspace'];
export const isStartErrorKind = (value: unknown): value is StartErrorKind =>
    typeof value === 'string' && START_ERROR_KINDS.some((kind) => kind === value);