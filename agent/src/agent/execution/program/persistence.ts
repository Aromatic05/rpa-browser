export type AgentProgramSaveRequest = Readonly<{
    name: string;
    source: string;
    expectedRevision?: string | null;
}>;

export type AgentProgramSaveResult =
    | Readonly<{
        status: 'saved';
        name: string;
        artifactRevision: string;
    }>
    | Readonly<{
        status: 'conflict';
        name: string;
        currentRevision: string | null;
    }>;

export type AgentProgramSaver = (
    request: AgentProgramSaveRequest,
) => Promise<AgentProgramSaveResult>;
