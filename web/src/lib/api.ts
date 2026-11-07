export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Something went wrong', data.code);
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

type Listener = (e: any) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;

/** One shared live stream. The browser reconnects it automatically. */
export function onLive(fn: Listener) {
  source ??= Object.assign(new EventSource('/api/events'), {
    onmessage: (m: MessageEvent) => { const e = JSON.parse(m.data); listeners.forEach((l) => l(e)); },
  });
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const closeLive = () => { source?.close(); source = undefined; };
