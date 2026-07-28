import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ensureFreshPageSession} from '../../../../src/runner/session/capture';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';

test('runner page session captures one V2 component bundle and refreshes it after dirty interaction', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <form id="Orders">
            <label for="Buyer">Buyer</label>
            <input id="Buyer" name="buyer">
            <button id="Save" type="submit">Save</button>
          </form>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {page});

        const first = await ensureFreshPageSession(deps, 'ws-1');
        assert.equal(Object.values(first.entry.capture.control.controls.controls).some((control) => control.kind === 'input'), true);
        assert.equal(Object.keys(first.entry.capture.form.forms.forms).length, 1);
        assert.equal(first.entry.capture.entityRules?.status, 'disabled');

        const reused = await ensureFreshPageSession(deps, 'ws-1');
        assert.equal(reused.entry, first.entry);

        await page.locator('#Orders').evaluate((form) => {
            const button = document.createElement('button');
            button.id = 'Cancel';
            button.type = 'button';
            button.textContent = 'Cancel';
            form.append(button);
        });
        deps.pageSession.markDirty(page, 'interaction');
        const refreshed = await ensureFreshPageSession(deps, 'ws-1');
        assert.notEqual(refreshed.entry, first.entry);
        assert.equal(refreshed.entry.identity.pageEpoch, first.entry.identity.pageEpoch);
        assert.equal(refreshed.entry.identity.captureRevision, first.entry.identity.captureRevision + 1);
        assert.equal(Object.values(refreshed.entry.capture.control.controls.controls)
            .some((control) => control.controlNodeId
                && refreshed.entry.capture.control.observation.attributes[control.controlNodeId]?.id === 'Cancel'), true);
    } finally {
        await browser.close();
    }
});
