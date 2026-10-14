// Wipes the demo state (register, working copies, vault) so the next start re-seeds
// the register from samples/. Document Engine keeps old documents; they are simply unused.
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
const unlock = (p) => { chmodSync(p, 0o755); if (statSync(p).isDirectory()) for (const f of readdirSync(p)) unlock(`${p}/${f}`); };
if (existsSync('data')) { unlock('data'); rmSync('data', { recursive: true }); }
console.log('Demo data reset. Restart the server to re-seed.');
