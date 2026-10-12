import type { FilmGifInput } from './contracts';
import { isRecord, isUuid } from './validation';

export function validateFilmGif(payload: unknown): FilmGifInput {
  if (!isRecord(payload) || !isUuid(payload.requestId) || !isUuid(payload.filmId) || !isUuid(payload.partId)
    || typeof payload.startSeconds !== 'number' || !Number.isFinite(payload.startSeconds) || payload.startSeconds < 0
    || typeof payload.endSeconds !== 'number' || !Number.isFinite(payload.endSeconds)
    || payload.endSeconds <= payload.startSeconds || payload.endSeconds - payload.startSeconds > 30
    || typeof payload.width !== 'number' || !Number.isInteger(payload.width) || payload.width < 160 || payload.width > 1280
    || typeof payload.fps !== 'number' || !Number.isInteger(payload.fps) || payload.fps < 5 || payload.fps > 24
    || typeof payload.setAsCover !== 'boolean') throw new Error('INVALID_GIF_INPUT');
  return { requestId: payload.requestId, filmId: payload.filmId, partId: payload.partId,
    startSeconds: payload.startSeconds, endSeconds: payload.endSeconds, width: payload.width,
    fps: payload.fps, setAsCover: payload.setAsCover };
}

export function validateFilmCover(payload: unknown): { filmId: string; assetId: string | null } {
  if (!isRecord(payload) || !isUuid(payload.filmId) || (payload.assetId !== null && !isUuid(payload.assetId))) {
    throw new Error('INVALID_COVER_INPUT');
  }
  return { filmId: payload.filmId, assetId: payload.assetId };
}
