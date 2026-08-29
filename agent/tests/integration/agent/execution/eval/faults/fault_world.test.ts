import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_EVAL_WORLD_ERROR_CODES, AgentEvalWorldError} from '../../../../../../src/agent/execution/eval/world';
import {AGENT_FAULT_ERROR_CODES, AgentFaultWorldError} from '../../../../../../src/agent/execution/eval/faults/contracts';
import type {AgentFaultEvent} from '../../../../../../src/agent/execution/eval/faults/contracts';
import {createFakeFaultWorld} from '../../../../../helpers/agent_fault_world';

const FORM = {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']} as const;

const faultWorld = () => createFakeFaultWorld();

const expectFaultError = async (
    promise: Promise<unknown>,
    code: string,
    worldChanged: boolean,
): Promise<AgentFaultWorldError> => {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof AgentFaultWorldError, `expected AgentFaultWorldError, got ${String(error)}`);
        assert.equal(error.code, code);
        assert.equal(error.worldChanged, worldChanged);
        return error;
    }
    assert.fail(`expected rejection with ${code}`);
};

const kindsOf = (events: readonly AgentFaultEvent[]): string[] =>
    events.map((event) => `${event.kind}:${event.key}${event.reason ? `:${event.reason}` : ''}`);

test('mutation-report-error applies the effect then reports failure with worldChanged metadata', async () => {
    const world = faultWorld();
    await world.load(FORM);
    world.arm({kind: 'mutation-report-error', targetKey: 'name'});
    const error = await expectFaultError(
        world.fill(world.field('name'), 'Alice'),
        AGENT_FAULT_ERROR_CODES.postEffectError,
        true,
    );
    assert.equal(await world.read(world.field('name')), 'Alice');
    assert.ok(error.revision >= 1);
    assert.deepEqual(kindsOf(world.events()).filter((entry) => entry.startsWith('fill-failed-after-apply')),
        ['fill-failed-after-apply:name:ERR_INJECTED_POST_EFFECT']);
});

test('revision-drift replaces the node between read and effect and the committed stale error survives', async () => {
    const world = faultWorld();
    await world.load(FORM);
    world.arm({kind: 'revision-drift', targetKey: 'name'});
    const stale = world.field('name');
    await assert.rejects(
        () => world.fill(stale, 'Alice'),
        (error: unknown) => error instanceof AgentEvalWorldError
            && error.code === AGENT_EVAL_WORLD_ERROR_CODES.staleTarget,
    );
    assert.equal(await world.read(world.field('name')), '', 'drift cleared the node value');
    assert.ok(kindsOf(world.events()).includes('drift:name'));
    assert.ok(kindsOf(world.events()).includes('fill-rejected:name:ERR_STALE_TARGET'));
    await world.fill(world.field('name'), 'Alice');
    assert.equal(await world.read(world.field('name')), 'Alice');
});

test('epoch-navigation invalidates every pre-navigation handle until refresh rebinds', async () => {
    const world = faultWorld();
    await world.load(FORM);
    world.arm({kind: 'epoch-navigation', targetKey: 'name'});
    const nameHandle = world.field('name');
    const submitHandle = world.field('submit');
    await expectFaultError(
        world.fill(nameHandle, 'Alice'),
        AGENT_FAULT_ERROR_CODES.staleTarget,
        false,
    );
    assert.equal(world.epoch(), 2);
    await assert.rejects(() => world.click(submitHandle), AgentFaultWorldError);
    await world.fill(world.refresh('name'), 'Alice');
    assert.equal(await world.read(world.field('name')), 'Alice');
    assert.ok(kindsOf(world.events()).includes('navigation:name'));
});

test('transactional-restore leaves a stray partial effect and reports a failed apply', async () => {
    const world = faultWorld();
    await world.load(FORM);
    world.arm({kind: 'transactional-restore', targetKey: 'name', partialValue: 'Alice~partial'});
    await expectFaultError(
        world.fill(world.field('name'), 'Alice'),
        AGENT_FAULT_ERROR_CODES.partialApply,
        true,
    );
    assert.equal(await world.read(world.field('name')), 'Alice~partial');
    await world.fill(world.field('name'), 'Before');
    assert.equal(await world.read(world.field('name')), 'Before');
});

