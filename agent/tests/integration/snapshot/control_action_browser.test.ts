import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
    captureControlSnapshot,
    executeSelectOptionOnPage,
    resolveControlRef,
} from '../../../src/automation/snapshot';

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

test('custom select verification rejects trigger text without selected option state', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="trigger-no-state" role="combobox" aria-controls="popup-no-state" aria-expanded="true">Choose</button>
          <div id="popup-no-state" role="listbox">
            <button role="option" data-value="Travel">差旅</button>
          </div>
          <script>
            const trigger = document.querySelector('#trigger-no-state');
            document.querySelector('#popup-no-state').addEventListener('click', (event) => {
              const option = event.target.closest('[role=option]');
              if (!option) return;
              trigger.textContent = option.textContent;
            });
          </script>
        `);
        const initial = await findControlByDomId(page, 'trigger-no-state');
        assert.equal(initial.control.capabilities.includes('select_option'), true);

        const result = await executeSelectOptionOnPage(page, {
            kind: 'custom_select', nodeId: initial.nodeId, values: ['Travel'],
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok ? undefined : result.code, 'ERR_ASSERTION_FAILED');
        assert.equal(await page.locator('#trigger-no-state').textContent(), '差旅');
        assert.notEqual(await page.locator('[role=option]').getAttribute('aria-selected'), 'true');
    } finally {
        await browser.close();
    }
});

test('checkbox group restores original state when a later option action fails', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <fieldset id="transactional-checkboxes">
            <input id="tx-a" type="checkbox" value="A">
            <input id="tx-b" type="checkbox" value="B">
          </fieldset>
          <script>
            document.querySelector('#tx-a').addEventListener('change', () => {
              document.querySelector('#tx-b')?.remove();
            }, { once: true });
          </script>
        `);
        const initial = await findControlByDomId(page, 'tx-a');
        const result = await executeSelectOptionOnPage(page, {
            kind: 'checkbox_group', nodeId: initial.nodeId, values: ['A', 'B'],
        }, { timeoutMs: 300 });

        assert.equal(result.ok, false);
        assert.equal(await page.locator('#tx-a').isChecked(), false);
    } finally {
        await browser.close();
    }
});

test('select_option rejects conflicting node selector and control ref targets', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <select id="TargetA"><option value="x">X</option><option value="y">Y</option></select>
          <select id="TargetB"><option value="x">X</option><option value="y">Y</option></select>
        `);
        const a = await findControlByDomId(page, 'TargetA');
        const b = await findControlByDomId(page, 'TargetB');
        const result = await executeSelectOptionOnPage(page, {
            kind: 'native_select',
            nodeId: a.nodeId,
            selector: '#TargetB',
            controlRef: b.control.ref,
            values: ['y'],
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok ? undefined : result.code, 'ERR_BAD_ARGS');
        assert.equal(await page.locator('#TargetA').inputValue(), 'x');
        assert.equal(await page.locator('#TargetB').inputValue(), 'x');
    } finally {
        await browser.close();
    }
});

test('native select supports optgroup and multiple selection without popup ref collision', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <select id="Grouped" multiple>
            <optgroup label="Primary">
              <option value="one">One</option>
              <option value="two">Two</option>
            </optgroup>
          </select>
        `);
        const initial = await findControlByDomId(page, 'Grouped');
        assert.equal(initial.control.kind, 'native_select');
        assert.equal(initial.control.status, 'complete');
        assert.equal(initial.control.options.length, 2);
        assert.equal(initial.control.capabilities.includes('select_option'), true);
        assert.equal(Object.values(initial.snapshot.controls.controls).some((control) =>
            control.kind === 'popup' && control.controlNodeId === initial.nodeId), false);
        const result = await executeSelectOptionOnPage(page, {
            kind: 'native_select', nodeId: initial.nodeId, values: ['one', 'two'],
        });
        assert.equal(result.ok, true);
        assert.deepEqual(await page.locator('#Grouped').evaluate((node: HTMLSelectElement) =>
            Array.from(node.selectedOptions).map((option) => option.value)), ['one', 'two']);
    } finally {
        await browser.close();
    }
});

test('control refs remain bound to the same iframe node when sibling frame order changes', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <iframe id="before" srcdoc="<button id='other'>Other</button>"></iframe>
          <iframe id="target" srcdoc="<button id='inside'>Target</button>"></iframe>
          <iframe id="after" srcdoc="<button id='later'>Later</button>"></iframe>
        `);
        await page.locator('#target').contentFrame().locator('#inside').waitFor();
        const first = await captureControlSnapshot(page);
        const target = Object.values(first.controls.controls).find((control) =>
            first.observation.attributes[control.controlNodeId ?? '']?.id === 'inside');
        assert.ok(target);
        await page.locator('#before').evaluate((node) => node.remove());
        await page.locator('body').evaluate((body) => body.insertAdjacentHTML('beforeend',
            `<iframe id="replacement" srcdoc="<button id='inside'>Replacement</button>"></iframe>`));
        await page.locator('#replacement').contentFrame().locator('#inside').waitFor();
        const second = await captureControlSnapshot(page);
        const resolution = resolveControlRef(second.controls, target.ref);
        assert.equal(resolution.status, 'resolved');
        if (resolution.status === 'resolved') {
            assert.equal(second.observation.text[resolution.value.controlNodeId ?? ''], 'Target');
        }
    } finally {
        await browser.close();
    }
});

test('select_option preserves canonical validation errors for empty missing wrong-kind and stale targets', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <select id="Target"><option value="A">A</option><option value="B">B</option></select>
        `);
        const initial = await findControlByDomId(page, 'Target');

        const empty = await executeSelectOptionOnPage(page, {
            kind: 'native_select', nodeId: initial.nodeId, values: [],
        });
        assert.equal(empty.ok, false);
        assert.equal(empty.ok ? undefined : empty.code, 'ERR_BAD_ARGS');

        const missing = await executeSelectOptionOnPage(page, {
            kind: 'native_select', selector: '#Missing', values: ['B'],
        });
        assert.equal(missing.ok, false);
        assert.equal(missing.ok ? undefined : missing.code, 'ERR_NOT_FOUND');

        const wrongKind = await executeSelectOptionOnPage(page, {
            kind: 'radio_group', nodeId: initial.nodeId, values: ['B'],
        });
        assert.equal(wrongKind.ok, false);
        assert.equal(wrongKind.ok ? undefined : wrongKind.code, 'ERR_BAD_ARGS');

        await page.locator('#Target').evaluate((node) => node.remove());
        const stale = await executeSelectOptionOnPage(page, {
            kind: 'native_select', nodeId: initial.nodeId, values: ['B'],
        });
        assert.equal(stale.ok, false);
        assert.equal(stale.ok ? undefined : stale.code, 'ERR_STALE');
    } finally {
        await browser.close();
    }
});
