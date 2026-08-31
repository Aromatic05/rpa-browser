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
 * Closed-beta acceptance item 9: no ordinary product surface (projection JSON
 * or real extension panel DOM text) exposes provider/model/sessionId/
 * checkpoint/entity_rules/DSL/Step/raw tool args/selectors.
 */

const matrix: ClosedBetaMatrix = newClosedBetaMatrix();

const CUSTOMER_PROFILE = '/step_actions/customer_profile.html';

const LEAK_TOKENS = [
    'provider',
    'model',
    'sessionid',
    'checkpoint',
    'entity_rules',
    'dsl',
    'step',
    'selector',
] as const;

const findLeaks = (text: string): string[] => {
    const lower = text.toLowerCase();
    return LEAK_TOKENS.filter((token) =>
        new RegExp(`(^|[^a-z0-9_])${token}([^a-z0-9_]|$)`, 'u').test(lower));
};

test.describe('closed-beta: ordinary product surfaces stay free of internals', () => {
    test.describe.configure({mode: 'serial', timeout: 300_000});

    test('task/events/workspace projections and the real product panel DOM carry no internal tokens', async () => {
        const fixture = await startFixtureServer();
        const faux = await startClosedBetaFauxModel({
            script: planFillProgramScript({selector: '#customerName', value: 'LeakGuard'}),
        });
        const session = await startClosedBetaSession({modelServer: faux});
        try {
            await session.openTab(`${fixture.baseURL}${CUSTOMER_PROFILE}`);

            const started = await session.product({verb: 'startTask', prompt: 'fill the customer name field'}) as {taskId?: string};
            expect(started.taskId, JSON.stringify(started)).toBeTruthy();
            const taskId = started.taskId as string;
            await pollProduct(async () => {
                const view = await session.product({verb: 'taskView', taskId}) as {status?: string};
                return view.status === 'completed' ? view : null;
            }, 90_000);

            const taskView = await session.product({verb: 'taskView', taskId}) as unknown;
            const events = await session.product({verb: 'events', taskId, afterSeq: 0}) as unknown;
            const workspace = await session.product({verb: 'workspaceView'}) as unknown;
            const library = await session.product({verb: 'librarySummary'}) as unknown;

            const projectionText = [
                JSON.stringify(taskView),
                JSON.stringify(events),
                JSON.stringify(workspace),
                JSON.stringify(library),
            ].join('\n');

            const panelInfo = await session.evaluate<{mounted: boolean; text: string}>(`(() => {
                const panel = document.getElementById('rpa-product-panel');
                const text = panel && 'shadowRoot' in panel && panel.shadowRoot
                    ? panel.shadowRoot.textContent || ''
                    : panel ? panel.textContent || '' : '';
                return {mounted: Boolean(panel), text};
            })()`);

            let panelText = panelInfo.text;
            if (panelInfo.mounted) {
                await session.evaluate(`(() => {
                    const panel = document.getElementById('rpa-product-panel');
                    const launcher = panel && 'shadowRoot' in panel && panel.shadowRoot
                        ? panel.shadowRoot.querySelector('[data-rpa-product-launcher]')
                        : null;
                    if (launcher instanceof HTMLElement) launcher.click();
                })()`);
                const deadline = Date.now() + 30_000;
                while (Date.now() < deadline && !/task completed/i.test(panelText)) {
                    panelText = await session.evaluate<string>(`(() => {
                        const panel = document.getElementById('rpa-product-panel');
                        const body = panel && 'shadowRoot' in panel && panel.shadowRoot
                            ? panel.shadowRoot.querySelector('.rpa-body')
                            : null;
                        return body ? body.textContent || '' : '';
                    })()`);
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }

            const projectionLeaks = findLeaks(projectionText);
            const panelLeaks = findLeaks(panelText);
            const domPanel = panelInfo.mounted;
            const domRendered = !domPanel || panelText.replace(/\s+/gu, ' ').trim().length > 0;

            const evidence: string[] = [
                `product panel mounted=${JSON.stringify(domPanel)}; user-facing text rendered=${JSON.stringify(domRendered)}`,
                `projection (task/events/workspace/library) token hits: ${projectionLeaks.length === 0 ? 'none' : projectionLeaks.join(',')}`,
                `panel DOM text token hits: ${panelLeaks.length === 0 ? 'none' : panelLeaks.join(',')}`,
            ];
            const passed = projectionLeaks.length === 0
                && panelLeaks.length === 0
                && domPanel
                && domRendered;
            matrix.rows.push(passed
                ? passRow('cb.surface.leaks', 'item 9: ordinary product surfaces carry no provider/model/sessionId/checkpoint/entity_rules/DSL/Step/raw args/selectors', evidence)
                : failRow('cb.surface.leaks', 'item 9: ordinary product surfaces carry no provider/model/sessionId/checkpoint/entity_rules/DSL/Step/raw args/selectors', 'ordinary product surface leaked internal tokens', evidence));
            expect(passed, JSON.stringify({domPanel, domRendered, projectionLeaks, panelLeaks, panelTextPreview: panelText.slice(0, 400)}, null, 2)).toBe(true);
        } finally {
            await session.close();
            await faux.close();
            await fixture.close();
            flushClosedBetaMatrix(matrix);
        }
    });
});