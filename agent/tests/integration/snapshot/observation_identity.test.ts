import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationIdentityTracker } from '../../../src/snapshot';

test('ObservationIdentityTracker increments revision within one document and rotates epoch for a new document', () => {
    let sequence = 0;
    const tracker = new ObservationIdentityTracker(() => `epoch-${++sequence}`);

    const first = tracker.next('document-token-a');
    const second = tracker.next('document-token-a');
    const navigation = tracker.next('document-token-b');

    assert.equal(first.pageEpoch, 'epoch-1');
    assert.equal(first.captureRevision, 1);
    assert.equal(second.pageEpoch, first.pageEpoch);
    assert.equal(second.captureRevision, 2);
    assert.notEqual(navigation.pageEpoch, first.pageEpoch);
    assert.equal(navigation.captureRevision, 1);
});
