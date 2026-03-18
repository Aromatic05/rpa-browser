import test from 'node:test';
import { startFixtureServer } from '../helpers/server';
import { startAgentStack } from './harness/process_harness';
import { createWsActionClient } from './harness/ws_action_client';
import { workspaceRestoreComplexScenario } from './scenarios/workspace_restore_complex';

const headed = ['1', 'true', 'yes'].includes((process.env.RPA_INTEGRATION_HEADED || '').toLowerCase());

test(`integration: ${workspaceRestoreComplexScenario.name} (${headed ? 'headed' : 'headless'})`, async () => {
    const fixture = await startFixtureServer();
    let stack: Awaited<ReturnType<typeof startAgentStack>> | null = null;
    let client: Awaited<ReturnType<typeof createWsActionClient>> | null = null;
    try {
        stack = await startAgentStack({ headed, fixtureBaseUrl: fixture.baseURL });
        client = await createWsActionClient(stack.wsUrl);
        await workspaceRestoreComplexScenario.run({ client, fixtureBaseUrl: fixture.baseURL });
    } finally {
        await client?.close().catch(() => undefined);
        await stack?.stop();
        await fixture.close();
    }
}, 240000);

