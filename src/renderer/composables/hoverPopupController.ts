export interface HoverPopupControllerOptions {
  openDelay: number;
  closeDelay: number;
  onOpen: () => void;
  onClose: () => void;
}

export interface HoverPopupController {
  enterCard(): void;
  leaveCard(): void;
  enterPopup(): void;
  leavePopup(): void;
  closeNow(): void;
  dispose(): void;
}

export function createHoverPopupController(options: HoverPopupControllerOptions): HoverPopupController {
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearOpen = (): void => {
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
  };
  const clearClose = (): void => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  };
  const scheduleClose = (): void => {
    clearClose();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (!disposed) options.onClose();
    }, options.closeDelay);
  };

  return {
    enterCard() {
      if (disposed) return;
      clearClose();
      clearOpen();
      openTimer = setTimeout(() => {
        openTimer = null;
        if (!disposed) options.onOpen();
      }, options.openDelay);
    },
    leaveCard() {
      if (disposed) return;
      clearOpen();
      scheduleClose();
    },
    enterPopup() {
      if (disposed) return;
      clearClose();
    },
    leavePopup() {
      if (disposed) return;
      scheduleClose();
    },
    closeNow() {
      if (disposed) return;
      clearOpen();
      clearClose();
      options.onClose();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearOpen();
      clearClose();
      options.onClose();
    },
  };
}
