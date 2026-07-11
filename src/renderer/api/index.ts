export function mediaUrl(kind: 'asset' | 'preview' | 'poster', id: string): string {
  return `film-media://${kind}/${encodeURIComponent(id)}`;
}
