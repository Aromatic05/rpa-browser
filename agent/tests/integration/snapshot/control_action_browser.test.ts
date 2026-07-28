import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
    captureControlSnapshot,
    executeSelectOptionOnPage,
} from '../../../src/snapshot';

const findControlByDomId = async (page: import('playwright').Page, id: string) => {
    const snapshot = await captureControlSnapshot(page);
    const nodeId = Object.keys(snapshot.observation.nodes).find((candidate) => snapshot.observation.attributes[candidate]?.id === id);
    assert.ok(nodeId, `node ${id} not captured`);
    const refs = snapshot.controls.byNodeId[nodeId] ?? [];
    const control = refs.map((ref) => snapshot.controls.controls[ref]).find((candidate) =>
        candidate && candidate.kind !== 'option' && candidate.kind !== 'popup');
    assert.ok(control, `control ${id} not found`);
    return { snapshot, nodeId, control };
};

test('native select, radio and checkbox actions verify state after recapture', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <select id="Native"><option value="CaseA">Alpha</option><option value="caseB">Beta</option></select>
          <fieldset id="RadioGroup"><input id="r1" type="radio" name="status" value="A"><input id="r2" type="radio" name="status" value="B"></fieldset>
          <fieldset id="CheckGroup"><input id="c1" type="checkbox" value="X"><input id="c2" type="checkbox" value="Y"></fieldset>
        `);

        const native = await findControlByDomId(page, 'Native');
        const nativeResult = await executeSelectOptionOnPage(page, {
            kind: 'native_select', nodeId: native.nodeId, values: ['caseB'],
        });
        assert.equal(nativeResult.ok, true);
        assert.equal(await page.locator('#Native').inputValue(), 'caseB');

        const radio = await findControlByDomId(page, 'r1');
        const radioResult = await executeSelectOptionOnPage(page, {
            kind: 'radio_group', nodeId: radio.nodeId, values: ['B'],
        });
        assert.equal(radioResult.ok, true);
        assert.equal(await page.locator('#r2').isChecked(), true);
        assert.equal(await page.locator('#r1').isChecked(), false);

        const checkbox = await findControlByDomId(page, 'c1');
        const checkboxResult = await executeSelectOptionOnPage(page, {
            kind: 'checkbox_group', nodeId: checkbox.nodeId, values: ['X', 'Y'],
        });
        assert.equal(checkboxResult.ok, true);
        assert.equal(await page.locator('#c1').isChecked(), true);
        assert.equal(await page.locator('#c2').isChecked(), true);
    } finally {
        await browser.close();
    }
});

test('custom select transitions from partial closed state to complete exact popup ownership', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="trigger" role="combobox" aria-controls="popup" aria-expanded="false">Choose</button>
          <script>
            const trigger = document.querySelector('#trigger');
            trigger.addEventListener('click', () => {
              trigger.setAttribute('aria-expanded', 'true');
              if (!document.querySelector('#popup')) {
                const popup = document.createElement('div');
                popup.id = 'popup'; popup.setAttribute('role', 'listbox');
                popup.innerHTML = '<button role="option" data-value="Office">办公用品</button><button role="option" data-value="Travel">差旅</button>';
                popup.addEventListener('click', (event) => {
                  const option = event.target.closest('[role=option]');
                  if (!option) return;
                  for (const node of popup.querySelectorAll('[role=option]')) node.setAttribute('aria-selected', String(node === option));
                  trigger.textContent = option.textContent;
                });
                document.body.appendChild(popup);
              }
            });
          </script>
        `);
        const initial = await findControlByDomId(page, 'trigger');
        assert.equal(initial.control.status, 'partial');
        assert.equal(initial.control.capabilities.includes('select_option'), false);

        const result = await executeSelectOptionOnPage(page, {
            kind: 'custom_select', nodeId: initial.nodeId, values: ['Travel'],
        });
        assert.equal(result.ok, true);
        assert.equal(await page.locator('#trigger').textContent(), '差旅');
        assert.equal(await page.locator('[role=option][data-value=Travel]').getAttribute('aria-selected'), 'true');
    } finally {
        await browser.close();
    }
});

test('multiple custom selects with no exact target return ambiguity and perform no click', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <button role="combobox" aria-expanded="false">First</button>
          <button role="combobox" aria-expanded="false">Second</button>
        `);
        const result = await executeSelectOptionOnPage(page, {
            kind: 'custom_select', selector: '[role="combobox"]', values: ['X'],
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok ? undefined : result.code, 'ERR_AMBIGUOUS');
        assert.deepEqual(await page.locator('[role="combobox"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-expanded'))), ['false', 'false']);
    } finally {
        await browser.close();
    }
});


test('disabled options are rejected before action and state remains unchanged', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <select id="Native">
            <option value="A" selected>A</option>
            <option value="B" disabled>B</option>
          </select>
        `);
        const initial = await findControlByDomId(page, 'Native');
        const result = await executeSelectOptionOnPage(page, {
            kind: 'native_select', nodeId: initial.nodeId, values: ['B'],
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok ? undefined : result.code, 'ERR_UNRESOLVED');
        assert.equal(await page.locator('#Native').inputValue(), 'A');
    } finally {
        await browser.close();
    }
});
