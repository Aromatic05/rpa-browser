import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyText, idleView, mount, openPanel} from './harness.js';
import type {WorkspaceProductView} from '../model/contracts.js';

const reviewView = (): WorkspaceProductView => ({...idleView(), reservation:'teach', authoring:{teach:{
    teachKind:'demonstration',phase:'review',stepCount:4,businessAreas:[],unsavedAsset:true,
    review:{summary:'4 个操作',stepSummaries:[],canSave:true},
}}});

test('recording and review show the next action without the setup chooser', () => {
    const review = reviewView();
    const fixture = mount({...review,authoring:{teach:{...review.authoring!.teach!,phase:'recording'}}});
    try {
        openPanel(fixture);
        assert.ok(fixture.shadow.querySelector('[data-rpa-product-action="stop-teach"]'));
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-action="start-teach"]'), null);
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-field="teach-kind"]'), null);
        assert.match(bodyText(fixture), /第 2 步/);
        fixture.handle.setView(review);
        assert.match(bodyText(fixture), /第 3 步/);
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-action="start-teach"]'), null);
    } finally {fixture.cleanup();}
});

test('typing a recording name keeps focus and caret when live state refreshes', () => {
    const fixture = mount(reviewView());
    try {
        openPanel(fixture);
        const input = fixture.shadow.querySelector('[data-rpa-product-field="demonstration-name"]') as HTMLInputElement;
        input.focus(); input.value='每周报表'; input.setSelectionRange(2,2);
        input.dispatchEvent(new fixture.dom.window.Event('input',{bubbles:true}));
        assert.equal(fixture.shadow.activeElement, input);
        fixture.handle.setView(reviewView());
        const refreshed = fixture.shadow.querySelector('[data-rpa-product-field="demonstration-name"]') as HTMLInputElement;
        assert.equal(refreshed.value,'每周报表');
        assert.equal(fixture.shadow.activeElement,refreshed);
        assert.equal(refreshed.selectionStart,2);
    } finally {fixture.cleanup();}
});

test('save routes to recordings only after the backend lists the saved recording', () => {
    const fixture = mount(reviewView());
    try {
        openPanel(fixture);
        const input = fixture.shadow.querySelector('[data-rpa-product-field="demonstration-name"]') as HTMLInputElement;
        input.value='每周报表'; input.dispatchEvent(new fixture.dom.window.Event('input',{bubbles:true}));
        (fixture.shadow.querySelector('[data-rpa-product-action="save-teach"]') as HTMLButtonElement).click();
        fixture.handle.setView(idleView());
        assert.notEqual(fixture.body.dataset.rpaProductSurface,'library');
        const saved = idleView(); saved.librarySummary.demonstrations=[{name:'每周报表',stepCount:4}];
        fixture.handle.setView(saved);
        assert.equal(fixture.body.dataset.rpaProductSurface,'library');
        assert.match(bodyText(fixture), /已保存：每周报表/);
    } finally {fixture.cleanup();}
});

test('help explains ordinary websites and can open the no-key recording path', () => {
    const fixture = mount({...idleView(),modelConfigured:false});
    try {
        openPanel(fixture);
        assert.match(fixture.launcher.textContent ?? '',/RPA 助手/);
        (fixture.shadow.querySelector('[data-rpa-product-action="help"]') as HTMLButtonElement).click();
        assert.equal(fixture.body.dataset.rpaProductSurface,'guide');
        assert.match(bodyText(fixture),/在其他网站上怎么用/);
        (fixture.shadow.querySelector('[data-rpa-product-action="guide-record"]') as HTMLButtonElement).click();
        assert.equal(fixture.body.dataset.rpaProductSurface,'teach');
        assert.equal((fixture.shadow.querySelector('[data-rpa-product-action="start-teach"]') as HTMLButtonElement).disabled,false);
    } finally {fixture.cleanup();}
});
