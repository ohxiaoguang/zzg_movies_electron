import { parseResonanceState, type ResonanceVideo } from './resonance';

export type ResonanceBackupVideo = Omit<ResonanceVideo, 'id' | 'filmId' | 'partId' | 'title' | 'vrModeKnown' | 'highlightSeconds'> & {
  highlightSeconds?: number;
  filmIndex: number | null;
  fileSize: number | null;
};
export interface ResonanceBackupState {
  version: 1;
  activeSceneId: string | null;
  draft: ResonanceBackupVideo[];
  scenes: Array<{ id: string; name: string; createdAt: string; videos: ResonanceBackupVideo[] }>;
}

export function parseResonanceBackup(value: unknown, filmCount: number): ResonanceBackupState {
  try {
    if (!value || typeof value !== 'object') throw new Error();
    const input = value as ResonanceBackupState;
    let count = 0;
    function validateVideos(videos: ResonanceBackupVideo[]) {
      if (!Array.isArray(videos) || (count += videos.length) > 10000) throw new Error();
      return videos.map((video, index) => {
        if (!video || (video.filmIndex !== null && (!Number.isInteger(video.filmIndex) || video.filmIndex < 0 || video.filmIndex >= filmCount))
          || (video.fileSize !== null && (!Number.isSafeInteger(video.fileSize) || video.fileSize < 0))) throw new Error();
        return { ...video, filmId: 'validate', partId: String(index), title: '', vrModeKnown: true };
      });
    }
    if (!Array.isArray(input.scenes) || input.scenes.length > 1000) throw new Error();
    const state = parseResonanceState({
      version: input.version, activeSceneId: input.activeSceneId,
      scenes: input.scenes.map((scene) => ({ ...scene, videos: validateVideos(scene.videos) })),
      draft: validateVideos(input.draft),
    });
    function portable(video: ResonanceVideo, original: ResonanceBackupVideo): ResonanceBackupVideo {
      return {
        filmIndex: original.filmIndex, fileSize: original.fileSize,
        filename: video.filename, currentSeconds: video.currentSeconds, durationSeconds: video.durationSeconds,
        ...(original.highlightSeconds === undefined ? {} : { highlightSeconds: video.highlightSeconds }),
        aspectRatio: video.aspectRatio, isVr: video.isVr, vrView: video.vrView, addedAt: video.addedAt,
      };
    }
    return {
      version: 1, activeSceneId: state.activeSceneId,
      draft: state.draft.map((video, index) => portable(video, input.draft[index])),
      scenes: state.scenes.map((scene, index) => ({
        id: scene.id, name: scene.name, createdAt: scene.createdAt,
        videos: scene.videos.map((video, videoIndex) => portable(video, input.scenes[index].videos[videoIndex])),
      })),
    };
  } catch { throw new Error('CLOUD_BACKUP_FILE_INVALID'); }
}
