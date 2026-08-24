import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
    capturePageObservation,
    createObservationAnchor,
    resolveObservationAnchor,
} from '../../../src/automation/snapshot';

test('browser captures increment revision in one document and rotate epoch after navigation', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto('data:text/html,<input id="name" value="alice">');

        const first = await capturePageObservation(page, { captureRuntimeState: true });
        const firstInput = Object.values(first.nodes).find((node) =>
            first.attributes[node.id]?.id === 'name');
        assert.ok(firstInput);
        const anchor = createObservationAnchor(first, firstInput.id);
        assert.ok(anchor);

        const second = await capturePageObservation(page, { captureRuntimeState: true });
        assert.equal(second.identity.pageEpoch, first.identity.pageEpoch);
        assert.equal(second.identity.captureRevision, first.identity.captureRevision + 1);
        assert.equal(resolveObservationAnchor(anchor, second).status, 'resolved');

        await page.goto('data:text/html,<input id="name" value="bob">');
        const third = await capturePageObservation(page, { captureRuntimeState: true });
        assert.notEqual(third.identity.pageEpoch, first.identity.pageEpoch);
        assert.equal(third.identity.captureRevision, 1);
        assert.equal(resolveObservationAnchor(anchor, third).status, 'stale');
    } finally {
        await browser.close();
    }
});
