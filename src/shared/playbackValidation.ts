import type { WebPlaybackProgressInput, WebPlaybackSessionCreateInput } from './contracts';
import { isRecord, isUuid } from './validation';

export function validatePlaybackSessionCreate(payload: unknown): WebPlaybackSessionCreateInput {
  if (!isRecord(payload)) throw new Error('INVALID_PLAYBACK_REQUEST');
  const filmId = payload.filmId;
  const partId = payload.partId;
  const hasFilm = filmId !== undefined;
  const hasPart = partId !== undefined;
  if (hasFilm === hasPart) throw new Error('INVALID_PLAYBACK_REQUEST');
  if (hasFilm && !isUuid(filmId)) throw new Error('INVALID_PLAYBACK_REQUEST');
  if (hasPart && !isUuid(partId)) throw new Error('INVALID_PLAYBACK_REQUEST');
  return hasFilm ? { filmId } : { partId: partId as string };
}

export function validatePlaybackProgress(payload: unknown): WebPlaybackProgressInput {
  if (!isRecord(payload)) throw new Error('INVALID_PLAYBACK_PROGRESS');
  const positionSeconds = finiteSeconds(payload.positionSeconds);
  const durationSeconds = payload.durationSeconds === undefined ? undefined : finiteSeconds(payload.durationSeconds);
  if (durationSeconds !== undefined && positionSeconds > durationSeconds + 60) throw new Error('INVALID_PLAYBACK_PROGRESS');
  return { positionSeconds, ...(durationSeconds === undefined ? {} : { durationSeconds }) };
}

function finiteSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 31 * 24 * 60 * 60) {
    throw new Error('INVALID_PLAYBACK_PROGRESS');
  }
  return Math.round(value * 1000) / 1000;
}
