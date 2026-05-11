import { runControlEval, type ControlEvalContextDeps } from './eval';
import {
    ControlProtocolError,
    encodeControlEvalResponse,
    parseControlEvalRequest,
    type ControlEvalResponse,
} from './protocol';
import { createControlTransport } from './transport';

export type ControlServerOptions = {
    endpoint?: string;
    evalContext: ControlEvalContextDeps;
};

export type ControlServer = {
    endpoint: string;
    start(): Promise<void>;
    close(): Promise<void>;
};

const protocolErrorToResponse = (error: ControlProtocolError): ControlEvalResponse => ({
    id: error.requestId || 'unknown',
    ok: false,
    logs: [],
    error: {
        code: error.code,
        name: error.name || 'ControlProtocolError',
        message: error.message,
        stack: error.stack || `${error.name || 'ControlProtocolError'}: ${error.message}`,
    },
});

const unknownErrorToResponse = (error: unknown): ControlEvalResponse => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? error.stack : `Error: ${message}`;
    return {
        id: 'unknown',
        ok: false,
        logs: [],
        error: {
            code: 'ERR_CONTROL_BAD_REQUEST',
            name: error instanceof Error ? error.name : 'Error',
            message,
            stack,
        },
    };
};

export const createControlServer = (options: ControlServerOptions): ControlServer => {
    const transport = createControlTransport(options.endpoint);
    let started = false;
    let closed = false;
    let closePromise: Promise<void> | null = null;

    return {
        endpoint: transport.endpoint,
        async start(): Promise<void> {
            if (started) {
                return;
            }
            if (closed) {
                throw new Error('control server already closed');
            }
            await transport.listen((conn) => {
                conn.onLine((line) => {
                    void (async () => {
                        let response: ControlEvalResponse;
                        try {
                            const request = parseControlEvalRequest(line);
                            response = await runControlEval(request, options.evalContext);
                        } catch (error) {
                            response =
                                error instanceof ControlProtocolError
                                    ? protocolErrorToResponse(error)
                                    : unknownErrorToResponse(error);
                        }
                        conn.writeLine(`${encodeControlEvalResponse(response)}\n`);
                    })();
                });
            });
            started = true;
        },
        async close(): Promise<void> {
            if (closed) {
                await closePromise;
                return;
            }
            closed = true;
            if (!started) {
                closePromise = Promise.resolve();
                return;
            }
            closePromise = transport.close();
            await closePromise;
        },
    };
};
