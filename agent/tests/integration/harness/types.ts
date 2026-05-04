export type ActionPayload = {
    v: 1;
    id: string;
    type: string;
    workspaceName?: string;
    payload?: unknown;
};

export type ActionOk<T = any> = { ok: true; data: T };
export type ActionErr = { ok: false; error: { code: string; message: string; details?: unknown } };

export type IntegrationClient = {
    sendAction: <T = any>(action: Omit<ActionPayload, 'v' | 'id'> & { id?: string }) => Promise<ActionOk<T> | ActionErr>;
    waitForEvent: <T = Record<string, unknown>>(event: string, timeoutMs?: number) => Promise<T>;
    close: () => Promise<void>;
};

export type IntegrationScenarioContext = {
    client: IntegrationClient;
    fixtureBaseUrl: string;
};

export type IntegrationScenario = {
    name: string;
    run: (ctx: IntegrationScenarioContext) => Promise<void>;
};
