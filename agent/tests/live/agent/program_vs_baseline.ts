import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createOpenAICompatibleAgentModelRuntime} from '../../../src/agent/model/runtime';
import {evaluateAgentTask} from '../../../src/agent/execution/eval/evaluator';
import type {AgentRunResult, AgentRunner} from '../../../src/agent/execution/types';
import {createWorkflowOnFs} from '../../../src/automation/workflow';
import {stepExecutors} from '../../../src/automation/runner/steps/executors';
import {createWorkspaceHarness} from '../../helpers/workspace_harness';

const requiredEnv = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) {throw new Error(`${name} is required`);}
    return value;
};

type LiveModelConfig = Readonly<{
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
}>;

const resolveLiveModelConfig = (): LiveModelConfig => {
    const provider = process.env.RPA_AGENT_PROVIDER?.trim();
    const model = process.env.RPA_AGENT_MODEL?.trim();
    const baseUrl = process.env.RPA_AGENT_BASE_URL?.trim();
    const apiKey = process.env.RPA_AGENT_API_KEY?.trim();
    if (provider && model && baseUrl && apiKey) {return {provider, model, baseUrl, apiKey};}
    if ([provider, baseUrl, apiKey].some(Boolean)) {
        throw new Error('RPA_AGENT_PROVIDER, RPA_AGENT_MODEL, RPA_AGENT_BASE_URL, and RPA_AGENT_API_KEY must be provided together');
    }

    const opencodeProvider = requiredEnv('RPA_AGENT_OPENCODE_PROVIDER');
    const configPath = process.env.RPA_AGENT_OPENCODE_CONFIG?.trim()
        || path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        provider?: Record<string, {
            options?: {baseURL?: unknown; apiKey?: unknown};
            models?: Record<string, unknown>;
        }>;
    };
    const entry = config.provider?.[opencodeProvider];
    const resolvedBaseUrl = typeof entry?.options?.baseURL === 'string' ? entry.options.baseURL.trim() : '';
    const resolvedApiKey = typeof entry?.options?.apiKey === 'string' ? entry.options.apiKey.trim() : '';
    const resolvedModel = model || Object.keys(entry?.models ?? {})[0] || '';
    if (!entry || !resolvedBaseUrl || !resolvedApiKey || !resolvedModel) {
        throw new Error(`OpenCode provider is incomplete: ${opencodeProvider}`);
    }
    return {
        provider: opencodeProvider,
        model: resolvedModel,
        baseUrl: resolvedBaseUrl,
        apiKey: resolvedApiKey,
    };
};

const fixtureHtml = (revision: string): string => `<!doctype html>
<html>
  <head><title>Agent live eval ${revision}</title></head>
  <body>
    <main>
      <h1>Profile</h1>
      <label for="Name">Name</label>
      <input id="Name" name="name" value="">
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
        ...(tool.isError ? {args: tool.args} : {}),
    })),
    program: run.result.programs?.map((program) => ({
        status: program.status,
        source: program.source,
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
        const {registry} = createWorkspaceHarness({
            getPage: async () => page,
            pluginHost: {getExecutors: () => stepExecutors} as never,
            agentModelRuntime: modelRuntime,
        });
        const workspaceName = `agent-live-eval-${crypto.randomUUID()}`;
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
        const requestedModes = process.env.RPA_EVAL_MODES?.split(',')
            .map((mode) => mode.trim())
            .filter((mode): mode is 'program' | 'react-baseline' => mode === 'program' || mode === 'react-baseline');
        const report = await evaluateAgentTask({
            runner,
            ...(requestedModes?.length ? {modes: requestedModes} : {}),
        }, {
            id: 'profile-name-fill',
            prompt: 'Set the Name field on the current page to Alice. Inspect the page, perform the mutation, and verify the result.',
            provider,
            model,
            prepare: async (mode) => {
                const html = fixtureHtml(`${mode}-${crypto.randomUUID()}`);
                await page.goto(`data:text/html,${encodeURIComponent(html)}`, {waitUntil: 'domcontentloaded'});
            },
            verify: async () => ({
                passed: await page.locator('#Name').inputValue() === 'Alice',
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
