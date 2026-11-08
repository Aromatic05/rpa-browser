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

        assert.match(text, /12 recorded actions/);
        assert.match(text, /form · 1 entity/);
        assert.match(text, /needs review/, 'real library health evidence is shown, never a fabricated ready');

        assert.equal(/\bstep\b/i.test(text), false, 'Step must never render as an asset in the Library');
        assert.equal(text.includes('dsl'), false);
        assert.equal(text.includes('yaml'), false);
    } finally {
        fixture.cleanup();
    }
});

test('an unavailable Library projection says so instead of faking completeness', () => {
    const fixture = mount(libraryView());
    try {
        openLibrary(fixture);
        const view = { ...libraryView(), libraryUnavailable: true };
        fixture.handle.setView(view);
        const text = bodyText(fixture);
        assert.match(text, /does not expose a Library projection/i);
    } finally {
        fixture.cleanup();
    }
});

test('Library exposes only actions that are actually implemented', () => {
    const fixture = mount(libraryView());
    try {
        openLibrary(fixture);
        assert.equal(
            fixture.shadow.querySelector('[data-rpa-product-action="replay"]'),
            null,
            'demonstration replay is not advertised until its product lifecycle is actually wired',
        );

        (fixture.shadow.querySelector('[data-rpa-product-action="edit-page-knowledge"]') as HTMLButtonElement).click();
        const editCall = fixture.calls.find((call) => call.name === 'editPageKnowledge');
        assert.ok(editCall);
        assert.deepEqual(editCall.args, [{ profileName: 'orders' }]);
    } finally {
        fixture.cleanup();
    }
});

test('editing is disabled while another workspace activity owns the reservation', () => {
    const fixture = mount(libraryView('task'));
    try {
        openLibrary(fixture);
        const edit = fixture.shadow.querySelector('[data-rpa-product-action="edit-page-knowledge"]') as HTMLButtonElement;
        assert.equal(edit.disabled, true, 'Edit disabled under an active reservation');
        assert.match(bodyText(fixture), /The workspace is in use\./);
    } finally {
        fixture.cleanup();
    }
});

test('Library starts and stops playback and explains a failed action', () => {
    const view = {...libraryView(), playbackAvailable: true};
    const fixture = mount(view);
    try {
        openLibrary(fixture);
        const replay = fixture.shadow.querySelector<HTMLButtonElement>('[data-rpa-product-action="replay"]');
        assert.ok(replay);
        replay.click();
        assert.deepEqual(fixture.calls.find((call) => call.name === 'replayDemonstration')?.args, ['New vendor onboarding']);

        fixture.handle.setView({...view, reservation: 'playback', playback: {phase: 'running', completed: 1, total: 2}});
        assert.equal(fixture.shadow.querySelector<HTMLButtonElement>('[data-rpa-product-action="replay"]')?.disabled, true);
        fixture.shadow.querySelector<HTMLButtonElement>('[data-rpa-product-action="stop-playback"]')?.click();
        assert.ok(fixture.calls.some((call) => call.name === 'stopPlayback'));

        fixture.handle.setView({...view, playback: {
            phase: 'failed', completed: 2, total: 2,
            failure: {index: 1, code: 'ERR_AMBIGUOUS', fallbackConflict: true},
        }});
        assert.match(bodyText(fixture), /Action 2: The backup clues matched more than one element/);
        fixture.handle.setView({...view, playback: {
            phase: 'failed', completed: 2, total: 2,
            failure: {index: 1, code: 'ERR_AMBIGUOUS', frameIssue: 'ambiguous'},
        }});
        assert.match(bodyText(fixture), /Action 2: More than one embedded page matches the recording/);
    } finally {
        fixture.cleanup();
    }
});
