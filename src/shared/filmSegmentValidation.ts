import type {
  FilmSegmentCreateInput,
  FilmSegmentDeleteInput,
  FilmSegmentUpdateInput,
} from './contracts';
import { isRecord, isUuid } from './validation';

const MAX_SECONDS = 31 * 24 * 60 * 60;

export function validateFilmSegmentCreate(payload: unknown): FilmSegmentCreateInput {
  if (!isRecord(payload) || !isUuid(payload.filmId) || !isUuid(payload.filmFileId)) {
    throw new Error('INVALID_FILM_SEGMENT');
  }
  const startSeconds = segmentSeconds(payload.startSeconds);
  const endSeconds = segmentSeconds(payload.endSeconds);
  if (endSeconds <= startSeconds) throw new Error('INVALID_FILM_SEGMENT_RANGE');
  return {
    filmId: payload.filmId,
    filmFileId: payload.filmFileId,
    startSeconds,
    endSeconds,
    ...(payload.title === undefined ? {} : { title: segmentText(payload.title, 500) }),
    ...(payload.comment === undefined ? {} : { comment: segmentText(payload.comment, 10_000) }),
    ...(payload.includeInPreview === undefined ? {} : { includeInPreview: segmentBoolean(payload.includeInPreview) }),
  };
}

export function validateFilmSegmentUpdate(payload: unknown): FilmSegmentUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_SEGMENT');
  const input: FilmSegmentUpdateInput = { id: payload.id };
  if (payload.startSeconds !== undefined) input.startSeconds = segmentSeconds(payload.startSeconds);
  if (payload.endSeconds !== undefined) input.endSeconds = segmentSeconds(payload.endSeconds);
  if (payload.title !== undefined) input.title = segmentText(payload.title, 500);
  if (payload.comment !== undefined) input.comment = segmentText(payload.comment, 10_000);
  if (payload.includeInPreview !== undefined) input.includeInPreview = segmentBoolean(payload.includeInPreview);
  if (Object.keys(input).length === 1) throw new Error('INVALID_FILM_SEGMENT');
  return input;
}

export function validateFilmSegmentDelete(payload: unknown): FilmSegmentDeleteInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_SEGMENT');
  return { id: payload.id };
}

function segmentSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) {
    throw new Error('INVALID_FILM_SEGMENT_RANGE');
  }
  return Math.round(value * 1000) / 1000;
}

function segmentText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new Error('INVALID_FILM_SEGMENT');
  return value.trim().slice(0, maximum);
}

function segmentBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('INVALID_FILM_SEGMENT');
  return value;
}
