// Self-host the Web SDK assets from our own origin (no Nutrient CDN at runtime).
import { cpSync, existsSync } from 'node:fs';

const src = 'node_modules/@nutrient-sdk/viewer/dist/nutrient-viewer-lib';
if (existsSync(src)) {
	cpSync(src, 'client/public/nutrient-viewer-lib', { recursive: true });
	console.log('Copied Web SDK assets to client/public/nutrient-viewer-lib');
}
