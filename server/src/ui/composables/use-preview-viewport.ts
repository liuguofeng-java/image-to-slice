import { onMounted, onBeforeUnmount, ref, type Ref } from 'vue';
import { createCanvasViewportController } from '../services/canvas-viewport.js';

export function usePreviewViewport(viewport: Ref<HTMLElement | undefined>, source: () => { width: number; height: number }, padding = 12) {
  const view = ref({ zoom: 1, contentWidth: 0, contentHeight: 0, left: 0, top: 0 });
  let controller: ReturnType<typeof createCanvasViewportController> | null = null;
  onMounted(() => {
    controller = createCanvasViewportController({ viewport: viewport.value, getSourceSize: source, fitPadding: padding,
      render: (next: typeof view.value) => { view.value = next; } });
  });
  onBeforeUnmount(() => controller?.destroy());
  return { view, fit: () => controller?.fit(), zoom: (direction: number) => controller?.setZoom(view.value.zoom + direction * .1), reset: () => controller?.setZoom(1), forward: (target: Window) => controller?.bindWheelTarget(target) };
}
