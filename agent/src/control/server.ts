import { createControlRouter } from './router';
import { ControlProtocolError, encodeControlResponse, parseControlRequest, type ControlResponse } from './protocol';
import { createControlTransport } from './transport';
import type { RunStepsDeps } from '../runner/run_steps';
import type { DslCheckpointProvider } from '../dsl/emit';

export type ControlServerOptions = {
    endpoint?: string;
    deps: RunStepsDeps;
    workspaceId?: string;
    checkpointProvider?: DslCheckpointProvider;
};

export type ControlServer = {
    endpoint: string;
    start(): Promise<void>;
    close(): Promise<void>;
};

export const createControlServer = (options: ControlServerOptions): ControlServer => {
    const transport = createControlTransport(options.endpoint);
    const router = createControlRouter({
        deps: options.deps,
        workspaceId: options.workspaceId,
        checkpointProvider: options.checkpointProvider,
    });

    return {
        endpoint: transport.endpoint,
        async start(): Promise<void> {
            await transport.listen((conn) => {
                conn.onLine((line) => {
                    void (async () => {
                        let response: ControlResponse;
                        try {
                            const request = parseControlRequest(line);
                            response = await router.handle(request);
                        } catch (error) {
                            const protocolError =
                                error instanceof ControlProtocolError
                                    ? error
                                    : new ControlProtocolError(
                                          'ERR_CONTROL_BAD_REQUEST',
                                          error instanceof Error ? error.message : String(error),
                                      );
                            response = {
                                id: protocolError.requestId || 'unknown',
                                ok: false,
                                error: {
                                    code: protocolError.code,
                                    message: protocolError.message,
                                    ...(typeof protocolError.details === 'undefined'
                                        ? {}
                                        : { details: protocolError.details }),
                                },
                            };
                        }
                        conn.writeLine(`${encodeControlResponse(response)}\n`);
                    })();
                });
            });
        },
        async close(): Promise<void> {
            await transport.close();
        },
    };
};
