import type { VrViewDto } from './contracts';

export interface ResonanceVideo {
  id: string;
  filmId: string;
  partId: string;
  title: string;
  filename: string;
  currentSeconds: number;
  durationSeconds: number;
  aspectRatio: number;
  isVr: boolean;
  vrView: VrViewDto | null;
  vrModeKnown: boolean;
  addedAt: string;
}

export type ResonanceVideoInput = Omit<ResonanceVideo, 'id' | 'addedAt' | 'vrModeKnown'>;
export interface ResonanceScene {
  id: string;
  name: string;
  videos: ResonanceVideo[];
  createdAt: string;
}
export interface ResonanceState {
  version: 1;
  activeSceneId: string | null;
  draft: ResonanceVideo[];
  scenes: ResonanceScene[];
}

export function emptyResonanceState(): ResonanceState {
  return { version: 1, activeSceneId: null, draft: [], scenes: [] };
}

// Reconstruct an allowlisted document at the IPC and database boundaries.
export function parseResonanceState(value: unknown): ResonanceState {
  const state = record(value);
  if (state.version !== 1 || !Array.isArray(state.scenes) || state.scenes.length > 1000) invalid();
  let total = 0;
  function videos(value: unknown): ResonanceVideo[] {
    if (!Array.isArray(value) || (total += value.length) > 10000) invalid();
    const ids = new Set<string>();
    return value.map((entry) => {
      const video = record(entry);
      const filmId = text(video.filmId, 256);
      const partId = text(video.partId, 256);
      const id = `${filmId}:${partId}`;
      if (ids.has(id) || typeof video.isVr !== 'boolean' || typeof video.vrModeKnown !== 'boolean') invalid();
      ids.add(id);
      const view = video.vrView === null ? null : record(video.vrView);
      return {
        id, filmId, partId, title: text(video.title, 2000, true), filename: text(video.filename, 2000),
        currentSeconds: number(video.currentSeconds, 0), durationSeconds: number(video.durationSeconds, 0),
        aspectRatio: number(video.aspectRatio, 0.25, 4), isVr: video.isVr, vrModeKnown: video.vrModeKnown,
        vrView: view ? {
          yawDegrees: number(view.yawDegrees, -180, 179.999),
          pitchDegrees: number(view.pitchDegrees, -85, 85), fovDegrees: number(view.fovDegrees, 30, 100),
        } : null,
        addedAt: text(video.addedAt, 100),
      };
    });
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const scenes = state.scenes.map((entry) => {
    const scene = record(entry);
    const id = text(scene.id, 256);
    const name = text(scene.name, 60);
    const key = name.normalize('NFKC').trim().toLocaleLowerCase();
    if (!key || ids.has(id) || names.has(key)) invalid();
    ids.add(id);
    names.add(key);
    return { id, name, videos: videos(scene.videos), createdAt: text(scene.createdAt, 100) };
  });
  if (state.activeSceneId !== null && (typeof state.activeSceneId !== 'string' || !ids.has(state.activeSceneId))) invalid();
  return { version: 1, activeSceneId: state.activeSceneId as string | null, scenes, draft: videos(state.draft) };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid();
  return value;
}
function number(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  return value;
}
function invalid(): never { throw new Error('RESONANCE_STATE_INVALID'); }
