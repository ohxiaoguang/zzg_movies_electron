export {
  ElectronFilmLibraryClient,
  HttpFilmLibraryClient,
  filmLibraryClient,
  type FilmLibraryClient,
} from './FilmLibraryClient';

export function mediaUrl(kind: 'asset' | 'preview' | 'poster' | 'part' | 'original-part', id: string): string {
  return `film-media://${kind}/${encodeURIComponent(id)}`;
}
