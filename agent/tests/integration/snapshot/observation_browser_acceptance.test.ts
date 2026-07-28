import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureAndAnalyzePageObservation, resolveLocatorScopePath } from '../../../src/snapshot';

test('browser capture distinguishes shadow and captured without candidate iframe scopes and composes geometry', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        await page.setContent(`
            <!doctype html>
            <html>
              <body>
                <button id="main-controller" aria-controls="shared-target" aria-expanded="false">Main</button>
                <div id="shared-target" role="table">Main target</div>
                <div id="zero-wrapper" style="display: contents"><button>Visible child</button></div>
                <div id="shadow-host"></div>
                <iframe id="empty-frame" srcdoc="<!doctype html><html><body></body></html>"
                  style="position:absolute;left:200px;top:150px;width:300px;height:200px"></iframe>
                <script>
                  const root = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
                  root.innerHTML = '<button id="shadow-controller" aria-controls="shared-target">Shadow</button>' +
                    '<div id="shared-target" role="dialog">Shadow target</div>';
                </script>
              </body>
            </html>
        `, { waitUntil: 'domcontentloaded' });
        await page.locator('#empty-frame').contentFrame().locator('body').waitFor({ state: 'attached' });

        const analysis = await captureAndAnalyzePageObservation(page, { captureRuntimeState: true });
        const scopes = Object.values(analysis.observation.scopes.scopes);

        assert.equal(scopes.some((scope) => scope.kind === 'open-shadow-root' && scope.status === 'captured'), true);
        assert.equal(scopes.some((scope) => scope.kind === 'iframe' && scope.status === 'captured'), true);
        assert.equal(analysis.report.scope.capturedWithoutCandidateCount >= 1, true);

        const rootScopeId = analysis.observation.scopes.rootScopeIds[0];
        const mainController = Object.values(analysis.observation.nodes).find((node) =>
            analysis.observation.attributes[node.id]?.id === 'main-controller'
            && node.scopeId === rootScopeId,
        );
        const mainTarget = Object.values(analysis.observation.nodes).find((node) =>
            analysis.observation.attributes[node.id]?.id === 'shared-target'
            && node.scopeId === rootScopeId,
        );
        const zeroWrapper = Object.values(analysis.observation.nodes).find((node) =>
            analysis.observation.attributes[node.id]?.id === 'zero-wrapper',
        );
        assert.ok(mainController);
        assert.ok(mainTarget);
        assert.ok(zeroWrapper);
        assert.equal(analysis.observation.activity[zeroWrapper.id].selfHasBox, false);
        assert.equal(analysis.observation.activity[zeroWrapper.id].subtreeActive, true);

        const mainRelations = analysis.relations.edges.filter((edge) =>
            edge.sourceNodeId === mainController.id);
        assert.equal(mainRelations.some((edge) =>
            edge.kind === 'controls-target'
            && edge.status === 'resolved'
            && edge.targetNodeIds.length === 1
            && edge.targetNodeIds[0] === mainTarget.id), true);
        assert.equal(mainRelations.some((edge) => edge.kind === 'popup-owner'), false);
        assert.equal(analysis.diagnostics.some((diagnostic) =>
            diagnostic.code === 'activity.controller-state-mismatch'
            && diagnostic.nodeIds.includes(mainController.id)
            && diagnostic.nodeIds.includes(mainTarget.id)), true);

        const shadowTarget = Object.values(analysis.observation.nodes).find((node) =>
            analysis.observation.attributes[node.id]?.id === 'shared-target'
            && node.scopeId !== analysis.observation.scopes.rootScopeIds[0]
            && analysis.observation.attributes[node.id]?.role === 'dialog',
        );
        assert.ok(shadowTarget);
        const shadowController = Object.values(analysis.observation.nodes).find((node) =>
            analysis.observation.attributes[node.id]?.id === 'shadow-controller'
            && node.scopeId === shadowTarget.scopeId,
        );
        assert.ok(shadowController);
        const shadowRelations = analysis.relations.edges.filter((edge) =>
            edge.sourceNodeId === shadowController.id);
        assert.equal(shadowRelations.some((edge) =>
            edge.kind === 'controls-target'
            && edge.targetNodeIds.length === 1
            && edge.targetNodeIds[0] === shadowTarget.id), true);
        assert.equal(shadowRelations.some((edge) =>
            edge.kind === 'popup-owner'
            && edge.targetNodeIds.length === 1
            && edge.targetNodeIds[0] === shadowTarget.id), true);
        assert.equal(shadowRelations.some((edge) => edge.targetNodeIds.includes(mainTarget.id)), false);

        const scopePath = resolveLocatorScopePath(analysis.observation, shadowTarget.id);
        assert.equal(scopePath.status, 'resolved');
        assert.equal(scopePath.status === 'resolved' ? scopePath.value.at(-1)?.kind : undefined, 'shadow');

        const geometry = analysis.observation.geometry[shadowTarget.id];
        assert.equal(geometry.some((record) => record.space === 'top-css-viewport'), true);

        const leakedMarkers = await page.locator('[data-rpa-observation-id]').count();
        const leakedRuntimeMarkers = await page.locator('[data-rpa-state-id]').count();
        assert.equal(leakedMarkers, 0);
        assert.equal(leakedRuntimeMarkers, 0);
    } finally {
        await browser.close();
    }
});
