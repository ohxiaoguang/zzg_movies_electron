let activeVideo: { id: string; element: HTMLVideoElement } | null = null;

function releaseElement(element: HTMLVideoElement): void {
  element.pause();
  element.removeAttribute('src');
  element.load();
}

export function claimPreview(id: string, element: HTMLVideoElement): void {
  if (activeVideo && activeVideo.element !== element) {
    releaseElement(activeVideo.element);
  }
  activeVideo = { id, element };
}

export function releasePreview(id: string, element: HTMLVideoElement): void {
  if (activeVideo?.id === id && activeVideo.element === element) activeVideo = null;
  releaseElement(element);
}

export function releaseActivePreview(): void {
  if (!activeVideo) return;
  const current = activeVideo;
  activeVideo = null;
  releaseElement(current.element);
}
