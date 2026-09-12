import type { Directive } from 'vue';

export interface NumberScrubOptions {
  step?: number;
  pixelsPerStep?: number;
  precision?: number;
  min?: number;
  max?: number;
}

export function scrubbedValue(start: number, deltaX: number, options: NumberScrubOptions) {
  const step = options.step ?? 1,
    pixels = options.pixelsPerStep ?? 4,
    multiplier = step * (deltaX < 0 ? -1 : 1),
    steps = Math.floor(Math.abs(deltaX) / pixels),
    precision = options.precision ?? Math.max(0, String(step).split('.')[1]?.length || 0),
    factor = 10 ** precision,
    raw = Math.round((start + steps * multiplier) * factor) / factor;
  return Math.min(options.max ?? Infinity, Math.max(options.min ?? -Infinity, raw));
}

type ScrubElement = HTMLElement & { __numberScrubOptions?: NumberScrubOptions };

function install(element: ScrubElement) {
  element.classList.add('scrubbable-number');
  element.title ||= '左右拖动调整数值；到屏幕边缘仍可继续；单击可输入，Shift 精细调整';
  element.addEventListener('pointerdown', (down) => {
    const input = element.querySelector('input');
    if (down.button !== 0 || !input || input.disabled || element.classList.contains('is-disabled'))
      return;
    const start = Number(input.value);
    if (!Number.isFinite(start)) return;
    const options = element.__numberScrubOptions || {},
      startX = down.clientX,
      oldCursor = document.body.style.cursor,
      oldSelection = document.body.style.userSelect;
    let dragging = false,
      pointerLocked = false,
      deltaX = 0,
      next = start;

    const releasePointer = () => {
      if (document.pointerLockElement === element) document.exitPointerLock?.();
      pointerLocked = false;
    };
    const requestPointer = () => {
      try {
        const result = element.requestPointerLock?.();
        if (result && typeof (result as Promise<void>).catch === 'function')
          void (result as Promise<void>).catch(() => {});
      } catch {
        // Pointer Lock 受浏览器权限策略影响时，保留普通拖动作为降级路径。
      }
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', cancel, true);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelection;
      element.classList.remove('is-scrubbing');
      releasePointer();
    };
    const render = (value: number) => {
      input.value = value.toFixed(options.precision ?? 0);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      element.dispatchEvent(new CustomEvent('numberscrubinput', { bubbles: true, detail: value }));
    };
    const move = (event: PointerEvent) => {
      if (document.pointerLockElement === element) {
        pointerLocked = true;
        deltaX += event.movementX;
      } else if (!pointerLocked) {
        deltaX = event.clientX - startX;
      }
      const delta = deltaX;
      if (!dragging && Math.abs(delta) < 3) return;
      if (!dragging) {
        dragging = true;
        element.classList.add('is-scrubbing');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        element.dispatchEvent(new CustomEvent('numberscrubstart', { bubbles: true }));
        // 锁定相对位移，避免光标触及屏幕边缘后 clientX 不再增长。
        requestPointer();
      }
      event.preventDefault();
      const adjusted = event.shiftKey ? delta / 10 : delta;
      next = scrubbedValue(start, adjusted, options);
      render(next);
    };
    const end = (event: PointerEvent) => {
      cleanup();
      if (!dragging) return;
      event.preventDefault();
      render(next);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new CustomEvent('numberscrubend', { bubbles: true }));
      const suppressClick = (click: MouseEvent) => {
        click.preventDefault();
        click.stopImmediatePropagation();
      };
      element.addEventListener('click', suppressClick, { capture: true, once: true });
    };
    const cancel = () => {
      cleanup();
      if (dragging) {
        render(start);
        element.dispatchEvent(new CustomEvent('numberscrubend', { bubbles: true }));
      }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', cancel, true);
  });
}

export const numberScrub: Directive<ScrubElement, NumberScrubOptions> = {
  mounted(element, binding) {
    element.__numberScrubOptions = binding.value;
    install(element);
  },
  updated(element, binding) {
    element.__numberScrubOptions = binding.value;
  },
};
