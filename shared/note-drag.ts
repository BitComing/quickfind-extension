/**
 * 大纲圆点上的长按拖动。
 *
 * 与 Workflowy 对齐的交互：圆点单击进入专注，按住圆点不动一小段时间才进入拖动；
 * 拖动时用命中测试定位落点行，再按指针在行内的位置切成「上方 / 内部 / 下方」三个投放区。
 *
 * 这里只负责指针这一层——命中测试的根、浮层挂到哪里、落点是否合法、松手后怎么移动节点，
 * 都由调用方通过 options 注入。内容脚本（ShadowRoot）与选项页（document）共用这一份，
 * 免得两边各写一套手感不一致的拖动。
 */

export type NoteDropZone = 'before' | 'inside' | 'after';

export interface NoteDragOptions {
  /** 命中测试的根：内容脚本传 ShadowRoot，选项页传 document。 */
  hitRoot: () => Document | ShadowRoot | null;
  /** 跟随指针的拖动浮层挂到哪：内容脚本传 ShadowRoot，选项页传 document.body。 */
  overlayRoot: () => Node | null;
  /** 可滚动容器；指针贴近它上下边缘时自动滚动。 */
  scrollContainer?: () => HTMLElement | null;
  /** 浮层上显示的文字。 */
  ghostText: (id: string) => string;
  /** 候选落点是否合法——不能落在自己或自己的后代上。 */
  canDropOn: (sourceId: string, targetId: string) => boolean;
  /** 松手且落点合法时提交这次移动。 */
  onDrop: (sourceId: string, targetId: string, zone: NoteDropZone) => void;
  /** 长按判定阈值（毫秒），默认 200。 */
  holdMs?: number;
  /** 长按前的容错位移（像素），超过就当作普通点击或选择，默认 6。 */
  moveTolerance?: number;
}

export interface NoteDragController {
  /** 在圆点上 pointerdown 时调用，之后由控制器接管指针。 */
  press: (event: PointerEvent, id: string, row: HTMLElement, bullet: HTMLElement) => void;
  /** 刚结束一次拖动后返回 true——调用方据此忽略随之而来的 click。 */
  shouldIgnoreClick: () => boolean;
  /** 卸载监听与残留节点。 */
  dispose: () => void;
}

/** ShadowRoot 是否带命中测试随浏览器而异，按可选方法探测，不硬写死。 */
interface HitTestRoot {
  elementFromPoint?: (x: number, y: number) => Element | null;
  getSelection?: () => Selection | null;
}

interface PressState {
  id: string;
  row: HTMLElement;
  bullet: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  timer: number;
}

interface DragState {
  id: string;
  row: HTMLElement;
  bullet: HTMLElement;
  pointerId: number;
  ghost: HTMLElement;
  list: HTMLElement | null;
  x: number;
  y: number;
  frame: number;
  targetId: string | null;
  zone: NoteDropZone;
  indicator: HTMLElement | null;
}

const ROW_SELECTOR = '.note-row';
const ZONE_BEFORE = 'drag-target-before';
const ZONE_INSIDE = 'drag-target-inside';
const ZONE_AFTER = 'drag-target-after';
const ZONE_CLASSES = [ZONE_BEFORE, ZONE_INSIDE, ZONE_AFTER];
/** 指针进入距滚动容器边缘这么多像素时开始自动滚动。 */
const EDGE_PADDING = 26;
/** 拖动刚结束时按下的那一下 click 不该被当成「专注」。 */
const CLICK_GUARD_MS = 400;
const RATIO_BEFORE = 0.28;
const RATIO_AFTER = 0.72;

