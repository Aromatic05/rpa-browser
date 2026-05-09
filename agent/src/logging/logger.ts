/**
 * Logger：统一 action/record/trace/step 的输出策略。
 *
 * 设计目标：
 * - 统一前缀与输出格式，避免散落的 console.log
 * - 支持按类型控制“终端输出 / 文件输出”
 * - 文件输出为 JSONL，便于后续审计/解析
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RunnerConfig } from '../config';

export type LogType = 'action' | 'record' | 'trace' | 'step' | 'entity' | 'dsl' | 'infra' | 'ext';
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export type Logger = ((...args: unknown[]) => void) & {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warning: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

type LogTarget = {
    consoleEnabled: boolean;
    fileEnabled: boolean;
    filePath: string;
    consoleMinLevel: LogLevel;
    fileMinLevel: LogLevel;
};

let loggerConfig: RunnerConfig | null = null;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const streams = new Map<LogType, fs.WriteStream>();

export const resolveLogPath = (template: string): string => {
    if (template.includes('{ts}')) {return template.replace('{ts}', runId);}
    const ext = path.extname(template);
    const base = ext ? template.slice(0, -ext.length) : template;
    return `${base}-${runId}${ext || '.log'}`;
};

const ensureStream = (type: LogType, filePath: string) => {
    if (streams.has(type)) {return streams.get(type)!;}
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    streams.set(type, stream);
    return stream;
};

const getTarget = (type: LogType): LogTarget => {
    const obs = loggerConfig?.observability;
    if (!obs) {
        return { consoleEnabled: false, fileEnabled: false, filePath: '', consoleMinLevel: 'warning', fileMinLevel: 'warning' };
    }
    const baseLevels = { consoleMinLevel: obs.consoleLogLevel, fileMinLevel: obs.fileLogLevel } as const;
    if (type === 'action') {
        return {
            consoleEnabled: obs.actionConsoleEnabled,
            fileEnabled: obs.actionFileEnabled,
            filePath: resolveLogPath(obs.actionFilePath),
            ...baseLevels,
        };
    }
    if (type === 'record') {
        return {
            consoleEnabled: obs.recordConsoleEnabled,
            fileEnabled: obs.recordFileEnabled,
            filePath: resolveLogPath(obs.recordFilePath),
            ...baseLevels,
        };
    }
    if (type === 'trace') {
        return {
            consoleEnabled: obs.traceConsoleEnabled,
            fileEnabled: obs.traceFileEnabled,
            filePath: resolveLogPath(obs.traceFilePath),
            ...baseLevels,
        };
    }
    if (type === 'entity') {
        return {
            consoleEnabled: obs.entityConsoleEnabled,
            fileEnabled: obs.entityFileEnabled,
            filePath: resolveLogPath(obs.entityFilePath),
            ...baseLevels,
        };
    }
    if (type === 'dsl') {
        return {
            consoleEnabled: obs.dslConsoleEnabled,
            fileEnabled: obs.dslFileEnabled,
            filePath: resolveLogPath(obs.dslFilePath),
            ...baseLevels,
        };
    }
    if (type === 'step') {
        return {
            consoleEnabled: obs.stepConsoleEnabled,
            fileEnabled: obs.stepFileEnabled,
            filePath: resolveLogPath(obs.stepFilePath),
            ...baseLevels,
        };
    }
    if (type === 'infra') {
        return {
            consoleEnabled: obs.infraConsoleEnabled,
            fileEnabled: obs.infraFileEnabled,
            filePath: resolveLogPath(obs.infraFilePath),
            ...baseLevels,
        };
    }
    if (type === 'ext') {
        return {
            consoleEnabled: obs.extConsoleEnabled,
            fileEnabled: obs.extFileEnabled,
            filePath: resolveLogPath(obs.extFilePath),
            ...baseLevels,
        };
    }
    return {
        consoleEnabled: false,
        fileEnabled: false,
        filePath: '',
        consoleMinLevel: 'warning',
        fileMinLevel: 'warning',
    };
};

export const initLogger = (config: RunnerConfig): void => {
    loggerConfig = config;
};

const emit = (type: LogType, level: LogLevel, args: unknown[]) => {
    const target = getTarget(type);
    const levelRank = { debug: 10, info: 20, warning: 30, error: 40 } as const;
    if (target.consoleEnabled && levelRank[level] >= levelRank[target.consoleMinLevel]) {
        if (level === 'error') {
            console.error(`[${type}]`, ...args);
        } else if (level === 'warning') {
            console.warn(`[${type}]`, ...args);
        } else {
            console.warn(`[${type}][${level}]`, ...args);
        }
    }
    if (target.fileEnabled && target.filePath && levelRank[level] >= levelRank[target.fileMinLevel]) {
        const payload = {
            ts: Date.now(),
            type,
            level,
            message: args,
        };
        const line = `${JSON.stringify(payload)}\n`;
        if (level === 'error' && type === 'infra') {
            const dir = path.dirname(target.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.appendFileSync(target.filePath, line);
        } else {
            const stream = ensureStream(type, target.filePath);
            stream.write(line);
        }
    }
};

export const getLogger = (type: LogType): Logger => {
    const logger = ((...args: unknown[]) => {
        emit(type, 'info', args);
    }) as Logger;
    logger.debug = (...args: unknown[]) => {
        emit(type, 'debug', args);
    };
    logger.info = (...args: unknown[]) => {
        emit(type, 'info', args);
    };
    logger.warning = (...args: unknown[]) => {
        emit(type, 'warning', args);
    };
    logger.warn = (...args: unknown[]) => {
        emit(type, 'warning', args);
    };
    logger.error = (...args: unknown[]) => {
        emit(type, 'error', args);
    };
    return logger;
};
