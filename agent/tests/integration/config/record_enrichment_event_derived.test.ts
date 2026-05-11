import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichRecordedStepWithSnapshot } from '../../src/record/enrichment';

test('raw/event-derived resolve preserves attrs/state and excludes duplicated css+value hints', async () => {
    const out = await enrichRecordedStepWithSnapshot({
        event: {
            tabName: 'tab-1',
            ts: Date.now(),
            type: 'input',
            selector: 'table tr:nth-of-type(5) input',
            value: '109',
            targetHint: 'input',
            a11yHint: { role: 'textbox' },
            targetAttrs: {
                tag: 'input',
                class: 'ant-input',
                name: 'price',
                placeholder: '请输入',
                ariaLabel: '价格',
            },
            targetState: {
                focused: true,
                disabled: true,
                readonly: true,
                ariaDisabled: 'true',
            },
            locatorCandidates: [
                { kind: 'css', selector: 'table tr:nth-of-type(5) input' } as any,
                { kind: 'label', text: '价格', exact: true } as any,
                { kind: 'placeholder', text: '请输入', exact: true } as any,
                { kind: 'role', role: 'textbox', name: '价格', exact: true } as any,
            ],
        },
        page: undefined,
        snapshotCache: new Map(),
        cacheKey: 'k',
    });

    assert.equal(out.resolveHint?.target?.tag, 'input');
    assert.equal(out.resolveHint?.target?.role, 'textbox');
    assert.equal(out.resolveHint?.target?.attrs?.name, 'price');
    assert.equal(out.resolveHint?.target?.state?.focused, true);
    assert.equal(out.resolveHint?.target?.attrs?.value, undefined);
    assert.equal(out.resolveHint?.raw?.locatorCandidates?.some((item) => item.kind === 'css' && item.selector === 'table tr:nth-of-type(5) input'), false);
    assert.equal(out.resolveHint?.raw?.locatorCandidates?.some((item) => item.kind === 'label' && item.text === '价格'), true);
    assert.equal(out.resolveHint?.raw?.locatorCandidates?.some((item) => item.kind === 'placeholder' && item.text === '请输入'), true);
    assert.equal(out.resolveHint?.raw?.locatorCandidates?.some((item) => item.kind === 'role' && item.role === 'textbox'), true);
    assert.equal(out.resolveHint?.target?.nodeId, undefined);
    assert.equal(out.resolveHint?.target?.primaryDomId, undefined);
    assert.equal(out.resolveHint?.locator?.direct?.query, undefined);
    assert.equal(Boolean(out.resolveHint?.capture?.source), true);
    assert.equal(Boolean(out.resolvePolicy?.requireVisible), true);
});
