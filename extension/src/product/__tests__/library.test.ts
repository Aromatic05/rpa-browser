import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyText, libraryView, mount, openPanel } from './harness.js';

const openLibrary = (fixture: ReturnType<typeof mount>): void => {
    openPanel(fixture);
    (fixture.shadow.querySelector('[data-rpa-product-nav="library"]') as HTMLButtonElement).click();
};

test('Library never renders Step as an asset and shows dependency metadata only', () => {
    const fixture = mount(libraryView());
    try {
        openLibrary(fixture);
        const text = bodyText(fixture);
        assert.match(text, /Automations/);
        assert.match(text, /Procedures & Recovery/);
        assert.match(text, /Demonstrations/);
        assert.match(text, /Page Knowledge/);

        assert.match(text, /Submit weekly report/);
        assert.match(text, /Ensure login/);
        assert.match(text, /New vendor onboarding/);
        assert.match(text, /Orders page/);

        assert.match(text, /12 actions · replayable/);
        assert.match(text, /form · 1 entity/);

        assert.equal(/\bstep\b/i.test(text), false, 'Step must never render as an asset in the Library');
        assert.equal(text.includes('dsl'), false);
        assert.equal(text.includes('yaml'), false);
    } finally {
        fixture.cleanup();
    }
});

test('Library emits typed replay and edit intents for backend-supported actions', () => {
    const fixture = mount(libraryView());
    try {
        openLibrary(fixture);
        (fixture.shadow.querySelector('[data-rpa-product-action="replay"]') as HTMLButtonElement).click();
        const replayCall = fixture.calls.find((call) => call.name === 'replayDemonstration');
        assert.ok(replayCall);
        assert.deepEqual(replayCall.args, [{ name: 'New vendor onboarding' }]);

        (fixture.shadow.querySelector('[data-rpa-product-action="edit-page-knowledge"]') as HTMLButtonElement).click();
        const editCall = fixture.calls.find((call) => call.name === 'editPageKnowledge');
        assert.ok(editCall);
        assert.deepEqual(editCall.args, [{ profileName: 'orders' }]);
    } finally {
        fixture.cleanup();
    }
});

test('replay and editing are disabled while another workspace activity owns the reservation', () => {
    const fixture = mount(libraryView('task'));
    try {
        openLibrary(fixture);
        const replay = fixture.shadow.querySelector('[data-rpa-product-action="replay"]') as HTMLButtonElement;
        const edit = fixture.shadow.querySelector('[data-rpa-product-action="edit-page-knowledge"]') as HTMLButtonElement;
        assert.equal(replay.disabled, true, 'Replay disabled under an active reservation');
        assert.equal(edit.disabled, true, 'Edit disabled under an active reservation');
        assert.match(bodyText(fixture), /The workspace is in use\./);
        replay.click();
        assert.equal(fixture.calls.some((call) => call.name === 'replayDemonstration'), false);
    } finally {
        fixture.cleanup();
    }
});