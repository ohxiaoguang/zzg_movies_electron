import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve(process.cwd(), '.github/workflows/release.yml');

describe('GitHub release workflow', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  it('runs for version tags on a Windows runner with release permission', () => {
    expect(workflow).toContain("- 'v*'");
    expect(workflow).toContain("- '[0-9]*'");
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('contents: write');
  });

  it('uses the tag as the package version and verifies the packaged version', () => {
    expect(workflow).toContain("$version = $tag -replace '^v', ''");
    expect(workflow).toContain('npm version $version --no-git-tag-version --allow-same-version');
    expect(workflow).toContain('EXPECTED_APP_VERSION: ${{ env.RELEASE_VERSION }}');
    expect(workflow).toContain('npm run smoke:package');
  });

  it('creates or updates a GitHub Release with installer and ZIP assets', () => {
    expect(workflow).toContain('npm run make');
    expect(workflow).toContain('LocalFilmLibrarySetup.exe');
    expect(workflow).toContain('local-film-library-win32-x64-$env:RELEASE_VERSION.zip');
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('gh release upload');
  });
});
