const canvasViewportUtils = typeof require === "function"
  ? require("./app-utils")
  : {
      calculatePreviewFitZoom,
      calculatePreviewPlacement,
      clampPreviewZoom
    };

function calculateAnchoredCanvasScroll({
  scrollLeft = 0,
  scrollTop = 0,
  anchorX = 0,
  anchorY = 0,
  previousZoom = 1,
  nextZoom = 1,
  previousLeft = 0,
  previousTop = 0,
  nextLeft = 0,
  nextTop = 0
}) {
  const safePreviousZoom = Math.max(0.0001, Number(previousZoom) || 1);
  const safeNextZoom = Math.max(0.0001, Number(nextZoom) || 1);
  const resolvedAnchorX = Number(anchorX) || 0;
  const resolvedAnchorY = Number(anchorY) || 0;
  const sourceX = (
    (Number(scrollLeft) || 0) + resolvedAnchorX - (Number(previousLeft) || 0)
  ) / safePreviousZoom;
  const sourceY = (
    (Number(scrollTop) || 0) + resolvedAnchorY - (Number(previousTop) || 0)
  ) / safePreviousZoom;
  return {
    left: Math.max(
      0,
      sourceX * safeNextZoom + (Number(nextLeft) || 0) - resolvedAnchorX
    ),
    top: Math.max(
      0,
      sourceY * safeNextZoom + (Number(nextTop) || 0) - resolvedAnchorY
    )
  };
}

function calculateWheelZoom(zoom, deltaY, deltaMode = 0, viewportHeight = 0) {
  const currentZoom = Math.max(0.0001, Number(zoom) || 1);
  const rawDelta = Number(deltaY) || 0;
  const pixelDelta = deltaMode === 1
    ? rawDelta * 16
    : deltaMode === 2
      ? rawDelta * Math.max(1, Number(viewportHeight) || 1)
      : rawDelta;
  const limitedDelta = Math.max(-160, Math.min(160, pixelDelta));
  return currentZoom * Math.exp(-limitedDelta * 0.0016);
}

