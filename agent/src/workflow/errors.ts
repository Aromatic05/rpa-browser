export class WorkflowError extends Error {
    readonly code: string;

    constructor(message: string, code: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'WorkflowError';
        this.code = code;
    }
}

export const invalidWorkflowArtifact = (
    kind: string,
    name: string,
    error: unknown,
): WorkflowError => new WorkflowError(
    `invalid ${kind} artifact: ${name}`,
    'ERR_WORKFLOW_INVALID_ARTIFACT',
    error instanceof Error ? { cause: error } : undefined,
);
