import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFingerprintFromHitTest,
    isPickerHost,
    shouldInterceptClick,
    type DOMElFingerprint,
} from '../picking/capture_picker.js';

type FakeElementOptions = {
    id?: string;
    attrs?: Record<string, string>;
    parent?: FakeElement | null;
    closestImpl?: (selector: string) => FakeElement | null;
};

class FakeElement {
    public readonly tagName: string;
    public id: string;
    private readonly attrs: Record<string, string>;
    public parentNode: FakeElement | null;
    private readonly closestImpl?: (selector: string) => FakeElement | null;

    constructor(opts: FakeElementOptions = {}) {
        this.tagName = opts.attrs?.tag ?? 'div';
        this.id = opts.id ?? '';
        this.attrs = {...opts.attrs};
        this.parentNode = opts.parent ?? null;
        this.closestImpl = opts.closestImpl;
    }

    public getAttribute(name: string): string | null {
        return this.attrs[name] ?? null;
    }

    public closest(selector: string): FakeElement | null {
        if (this.closestImpl) {
            return this.closestImpl(selector);
        }
        let cursor: FakeElement | null = this;
        while (cursor) {
            const panel = cursor.attrs['data-rpa-panel'];
            const host = cursor.attrs['data-rpa-annotator-host'];
            if (selector.includes('data-rpa-panel') && panel === 'true') {
                return cursor;
            }
            if (selector.includes('data-rpa-annotator-host') && host === 'true') {
                return cursor;
            }
            cursor = cursor.parentNode;
        }
        return null;
    }
}

test('shouldInterceptClick returns true for ordinary page elements', () => {
    const element = new FakeElement({attrs: {tag: 'button'}});
    assert.equal(shouldInterceptClick(element), true);
});

test('shouldInterceptClick returns false for null or undefined', () => {
    assert.equal(shouldInterceptClick(null), false);
    assert.equal(shouldInterceptClick(undefined), false);
});

test('shouldInterceptClick returns false inside rpa-floating-panel host', () => {
    const panel = new FakeElement({
        id: 'rpa-floating-panel',
        attrs: {tag: 'div', 'data-rpa-panel': 'true'},
    });
    const button = new FakeElement({
        attrs: {tag: 'button'},
        parent: panel,
    });
    assert.equal(shouldInterceptClick(button), false);
});

test('shouldInterceptClick returns false inside rpa-entity-annotator-host', () => {
    const host = new FakeElement({
        id: 'rpa-entity-annotator-host',
        attrs: {tag: 'div', 'data-rpa-panel': 'true'},
    });
    const svg = new FakeElement({
        attrs: {tag: 'svg'},
        parent: host,
    });
    assert.equal(shouldInterceptClick(svg), false);
});

test('shouldInterceptClick returns false when data-rpa-panel is on an ancestor without host id', () => {
    const wrapper = new FakeElement({
        attrs: {tag: 'div', 'data-rpa-panel': 'true'},
    });
    const child = new FakeElement({attrs: {tag: 'span'}, parent: wrapper});
    assert.equal(shouldInterceptClick(child), false);
});

test('isPickerHost returns true for the host element itself', () => {
    const host = new FakeElement({
        id: 'rpa-entity-annotator-host',
        attrs: {tag: 'div', 'data-rpa-panel': 'true'},
    });
    assert.equal(isPickerHost(host), true);
});

test('isPickerHost walks parentNode chain when closest is missing', () => {
    const panel = {id: 'rpa-floating-panel'} as unknown;
    const button = {parentNode: panel} as unknown;
    assert.equal(isPickerHost(button), true);
});

test('isPickerHost returns false for detached page element', () => {
    const standalone = {tagName: 'button', parentNode: null} as unknown;
    assert.equal(isPickerHost(standalone), false);
});

test('isPickerHost handles cycles safely via depth cap', () => {
    const node: {parentNode: unknown} = {parentNode: null};
    node.parentNode = node;
    assert.equal(isPickerHost(node), false);
});

test('shouldInterceptClick returns false for shadow-retargeted target whose host has data-rpa-panel', () => {
    const host = new FakeElement({
        id: 'rpa-entity-annotator-host',
        attrs: {tag: 'div', 'data-rpa-panel': 'true'},
    });
    const innerSvg = new FakeElement({
        attrs: {tag: 'svg'},
        closestImpl: () => host,
    });
    assert.equal(shouldInterceptClick(innerSvg), false);
});

