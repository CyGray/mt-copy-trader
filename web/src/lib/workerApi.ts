const DEFAULT_WORKER_URL = 'http://localhost:4000';

export function getWorkerUrl(): string {
  return process.env.WORKER_URL ?? DEFAULT_WORKER_URL;
}
