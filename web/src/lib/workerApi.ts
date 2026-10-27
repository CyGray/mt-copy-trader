const DEFAULT_WORKER_URL = 'http://localhost:4000';

export function getWorkerUrl(): string {
  return process.env.WORKER_URL ?? DEFAULT_WORKER_URL;
}

/** Adds the shared worker bearer token when WORKER_API_TOKEN is configured. */
export function workerHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = process.env.WORKER_API_TOKEN;
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}
