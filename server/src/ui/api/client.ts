export const fetchBackend = (path: string, init?: RequestInit) => {
  if (!path.startsWith('/api/') && path !== '/health') throw new Error('无效的本地 API 路径');
  return fetch(path, init);
};
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchBackend(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload as T;
}
export const jsonRequest = (payload: unknown, signal?: AbortSignal, method = 'POST'): RequestInit => ({
  method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
});
export function pollProgress(id: string, update: (message: string) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  async function poll() {
    try { const result = await api(`/api/progress/${encodeURIComponent(id)}`); if (!stopped) update(result.progress?.message || result.message || result.progress?.label || '处理中…'); } catch { /* A progress endpoint must not fail the owning task. */ }
    if (!stopped) timer = setTimeout(poll, 1000);
  }
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
