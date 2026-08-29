import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectCredentialRefs,
    createCredentialResolvingStepExecutor,
    isCredentialRefString,
    resolveCredentialRefsDeep,
} from '../../../../src/automation/dsl/runtime/credentials';
import {
    createCredentialRef,
    createMemoryCredentialResolver,
    serializeCredentialRef,
    type CredentialResolver,
} from '../../../../src/security/credentials';
import type {StepResult, StepUnion} from '../../../../src/automation/runner/steps/types';

const CANARY = 'tok_canary_3f9a2c_d0e1f2';

const apiTokenRef = () => createCredentialRef({id: 'env:API_TOKEN', kind: 'token', provider: 'env'});

const resolvable = () => createMemoryCredentialResolver({'env:API_TOKEN': CANARY});

const fillStep = (value: unknown, args: Record<string, unknown> = {}): StepUnion => ({
    id: 'step-fill',
    name: 'browser.fill',
    args: {nodeId: 'buyer', value, ...args},
    meta: {source: 'dsl', ts: 0},
}) as StepUnion;

const traceResolve = (resolved: string[], underlying: CredentialResolver): CredentialResolver => ({
    resolve: async (ref) => {
        resolved.push(ref.id);
        return await underlying.resolve(ref);
    },
    has: (ref) => underlying.has(ref),
    describe: (ref) => underlying.describe(ref),
});

test('collectCredentialRefs walks nested inputs and ignores scalars', () => {
    const refString = serializeCredentialRef(apiTokenRef());
    assert.deepEqual(
        collectCredentialRefs({token: refString, nested: {list: [refString, 'plain']}, ok: true}),
        [apiTokenRef(), apiTokenRef()],
    );
    assert.deepEqual(collectCredentialRefs({plain: 'text', n: 3, f: null, a: [1]}), []);
});

test('resolveCredentialRefsDeep resolves nested refs and preserves ordinary scalars without mutating the input', async () => {
    const refString = serializeCredentialRef(apiTokenRef());
    const input = {token: refString, nested: {token: refString, value: 'plain', flags: [null, 'x']}};
    const rewritten = await resolveCredentialRefsDeep(input, resolvable().resolve);
    assert.deepEqual(rewritten, {
        token: CANARY,
        nested: {token: CANARY, value: 'plain', flags: [null, 'x']},
    });
    assert.equal(input.token, refString, 'the input value must not be mutated');
});

test('the executor hands the wrapped runner exactly the resolved args exactly once', async () => {
    const refString = serializeCredentialRef(apiTokenRef());
    const resolved: string[] = [];
    const executed: StepUnion[] = [];
    const execute = createCredentialResolvingStepExecutor({
        resolver: traceResolve(resolved, resolvable()),
        execute: async (step) => {
            executed.push(step);
            return {stepId: step.id, ok: true, data: {filled: true}} as StepResult;
        },
    });

    const step = fillStep(refString);
    const result = await execute(step);

    assert.equal(result.ok, true);
    assert.deepEqual(executed, [{...step, args: {nodeId: 'buyer', value: CANARY}}]);
    assert.deepEqual(resolved, ['env:API_TOKEN']);
    assert.equal((step.args as {value?: unknown}).value, refString, 'the original step must remain reference-only');
});

test('the executor resolves nested array/object args while leaving ordinary values untouched', async () => {
    const refString = serializeCredentialRef(apiTokenRef());
    const executed: StepUnion[] = [];
    const execute = createCredentialResolvingStepExecutor({
        resolver: resolvable(),
        execute: async (step) => {
            executed.push(step);
            return {stepId: step.id, ok: true, data: {}} as StepResult;
        },
    });

    await execute(fillStep(undefined, {values: [[refString, 'plain'], {token: refString}]}));

    assert.deepEqual(executed[0].args, {
        nodeId: 'buyer',
        value: undefined,
        values: [[CANARY, 'plain'], {token: CANARY}],
    });
});

test('a scalar-only step never touches the resolver', async () => {
    const resolver: CredentialResolver = {
        resolve: async () => {throw new Error('resolve must not be called');},
        has: () => {throw new Error('has must not be called');},
        describe: () => '',
    };
    const executed: StepUnion[] = [];
    const execute = createCredentialResolvingStepExecutor({
        resolver,
        execute: async (step) => {
            executed.push(step);
            return {stepId: step.id, ok: true, data: {}} as StepResult;
        },
    });

    await execute(fillStep('alice'));

    assert.deepEqual(executed, [fillStep('alice')]);
});

test('an unresolvable ref fails the step without reaching the wrapped executor', async () => {
    const executed: string[] = [];
    const execute = createCredentialResolvingStepExecutor({
        resolver: createMemoryCredentialResolver({}),
        execute: async (step) => {
            executed.push(step.id);
            return {stepId: step.id, ok: true, data: {}} as StepResult;
        },
    });

    const result = await execute(fillStep(serializeCredentialRef(apiTokenRef())));

    assert.equal(result.ok, false);
    if (result.ok) {throw new Error('expected a step failure for the unresolvable ref');}
    assert.equal(result.error?.code, 'ERR_SECURITY_CREDENTIAL_NOT_FOUND');
    assert.deepEqual(executed, [], 'the mutation executor must not run for an unresolvable ref');
    assert.equal(isCredentialRefString(serializeCredentialRef(apiTokenRef())), true);
});