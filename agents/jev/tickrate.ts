// Measure a world's real game speed through the gateway (observe mode, no game actions).
//   bun tickrate.ts <gateway_url> <bot> <seconds>            one measurement, prints "N ticks/s"
//   bun tickrate.ts <gateway_url> <bot> <seconds> <out.jsonl> repeat until killed, appending samples
import { appendFileSync } from 'fs';
const GAME_SPEED = Number(process.env.GAME_SPEED || 8);
import { BotSDK } from '../../sdk/index';
const gw = process.argv[2] || 'ws://localhost:7801'; const bot = process.argv[3] || 'agent1'; const secs = parseInt(process.argv[4] || '6'); const out = process.argv[5];
const sdk = new BotSDK({ botUsername: bot, password: 'test', gatewayUrl: gw, connectionMode: 'observe', autoLaunchBrowser: false, showChat: false });
await sdk.connect();
await sdk.waitForCondition(s => s.inGame && s.tick > 0, 30_000);
for (;;) {
    const t0 = Date.now(); const k0 = sdk.getState()!.tick;
    await new Promise(r => setTimeout(r, secs * 1000));
    const t1 = Date.now(); const k1 = sdk.getState()!.tick;
    const tps = (k1 - k0) / ((t1 - t0) / 1000);
    if (out) appendFileSync(out, JSON.stringify({ ts: new Date().toISOString(), ticks_per_second: +tps.toFixed(2) }) + '\n');
    else { console.log(`${gw} ${bot}: ${tps.toFixed(1)} ticks/s over ${((t1 - t0) / 1000).toFixed(1)}s (expected ${(2.5 * GAME_SPEED).toFixed(1)} at ${GAME_SPEED}x, NODE_TICKRATE=${Math.round(400 / GAME_SPEED)})`); break; }
}
await sdk.disconnect(); process.exit(0);
