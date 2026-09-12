import type { Asset, Document, Project, ModelConfig, Rect, Candidate, Job } from './types';
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3002').replace(
  /\/$/,
  '',
);
/** 独立 HTTP 客户端；DTO 只从本前端 types 引入，不依赖后端实现。 */
export async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(API_BASE + path, {
    method,
    signal,
    // 无请求体时不要发送 JSON Content-Type，否则 Fastify 会拒绝空 JSON body。
    // FormData 由浏览器自动生成 multipart boundary，不能手动覆盖。
    headers:
      body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(data.error || `请求失败 ${r.status}`), { status: r.status });
  return data;
}
export const api = {
  health: () => request<{ status: string }>('/health'),
  list: () =>
    request<{ projects: Pick<Project, 'id' | 'name' | 'revision' | 'updatedAt'>[] }>(
      '/api/v1/projects',
    ),
  create: (name: string) => request<Project>('/api/v1/projects', 'POST', { name }),
  open: (id: string) => request<Project>('/api/v1/projects/' + id),
  save: (id: string, revision: number, document: Document) =>
    request<Project>('/api/v1/projects/' + id, 'PUT', { revision, document }),
  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Asset>('/api/v1/assets', 'POST', form);
  },
  asset: (id: string) => request<Asset>('/api/v1/assets/' + id),
  config: () => request<{ config: ModelConfig | null }>('/api/v1/model-configs'),
  saveConfig: (c: ModelConfig) =>
    request<{ config: ModelConfig }>('/api/v1/model-configs', 'PUT', c),
  models: (signal?: AbortSignal) =>
    request<{ models: string[] }>('/api/v1/model-configs/models', 'POST', undefined, signal),
  test: (signal?: AbortSignal) =>
    request<{ status: string }>('/api/v1/model-configs/test', 'POST', undefined, signal),
  split: (body: {
    projectId: string;
    sceneId: string;
    layerId: string;
    region: Rect;
    manual: boolean;
  }) => request<{ id: string; status: string }>('/api/v1/split-jobs', 'POST', body),
  job: (id: string) => request<Job>('/api/v1/split-jobs/' + id),
  cancel: (id: string) => request('/api/v1/split-jobs/' + id, 'DELETE'),
  apply: (id: string, revision: number, operationId: string, candidates: Candidate[]) =>
    request<Project>('/api/v1/split-jobs/' + id + '/apply', 'POST', {
      revision,
      operationId,
      candidates,
    }),
};
export const imageUrl = (id: string) => API_BASE + '/api/v1/assets/' + id + '/image';
export async function download(body: {
  projectId: string;
  sceneId: string;
  kind: 'png' | 'zip' | 'scene';
  layerIds: string[];
}) {
  const r = await fetch(API_BASE + '/api/v1/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).error);
  const url = URL.createObjectURL(await r.blob()),
    a = document.createElement('a');
  a.href = url;
  a.download =
    body.kind === 'zip' ? 'slices.zip' : body.kind === 'scene' ? 'scene.png' : 'slice.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
