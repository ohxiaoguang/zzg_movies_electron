import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

interface AppLoggerOptions {
  redactPaths?: boolean;
}

export class AppLogger {
  private readonly logFile: string;
  private readonly redactPaths: boolean;

  public constructor(private readonly logsDirectory: string, options: AppLoggerOptions = {}) {
    this.redactPaths = options.redactPaths ?? true;
    fs.mkdirSync(logsDirectory, { recursive: true });
    this.logFile = path.join(logsDirectory, 'application.log');
  }

  public info(message: string, details?: Record<string, unknown>): void {
    this.write('info', message, details);
  }

  public warn(message: string, details?: Record<string, unknown>): void {
    this.write('warn', message, details);
  }

  public error(message: string, details?: Record<string, unknown>): void {
    this.write('error', message, details);
  }

  private write(level: LogLevel, message: string, details?: Record<string, unknown>): void {
    const safeDetails = details ? this.sanitizeDetails(details) : undefined;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message,
      ...(safeDetails ? { details: safeDetails } : {}),
    });

    try {
      fs.appendFileSync(this.logFile, `${line}\n`, 'utf8');
    } catch {
      // Logging must never take down the application.
    }
  }

  private sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      if (this.redactPaths && (key.toLowerCase().includes('path') || key.toLowerCase().includes('root'))) {
        result[key] = typeof value === 'string' ? path.basename(value) : '[redacted]';
      } else if (value instanceof Error) {
        result[key] = value.message;
      } else if (typeof value === 'string' && value.length > 500) {
        result[key] = `${value.slice(0, 497)}...`;
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
