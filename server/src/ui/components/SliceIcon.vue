<script setup lang="ts">
defineProps<{ kind: 'restore' | 'visible' | 'hidden' | 'cancel' }>();
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="kind === 'restore'"><path d="M9 7H4v-5" /><path d="M4.5 7.5A9 9 0 1 1 3 15" /></template>
    <path v-else-if="kind === 'cancel'" d="M6 6l12 12M18 6L6 18" />
    <template v-else-if="kind === 'hidden'"><path d="M3 3l18 18" /><path d="M10.6 5.2A9.8 9.8 0 0 1 12 5c5.4 0 9 7 9 7a16.7 16.7 0 0 1-2.3 3.2M6.2 6.2C4.1 7.7 3 10 3 12c0 0 3.6 7 9 7 1.4 0 2.7-.5 3.8-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" /></template>
    <template v-else><path d="M3 12s3.6-7 9-7 9 7 9 7-3.6 7-9 7-9-7-9-7Z" /><circle cx="12" cy="12" r="3" /></template>
  </svg>
</template>
