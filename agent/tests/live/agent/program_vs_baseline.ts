import crypto from 'node:crypto';
import type {Page} from 'playwright';
import {runLiveAgentScenario} from './runner';
import {agentEvalReportToJson, allModesPassed} from '../../../src/agent/execution/eval/report';
import type {AgentEvalScenario} from '../../../src/agent/execution/eval/contracts';
import {resolveLiveModelConfig} from './model_config';

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

const main = async (): Promise<void> => {
    const {provider, model} = resolveLiveModelConfig();
    const requestedModes = process.env.RPA_EVAL_MODES?.split(',')
        .map((mode) => mode.trim())
        .filter((mode): mode is 'program' | 'react-baseline' => mode === 'program' || mode === 'react-baseline');

    const context: {page?: Page} = {};
    const scenario: AgentEvalScenario = {
        version: 1,
        id: 'profile-name-fill',
        name: 'Profile name fill',
        description: 'Set the Name field to Alice and verify the browser state.',
        modes: requestedModes?.length ? requestedModes : ['program', 'react-baseline'],
        trials: 1,
        task: {
            id: 'profile-name-fill',
            prompt: 'Set the Name field on the current page to Alice. Inspect the page, perform the mutation, and verify the result.',
            provider,
            model,
            prepare: async (mode) => {
                const html = fixtureHtml(`${mode}-${crypto.randomUUID()}`);
                await context.page!.goto(`data:text/html,${encodeURIComponent(html)}`, {waitUntil: 'domcontentloaded'});
            },
            verify: async () => ({
                passed: await context.page!.locator('#Name').inputValue() === 'Alice',
                evidence: {value: await context.page!.locator('#Name').inputValue()},
            }),
        },
    };

    const report = await runLiveAgentScenario({scenario, context});
    process.stdout.write(`${agentEvalReportToJson(report)}\n`);
    process.exitCode = allModesPassed(report) ? 0 : 1;
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
