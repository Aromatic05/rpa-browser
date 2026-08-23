export class DslDebugAbortError extends Error {
    public readonly code = 'ERR_DSL_DEBUG_ABORTED';
    public readonly continuationId: string;

    constructor(continuationId: string) {
        super('DSL execution aborted by debugger');
        this.name = 'DslDebugAbortError';
        this.continuationId = continuationId;
    }
}
