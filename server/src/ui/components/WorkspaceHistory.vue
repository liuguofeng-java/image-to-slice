<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { usePanelFocus } from '../composables/use-panel-focus';
import { api, jsonRequest } from '../api/client';
import { useWorkspaceStore } from '../stores/workspace';
const emit = defineEmits<{ close: [] }>(), store = useWorkspaceStore();
const panel = ref<HTMLElement>(), noteId = ref(''), noteValue = ref('');
usePanelFocus(panel, () => emit('close'));
const records = ref<{ id: string; note?: string; title?: string; thumbnail?: string; updatedAt: number; sliceCount: number }[]>([]), error = ref(''), busy = ref(false);
async function load() { records.value = (await api('/api/workspace-drafts')).drafts || []; }
async function action(id: string, kind: string) { busy.value = true; error.value = ''; try {
  if (kind === 'restore' || kind === 'duplicate') { if (store.dirty) await store.save(); const result = await api(`/api/workspace-drafts/${id}${kind === 'duplicate' ? '/duplicate' : ''}`, kind === 'duplicate' ? { method: 'POST' } : undefined); await store.restore(result.item.draft, result.item.id); emit('close'); }
  if (kind === 'delete' && confirm('删除这条切图记录？此操作无法撤销。')) { await api(`/api/workspace-drafts/${id}`, { method: 'DELETE' }); if (id === store.draftId) store.draftId = null; await load(); }
  if (kind === 'note') { noteId.value = id; noteValue.value = records.value.find(r => r.id === id)?.note || ''; }
} catch (failure) { error.value = (failure as Error).message; } finally { busy.value = false; } }
onMounted(() => load().catch(failure => { error.value = failure.message; }));
</script>
<template>
<section ref="panel" class="drafts-panel open" tabindex="-1" aria-label="切图记录">
  <header class="drafts-head"><strong>切图记录</strong><div class="drafts-head-actions"><button class="drafts-copy" :disabled="busy || !store.draftId" @click="store.draftId && action(store.draftId, 'duplicate')">创建副本</button><button class="drafts-close" aria-label="关闭切图记录" @click="emit('close')">×</button></div></header>
  <div class="drafts-list"><p v-if="!records.length" class="drafts-empty">还没有切图记录</p><article v-for="record in records" :key="record.id" class="draft-item" :class="{ active: store.draftId === record.id }">
    <button class="draft-item-main" :disabled="busy" :aria-label="'恢复 ' + (record.note || record.title || '未命名记录')" @click="action(record.id, 'restore')"><img class="draft-item-image" :src="record.thumbnail" alt="" /><div class="draft-item-info"><div class="draft-item-title">{{ record.note || record.title || '未命名记录' }}</div><div class="draft-item-meta">{{ record.sliceCount }} 个切图 · {{ new Date(record.updatedAt).toLocaleString() }}</div></div></button>
    <div class="drafts-head-actions"><button class="draft-item-note-edit" :disabled="busy" aria-label="修改备注" @click="action(record.id, 'note')">✎</button><button class="draft-item-delete" :disabled="busy" aria-label="删除记录" @click="action(record.id, 'delete')">×</button></div>
  </article><p v-if="error" class="field-error" role="alert">{{ error }}</p></div>
</section>
<AppModal v-if="noteId" title="修改备注" class="record-note-modal" @close="noteId = ''"><form @submit.prevent="async () => { try { await api('/api/workspace-drafts/' + noteId + '/note', jsonRequest({ note: noteValue })); await load(); noteId = ''; } catch (e) { error = (e as Error).message; } }"><input v-model="noteValue" class="record-note-input" maxlength="80" placeholder="输入自己可见的标题" /><div class="custom-size-actions"><button type="button" @click="noteId = ''">取消</button><button class="confirm" type="submit">确定</button></div></form></AppModal>
</template>
