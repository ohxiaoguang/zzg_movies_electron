type PopupCloser = () => void;

let activePopup: { id: string; close: PopupCloser } | null = null;

export function claimHoverPopup(id: string, close: PopupCloser): void {
  const previous = activePopup;
  activePopup = null;
  if (previous && previous.close !== close) previous.close();
  activePopup = { id, close };
}

export function releaseHoverPopup(id: string, close: PopupCloser): void {
  if (activePopup?.id === id && activePopup.close === close) activePopup = null;
}

export function closeAllHoverPopups(): void {
  const current = activePopup;
  activePopup = null;
  current?.close();
}