function createCanvasViewportController({
  viewport,
  controls = null,
  getSourceSize,
  render,
  onViewChange = () => {},
  fitPadding = 0,
  resizeObserverFactory = typeof ResizeObserver === "undefined"
    ? null
    : (callback) => new ResizeObserver(callback)
}) {
  if (!viewport || typeof getSourceSize !== "function" || typeof render !== "function") {
    throw new Error("Canvas viewport requires viewport, getSourceSize, and render");
  }

  let zoom = 1;
  let mode = "fit";
  let lastView = null;
  let wheelTarget = null;
  let panEventTarget = null;
  let panState = null;
  let panOffsetX = 0;
  let panOffsetY = 0;
  let destroyed = false;

  function getSource() {
    const source = getSourceSize() || {};
    return {
      width: Math.max(0, Number(source.width) || 0),
      height: Math.max(0, Number(source.height) || 0)
    };
  }

  function updateControls() {
    if (!controls) return;
    const valueButton = controls.querySelector('[data-canvas-zoom="reset"]');
    const outButton = controls.querySelector('[data-canvas-zoom="out"]');
    const inButton = controls.querySelector('[data-canvas-zoom="in"]');
    const fitButton = controls.querySelector('[data-canvas-zoom="fit"]');
    if (valueButton) valueButton.textContent = `${Math.round(zoom * 100)}%`;
    if (outButton) outButton.disabled = zoom <= 0.1;
    if (inButton) inButton.disabled = zoom >= 4;
    fitButton?.classList.toggle("active", mode === "fit");
  }

  function renderCurrentView() {
    const source = getSource();
    const contentWidth = source.width * zoom;
    const contentHeight = source.height * zoom;
    const placement = canvasViewportUtils.calculatePreviewPlacement({
      contentWidth,
      contentHeight,
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight
    });
    lastView = {
      zoom,
      mode,
      contentWidth,
      contentHeight,
      left: placement.left + panOffsetX,
      top: placement.top + panOffsetY
    };
    render(lastView);
    updateControls();
    onViewChange(lastView);
    return lastView;
  }

  function setZoom(value, anchor = null) {
    if (destroyed) return;
    const previousView = lastView || renderCurrentView();
    const previousZoom = zoom;
    const nextZoom = canvasViewportUtils.clampPreviewZoom(value);
    if (Math.abs(nextZoom - previousZoom) < 0.0001) return;
    const resolvedAnchor = anchor || {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2
    };
    const previousScrollLeft = viewport.scrollLeft;
    const previousScrollTop = viewport.scrollTop;
    zoom = nextZoom;
    mode = "manual";
    const nextView = renderCurrentView();
    const scroll = calculateAnchoredCanvasScroll({
      scrollLeft: previousScrollLeft,
      scrollTop: previousScrollTop,
      anchorX: resolvedAnchor.x,
      anchorY: resolvedAnchor.y,
      previousZoom,
      nextZoom,
      previousLeft: previousView.left,
      previousTop: previousView.top,
      nextLeft: nextView.left,
      nextTop: nextView.top
    });
    viewport.scrollLeft = scroll.left;
    viewport.scrollTop = scroll.top;
  }

  function fit() {
    if (destroyed) return;
    const source = getSource();
    mode = "fit";
    panOffsetX = 0;
    panOffsetY = 0;
    zoom = canvasViewportUtils.calculatePreviewFitZoom(
      source.width,
      source.height,
      Math.max(1, viewport.clientWidth - fitPadding * 2),
      Math.max(1, viewport.clientHeight - fitPadding * 2)
    );
    renderCurrentView();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }

  function refresh() {
    if (destroyed) return;
    if (mode === "fit") {
      fit();
      return;
    }
    renderCurrentView();
  }

  function handleWheel(event) {
    const forwarded = wheelTarget !== viewport;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const anchor = forwarded
      ? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
      : {
          x: (Number(event.clientX) || rect.left + rect.width / 2) - rect.left,
          y: (Number(event.clientY) || rect.top + rect.height / 2) - rect.top
        };
    setZoom(
      calculateWheelZoom(zoom, event.deltaY, event.deltaMode, viewport.clientHeight),
      anchor
    );
  }

  function finishPan() {
    if (!panState) return;
    panEventTarget?.removeEventListener("mousemove", handlePanMove, true);
    panEventTarget?.removeEventListener("mouseup", handlePanEnd, true);
    panEventTarget?.removeEventListener("blur", handlePanEnd, true);
    viewport.classList.remove("canvas-panning");
    panEventTarget = null;
    panState = null;
  }

  function handlePanMove(event) {
    if (!panState) return;
    event.preventDefault();
    panOffsetX = panState.offsetX + ((Number(event.clientX) || 0) - panState.x);
    panOffsetY = panState.offsetY + ((Number(event.clientY) || 0) - panState.y);
    mode = "manual";
    renderCurrentView();
  }

  function handlePanEnd(event) {
    if (event?.button != null && event.button !== 1) return;
    event?.preventDefault?.();
    finishPan();
  }

  function handlePanStart(event) {
    if (event.button !== 1) return;
    event.preventDefault();
    finishPan();
    panState = {
      x: Number(event.clientX) || 0,
      y: Number(event.clientY) || 0,
      offsetX: panOffsetX,
      offsetY: panOffsetY
    };
    panEventTarget = wheelTarget || viewport.ownerDocument?.defaultView || window;
    viewport.classList.add("canvas-panning");
    panEventTarget.addEventListener("mousemove", handlePanMove, true);
    panEventTarget.addEventListener("mouseup", handlePanEnd, true);
    panEventTarget.addEventListener("blur", handlePanEnd, true);
  }

  function handleAuxClick(event) {
    if (event.button === 1) event.preventDefault();
  }

  function bindWheelTarget(target = viewport) {
    wheelTarget?.removeEventListener("wheel", handleWheel);
    wheelTarget?.removeEventListener("mousedown", handlePanStart);
    wheelTarget?.removeEventListener("auxclick", handleAuxClick);
    finishPan();
    wheelTarget = target || viewport;
    wheelTarget.addEventListener("wheel", handleWheel, { passive: false });
    wheelTarget.addEventListener("mousedown", handlePanStart, { passive: false });
    wheelTarget.addEventListener("auxclick", handleAuxClick, { passive: false });
  }

  function handleControlsClick(event) {
    const button = event.target.closest("[data-canvas-zoom]");
    if (!button || !controls.contains(button)) return;
    const action = button.dataset.canvasZoom;
    if (action === "out") setZoom(zoom - 0.1);
    if (action === "reset") setZoom(1);
    if (action === "in") setZoom(zoom + 0.1);
    if (action === "fit") fit();
  }

  function handleKeydown(event) {
    if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const key = String(event.key || "").toLowerCase();
    if (!["+", "=", "-", "_", "0", "f"].includes(key)) return;
    event.preventDefault();
    if (key === "+" || key === "=") setZoom(zoom + 0.1);
    if (key === "-" || key === "_") setZoom(zoom - 0.1);
    if (key === "0") setZoom(1);
    if (key === "f") fit();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    finishPan();
    wheelTarget?.removeEventListener("wheel", handleWheel);
    wheelTarget?.removeEventListener("mousedown", handlePanStart);
    wheelTarget?.removeEventListener("auxclick", handleAuxClick);
    controls?.removeEventListener("click", handleControlsClick);
    viewport.removeEventListener("keydown", handleKeydown);
    resizeObserver?.disconnect();
    wheelTarget = null;
  }

  controls?.addEventListener("click", handleControlsClick);
  viewport.addEventListener("keydown", handleKeydown);
  bindWheelTarget(viewport);
  const resizeObserver = resizeObserverFactory ? resizeObserverFactory(refresh) : null;
  resizeObserver?.observe(viewport);
  fit();

  return {
    bindWheelTarget,
    destroy,
    fit,
    getState: () => ({ zoom, mode, panX: panOffsetX, panY: panOffsetY }),
    refresh,
    setZoom
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    calculateAnchoredCanvasScroll,
    calculateWheelZoom,
    createCanvasViewportController
  };
}
