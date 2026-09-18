#!/usr/bin/env bun
// CLI entry for the Jev controller.
//
//   bun bots/jev/run.ts --skill Woodcutting --minutes 15 --log-dir /logs/agent [--policy jev|random|first] [--mode burst|tick]
//
// --mode tick asks Jev every game tick (--poll-every N: every N ticks) and keeps the running
// action while the answer stays the same; --jev-timeout-ms defaults to the poll interval there.
//
// GAME_SPEED (default 8) must match the engine's speed (400 / NODE_TICKRATE).
// Reads TYPESAFE_API_KEY from the environment (policy=jev). The bot's gateway
// credentials default to the benchmark image's `agent` / `test` on
// ws://localhost:7780 and can be overridden with --bot / --password / --gateway.

import { runController, type Policy, type Mode, TICK_MS } from './controller';
import { TIME_SCALE } from './catalog';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}

const skill = arg('skill');
if (!skill) {
    console.error('usage: bun run.ts --skill <Skill> --minutes <N> --log-dir <dir> [--policy jev|random|first] [--mode burst|tick] [--burst-ms 20000] [--poll-every N] [--jev-timeout-ms N]');
    process.exit(2);
}
const minutes = Number(arg('minutes', '15'));
const logDir = arg('log-dir', '/logs/agent')!;
const policy = (arg('policy', 'jev') as Policy);
// 20 s per decision at the benchmark's 8x; slower worlds get longer bursts, capped at 60 s so Jev still decides often.
const burstMs = Number(arg('burst-ms', String(Math.min(60_000, Math.round(20_000 * TIME_SCALE)))));
const model = arg('model', process.env.JEV_MODEL || 'jev-latest');
const mode = (arg('mode', process.env.JEV_MODE || 'burst') as Mode);
if (mode !== 'burst' && mode !== 'tick') { console.error(`unknown --mode ${mode}`); process.exit(2); }
const pollEvery = Math.max(1, Math.round(Number(arg('poll-every', process.env.JEV_POLL_EVERY || '1')) || 1));
const jevTimeoutMs = Number(arg('jev-timeout-ms', String(mode === 'tick' ? TICK_MS * pollEvery : 30_000)));
const apiKey = process.env.TYPESAFE_API_KEY;
if (policy === 'jev' && !apiKey) {
    console.error('TYPESAFE_API_KEY is not set');
    process.exit(2);
}

const summary = await runController({
    skill,
    minutes,
    logDir,
    policy,
    botUsername: arg('bot', process.env.BOT_NAME || 'agent')!,
    password: arg('password', process.env.BOT_PASSWORD || 'test')!,
    gatewayUrl: arg('gateway', process.env.GATEWAY_URL || 'ws://localhost:7780')!,
    apiKey,
    model,
    burstMs,
    mode,
    jevTimeoutMs,
    pollEvery,
    seed: Number(arg('seed', '1234')),
});
console.log(JSON.stringify(summary));
process.exit(0);
