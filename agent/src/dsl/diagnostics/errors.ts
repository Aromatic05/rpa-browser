export class DslError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = new.target.name;
        this.code = code;
    }
}

export class DslParseError extends DslError {
    constructor(message: string) {
        super('ERR_DSL_PARSE', message);
    }
}

export class DslRuntimeError extends DslError {
    details?: unknown;

    constructor(message: string, code = 'ERR_DSL_RUNTIME', details?: unknown) {
        super(code, message);
        this.details = details;
    }
}

export class UnsupportedError extends DslError {
    constructor(message: string) {
        super('ERR_DSL_UNSUPPORTED', message);
    }
}

export class DslValidationError extends DslError {
    diagnostics: Array<{
        code: string;
        message: string;
        path?: string;
    }>;

    constructor(diagnostics: Array<{ code: string; message: string; path?: string }>) {
        super('ERR_DSL_VALIDATION', 'DSL validation failed');
        this.diagnostics = diagnostics;
    }
}
