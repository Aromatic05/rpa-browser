export type ControlConnection = {
    writeLine(line: string): void;
    close(): void;
    onLine(handler: (line: string) => void): void;
    onClose(handler: () => void): void;
};

export type ControlTransport = {
    endpoint: string;
    listen(onConnection: (conn: ControlConnection) => void): Promise<void>;
    close(): Promise<void>;
};
