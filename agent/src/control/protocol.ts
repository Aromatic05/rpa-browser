export type ControlRequest = {
    id: string;
    method: string;
    params?: unknown;
};

export type ControlResponse =
    | {
          id: string;
          ok: true;
          result?: unknown;
      }
    | {
          id: string;
          ok: false;
          error: {
              code: string;
              message: string;
              details?: unknown;
          };
      };

export class ControlProtocolError extends Error {
    code: string;
    details?: unknown;
    requestId?: string;

    constructor(code: string, message: string, details?: unknown, requestId?: string) {
        super(message);
        this.code = code;
        this.details = details;
        this.requestId = requestId;
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseControlRequest = (line: string): ControlRequest => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch (error) {
        throw new ControlProtocolError('ERR_CONTROL_BAD_JSON', 'invalid control rpc json', {
            cause: error instanceof Error ? error.message : String(error),
        });
    }

    if (!isRecord(parsed)) {
        throw new ControlProtocolError('ERR_CONTROL_BAD_REQUEST', 'control request must be a json object');
    }

    const requestId = typeof parsed.id === 'string' ? parsed.id : undefined;
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
        throw new ControlProtocolError('ERR_CONTROL_BAD_REQUEST', 'control request id must be a non-empty string');
    }
    if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
        throw new ControlProtocolError(
            'ERR_CONTROL_BAD_REQUEST',
            'control request method must be a non-empty string',
            undefined,
            requestId,
        );
    }

    return {
        id: parsed.id,
        method: parsed.method,
        ...(Object.prototype.hasOwnProperty.call(parsed, 'params') ? { params: parsed.params } : {}),
    };
};

export const encodeControlResponse = (response: ControlResponse): string => JSON.stringify(response);
