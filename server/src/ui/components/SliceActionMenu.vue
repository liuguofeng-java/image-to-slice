<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
defineProps<{ label: string; disabled?: boolean }>();
const menu = ref<HTMLDetailsElement>();
const list = ref<HTMLDivElement>();
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
async function toggle() {
  await nextTick();
  if (disposed || !menu.value || !list.value) return;
  const host = menu.value.closest('#cutGrid');
  host?.classList.toggle('menu-open', Boolean(host.querySelector('details[open]')));
  if (!menu.value.open) return;
  host?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(other => {
    if (other !== menu.value) other.open = false;
  });
  const rect = menu.value.getBoundingClientRect();
  const bounds = list.value.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 12));
  const top = rect.bottom + 6 + bounds.height > window.innerHeight - 12 ? rect.top - bounds.height - 6 : rect.bottom + 6;
  list.value.style.setProperty('--cut-action-list-left', `${left}px`);
  list.value.style.setProperty('--cut-action-list-top', `${Math.max(12, top)}px`);
}
function closeOnAction(event: MouseEvent) {
  if ((event.target as Element).closest('button') && menu.value) menu.value.open = false;
}
</script>

<template>
  <details ref="menu" class="cut-action-menu" @click.stop="closeOnAction" @toggle="toggle">
    <summary class="cut-action-trigger" :aria-disabled="disabled" @click="disabled && $event.preventDefault()">{{ label }}</summary>
    <div ref="list" class="cut-action-list"><slot /></div>
  </details>
</template>
