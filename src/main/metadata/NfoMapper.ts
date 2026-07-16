import type { NfoMetadata } from './NfoParser';

export interface MappedNfoFields {
  title: string;
  originalTitle: string | null;
  sortTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  runtimeSeconds: number | null;
  plot: string | null;
  outline: string | null;
  tagline: string | null;
  contentRating: string | null;
  studio: string | null;
  countries: string[];
  directors: string[];
  actors: string[];
  tags: string[];
  rating: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  containerFormat: string | null;
}

export function mapNfoMetadata(metadata: NfoMetadata | null, fallbackTitle: string): MappedNfoFields {
  return {
    title: metadata?.title ?? fallbackTitle,
    originalTitle: metadata?.originalTitle ?? null,
    sortTitle: metadata?.sortTitle ?? metadata?.title ?? fallbackTitle,
    year: metadata?.year ?? null,
    releaseDate: metadata?.releaseDate ?? null,
    runtimeSeconds: metadata?.runtimeSeconds ?? null,
    plot: metadata?.plot ?? null,
    outline: metadata?.outline ?? null,
    tagline: metadata?.tagline ?? null,
    contentRating: metadata?.contentRating ?? null,
    studio: metadata?.studio ?? null,
    countries: metadata?.countries ?? [],
    directors: metadata?.directors ?? [],
    actors: metadata?.actors ?? [],
    tags: metadata?.tags ?? [],
    rating: metadata?.userRating ?? metadata?.rating ?? 0,
    width: metadata?.width ?? null,
    height: metadata?.height ?? null,
    videoCodec: metadata?.videoCodec ?? null,
    audioCodec: metadata?.audioCodec ?? null,
    containerFormat: metadata?.containerFormat ?? null,
  };
}
