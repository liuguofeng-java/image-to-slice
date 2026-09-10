import { onMounted, onBeforeUnmount, type Ref } from 'vue';

// Non-modal floating panels retain access to the canvas and return focus on close.
export function usePanelFocus(element: Ref<HTMLElement | undefined>, close: () => void) {
  let previous: HTMLElement | null = null;
  function key(event: KeyboardEvent) {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    event.preventDefault(); event.stopPropagation(); close();
  }
  onMounted(() => { previous = document.activeElement as HTMLElement; element.value?.focus({ preventScroll: true }); element.value?.addEventListener('keydown', key); });
  onBeforeUnmount(() => { element.value?.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus({ preventScroll: true }); });
}