export function createNoteDrag(options: NoteDragOptions): NoteDragController {
  const holdMs = options.holdMs ?? 200;
  const tolerance = options.moveTolerance ?? 6;
  let press: PressState | null = null;
  let drag: DragState | null = null;
  let clickGuardUntil = 0;
  let listening = false;

  function probeRoot(): HitTestRoot | null {
    return (options.hitRoot() as unknown as HitTestRoot | null) ?? null;
  }

  function hitTest(x: number, y: number): Element | null {
    const root = probeRoot();
    if (!root) return null;
    const probe = root.elementFromPoint;
    return typeof probe === 'function' ? probe.call(root, x, y) : null;
  }

  function rowAt(x: number, y: number): HTMLElement | null {
    const row = hitTest(x, y)?.closest(ROW_SELECTOR);
    return row instanceof HTMLElement ? row : null;
  }

  /** 进入拖动后清掉这次按下可能带出来的文字选择。 */
  function clearSelection(): void {
    const root = probeRoot();
    const reader = root && root.getSelection;
    const scoped = typeof reader === 'function' && root ? reader.call(root) : null;
    (scoped || window.getSelection())?.removeAllRanges();
  }

  function clearIndicator(state: DragState | null): void {
    if (!state) return;
    const element = state.indicator;
    state.indicator = null;
    if (element) ZONE_CLASSES.forEach((className) => element.classList.remove(className));
  }

  function positionGhost(state: DragState): void {
    state.ghost.style.left = state.x + 12 + 'px';
    state.ghost.style.top = state.y - 12 + 'px';
  }

  function updateIndicator(state: DragState): void {
    const row = rowAt(state.x, state.y);
    const targetId = row ? row.dataset.noteId ?? null : null;
    if (!row || !targetId || !options.canDropOn(state.id, targetId)) {
      clearIndicator(state);
      state.targetId = null;
      return;
    }
    const rect = row.getBoundingClientRect();
    const ratio = (state.y - rect.top) / Math.max(1, rect.height);
    const zone: NoteDropZone = ratio < RATIO_BEFORE ? 'before' : ratio > RATIO_AFTER ? 'after' : 'inside';
    if (state.indicator === row && state.targetId === targetId && state.zone === zone) return;
    clearIndicator(state);
    row.classList.add(zone === 'before' ? ZONE_BEFORE : zone === 'inside' ? ZONE_INSIDE : ZONE_AFTER);
    state.indicator = row;
    state.targetId = targetId;
    state.zone = zone;
  }

  /** 指针停在边缘不动时也要继续滚，所以用 rAF 循环，而不是只在 pointermove 里滚。 */
  function tick(): void {
    const state = drag;
    if (!state) return;
    const scroller = options.scrollContainer?.() ?? null;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      let delta = 0;
      if (state.y < rect.top + EDGE_PADDING) delta = -Math.max(2, Math.round((rect.top + EDGE_PADDING - state.y) / 3));
      else if (state.y > rect.bottom - EDGE_PADDING) delta = Math.max(2, Math.round((state.y - rect.bottom + EDGE_PADDING) / 3));
      if (delta) {
        scroller.scrollTop += delta;
        updateIndicator(state);
      }
    }
    state.frame = window.requestAnimationFrame(tick);
  }

  function startDrag(state: PressState): void {
    const ghost = document.createElement('div');
    ghost.className = 'note-drag-ghost';
    ghost.textContent = options.ghostText(state.id);
    options.overlayRoot()?.appendChild(ghost);
    const list = state.row.parentElement;
    state.row.classList.add('dragging');
    state.bullet.classList.add('is-armed');
    list?.classList.add('is-dragging');
    const next: DragState = {
      id: state.id,
      row: state.row,
      bullet: state.bullet,
      pointerId: state.pointerId,
      ghost,
      list,
      x: state.startX,
      y: state.startY,
      frame: 0,
      targetId: null,
      zone: 'after',
      indicator: null
    };
    drag = next;
    clearSelection();
    positionGhost(next);
    updateIndicator(next);
    next.frame = window.requestAnimationFrame(tick);
  }

  function attach(): void {
    if (listening) return;
    listening = true;
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
  }

  function detach(): void {
    if (!listening) return;
    listening = false;
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);
  }

  function cancelPress(): void {
    if (press) window.clearTimeout(press.timer);
    press = null;
    if (!drag) detach();
  }

  function finishDrag(): void {
    const state = drag;
    drag = null;
    detach();
    if (!state) return;
    if (state.frame) window.cancelAnimationFrame(state.frame);
    clearIndicator(state);
    state.ghost.remove();
    state.row.classList.remove('dragging');
    state.bullet.classList.remove('is-armed');
    state.list?.classList.remove('is-dragging');
    clickGuardUntil = performance.now() + CLICK_GUARD_MS;
    if (state.targetId) options.onDrop(state.id, state.targetId, state.zone);
  }

  function onPointerMove(event: PointerEvent): void {
    const active = drag;
    if (active && event.pointerId === active.pointerId) {
      active.x = event.clientX;
      active.y = event.clientY;
      positionGhost(active);
      updateIndicator(active);
      return;
    }
    const pending = press;
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (Math.abs(event.clientX - pending.startX) > tolerance || Math.abs(event.clientY - pending.startY) > tolerance) cancelPress();
  }

  function onPointerUp(event: PointerEvent): void {
    const active = drag;
    if (active && event.pointerId === active.pointerId) { finishDrag(); return; }
    const pending = press;
    if (pending && event.pointerId === pending.pointerId) cancelPress();
  }

  function beginPress(event: PointerEvent, id: string, row: HTMLElement, bullet: HTMLElement): void {
    if (drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
    cancelPress();
    const state: PressState = { id, row, bullet, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, timer: 0 };
    state.timer = window.setTimeout(() => {
      if (press !== state) return;
      press = null;
      startDrag(state);
    }, holdMs);
    press = state;
    attach();
  }

  return {
    press: beginPress,
    shouldIgnoreClick: () => performance.now() < clickGuardUntil,
    dispose(): void {
      if (press) window.clearTimeout(press.timer);
      press = null;
      const state = drag;
      drag = null;
      if (state) {
        if (state.frame) window.cancelAnimationFrame(state.frame);
        clearIndicator(state);
        state.ghost.remove();
        state.row.classList.remove('dragging');
        state.bullet.classList.remove('is-armed');
        state.list?.classList.remove('is-dragging');
      }
      detach();
    }
  };
}
