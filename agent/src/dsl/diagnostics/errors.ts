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
    constructor(message: string) {
        super('ERR_DSL_RUNTIME', message);
    }
}

export class UnsupportedError extends DslError {
    constructor(message: string) {
        super('ERR_DSL_UNSUPPORTED', message);
    }
}
