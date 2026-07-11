import fs from 'node:fs';
import path from 'node:path';

export function resolveSafeMediaPath(rootPath: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('MEDIA_PATH_INVALID');
  const root = path.resolve(rootPath);
  const target = path.resolve(root, relativePath);
  if (!isPathWithinRoot(root, target)) throw new Error('MEDIA_PATH_OUTSIDE_SOURCE');
  return target;
}

export function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function resolveExistingSafeMediaPath(rootPath: string, relativePath: string): Promise<string> {
  const resolvedRoot = await fs.promises.realpath(rootPath);
  const resolvedPath = await fs.promises.realpath(resolveSafeMediaPath(resolvedRoot, relativePath));
  if (!isPathWithinRoot(resolvedRoot, resolvedPath)) throw new Error('MEDIA_PATH_OUTSIDE_SOURCE');
  return resolvedPath;
}
