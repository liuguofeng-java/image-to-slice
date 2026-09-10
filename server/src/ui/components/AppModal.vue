<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
let previous: HTMLElement | null = null;
onMounted(() => { previous = document.activeElement as HTMLElement; dialog.value?.showModal(); });
onBeforeUnmount(() => { dialog.value?.close(); previous?.focus(); });
</script>
<template><dialog ref="dialog" class="app-modal" @cancel.prevent="emit('close')"><header><slot name="header"><h2>{{ title }}</h2><button aria-label="关闭" @click="emit('close')">×</button></slot></header><div class="app-modal-body"><slot /></div><footer v-if="$slots.footer"><slot name="footer" /></footer></dialog></template>
