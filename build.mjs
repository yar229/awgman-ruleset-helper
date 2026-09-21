import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const sources = ['background.js', 'lib', 'popup', 'editor', 'icons', 'README.md'];

const versionArg = process.argv.find((a) => a.startsWith('--version='));
const version = versionArg ? versionArg.split('=')[1] : null;

async function stage(browser, manifestSrc, destDir) {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  for (const f of sources) {
    await cp(f, destDir + '/' + f, { recursive: true });
  }
  const manifest = JSON.parse(await readFile(manifestSrc, 'utf8'));
  if (version) manifest.version = version;
  await writeFile(destDir + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log('staged', browser, '->', destDir, version ? '(v' + version + ')' : '');
}

await stage('chrome', 'manifest.json', 'dist/chrome');
await stage('firefox', 'manifest.firefox.json', 'dist/firefox');