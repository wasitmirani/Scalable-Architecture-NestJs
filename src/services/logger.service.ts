// advanced-file-logger.service.ts
import { Injectable, LoggerService } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { APP_CONSTANTS } from 'src/common/constants/app.constants';

@Injectable()
export class AdvancedFileLogger implements LoggerService {
    private logDir: string;
    private currentDate: string;
    private logStream: fs.WriteStream;

    constructor() {
        this.logDir = path.join(process.cwd(), APP_CONSTANTS.LOG_DIR || 'storage/logs');
        this.ensureLogDirectory();
        this.initializeLogStream();
    }

    private ensureLogDirectory() {
        const dirs = [
            this.logDir,
            path.join(this.logDir, 'error'),
            path.join(this.logDir, 'debug'),
            path.join(this.logDir, 'warn'),
            path.join(this.logDir, 'info'),
            path.join(this.logDir, 'verbose'),
        ];

        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    private getCurrentDate() {
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    private initializeLogStream() {
        this.currentDate = this.getCurrentDate();
        const logFile = path.join(this.logDir, `${APP_CONSTANTS.APP_NAME}-${this.currentDate}.log`);

        if (this.logStream) {
            this.logStream.end();
        }

        this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
    }

    private writeToLog(level: string, message: string, context?: string, type: 'daily' | 'error' | 'debug' | 'warn' | 'info' = 'daily') {
        const currentDate = this.getCurrentDate();

        // Check if date changed, reinitialize stream
        if (currentDate !== this.currentDate) {
            this.initializeLogStream();
        }

        let filePath: string;
        let stream: fs.WriteStream;

        if (type === 'error') {
            filePath = path.join(this.logDir, 'error', `error-${currentDate}.log`);
            stream = fs.createWriteStream(filePath, { flags: 'a' });
        } else if (type === 'debug') {
            filePath = path.join(this.logDir, 'debug', `debug-${currentDate}.log`);
            stream = fs.createWriteStream(filePath, { flags: 'a' });
        } else if (type === 'warn') {
            filePath = path.join(this.logDir, 'warn', `warn-${currentDate}.log`);
            stream = fs.createWriteStream(filePath, { flags: 'a' });
        }
        else if (type === 'info') {
            filePath = path.join(this.logDir, 'info', `info-${currentDate}.log`);
            stream = fs.createWriteStream(filePath, { flags: 'a' });
        }
        else {
            stream = this.logStream;
        }

        const timestamp = new Date().toISOString();
        const contextStr = context ? `[${context}] ` : '';
        const formattedMessage = `[${timestamp}] ${level.toUpperCase()}: ${contextStr}${message}\n`;

        if (type === 'daily') {
            this.logStream.write(formattedMessage);
        } else {
            stream.write(formattedMessage);
            stream.end();
        }
    }

    log(message: any, context?: string) {
        this.writeToLog('INFO', this.formatMessage(message), context, 'info');
    }

    error(message: any, trace?: string, context?: string) {
        const errorMessage = trace
            ? `${this.formatMessage(message)}\nStack Trace: ${trace}`
            : this.formatMessage(message);

        // Write to both daily log and error log
        this.writeToLog('ERROR', errorMessage, context);
        this.writeToLog('ERROR', errorMessage, context, 'error');
    }

    warn(message: any, context?: string) {
        this.writeToLog('WARNING', this.formatMessage(message), context, 'warn');
    }

    debug(message: any, context?: string) {
        this.writeToLog('DEBUG', this.formatMessage(message), context, 'debug');
    }

    verbose(message: any, context?: string) {
        this.writeToLog('VERBOSE', this.formatMessage(message), context);
    }

    private formatMessage(message: any): string {
        if (typeof message === 'object') {
            return JSON.stringify(message, null, 2);
        }

        const APP_TIMEZONE = APP_CONSTANTS.APP_TMEZONE;
        const date = new Date();
        const options: Intl.DateTimeFormatOptions = {
            timeZone: APP_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        };

        try {
            const timestamp = date.toLocaleString('en-US', options);
            return String(message) + " | Timestamp: " + timestamp + " " + APP_TIMEZONE;
        } catch (error) {
            // Fallback to UTC if invalid timezone
            return String(message) + " | Timestamp: " + date.toISOString() + APP_TIMEZONE;
        }
    }
}