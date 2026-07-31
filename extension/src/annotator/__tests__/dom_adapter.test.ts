import test from 'node:test';
import assert from 'node:assert/strict';
import {attachPickerListeners, viewportRect} from '../picking/dom_adapter.js';

test('picker geometry remains in viewport coordinates after page scroll', () => {
    const rect = viewportRect({left: 18, top: 42, width: 120, height: 36});
    assert.deepEqual(rect, {x: 18, y: 42, width: 120, height: 36});
});

const withDomGlobals = async (
    dom: import('jsdom').JSDOM,
    run: () => void | Promise<void>,
): Promise<void> => {
    const names = ['Element', 'HTMLElement', 'MouseEvent', 'PointerEvent'] as const;
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const name of names) {
        previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperties(globalThis, {
        Element: {configurable: true, value: dom.window.Element},
        HTMLElement: {configurable: true, value: dom.window.HTMLElement},
        MouseEvent: {configurable: true, value: dom.window.MouseEvent},
        PointerEvent: {configurable: true, value: dom.window.MouseEvent},
    });
    try {
        await run();
    } finally {
        for (const name of names) {
            const descriptor = previous.get(name);
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    }
};

test('active picker captures on pointerdown and blocks the page control event sequence', async () => {
    const {JSDOM} = await import('jsdom');
    const dom = new JSDOM('<button id="submit" type="button">提交</button>');
    await withDomGlobals(dom, () => {
        const button = dom.window.document.querySelector('#submit')!;
        const counts = {pointerdown: 0, mousedown: 0, pointerup: 0, mouseup: 0, click: 0};
        for (const type of Object.keys(counts) as Array<keyof typeof counts>) {
            button.addEventListener(type, () => { counts[type] += 1; });
        }
        const picks: string[] = [];
        const detach = attachPickerListeners(dom.window.document, {
            isActive: () => true,
            onPick: (event) => picks.push(event.fingerprint.tagName),
        });
        for (const type of Object.keys(counts) as Array<keyof typeof counts>) {
            button.dispatchEvent(new dom.window.MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: 12,
                clientY: 18,
            }));
        }
        detach();
        assert.deepEqual(counts, {pointerdown: 0, mousedown: 0, pointerup: 0, mouseup: 0, click: 0});
        assert.deepEqual(picks, ['BUTTON']);
    });
});

test('inactive picker leaves page controls untouched', async () => {
    const {JSDOM} = await import('jsdom');
    const dom = new JSDOM('<button id="submit" type="button">提交</button>');
    await withDomGlobals(dom, () => {
        const button = dom.window.document.querySelector('#submit')!;
        let clicks = 0;
        button.addEventListener('click', () => { clicks += 1; });
        const detach = attachPickerListeners(dom.window.document, {
            isActive: () => false,
            onPick: () => assert.fail('inactive picker must not pick'),
        });
        button.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, cancelable: true}));
        detach();
        assert.equal(clicks, 1);
    });
});
