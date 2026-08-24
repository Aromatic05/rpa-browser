import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {
    buildSnapshotProjection,
    diffSnapshotProjection,
} from '../../../src/automation/snapshot';
import {ensureFreshPageSession} from '../../../src/automation/runner/session/capture';
import {completeRunStepsDeps} from '../../helpers/run_steps_workspace';

const fullProjection = (entry: Awaited<ReturnType<typeof ensureFreshPageSession>>['entry']) => {
    const built = buildSnapshotProjection(entry, {mode: 'full'});
    assert.ok(built.ok);
    return built.projection;
};

test('real browser filter rerender and modal lifecycle update one PageSession epoch', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 1000, height: 800}});
        await page.setContent(`
          <main>
            <label for="filter">Filter orders</label>
            <input id="filter" type="search">
            <button id="open-modal" type="button">Create order</button>
            <table id="orders" aria-label="Orders">
              <thead><tr><th>Order</th><th>Status</th></tr></thead>
              <tbody></tbody>
            </table>
            <div id="modal-root"></div>
          </main>
          <script>
            const rows = [
              {id: 'SO-001', status: 'Open'},
              {id: 'SO-002', status: 'Closed'},
            ];
            const tbody = document.querySelector('#orders tbody');
            const renderRows = (query = '') => {
              tbody.replaceChildren(...rows
                .filter((row) => row.id.toLowerCase().includes(query.toLowerCase()))
                .map((row) => {
                  const tr = document.createElement('tr');
                  tr.dataset.rowKey = row.id;
                  tr.innerHTML = '<td>' + row.id + '</td><td>' + row.status + '</td>';
                  return tr;
                }));
            };
            const modalRoot = document.querySelector('#modal-root');
            const openModal = () => {
              modalRoot.innerHTML =
                '<div role="dialog" aria-modal="true" aria-label="Create order">'
                + '<label for="buyer">Buyer</label>'
                + '<input id="buyer" name="buyer">'
                + '<label for="amount">Amount</label>'
                + '<input id="amount" name="amount" type="number">'
                + '<button id="save-order" type="submit">Save</button>'
                + '<button id="close-modal" type="button">Close</button>'
                + '</div>';
              document.querySelector('#close-modal').addEventListener('click', () => modalRoot.replaceChildren());
            };
            document.querySelector('#filter').addEventListener('input', (event) => renderRows(event.target.value));
            document.querySelector('#open-modal').addEventListener('click', openModal);
            renderRows();
          </script>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {workspaceName: 'ws-1', page});

        const initialContext = await ensureFreshPageSession(deps, 'ws-1', {explicit: true});
        const initial = fullProjection(initialContext.entry);
        assert.equal(initial.components.tables[0].rows.length, 2);
        assert.equal(initial.components.forms.some((form) => form.boundaryKind === 'dialog'), false);

        await page.locator('#filter').fill('SO-002');
        deps.pageSession.markDirty(page, 'interaction');
        const filteredContext = await ensureFreshPageSession(deps, 'ws-1');
        const filtered = fullProjection(filteredContext.entry);
        assert.equal(filtered.meta.pageEpoch, initial.meta.pageEpoch);
        assert.ok(filtered.meta.captureRevision > initial.meta.captureRevision);
        assert.deepEqual(filtered.components.tables[0].rows.map((row) => row.key), ['SO-002']);
        const filteredDiff = diffSnapshotProjection(filtered, initial);
        assert.equal(filteredDiff.mode, 'diff');
        assert.equal(filteredDiff.projection.meta.changedComponentIds.includes(filtered.components.tables[0].id), true);

        await page.locator('#open-modal').click();
        deps.pageSession.markDirty(page, 'interaction');
        const openedContext = await ensureFreshPageSession(deps, 'ws-1');
        const opened = fullProjection(openedContext.entry);
        const dialog = opened.components.forms.find((form) => form.boundaryKind === 'dialog');
        assert.ok(dialog);
        const observation = openedContext.entry.capture.control.observation;
        assert.deepEqual(dialog.fields.map((field) =>
            field.labelNodeIds.map((nodeId) => observation.text[nodeId]).join(' ')), ['Buyer', 'Amount']);
        assert.equal(dialog.actions.some((action) => observation.text[action.nodeId] === 'Save'), true);
        const openedDiff = diffSnapshotProjection(opened, filtered);
        assert.equal(openedDiff.mode, 'diff');
        assert.equal(openedDiff.projection.meta.changedComponentIds.includes(dialog.id), true);

        await page.locator('#close-modal').click();
        deps.pageSession.markDirty(page, 'interaction');
        const closedContext = await ensureFreshPageSession(deps, 'ws-1');
        const closed = fullProjection(closedContext.entry);
        assert.equal(closed.meta.pageEpoch, initial.meta.pageEpoch);
        assert.equal(closed.components.forms.some((form) => form.boundaryKind === 'dialog'), false);
        const closedDiff = diffSnapshotProjection(closed, opened);
        assert.equal(closedDiff.mode, 'diff');
        assert.equal(closedDiff.projection.meta.changedComponentIds.includes(dialog.id), true);
    } finally {
        await browser.close();
    }
});
