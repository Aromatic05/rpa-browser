import crypto from 'node:crypto';
import type { ObservationIdentity, PageEpochId } from './contracts';

export class ObservationIdentityTracker {
    private documentToken?: string;
    private pageEpoch?: PageEpochId;
    private captureRevision = 0;

    public constructor(private readonly createPageEpoch: () => PageEpochId = () => crypto.randomUUID()) {}

    public next(documentToken: string): ObservationIdentity {
        const normalizedToken = documentToken.trim();
        if (!normalizedToken) {
            throw new Error('document token must not be empty');
        }

        if (this.documentToken !== normalizedToken || !this.pageEpoch) {
            this.documentToken = normalizedToken;
            this.pageEpoch = this.createPageEpoch();
            this.captureRevision = 1;
        } else {
            this.captureRevision += 1;
        }

        return {
            pageEpoch: this.pageEpoch,
            captureRevision: this.captureRevision,
        };
    }
}
