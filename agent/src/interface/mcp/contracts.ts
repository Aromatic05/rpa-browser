export type McpToolResult = {
    ok: boolean;
    results: unknown[];
    trace?: unknown;
    error?: unknown;
};

export type McpToolHandler = (args: unknown) => Promise<McpToolResult>;
