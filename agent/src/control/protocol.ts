export type ControlEvalRequest = {
    id: string;
    source: string;
    timeoutMs?: number;
    workspaceName?: string;
    input?: unknown;
};

export type ControlEvalError = {
    code: string;
    name: string;
    message: string;
    stack: string;
};

export type ControlEvalResponse = {
    id: string;
    ok: boolean;
    result?: unknown;
    logs: string[];
    error?: ControlEvalError;
};

export class ControlProtocolError extends Error {
    code: string;
    requestId?: string;

    constructor(code: string, message: string, requestId?: string) {
        super(message);
        this.code = code;
        this.requestId = requestId;
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseControlEvalRequest = (line: string): ControlEvalRequest => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        throw new ControlProtocolError('ERR_CONTROL_BAD_JSON', 'invalid control eval json');
    }

    if (!isRecord(parsed)) {
        throw new ControlProtocolError('ERR_CONTROL_BAD_REQUEST', 'control eval request must be a json object');
    }

    const requestId = typeof parsed.id === 'string' ? parsed.id : undefined;
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
        throw new ControlProtocolError('ERR_CONTROL_BAD_REQUEST', 'control eval request id must be a non-empty string');
    }
    if (typeof parsed.source !== 'string' || parsed.source.length === 0) {
        throw new ControlProtocolError(
            'ERR_CONTROL_BAD_REQUEST',
            'control eval request source must be a non-empty string',
            requestId,
        );
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'timeoutMs')) {
        if (!Number.isFinite(parsed.timeoutMs) || Number(parsed.timeoutMs) <= 0) {
            throw new ControlProtocolError('ERR_CONTROL_BAD_REQUEST', 'timeoutMs must be a positive number', requestId);
        }
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'workspaceName')) {
        if (typeof parsed.workspaceName !== 'string' || parsed.workspaceName.length === 0) {
            throw new ControlProtocolError(
                'ERR_CONTROL_BAD_REQUEST',
                'workspaceName must be a non-empty string when provided',
                requestId,
            );
        }
    }

    return {
        id: parsed.id,
        source: parsed.source,
        ...(Object.prototype.hasOwnProperty.call(parsed, 'timeoutMs') ? { timeoutMs: Number(parsed.timeoutMs) } : {}),
        ...(Object.prototype.hasOwnProperty.call(parsed, 'workspaceName')
            ? { workspaceName: parsed.workspaceName }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(parsed, 'input') ? { input: parsed.input } : {}),
    };
};

export const encodeControlEvalResponse = (response: ControlEvalResponse): string => JSON.stringify(response);
