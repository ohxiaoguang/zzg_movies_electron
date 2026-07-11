let activeVideo: { id: string; element: HTMLVideoElement } | null = null;

export function claimPreview(id: string, element: HTMLVideoElement): void {
  if (activeVideo && activeVideo.element !== element) {
    activeVideo.element.pause();
    activeVideo.element.removeAttribute('src');
    activeVideo.element.load();
  }
  activeVideo = { id, element };
}

export function releasePreview(id: string, element: HTMLVideoElement): void {
  if (activeVideo?.id === id && activeVideo.element === element) activeVideo = null;
  element.pause();
}

