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
 * Closed-beta acceptance item 10: enabling HTTP bearer auth on the agent
 * service never breaks the trusted `agent.product` Action/WS path.
 */

const matrix: ClosedBetaMatrix = newClosedBetaMatrix();

const CUSTOMER_PROFILE = '/step_actions/customer_profile.html';
const TOKEN = 'closed-beta-auth-token';

test.describe('closed-beta: HTTP auth does not break the WS product path', () => {
    test.describe.configure({mode: 'serial', timeout: 300_000});

    test('bearer-auth HTTP rejects bad tokens while agent.product over WS keeps working end-to-end', async () => {
        const fixture = await startFixtureServer();
        const faux = await startClosedBetaFauxModel({
            script: planFillProgramScript({selector: '#customerName', value: 'AuthedByWs'}),
        });
        const session = await startClosedBetaSession({modelServer: faux, auth: {token: TOKEN}});
        try {
            await session.openTab(`${fixture.baseURL}${CUSTOMER_PROFILE}`);

            const started = await session.dispatch('agent.start', {});
            expect(started.type).toBe('agent.start.result');
            const status = await session.dispatch('agent.status', {});
            const port = ((status.payload ?? {}) as {port?: number | null}).port;
            expect(typeof port === 'number' && port !== null && port > 0, JSON.stringify(status.payload)).toBe(true);
            const base = `http://127.0.0.1:${String(port)}`;

            const noToken = await fetch(`${base}/agent/product`);
            const wrongToken = await fetch(`${base}/agent/product`, {headers: {authorization: `Bearer wrong-token`}});
            const rightToken = await fetch(`${base}/agent/product`, {headers: {authorization: `Bearer ${TOKEN}`}});
            const rightBody = await rightToken.json() as {workspace?: string; reservation?: {owner?: string}};

            const wsView = await session.product({verb: 'workspaceView'}) as {reservation?: {owner?: string}};

            const startedTask = await session.product({verb: 'startTask', prompt: 'fill the customer name field'}) as {taskId?: string};
            expect(startedTask.taskId, JSON.stringify(startedTask)).toBeTruthy();
            const settled = await pollProduct(async () => {
                const view = await session.product({verb: 'taskView', taskId: startedTask.taskId as string}) as {status?: string};
                return view.status === 'completed' ? view : null;
            }, 90_000);
            const domValue = await session.evaluate<string>(`return document.querySelector('#customerName')?.value ?? '';`);

            const evidence: string[] = [
                `HTTP GET /agent/product no token -> ${noToken.status}`,
                `HTTP GET /agent/product wrong token -> ${wrongToken.status}`,
                `HTTP GET /agent/product correct token -> ${rightToken.status} workspace=${JSON.stringify(rightBody.workspace)}`,
                `WS agent.product workspaceView owner=${JSON.stringify(wsView.reservation?.owner)}`,
                `WS agent.product task ${JSON.stringify(settled.status)} -> real DOM value ${JSON.stringify(domValue)}`,
            ];
            const passed = noToken.status === 401
                && wrongToken.status === 401
                && rightToken.status === 200
                && rightBody.workspace === 'default'
                && settled.status === 'completed'
                && domValue === 'AuthedByWs';
            matrix.rows.push(passed
                ? passRow('cb.auth.ws-product', 'item 10: HTTP bearer auth does not break the trusted Action/WS product path', evidence)
                : failRow('cb.auth.ws-product', 'item 10: HTTP bearer auth does not break the trusted Action/WS product path', 'auth/WS product interop mis-behaved', evidence));
            expect(passed, JSON.stringify({
                noToken: noToken.status,
                wrongToken: wrongToken.status,
                rightToken: rightToken.status,
                rightBody,
                wsView,
                taskStatus: settled.status,
                domValue,
            }, null, 2)).toBe(true);
        } finally {
            await session.close();
            await faux.close();
            await fixture.close();
            flushClosedBetaMatrix(matrix);
        }
    });
});