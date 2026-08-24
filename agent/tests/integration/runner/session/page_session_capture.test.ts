import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ensureFreshPageSession} from '../../../../src/automation/runner/session/capture';
import {
    createRecordingSnapshotPort,
    resolveRecordSnapshotForEvent,
} from '../../../../src/automation/recording/pipeline/snapshot';
import {createRecordingState} from '../../../../src/automation/recording/pipeline/state';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';

test('runner page session captures one V2 component bundle and refreshes it after dirty interaction', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <section id="Card">
            <form id="Orders">
              <label for="Buyer">Buyer</label>
              <input id="Buyer" name="buyer">
              <button id="Save" type="submit">Save</button>
            </form>
          </section>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {page});

        const first = await ensureFreshPageSession(deps, 'ws-1');
        assert.equal(Object.values(first.entry.capture.control.controls.controls).some((control) => control.kind === 'input'), true);
        assert.equal(Object.keys(first.entry.capture.form.forms.forms).length, 1);
        assert.equal(first.entry.capture.entityRules?.status, 'disabled');
        const cardNodeId = Object.keys(first.entry.capture.control.observation.nodes)
            .find((nodeId) => first.entry.capture.control.observation.attributes[nodeId]?.id === 'Card');
        assert.ok(cardNodeId);
        const confirmation = deps.pageSession.confirmSelection(page, cardNodeId);
        assert.equal(confirmation.ok, true);
        if (!confirmation.ok) {throw new Error('selection confirmation failed');}
        const confirmedAnchor = structuredClone(confirmation.selection.anchor);

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
        const selection = deps.pageSession.readSelection(page);
        assert.equal(selection.status, 'resolved');
        if (selection.status !== 'resolved') {throw new Error('selection did not resolve');}
        assert.deepEqual(selection.anchor, confirmedAnchor);
        const form = Object.values(refreshed.entry.capture.form.forms.forms)[0];
        assert.equal(form.location.selectionScopeNodeId, selection.nodeId);
        assert.notEqual(form.location.structuralRootNodeId, selection.nodeId);
    } finally {
        await browser.close();
    }
});


test('record snapshot enrichment reuses the runner PageSession instead of a private TTL cache', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<button id="save" type="button">Save</button>');
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {page});
        const state = createRecordingState({snapshotPort: createRecordingSnapshotPort(deps)});

        const runnerFirst = await ensureFreshPageSession(deps, 'ws-1');
        const recordFirst = await resolveRecordSnapshotForEvent({
            state,
            workspaceName: 'ws-1',
            event: {tabName: 'tab-1', ts: 1, type: 'click', selector: '#save'},
            page,
        });
        assert.equal(recordFirst, runnerFirst.entry.capture);

        await page.locator('#save').evaluate((button) => {
            button.textContent = 'Save now';
        });
        state.snapshotPort?.markDirty(page, 'interaction');
        const recordRefreshed = await resolveRecordSnapshotForEvent({
            state,
            workspaceName: 'ws-1',
            event: {tabName: 'tab-1', ts: 2, type: 'click', selector: '#save'},
            page,
        });
        assert.ok(recordRefreshed);
        assert.equal(
            recordRefreshed.control.observation.identity.captureRevision,
            runnerFirst.entry.identity.captureRevision + 1,
        );

        const runnerRefreshed = await ensureFreshPageSession(deps, 'ws-1');
        assert.equal(runnerRefreshed.entry.capture, recordRefreshed);
        assert.equal(runnerRefreshed.entry.refreshReason, 'dirty-interaction');
    } finally {
        await browser.close();
    }
});
