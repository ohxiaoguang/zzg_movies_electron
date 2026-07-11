import fs from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';

const localElectronZipDir = path.resolve(__dirname, '.electron-cache');
const localSquirrelVendorDir = path.resolve(__dirname, '.build-nuget', 'squirrel-vendor');

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Set ELECTRON_ZIP_DIR for deterministic/offline packaging when the
    // Electron distribution is already available in a local cache.
    electronZipDir: process.env.ELECTRON_ZIP_DIR || (fs.existsSync(localElectronZipDir) ? localElectronZipDir : undefined),
    ignore: (file) => {
      const normalized = file.replaceAll('\\', '/');
      const keep = normalized === ''
        || normalized === '/'
        || normalized === '/package.json'
        || normalized === '/.vite'
        || normalized.startsWith('/.vite/')
        || normalized === '/node_modules'
        || normalized === '/node_modules/better-sqlite3'
        || normalized.startsWith('/node_modules/better-sqlite3/')
        || normalized === '/node_modules/bindings'
        || normalized.startsWith('/node_modules/bindings/')
        || normalized === '/node_modules/file-uri-to-path'
        || normalized.startsWith('/node_modules/file-uri-to-path/');
      return !keep;
    },
    name: 'local-film-library',
    executableName: 'local-film-library',
    appBundleId: 'com.localfilmlibrary.desktop',
    win32metadata: {
      CompanyName: 'Local Film Library',
      FileDescription: 'Local Film Library',
      ProductName: 'Local Film Library',
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'local_film_library',
        setupExe: 'LocalFilmLibrarySetup.exe',
        // electron-winstaller 5.4.4 bundles NuGet 2.8, which cannot package
        // Electron 42's dxcompiler.dll on this Windows/Node toolchain. Set
        // SQUIRREL_VENDOR_DIR to a vendor cache containing a newer nuget.exe.
        vendorDirectory: process.env.SQUIRREL_VENDOR_DIR
          || (fs.existsSync(localSquirrelVendorDir) ? localSquirrelVendorDir : undefined),
      },
    },
    {
      name: '@electron-forge/maker-zip',
      config: {},
      platforms: ['win32'],
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new AutoUnpackNativesPlugin({}),
  ],
};

export default config;
