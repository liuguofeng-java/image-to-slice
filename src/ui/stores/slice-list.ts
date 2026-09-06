import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import type { SliceListSnapshot } from '../types/slice-list';

export const useSliceListStore = defineStore('slice-list', () => {
  const snapshot = shallowRef<SliceListSnapshot>({ imageId: '', rows: [], animateReorder: false });
  function replace(next: SliceListSnapshot) {
    snapshot.value = next;
  }
  function updateProgress(id: string, label: string) {
    snapshot.value = { ...snapshot.value, rows: snapshot.value.rows.map(row =>
      row.id === id && row.processing ? { ...row, processingLabel: label } : row) };
  }
  return { snapshot, replace, updateProgress };
});
