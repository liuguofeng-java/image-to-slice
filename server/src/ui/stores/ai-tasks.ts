import { computed, onScopeDispose, shallowRef } from 'vue';
import { defineStore } from 'pinia';

export interface AiTaskRequest {
  controller: AbortController;
  progressId: string;
  blocksUi: boolean;
}

export const useAiTasksStore = defineStore('ai-tasks', () => {
  // Controllers are deliberately outside reactive/persistable state. Only IDs
  // are observable; promises and abort signals must never enter a draft.
  const requests = new Map<string, AiTaskRequest>();
  const runningIds = shallowRef<string[]>([]);
  const size = computed(() => runningIds.value.length);
  const publish = () => { runningIds.value = [...requests.keys()]; };
  function begin(id: string, progressId: string, blocksUi = false) {
    requests.get(id)?.controller.abort();
    const controller = new AbortController();
    requests.set(id, { controller, progressId, blocksUi });
    publish();
    return controller;
  }
  function get(id: string) { return requests.get(id); }
  function finish(id: string, controller: AbortController) {
    if (requests.get(id)?.controller !== controller) return false;
    requests.delete(id);
    publish();
    return true;
  }
  function abortAll() {
    const active = [...requests.values()];
    requests.clear();
    publish();
    active.forEach(request => request.controller.abort());
  }
  onScopeDispose(abortAll);
  return { runningIds, size, begin, get, finish, abortAll };
});
