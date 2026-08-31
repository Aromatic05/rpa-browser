import type {AgentEvalFixtureSpec, AgentEvalWorld, AgentEvalWorldHandle} from '../world';

/**
 * Fault-injection benchmark layer for the Program-first vs react-baseline
 * transactional-semantics study.
 *
 * Every fault is armed on the world port from outside the agent: production
 * runners never see fault-specific code. The fault world records an external
 * event log that the verifier and the matrix consume, so success is judged by
 * observed world transitions rather than by the model's self-report.
 */
export const AGENT_FAULT_KINDS = [
    'mutation-report-error',
    'revision-drift',
    'epoch-navigation',
    'transactional-restore',
    'compensation-partial-restore',
    'external-mutation-conflict',
    'ambiguous-timeout',
] as const;

export type AgentFaultKind = (typeof AGENT_FAULT_KINDS)[number];

export const AGENT_FAULT_ERROR_CODES = {
    staleTarget: 'ERR_STALE_TARGET',
    postEffectError: 'ERR_INJECTED_POST_EFFECT',
    partialApply: 'ERR_FAULT_PARTIAL_APPLY',
    partialRestore: 'ERR_FAULT_PARTIAL_RESTORE',
    revisionConflict: 'ERR_FAULT_REVISION_CONFLICT',
    postEffectTimeout: 'ERR_FAULT_POST_EFFECT_TIMEOUT',
} as const;

export type AgentFaultErrorCode = (typeof AGENT_FAULT_ERROR_CODES)[keyof typeof AGENT_FAULT_ERROR_CODES];

export class AgentFaultWorldError extends Error {
    readonly code: AgentFaultErrorCode;
    readonly worldChanged: boolean;
    readonly revision: number;
    readonly epoch: number;

    constructor(
        code: AgentFaultErrorCode,
        message: string,
        worldChanged: boolean,
        revision: number,
        epoch: number,
    ) {
        super(message);
        this.name = 'AgentFaultWorldError';
        this.code = code;
        this.worldChanged = worldChanged;
        this.revision = revision;
        this.epoch = epoch;
    }
}

/**
 * One fault-script entry. `fireOn` is the 1-based index of write attempts
 * (fill/click/transact) against `targetKey`; when omitted the fault fires on
 * the first attempt for the key.
 */
export type AgentFaultSpec = Readonly<{
    kind: AgentFaultKind;
    targetKey: string;
    fireOn?: number;
    partialValue?: string;
    halfRestoredValue?: string;
    externalValue?: string;
    effectApplied?: boolean;
}>;

export const AGENT_FAULT_EVENT_KINDS = [
    'load',
    'read',
    'rebind',
    'drift',
    'navigation',
    'external-mutate',
    'fill-applied',
    'fill-rejected',
    'fill-failed-after-apply',
    'fill-failed-no-effect',
    'click-applied',
    'click-rejected',
] as const;

export type AgentFaultEventKind = (typeof AGENT_FAULT_EVENT_KINDS)[number];

/** Deterministic, externally observed transition; the verifier's ground truth. */
export type AgentFaultEvent = Readonly<{
    sequence: number;
    kind: AgentFaultEventKind;
    key: string;
    value?: string;
    worldChanged?: boolean;
    revision?: number;
    epoch?: number;
    reason?: string;
}>;

export type CreateFaultInjectingWorldOptions = Readonly<{
    /** Performs the real page reload/navigation; called before the epoch bump. */
    navigate: (lastSpec: {page: string}) => Promise<void>;
}>;

/**
 * Extension of the committed eval world port: armed fault script, epoch-aware
 * handle invalidation, compare-and-set transact, and the external event log.
 */
export type AgentFaultWorld = Readonly<{
    base: AgentEvalWorld;
    arm: (spec: AgentFaultSpec) => void;
    armed: () => readonly AgentFaultSpec[];
    events: () => readonly AgentFaultEvent[];
    epoch: () => number;
    reseed: (seed: number) => void;
    random: () => number;
    load: (spec: AgentEvalFixtureSpec) => Promise<void>;
    field: (key: string) => AgentEvalWorldHandle;
    read: (handle: AgentEvalWorldHandle) => Promise<string | null>;
    /** Plain write attempt; fault script and epoch gate apply around it. */
    fill: (handle: AgentEvalWorldHandle, value: string) => Promise<number>;
    /** Program-first transactional write: fails with a conflict when the
     *  world moved beyond `expectedRevision` instead of clobbering blindly. */
    transact: (handle: AgentEvalWorldHandle, value: string, expectedRevision: number) => Promise<number>;
    click: (handle: AgentEvalWorldHandle) => Promise<number>;
    drift: (key: string) => Promise<void>;
    /** Rebind a live handle for `key` at the current page epoch. */
    refresh: (key: string) => AgentEvalWorldHandle;
    revision: () => number;
}>;
