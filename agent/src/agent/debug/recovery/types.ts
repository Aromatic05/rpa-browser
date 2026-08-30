/**
 * Sanitized, product-safe summary of a retained Agent recovery. It never leaks
 * raw checkpoint bodies or DSL sources; only identity and application state.
 */
export type RetainedRecoverySummary = Readonly<{
    checkpointId: string;
    checkpointName?: string;
    applied: boolean;
    retried?: boolean;
    blockedByApproval?: boolean;
}>;