import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {createOpenAICompatibleAgentModelRuntime} from '../../../src/agent/model/runtime';
import type {AgentRunResult} from '../../../src/agent/execution/types';
import {createWorkflowOnFs} from '../../../src/automation/workflow';
import {stepExecutors} from '../../../src/automation/runner/steps/executors';
import {createWorkspaceHarness} from '../../helpers/workspace_harness';
import {resolveLiveModelConfig} from './model_config';

const fixtureHtml = (): string => `<!doctype html>
<html>
  <head><title>Agent rollback live eval</title></head>
  <body>
    <main>
      <h1>Profile</h1>
      <label for="Name">Name</label>
      <input id="Name" name="name" value="Before">
    </main>
  </body>
</html>`;

const main = async (): Promise<void> => {
    const {provider, model, baseUrl, apiKey} = resolveLiveModelConfig();
    const modelRuntime = createOpenAICompatibleAgentModelRuntime({provider, model, baseUrl, apiKey});
    const browser = await chromium.launch({
        headless: process.env.RPA_EVAL_HEADED !== '1',
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage({viewport: {width: 900, height: 600}});
        await page.goto(`data:text/html,${encodeURIComponent(fixtureHtml())}`, {waitUntil: 'domcontentloaded'});
        const {registry} = createWorkspaceHarness({
            getPage: async () => page,
            pluginHost: {getExecutors: () => stepExecutors} as never,
            agentModelRuntime: modelRuntime,
        });
        const workspaceName = `agent-live-rollback-${crypto.randomUUID()}`;
        const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
        workspace.tabs.createTab({tabName: 'main'});
        workspace.tabs.bindPage('main', page);

        const response = await workspace.router.handle({
            v: 1,
            id: crypto.randomUUID(),
            type: 'agent.run',
            workspaceName,
            payload: {
                prompt: [
                    'This is a fault-injection recovery evaluation.',
                    'Inspect the current page and resolve the Name field target.',
                    'Submit one DSL Program that fills Name with Alice and then intentionally fails an invariant by executing `ensure compute eq(input.actual, input.expected)` with structured input actual=1 and expected=2.',
                    'After the invariant fails, do not retry the fill. Use the inherited rollbackAnchor with debug.rollback strategy="physical" to undo the earlier fill.',
                    'Terminate the failed retained execution after recovery, then verify that the Name field is back to Before.',
                    'Report compensated versus restored exactly as the debugger reports it.',
                ].join(' '),
                provider,
                model,
            },
        }, workspace, registry);
        const result = response.reply.payload as AgentRunResult;
        const value = await page.locator('#Name').inputValue();
        const tools = result.trace.tools.map((tool) => ({
            name: tool.toolName,
            classification: tool.classification,
            isError: tool.isError ?? false,
            ...(tool.toolName === 'debug.rollback' ? {args: tool.args} : {}),
        }));
        process.stdout.write(`${JSON.stringify({
            success: value === 'Before',
            value,
            text: result.text,
            executionMode: result.executionMode,
            programs: result.programs?.map((program) => ({
                status: program.status,
                effects: program.effects,
                error: program.error,
            })),
            metrics: result.trace.metrics,
            tools,
        }, null, 2)}\n`);
        if (value !== 'Before') {process.exitCode = 1;}
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