test('compensation-partial-restore fails the first undo and only the second attempt restores', async () => {
    const world = faultWorld();
    await world.load(FORM);
    world.arm({kind: 'compensation-partial-restore', targetKey: 'name', partialValue: 'Alice~partial', halfRestoredValue: 'HalfRestored'});
    await expectFaultError(world.fill(world.field('name'), 'Alice'), AGENT_FAULT_ERROR_CODES.partialApply, true);
    await expectFaultError(world.fill(world.field('name'), 'Before'), AGENT_FAULT_ERROR_CODES.partialRestore, true);
    assert.equal(await world.read(world.field('name')), 'HalfRestored');
    await world.fill(world.field('name'), 'Before');
    assert.equal(await world.read(world.field('name')), 'Before');
    assert.equal(kindsOf(world.events()).filter((entry) => entry.startsWith('fill-failed-after-apply')).length, 2);
});

test('external-mutation-conflict: transact rejects a stale revision while a plain fill clobbers', async () => {
    const world = faultWorld();
    await world.load(FORM);
    world.arm({kind: 'external-mutation-conflict', targetKey: 'name', externalValue: 'External-edit'});
    const observed = world.field('name');
    const expectedRevision = world.revision();
    await expectFaultError(
        world.transact(observed, 'Alice', expectedRevision),
        AGENT_FAULT_ERROR_CODES.revisionConflict,
        false,
    );
    assert.equal(await world.read(world.field('name')), 'External-edit', 'conflict must not clobber the external write');
    world.arm({kind: 'external-mutation-conflict', targetKey: 'name', externalValue: 'ignored-second'});
    await world.fill(world.field('name'), 'Alice');
    assert.equal(await world.read(world.field('name')), 'Alice', 'baseline-style fill overwrites blindly');
    const live = world.field('name');
    await world.transact(live, 'Alice2', world.revision());
    assert.equal(await world.read(world.field('name')), 'Alice2');
});

test('ambiguous-timeout fires applied or not-applied per the armed script only once', async () => {
    const applied = faultWorld();
    await applied.load(FORM);
    applied.arm({kind: 'ambiguous-timeout', targetKey: 'name', effectApplied: true});
    await expectFaultError(applied.fill(applied.field('name'), 'Alice'), AGENT_FAULT_ERROR_CODES.postEffectTimeout, true);
    assert.equal(await applied.read(applied.field('name')), 'Alice');
    await applied.fill(applied.field('name'), 'Alice');
    assert.ok(kindsOf(applied.events()).includes('fill-applied:name'));

    const missing = faultWorld();
    await missing.load(FORM);
    missing.arm({kind: 'ambiguous-timeout', targetKey: 'name', effectApplied: false});
    await expectFaultError(missing.fill(missing.field('name'), 'Alice'), AGENT_FAULT_ERROR_CODES.postEffectTimeout, false);
    assert.equal(await missing.read(missing.field('name')), 'Before');
    assert.ok(kindsOf(missing.events()).includes('fill-failed-no-effect:name:ERR_FAULT_POST_EFFECT_TIMEOUT'));
});

test('load clears the fault script, the event log and the page epoch', async () => {
    const world = faultWorld();
    await world.load(FORM);
    world.arm({kind: 'mutation-report-error', targetKey: 'name'});
    await assert.rejects(() => world.fill(world.field('name'), 'x'), AgentFaultWorldError);
    await world.load(FORM);
    assert.deepEqual(world.events().map((entry) => entry.kind), ['load']);
    assert.deepEqual(world.armed(), []);
    assert.equal(world.epoch(), 1);
    await world.fill(world.field('name'), 'Alice');
    assert.equal(await world.read(world.field('name')), 'Alice');
});
