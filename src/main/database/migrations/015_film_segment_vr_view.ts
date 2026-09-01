export const filmSegmentVrViewMigration = {
  version: 15,
  sql: `
    ALTER TABLE film_segment
      ADD COLUMN vr_yaw_degrees REAL
      CHECK (vr_yaw_degrees IS NULL OR (vr_yaw_degrees >= -180 AND vr_yaw_degrees < 180));
    ALTER TABLE film_segment
      ADD COLUMN vr_pitch_degrees REAL
      CHECK (vr_pitch_degrees IS NULL OR (vr_pitch_degrees >= -85 AND vr_pitch_degrees <= 85));
    ALTER TABLE film_segment
      ADD COLUMN vr_fov_degrees REAL
      CHECK (vr_fov_degrees IS NULL OR (vr_fov_degrees >= 30 AND vr_fov_degrees <= 100));
  `,
};
