import type {SecretResolutionErrorCode} from './contracts';

export class SecretResolutionError extends Error {
    readonly code: SecretResolutionErrorCode;
    readonly refString: string;

    constructor(code: SecretResolutionErrorCode, refString: string, message: string) {
        super(message);
        this.name = 'SecretResolutionError';
        this.code = code;
        this.refString = refString;
    }
}