import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewportScheduler} from '../layout/viewport_tracker.js';

type Clock = {
    handles: Array<() => void>;
    requestAnimationFrame: (cb: () => void) => number;
    cancelAnimationFrame: (handle: number) => void;
};

const createFakeClock = (): Clock => {
    const handles: Array<() => void> = [];
    return {
        handles,
        requestAnimationFrame: (cb) => {
            handles.push(cb);
            return handles.length - 1;
        },
        cancelAnimationFrame: (handle) => {
            if (handle >= 0 && handle < handles.length) {
                handles[handle] = () => undefined;
            }
        },
    };
};

test('schedule triggers a single rAF callback for repeated calls', () => {
    const clock = createFakeClock();
    let count = 0;
    const scheduler = createViewportScheduler(() => {
        count += 1;
    }, clock);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(clock.handles.length, 1, 'only one rAF should be requested');
    assert.equal(count, 0, 'callback not fired before rAF runs');
    clock.handles[0]();
    assert.equal(count, 1);
});

test('after firing, a new schedule requests another rAF', () => {
    const clock = createFakeClock();
    let count = 0;
    const scheduler = createViewportScheduler(() => {
        count += 1;
    }, clock);
    scheduler.schedule();
    clock.handles[0]();
    scheduler.schedule();
    assert.equal(clock.handles.length, 2);
    clock.handles[1]();
    assert.equal(count, 2);
});

test('dispose cancels pending callback and prevents future fires', () => {
    const clock = createFakeClock();
    let count = 0;
    const scheduler = createViewportScheduler(() => {
        count += 1;
    }, clock);
    scheduler.schedule();
    scheduler.dispose();
    if (clock.handles[0]) {clock.handles[0]();}
    assert.equal(count, 0);
    scheduler.schedule();
    assert.equal(clock.handles.length, 1);
});

test('schedule after dispose is a no-op', () => {
    const clock = createFakeClock();
    let count = 0;
    const scheduler = createViewportScheduler(() => {
        count += 1;
    }, clock);
    scheduler.dispose();
    scheduler.schedule();
    assert.equal(clock.handles.length, 0);
    assert.equal(count, 0);
});
