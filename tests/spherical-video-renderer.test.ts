import { describe, expect, it } from 'vitest';
import {
  clampSphericalFov,
  clampSphericalPitch,
} from '../src/renderer/media/SphericalVideoRenderer';

describe('spherical video view constraints', () => {
  it('keeps vertical rotation away from the panorama poles', () => {
    const maximum = (85 * Math.PI) / 180;
    expect(clampSphericalPitch(0.5)).toBe(0.5);
    expect(clampSphericalPitch(Math.PI)).toBeCloseTo(maximum);
    expect(clampSphericalPitch(-Math.PI)).toBeCloseTo(-maximum);
  });

  it('keeps wheel zoom within a usable field of view', () => {
    expect(clampSphericalFov(75)).toBe(75);
    expect(clampSphericalFov(5)).toBe(30);
    expect(clampSphericalFov(150)).toBe(100);
  });
});
