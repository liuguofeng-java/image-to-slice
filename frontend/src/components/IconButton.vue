<script setup lang="ts">
import type { Component } from 'vue';
defineProps<{ label: string; icon?: Component; active?: boolean; disabled?: boolean }>();
defineOptions({ inheritAttrs: false });
const emit = defineEmits<{ click: [event: MouseEvent] }>();
</script>
<template>
  <el-tooltip :content="label" :show-after="500" placement="bottom"
    ><button
      v-bind="$attrs"
      type="button"
      class="icon-button"
      :class="{ active }"
      :aria-label="label"
      :title="label"
      :disabled="disabled"
      @click="emit('click', $event)"
    >
      <el-icon v-if="icon" :size="17"><component :is="icon" /></el-icon><slot v-else /></button
  ></el-tooltip>
</template>
