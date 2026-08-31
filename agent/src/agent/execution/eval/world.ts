export const AGENT_EVAL_WORLD_ERROR_CODES = {
    staleTarget: 'ERR_STALE_TARGET',
    mutationFailed: 'ERR_MUTATION_FAILED',
    postEffectError: 'ERR_INJECTED_POST_EFFECT',
} as const;

export type AgentEvalWorldErrorCode = (typeof AGENT_EVAL_WORLD_ERROR_CODES)[keyof typeof AGENT_EVAL_WORLD_ERROR_CODES];

export class AgentEvalWorldError extends Error {
    readonly code: AgentEvalWorldErrorCode;
    readonly worldChanged: boolean;

    constructor(code: AgentEvalWorldErrorCode, message: string, worldChanged = false) {
        super(message);
        this.name = 'AgentEvalWorldError';
        this.code = code;
        this.worldChanged = worldChanged;
    }
}

/**
 * Description of a fixture page a scenario runs against. Implementations must
 * render one addressable field and one addressable result field per key so the
 * external verifier can inspect state without the model's self-report.
 */
export type AgentEvalFixtureSpec = Readonly<{
    /** Fixture identifier used to build the page url (or in-memory page name). */
    page: string;
    /** key -> initial value of each addressable field. */
    fields: Readonly<Record<string, string>>;
    /** Extra buttons rendered on the page; clicking sets the result field. */
    buttons?: readonly string[];
}>;

export type AgentEvalWorldHandle = Readonly<{
    key: string;
    /** Monotonic token per resolved node; drift/reload invalidates old tokens. */
    token: number;
}>;

/**
 * Minimal browser-world port shared by benchmark scenarios, the in-memory
 * fixture world, the Playwright page world and the simulated policy runner.
 * The benchmark's external verifier only trusts state observable through this
 * port (or the underlying page directly), never `result.text`.
 */
export type AgentEvalWorld = Readonly<{
    /** Rebind internal randomness for a deterministic trial. */
    reseed: (seed: number) => void;
    /** Deterministic pseudo-random source tied to the trial seed. */
    random: () => number;
    /** (Re)load a fixture page; resets all field values to the spec. */
    load: (spec: AgentEvalFixtureSpec) => Promise<void>;
    /** Resolve a handle for a field/button; handles go stale after `drift`. */
    field: (key: string) => AgentEvalWorldHandle;
    read: (handle: AgentEvalWorldHandle) => Promise<string | null>;
    /** Mutate a field; throws AgentEvalWorldError on stale/armed faults. */
    fill: (handle: AgentEvalWorldHandle, value: string) => Promise<number>;
    /** Click a button; sets the result field to the button key. */
    click: (handle: AgentEvalWorldHandle) => Promise<number>;
    /** Replace the live node for a key, invalidating existing handles. */
    drift: (key: string) => Promise<void>;
    /** Monotonic world revision; every accepted mutation bumps it. */
    revision: () => number;
}>;
