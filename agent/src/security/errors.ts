export type SecurityErrorCode =
    | 'ERR_SECURITY_UNKNOWN_CAPABILITY'
    | 'ERR_SECURITY_DENIED'
    | 'ERR_SECURITY_BAD_CREDENTIAL_REF'
    | 'ERR_SECURITY_CREDENTIAL_NOT_FOUND'
    | 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE';

export class SecurityError extends Error {
    readonly code: SecurityErrorCode;

    constructor(code: SecurityErrorCode, message: string) {
        super(message);
        this.name = 'SecurityError';
        this.code = code;
    }
}