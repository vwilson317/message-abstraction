import { useRef, type MouseEvent, type PointerEvent } from 'react';

const PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/**
 * Long press (touch or mouse) and right-click both call `onLongPress` with
 * where it happened. A press that fires swallows the click that follows, so
 * the row doesn't also open.
 */
export function useLongPress(onLongPress: (point: { x: number; y: number }) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fired = useRef(false);
  const start = useRef({ x: 0, y: 0 });

  const cancel = () => clearTimeout(timer.current);
  const fire = (point: { x: number; y: number }) => {
    if (fired.current) return;
    fired.current = true;
    navigator.vibrate?.(10);
    onLongPress(point);
  };

  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = setTimeout(() => fire(start.current), PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    // Right-click, and the context menu some phones raise on a long press. No click
    // follows a context menu, so this doesn't arm the click guard.
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      cancel();
      if (fired.current) return; // the long-press timer already opened it
      onLongPress({ x: e.clientX, y: e.clientY });
    },
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return;
      e.preventDefault();
      e.stopPropagation();
      fired.current = false;
    },
  };
}
