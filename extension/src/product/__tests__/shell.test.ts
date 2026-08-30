import test from 'node:test';
import assert from 'node:assert/strict';
import { footerText, idleView, mount, openPanel, runningView } from './harness.js';

test('launcher toggles the right-docked panel and collapse returns to the launcher', () => {
    const fixture = mount(idleView());
    try {
        assert.equal(fixture.panel.hidden, true, 'panel starts collapsed');
        assert.equal(fixture.launcher.hidden, false, 'launcher starts visible');

        openPanel(fixture);
        assert.equal(fixture.panel.hidden, false, 'panel opens on launcher click');
        assert.equal(fixture.launcher.hidden, true, 'launcher hides while the panel is open');
        assert.equal(fixture.panel.style.width, '400px', 'default width is 400px');

        const collapse = fixture.shadow.querySelector('[aria-label="Collapse panel"]') as HTMLButtonElement;
        assert.ok(collapse);
        collapse.click();
        assert.equal(fixture.panel.hidden, true, 'collapse hides the panel');
        assert.equal(fixture.launcher.hidden, false, 'collapse restores the launcher');
    } finally {
        fixture.cleanup();
    }
});

test('host, launcher and panel all carry the snapshot-ignore attribute', () => {
    const fixture = mount(idleView());
    try {
        assert.equal(fixture.host.getAttribute('data-rpa-snapshot-ignore'), 'true');
        assert.equal(fixture.launcher.getAttribute('data-rpa-snapshot-ignore'), 'true');
        assert.equal(fixture.panel.getAttribute('data-rpa-snapshot-ignore'), 'true');
    } finally {
        fixture.cleanup();
    }
});

test('header navigation switches surfaces and Task is disabled while idle', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        const taskNav = fixture.shadow.querySelector('[data-rpa-product-nav="task"]') as HTMLButtonElement;
        assert.equal(taskNav.disabled, true, 'Task nav is disabled while idle');

        const libraryNav = fixture.shadow.querySelector('[data-rpa-product-nav="library"]') as HTMLButtonElement;
        libraryNav.click();
        assert.equal(fixture.body.dataset.rpaProductSurface, 'library');

        const historyNav = fixture.shadow.querySelector('[data-rpa-product-nav="history"]') as HTMLButtonElement;
        historyNav.click();
        assert.equal(fixture.body.dataset.rpaProductSurface, 'history');

        const homeNav = fixture.shadow.querySelector('[data-rpa-product-nav="home"]') as HTMLButtonElement;
        homeNav.click();
        assert.equal(fixture.body.dataset.rpaProductSurface, 'home');
    } finally {
        fixture.cleanup();
    }
});

test('developer disclosure is a separate confirmable slot, off by default', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        assert.equal(fixture.body.dataset.rpaProductSurface, 'home', 'product surface by default');
        assert.match(footerText(fixture), /Developer mode: off/);
        assert.equal(footerText(fixture).includes('Developer mode: on'), false);

        const enable = fixture.shadow.querySelector('[data-rpa-product-action="enable-dev"]') as HTMLButtonElement;
        enable.click();
        assert.match(footerText(fixture), /Confirm enable/);
        assert.equal(fixture.body.dataset.rpaProductSurface, 'home', 'not enabled until confirmed');

        fixture.shadow
            .querySelector('[data-rpa-product-action="enable-dev"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
        assert.equal(fixture.body.dataset.rpaProductSurface, 'developer', 'body swaps to the developer surface');
        assert.match(footerText(fixture), /Developer mode: on/);
        assert.equal(fixture.calls.some((call) => call.name === 'openDeveloper'), true);

        const disable = fixture.shadow.querySelector('[data-rpa-product-action="disable-dev"]') as HTMLButtonElement;
        disable.click();
        assert.equal(fixture.body.dataset.rpaProductSurface, 'home', 'disabling restores the product surface');
        assert.equal(fixture.calls.some((call) => call.name === 'closeDeveloper'), true);
    } finally {
        fixture.cleanup();
    }
});

test('setView auto-routes from idle to the current task surface and back', () => {
    const fixture = mount(idleView());
    try {
        assert.equal(fixture.body.dataset.rpaProductSurface, 'home');
        fixture.handle.setView(runningView());
        assert.equal(fixture.body.dataset.rpaProductSurface, 'task');
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-block="task-header"]') !== null, true);
        fixture.handle.setView(idleView());
        assert.equal(fixture.body.dataset.rpaProductSurface, 'home');
    } finally {
        fixture.cleanup();
    }
});

test('resize clamp keeps the panel within 320-520 and emits a resize intent', () => {
    const fixture = mount(idleView(), { initialWidth: 900 });
    try {
        openPanel(fixture);
        assert.equal(fixture.panel.style.width, '520px', 'width clamps to the maximum');
        const handle = fixture.shadow.querySelector('[data-rpa-product-resize]') as HTMLElement;
        handle.dispatchEvent(
            new fixture.dom.window.MouseEvent('pointerdown', { clientX: 100, bubbles: true, cancelable: true }),
        );
        fixture.dom.window.dispatchEvent(
            new fixture.dom.window.MouseEvent('pointermove', { clientX: 10, bubbles: true }),
        );
        assert.equal(fixture.panel.style.width, '520px', 'max clamp holds during drag');
        fixture.dom.window.dispatchEvent(
            new fixture.dom.window.MouseEvent('pointermove', { clientX: 3000, bubbles: true }),
        );
        fixture.dom.window.dispatchEvent(new fixture.dom.window.MouseEvent('pointerup', { bubbles: true }));
        assert.equal(fixture.panel.style.width, '320px', 'min clamp holds during drag');
        assert.equal(fixture.calls.some((call) => call.name === 'resize'), true);
    } finally {
        fixture.cleanup();
    }
});