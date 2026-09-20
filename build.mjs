import { cp, mkdir, rm } from 'node:fs/promises';

const sources = ['background.js', 'lib', 'popup', 'editor', 'icons', 'README.md'];

async function stage(browser, manifestSrc, destDir) {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  for (const f of sources) {
    await cp(f, destDir + '/' + f, { recursive: true });
  }
  await cp(manifestSrc, destDir + '/manifest.json');
  console.log('staged', browser, '->', destDir);
}

await stage('chrome', 'manifest.json', 'dist/chrome');
await stage('firefox', 'manifest.firefox.json', 'dist/firefox');