import {test, expect} from '@playwright/test';
import {startFixtureServer} from '../../helpers/server';
import {startClosedBetaSession, pollProduct} from '../../helpers/product_closed_beta/session';
import {startClosedBetaFauxModel, planFillProgramScript} from '../../helpers/product_closed_beta/faux_model_server';
import {
    flushClosedBetaMatrix,
    newClosedBetaMatrix,
    passRow,
    failRow,
    type ClosedBetaMatrix,
} from '../../helpers/product_closed_beta/matrix';

/**
 * Closed-beta acceptance item 2: an ordinary Task started with prompt only
 * uses the workspace-configured provider/model defaults internally and
 * executes Program-first on the real page.
 */

const matrix: ClosedBetaMatrix = newClosedBetaMatrix();

const CUSTOMER_PROFILE = '/step_actions/customer_profile.html';

const FORBIDDEN = ['sessionId', 'session id', 'runId', 'continuationId', 'provider', 'model'];

test.describe('closed-beta: normal Product Task (prompt-only)', () => {
    test.describe.configure({mode: 'serial', timeout: 300_000});

    test('prompt-only startTask uses configured defaults and Program-first on the real page', async () => {
        const fixture = await startFixtureServer();
        const faux = await startClosedBetaFauxModel({
            script: planFillProgramScript({selector: '#customerName', value: 'PromptOnly'}),
        });
        const session = await startClosedBetaSession({modelServer: faux});
        try {
            await session.openTab(`${fixture.baseURL}${CUSTOMER_PROFILE}`);

            const started = await session.product({verb: 'startTask', prompt: 'fill the customer name field'}) as {
                taskId?: string;
                status?: string;
            };
            expect(started.taskId, JSON.stringify(started)).toBeTruthy();
            const taskId = started.taskId as string;

            const settled = await pollProduct(async () => {
                const view = await session.product({verb: 'taskView', taskId}) as {status?: string};
                return view.status === 'completed' ? view : null;
            }, 90_000);

            const value = await session.evaluate<string>(`return document.querySelector('#customerName')?.value ?? '';`);

            const programFirst = faux.toolResultLog.some((entry, index) => {
                const names = faux.toolResultLog.slice(0, index + 1).map((item) => item.name);
                return names.includes('browser.snapshot')
                    && names.includes('browser.capture_resolve')
                    && names.includes('agent.execute_program');
            });
            const defaultsUsed = faux.observedRequestModels.length > 0
                && faux.observedRequestModels.every((model) => model === 'closed-beta-model');

            const taskSerialized = JSON.stringify(settled);
            const leaked = FORBIDDEN.filter((token) => taskSerialized.toLowerCase().includes(token.toLowerCase()));

            const evidence: string[] = [
                `real DOM #customerName = ${JSON.stringify(value)}`,
                `task status = ${JSON.stringify(settled.status)}`,
                `model requests resolved defaults: model=${JSON.stringify([...new Set(faux.observedRequestModels)])}`,
                `tool call order (first 4): ${faux.toolResultLog.slice(0, 4).map((item) => item.name).join(' -> ')}`,
                `product task view leak scan: ${leaked.length === 0 ? 'clean' : `leaked ${leaked.join(',')}`}`,
                `received auth bearer headers = ${faux.receivedAuthHeaders.length}`,
            ];

            const passed = value === 'PromptOnly'
                && settled.status === 'completed'
                && defaultsUsed
                && programFirst
                && leaked.length === 0;
            matrix.rows.push(passed
                ? passRow('cb.task.prompt-only', 'item 2: prompt-only Task resolves configured provider/model defaults and executes Program-first', evidence)
                : failRow('cb.task.prompt-only', 'item 2: prompt-only Task resolves configured provider/model defaults and executes Program-first', 'ordinary task mis-behaved', evidence));
            expect(passed, JSON.stringify({value, status: settled.status, defaultsUsed, programFirst, leaked}, null, 2)).toBe(true);
        } finally {
            await session.close();
            await faux.close();
            await fixture.close();
            flushClosedBetaMatrix(matrix);
        }
    });
});