test('shouldInterceptClick returns false when target is debug panel host via composed path', () => {
    const debugHost = new FakeElement({
        id: 'rpa-floating-panel',
        attrs: {tag: 'div', 'data-rpa-panel': 'true'},
    });
    const innerButton = new FakeElement({
        attrs: {tag: 'button'},
        closestImpl: () => debugHost,
    });
    assert.equal(shouldInterceptClick(innerButton), false);
});

test('buildFingerprintFromHitTest strips elements inside picker hosts from hit elements', () => {
    const primary: DOMElFingerprint = {
        tagName: 'BUTTON',
        classTokens: ['cta'],
        rect: {x: 1, y: 2, width: 3, height: 4},
    };
    const fingerprint = buildFingerprintFromHitTest({
        point: {x: 10, y: 20},
        elements: [primary],
        ancestors: [],
    });
    assert.equal(fingerprint.tagName, 'BUTTON');
    assert.deepEqual(fingerprint.rect, {x: 1, y: 2, width: 3, height: 4});
});

test('buildFingerprintFromHitTest assembles fingerprint from primary element', () => {
    const primary: DOMElFingerprint = {
        tagName: 'BUTTON',
        classTokens: ['btn', 'btn-primary'],
        role: 'button',
        text: '提交',
        ariaLabel: '提交表单',
        rect: {x: 100, y: 200, width: 60, height: 30},
    };
    const ancestor: DOMElFingerprint = {
        tagName: 'FORM',
        classTokens: ['login-form'],
        role: 'form',
        text: '登录',
        ariaLabel: '登录表单',
        rect: {x: 0, y: 0, width: 400, height: 300},
    };
    const fingerprint = buildFingerprintFromHitTest({
        point: {x: 120, y: 215},
        elements: [primary],
        ancestors: [ancestor],
    });
    assert.deepEqual(fingerprint.point, {x: 120, y: 215});
    assert.equal(fingerprint.tagName, 'BUTTON');
    assert.deepEqual(fingerprint.classTokens, ['btn', 'btn-primary']);
    assert.equal(fingerprint.role, 'button');
    assert.equal(fingerprint.text, '提交');
    assert.equal(fingerprint.ariaLabel, '提交表单');
    assert.deepEqual(fingerprint.rect, primary.rect);
    assert.equal(fingerprint.ancestors.length, 1);
    assert.deepEqual(fingerprint.ancestors[0], {
        tagName: 'FORM',
        classTokens: ['login-form'],
        role: 'form',
        text: '登录',
        ariaLabel: '登录表单',
    });
    assert.ok(fingerprint.selectorCandidates.includes('button'));
    assert.ok(fingerprint.selectorCandidates.some((s) => s.startsWith('button.')));
});

test('buildFingerprintFromHitTest handles empty hit elements', () => {
    const fingerprint = buildFingerprintFromHitTest({
        point: {x: 5, y: 5},
        elements: [],
        ancestors: [],
    });
    assert.deepEqual(fingerprint.point, {x: 5, y: 5});
    assert.equal(fingerprint.tagName, '');
    assert.deepEqual(fingerprint.classTokens, []);
    assert.deepEqual(fingerprint.selectorCandidates, []);
    assert.deepEqual(fingerprint.rect, {x: 0, y: 0, width: 0, height: 0});
});

test('buildFingerprintFromHitTest skips unstable class tokens when building selector candidates', () => {
    const primary: DOMElFingerprint = {
        tagName: 'input',
        classTokens: ['css-1a2b3c', 'form-control'],
        rect: {x: 0, y: 0, width: 1, height: 1},
    };
    const fingerprint = buildFingerprintFromHitTest({
        point: {x: 0, y: 0},
        elements: [primary],
        ancestors: [],
    });
    assert.ok(fingerprint.selectorCandidates.includes('input'));
    assert.ok(fingerprint.selectorCandidates.includes('input.form-control'));
    assert.ok(
        !fingerprint.selectorCandidates.some((s) => s.includes('css-1a2b3c')),
        'generated css modules must not leak into selector candidates',
    );
});
