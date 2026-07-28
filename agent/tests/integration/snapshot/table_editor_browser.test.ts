import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureTableSnapshot } from '../../../src/snapshot';

test('real portal cell editor moves from unresolved closed revision to resolved open revision', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <table id="users">
            <thead><tr><th>Name</th></tr></thead>
            <tbody>
              <tr data-row-key="u1">
                <td id="editable-cell" aria-controls="cell-editor">
                  Alice <button id="open-editor" type="button">Edit</button>
                </td>
              </tr>
            </tbody>
          </table>
          <script>
            document.getElementById('open-editor').addEventListener('click', () => {
              const editor = document.createElement('div');
              editor.id = 'cell-editor';
              editor.setAttribute('role', 'dialog');
              editor.innerHTML = '<label for="editor-name">Name</label><input id="editor-name" value="Alice">';
              document.body.append(editor);
            });
          </script>
        `);

        const closed = await captureTableSnapshot(page);
        const closedTable = Object.values(closed.tables.tables)[0];
        assert.equal(closedTable.editors.length, 1);
        assert.equal(closedTable.editors[0].status, 'unresolved');
        assert.equal(closedTable.status, 'partial');

        await page.click('#open-editor');
        const open = await captureTableSnapshot(page);
        const openTable = Object.values(open.tables.tables)[0];
        const openCell = Object.values(open.tables.cells)[0];
        assert.equal(open.observation.identity.pageEpoch, closed.observation.identity.pageEpoch);
        assert.equal(open.observation.identity.captureRevision, closed.observation.identity.captureRevision + 1);
        assert.equal(openTable.editors.length, 1);
        assert.equal(openTable.editors[0].status, 'resolved');
        assert.equal(openTable.status, 'complete');
        assert.equal(openCell.controlIds.some((controlId) => open.controls.controls[controlId]?.kind === 'input'), true);
    } finally {
        await browser.close();
    }
});
