export interface PopupAnchorRect {
  left: number;
  right: number;
  top: number;
}

export interface PopupViewport {
  width: number;
  height: number;
}

export interface PopupSize {
  width: number;
  height: number;
}

export interface PopupPosition {
  left: number;
  top: number;
}

export function calculatePopupPosition(
  anchor: PopupAnchorRect,
  popup: PopupSize,
  viewport: PopupViewport,
  gap = 14,
  padding = 12,
): PopupPosition {
  const rightCandidate = anchor.right + gap;
  const leftCandidate = anchor.left - gap - popup.width;
  let left = rightCandidate + popup.width <= viewport.width - padding
    ? rightCandidate
    : leftCandidate;
  left = Math.max(padding, Math.min(left, Math.max(padding, viewport.width - popup.width - padding)));

  const bottomLimit = Math.max(padding, viewport.height - popup.height - padding);
  const top = Math.max(padding, Math.min(anchor.top, bottomLimit));
  return { left, top };
}
