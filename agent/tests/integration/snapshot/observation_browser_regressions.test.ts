import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
    capturePageObservation,
    createObservationAnchor,
    resolveObservationAnchor,
} from '../../../src/snapshot';

test('browser capture preserves page-owned markers and keeps exact runtime identity stable', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
            <!doctype html>
            <html><body>
              <input id="name" value="alice" data-rpa-state-id="business-token" data-rpa-observation-id="business-observation">
            </body></html>
        `, { waitUntil: 'domcontentloaded' });

        const first = await capturePageObservation(page, { captureRuntimeState: true });
        const firstInput = Object.values(first.nodes).find((node) => first.attributes[node.id]?.id === 'name');
        assert.ok(firstInput);
        assert.equal(await page.locator('#name').getAttribute('data-rpa-state-id'), 'business-token');
        assert.equal(await page.locator('#name').getAttribute('data-rpa-observation-id'), 'business-observation');
        assert.equal(first.attributes[firstInput.id]?.['data-rpa-state-id'], undefined);
        assert.equal(first.attributes[firstInput.id]?.['data-rpa-observation-id'], undefined);
        assert.equal(first.completeness.runtime, 'complete');

        const runtimeIdentityToken = first.domIdentity[firstInput.id]?.runtimeIdentityToken;
        assert.ok(runtimeIdentityToken);
        const anchor = createObservationAnchor(first, firstInput.id);
        assert.ok(anchor);

        const second = await capturePageObservation(page, { captureRuntimeState: true });
        const secondInput = Object.values(second.nodes).find((node) => second.attributes[node.id]?.id === 'name');
        assert.ok(secondInput);
        assert.equal(second.domIdentity[secondInput.id]?.runtimeIdentityToken, runtimeIdentityToken);
        assert.equal(resolveObservationAnchor({ ...anchor, backendNodeId: undefined }, second).status, 'resolved');
        assert.equal(await page.locator('#name').getAttribute('data-rpa-state-id'), 'business-token');
        assert.equal(await page.locator('#name').getAttribute('data-rpa-observation-id'), 'business-observation');
    } finally {
        await browser.close();
    }
});

test('successful empty optional-source captures are complete rather than partial', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><html><body><div>plain</div></body></html>');
        const observation = await capturePageObservation(page, { captureRuntimeState: true });
        assert.equal(observation.completeness.runtime, 'complete');
        assert.equal(observation.completeness.a11y, 'complete');
    } finally {
        await browser.close();
    }
});

test('browser capture composes scaled iframe content into top CSS viewport', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await page.setContent(`
            <!doctype html>
            <html><body style="margin:0">
              <iframe id="scaled" style="position:absolute;left:100px;top:50px;width:100px;height:100px;border:0;transform:scale(2);transform-origin:top left"
                srcdoc="<!doctype html><html><body style='margin:0'><button id='target' style='position:absolute;left:10px;top:20px;width:30px;height:40px'>T</button></body></html>"></iframe>
            </body></html>
        `, { waitUntil: 'domcontentloaded' });
        await page.locator('#scaled').contentFrame().locator('#target').waitFor();

        const observation = await capturePageObservation(page);
        const target = Object.values(observation.nodes).find((node) =>
            observation.attributes[node.id]?.id === 'target');
        assert.ok(target);
        const topRect = observation.geometry[target.id].find((record) =>
            record.space === 'top-css-viewport')?.rect;
        assert.deepEqual(topRect, { x: 120, y: 90, width: 60, height: 80 });
    } finally {
        await browser.close();
    }
});
