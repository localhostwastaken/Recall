// Renders the Recall logo (apps/web/src/brand/Logo.tsx, the single source of the drawing) to:
//   apps/web/public/favicon.svg, apps/web/public/favicon-32.png
//   extension/packages/extension/src/assets/img/icon-{16,32,34,48,128}.png
// PNGs are drawn by Chromium at their exact pixel size on a transparent background.
// Run from the repo root: node scripts/gen-icons.mjs
// Uses the repo's Playwright Chromium; set CHROMIUM_PATH to point at another Chromium binary.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps/web');
const EXT_IMG = join(ROOT, 'extension/packages/extension/src/assets/img');
const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  '/Users/madkeanuj/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium';

// 1. Load the Logo component through Vite (it compiles the TSX) and render it to SVG markup.
const webRequire = createRequire(join(WEB, 'package.json'));
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const vite = await createServer({
  root: WEB,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: { external: ['react', 'react-dom'] },
});
let Logo;
try {
  ({ Logo } = await vite.ssrLoadModule('/src/brand/Logo.tsx'));
} finally {
  await vite.close();
}

/** A standalone SVG file of the logo at `size` px (no React attributes, explicit namespace). */
function logoSvg(size) {
  const markup = renderToStaticMarkup(React.createElement(Logo, { size }));
  return markup.replace(/^<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">`);
}

// 2. The SVG favicon (scales itself; 64 is only its nominal size).
mkdirSync(join(WEB, 'public'), { recursive: true });
writeFileSync(join(WEB, 'public/favicon.svg'), `${logoSvg(64)}\n`);

// 3. PNGs, each drawn at its own size so Chromium hints it for that size.
const targets = [
  [join(WEB, 'public/favicon-32.png'), 32],
  [join(EXT_IMG, 'icon-16.png'), 16],
  [join(EXT_IMG, 'icon-32.png'), 32],
  [join(EXT_IMG, 'icon-34.png'), 34],
  [join(EXT_IMG, 'icon-48.png'), 48],
  [join(EXT_IMG, 'icon-128.png'), 128],
];
const { chromium } = createRequire(join(ROOT, 'package.json'))('@playwright/test');
const browser = await chromium.launch({ executablePath: CHROMIUM });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [file, size] of targets) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${logoSvg(size).replace('<svg ', '<svg style="display:block" ')}</body></html>`,
    );
    mkdirSync(dirname(file), { recursive: true });
    await page.locator('svg').screenshot({ path: file, omitBackground: true });
    console.log(`wrote ${file.slice(ROOT.length + 1)} (${size}px)`);
  }
} finally {
  await browser.close();
}
console.log('wrote apps/web/public/favicon.svg');
