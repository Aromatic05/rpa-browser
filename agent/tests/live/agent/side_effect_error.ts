import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {createOpenAICompatibleAgentModelRuntime} from '../../../src/agent/model/runtime';
import {evaluateAgentTask} from '../../../src/agent/execution/eval/evaluator';
import type {AgentRunResult, AgentRunner} from '../../../src/agent/execution/types';
import {createWorkflowOnFs} from '../../../src/automation/workflow';
import {
    stepExecutors,
    type ExecutorFn,
} from '../../../src/automation/runner/steps/executors';
import {createWorkspaceHarness} from '../../helpers/workspace_harness';
import {resolveLiveModelConfig} from './model_config';

const fixtureHtml = (): string => `<!doctype html>
<html>
  <head><title>Agent side-effect error eval</title></head>
  <body>
    <main>
      <h1>Profile</h1>
      <label for="Name">Name</label>
      <input id="Name" name="name" value="Before">
    </main>
  </body>
</html>`;

const compactRun = (run: NonNullable<Awaited<ReturnType<typeof evaluateAgentTask>>['runs']['program']>) => ({
    success: run.success,
    durationMs: Math.round(run.durationMs),
    verification: run.verification,
    metrics: run.metrics,
    tools: run.result.trace.tools.map((tool) => ({
        name: tool.toolName,
        classification: tool.classification,
        isError: tool.isError ?? false,
        ...(tool.toolName === 'debug.rollback' ? {args: tool.args} : {}),
    })),
    programs: run.result.programs?.map((program) => ({
        status: program.status,
        effects: program.effects,
        error: program.error,
    })),
});

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
        let injectNextFillFailure = true;
        const injectedFill: ExecutorFn = async (step, deps, workspaceName, context) => {
            const result = await stepExecutors['browser.fill'](step, deps, workspaceName, context);
            if (!injectNextFillFailure || !result.ok) {return result;}
            injectNextFillFailure = false;
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_INJECTED_POST_EFFECT',
                    message: 'Injected failure after browser.fill already mutated the page',
                },
            };
        };
        const executors = {...stepExecutors, 'browser.fill': injectedFill};
        const {registry} = createWorkspaceHarness({
            getPage: async () => page,
            pluginHost: {getExecutors: () => executors} as never,
            agentModelRuntime: modelRuntime,
        });
        const workspaceName = `agent-live-side-effect-error-${crypto.randomUUID()}`;
        const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
        workspace.tabs.createTab({tabName: 'main'});
        workspace.tabs.bindPage('main', page);

        const runner: AgentRunner = {
            run: async (request) => {
                const response = await workspace.router.handle({
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'agent.run',
                    workspaceName,
                    payload: request,
                }, workspace, registry);
                return response.reply.payload as AgentRunResult;
            },
        };
        const report = await evaluateAgentTask({runner}, {
            id: 'post-effect-fill-error',
            prompt: [
                'Set the Name field on the current page from Before to Alice.',
                'A fault may cause the mutation operation to report failure after its side effect already happened.',
                'If any mutation reports failure, do not retry the intended mutation. Restore the page to its original Name value Before, verify the actual browser state, and report the recovery result.',
            ].join(' '),
            provider,
            model,
            prepare: async () => {
                injectNextFillFailure = true;
                await page.goto(`data:text/html,${encodeURIComponent(fixtureHtml())}`, {waitUntil: 'domcontentloaded'});
            },
            verify: async () => ({
                passed: await page.locator('#Name').inputValue() === 'Before',
                evidence: {value: await page.locator('#Name').inputValue()},
            }),
        });

        const program = report.runs.program;
        const baseline = report.runs['react-baseline'];
        process.stdout.write(`${JSON.stringify({
            taskId: report.taskId,
            ...(program ? {program: compactRun(program)} : {}),
            ...(baseline ? {baseline: compactRun(baseline)} : {}),
        }, null, 2)}\n`);
        if ([program, baseline].some((run) => run && !run.success)) {process.exitCode = 1;}
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
