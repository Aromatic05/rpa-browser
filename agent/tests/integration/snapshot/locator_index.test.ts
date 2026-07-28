import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
    buildLocatorIndex,
    buildPageObservation,
    captureControlSnapshot,
    resolveExecutableLocator,
    type RawPageCapture,
} from '../../../src/snapshot';

const active = () => ({ hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true });

const scopedCapture = (): RawPageCapture => ({
    identity: { pageEpoch: 'scope-fixture', captureRevision: 1 },
    metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-28T00:00:00.000Z' },
    completeness: { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' },
    scopes: [
        { id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness: { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } },
        { id: 'frame', kind: 'iframe', parentScopeId: 'main', hostCaptureId: 'frame-host', rootCaptureId: 'frame-html', status: 'captured', completeness: { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } },
        { id: 'shadow', kind: 'open-shadow-root', parentScopeId: 'main', hostCaptureId: 'shadow-host', rootCaptureId: 'shadow-root', status: 'captured', completeness: { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } },
    ],
    nodes: [
        { captureId: 'html', scopeId: 'main', childCaptureIds: ['body'], tag: 'html', attributes: {}, activity: active() },
        { captureId: 'body', scopeId: 'main', parentCaptureId: 'html', childCaptureIds: ['frame-host', 'shadow-host'], tag: 'body', attributes: {}, activity: active() },
        { captureId: 'frame-host', scopeId: 'main', parentCaptureId: 'body', childCaptureIds: [], tag: 'iframe', attributes: { id: 'CaseFrame' }, activity: active() },
        { captureId: 'frame-html', scopeId: 'frame', childCaptureIds: ['frame-button'], tag: 'html', attributes: {}, activity: active() },
        { captureId: 'frame-button', scopeId: 'frame', parentCaptureId: 'frame-html', childCaptureIds: [], tag: 'button', attributes: { id: 'FrameButton' }, ownText: 'Frame', activity: active() },
        { captureId: 'shadow-host', scopeId: 'main', parentCaptureId: 'body', childCaptureIds: [], tag: 'div', attributes: { id: 'ShadowHost' }, activity: active() },
        { captureId: 'shadow-root', scopeId: 'shadow', childCaptureIds: ['shadow-button'], tag: '#shadow-root', attributes: {}, activity: { ...active(), selfHasBox: false } },
        { captureId: 'shadow-button', scopeId: 'shadow', parentCaptureId: 'shadow-root', childCaptureIds: [], tag: 'button', attributes: { id: 'ShadowButton' }, ownText: 'Shadow', activity: active() },
    ],
    accessibility: [], runtimeState: {}, diagnostics: [],
});

test('locator index preserves raw identifiers and carries explicit frame/shadow paths', () => {
    const observation = buildPageObservation(scopedCapture());
    const index = buildLocatorIndex(observation);
    const frameButton = observation.captureIdToNodeId['frame-button'];
    const shadowButton = observation.captureIdToNodeId['shadow-button'];
    const frameLocator = index.locators[index.byNodeId[frameButton][0]];
    const shadowLocator = index.locators[index.byNodeId[shadowButton][0]];

    assert.equal(frameLocator.status, 'resolved');
    assert.equal(frameLocator.selector, '[id="FrameButton"]');
    assert.deepEqual(frameLocator.scopePath.map((step) => step.kind), ['frame']);
    assert.equal(shadowLocator.status, 'resolved');
    assert.equal(shadowLocator.selector, '[id="ShadowButton"]');
    assert.deepEqual(shadowLocator.scopePath.map((step) => step.kind), ['shadow']);
});


test('unavailable scope produces an unresolved locator instead of a global selector fallback', () => {
    const raw = scopedCapture();
    const frameScope = raw.scopes.find((scope) => scope.id === 'frame');
    assert.ok(frameScope);
    frameScope.status = 'unavailable';
    frameScope.unavailableReason = 'cross-origin';
    frameScope.completeness = {
        dom: 'unavailable', a11y: 'unavailable', runtime: 'unavailable', geometry: 'unavailable',
    };
    const observation = buildPageObservation(raw);
    const index = buildLocatorIndex(observation);
    const nodeId = observation.captureIdToNodeId['frame-button'];
    const locator = index.locators[index.byNodeId[nodeId][0]];
    assert.equal(locator.status, 'unresolved');
    assert.equal(locator.selector, undefined);
    assert.equal(index.diagnostics.some((item) => item.code === 'locator.scope.unresolved'), true);
});

test('live locator execution reaches iframe and shadow nodes without global fallback', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="top">Top</button>
          <iframe id="frame" srcdoc="<button id='inside'>Frame</button>"></iframe>
          <div id="host"></div>
          <script>
            const root = document.querySelector('#host').attachShadow({mode:'open'});
            root.innerHTML = '<button id="shadow">Shadow</button>';
          </script>
        `);
        await page.locator('#frame').contentFrame().locator('#inside').waitFor();
        const snapshot = await captureControlSnapshot(page);
        const frameNodeId = Object.keys(snapshot.observation.nodes).find((nodeId) => snapshot.observation.attributes[nodeId]?.id === 'inside');
        const shadowNodeId = Object.keys(snapshot.observation.nodes).find((nodeId) => snapshot.observation.attributes[nodeId]?.id === 'shadow');
        assert.ok(frameNodeId);
        assert.ok(shadowNodeId);

        const frameResult = await resolveExecutableLocator(page, snapshot.observation, snapshot.locators, snapshot.locators.byNodeId[frameNodeId][0]);
        const shadowResult = await resolveExecutableLocator(page, snapshot.observation, snapshot.locators, snapshot.locators.byNodeId[shadowNodeId][0]);
        assert.equal(frameResult.status, 'resolved');
        assert.equal(shadowResult.status, 'resolved');
        if (frameResult.status === 'resolved') await frameResult.locator.click();
        assert.equal(await page.locator('#frame').contentFrame().locator('#inside').evaluate((node) => node.matches(':focus')), true);
        if (shadowResult.status === 'resolved') await shadowResult.locator.click();
        assert.equal(await page.locator('#host').locator('#shadow').evaluate((node) => node.matches(':focus')), true);
    } finally {
        await browser.close();
    }
});

test('locator execution reports stale and ambiguous matches instead of clicking a fallback', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<button id="target">Target</button>');
        const snapshot = await captureControlSnapshot(page);
        const nodeId = Object.keys(snapshot.observation.nodes).find((id) => snapshot.observation.attributes[id]?.id === 'target');
        assert.ok(nodeId);
        const locatorId = snapshot.locators.byNodeId[nodeId][0];

        await page.locator('#target').evaluate((node) => node.remove());
        const stale = await resolveExecutableLocator(page, snapshot.observation, snapshot.locators, locatorId);
        assert.equal(stale.status, 'stale');

        await page.setContent('<button id="target">A</button><button id="target">B</button>');
        const ambiguous = await resolveExecutableLocator(page, snapshot.observation, snapshot.locators, locatorId);
        assert.equal(ambiguous.status, 'ambiguous');
    } finally {
        await browser.close();
    }
});
