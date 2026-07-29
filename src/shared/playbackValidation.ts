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
  const purpose = payload.purpose === undefined ? 'full' : payload.purpose;
  if (purpose !== 'full' && purpose !== 'segment-preview') throw new Error('INVALID_PLAYBACK_REQUEST');
  if (purpose === 'segment-preview' && !hasPart) throw new Error('INVALID_PLAYBACK_REQUEST');
  const startSeconds = payload.startSeconds === undefined ? undefined : finiteSeconds(payload.startSeconds);
  const endSeconds = payload.endSeconds === undefined ? undefined : finiteSeconds(payload.endSeconds);
  if (purpose === 'segment-preview' && (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds)) {
    throw new Error('INVALID_PLAYBACK_REQUEST');
  }
  if (purpose === 'full' && (startSeconds !== undefined || endSeconds !== undefined)) throw new Error('INVALID_PLAYBACK_REQUEST');
  return {
    ...(hasFilm ? { filmId: filmId as string } : { partId: partId as string }),
    ...(purpose === 'full' ? {} : { purpose, startSeconds, endSeconds }),
  };
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
