export type AgentProgramCatalogItem = Readonly<{
    name: string;
    title: string;
    summary: string;
    updatedAt: number;
}>;

export type AgentLoadedProgram = Readonly<{
    name: string;
    source: string;
    artifactRevision: string;
    resolveSymbols: readonly string[];
}>;

export type AgentProgramLoadResult =
    | Readonly<{status: 'loaded'; program: AgentLoadedProgram}>
    | Readonly<{status: 'not_found'; name: string}>;

export type AgentProgramLibrary = Readonly<{
    list: () => Promise<readonly AgentProgramCatalogItem[]>;
    load: (name: string) => Promise<AgentProgramLoadResult>;
}>;
