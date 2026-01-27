type LogLevel = 'info' | 'warn' | 'error';

type LogPayload = Record<string, unknown>;

export const logger = {
  info(event: string, payload: LogPayload = {}) {
    log('info', event, payload);
  },
  warn(event: string, payload: LogPayload = {}) {
    log('warn', event, payload);
  },
  error(event: string, payload: LogPayload = {}) {
    log('error', event, payload);
  },
};

function log(level: LogLevel, event: string, payload: LogPayload) {
  const entry = {
    level,
    event,
    payload,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(entry));
}
