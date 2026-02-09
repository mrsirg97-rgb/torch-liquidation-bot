/**
 * logger.ts — simple structured logging with levels.
 */

import type { LogLevel } from './types'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export class Logger {
  private minLevel: number

  constructor(
    private module: string,
    level: LogLevel,
  ) {
    this.minLevel = LEVEL_PRIORITY[level]
  }

  debug(msg: string, data?: Record<string, unknown>) {
    this.log('debug', msg, data)
  }

  info(msg: string, data?: Record<string, unknown>) {
    this.log('info', msg, data)
  }

  warn(msg: string, data?: Record<string, unknown>) {
    this.log('warn', msg, data)
  }

  error(msg: string, data?: Record<string, unknown>) {
    this.log('error', msg, data)
  }

  child(module: string): Logger {
    return new Logger(`${this.module}:${module}`, this.levelName())
  }

  private levelName(): LogLevel {
    const entry = Object.entries(LEVEL_PRIORITY).find(([, v]) => v === this.minLevel)
    return (entry?.[0] ?? 'info') as LogLevel
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (LEVEL_PRIORITY[level] < this.minLevel) return

    const ts = new Date().toISOString()
    const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${this.module}]`

    if (data) {
      const parts = Object.entries(data)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      console.log(`${prefix} ${msg} | ${parts}`)
    } else {
      console.log(`${prefix} ${msg}`)
    }
  }
}
