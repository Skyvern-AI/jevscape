#!/usr/bin/env bun
// Live dashboard server for a running Jev controller.
//
//   bun live.ts --log-dir <controller log dir> [--port 7790] [--bot agent1]
//               [--client "http://localhost:8888/bot?bot=agent1&password=test"] [--gateway http://localhost:7780]
//
// Serves live.html at / and streams <log-dir>/events.jsonl over Server-Sent Events at /events
// (full replay on connect, then tail). /status proxies the gateway's per-bot status so the page
// can show whether the browser game client is logged in before the controller starts.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}

const logDir = arg('log-dir');
if (!logDir) {
    console.error('usage: bun live.ts --log-dir <dir> [--port 7790] [--bot agent1] [--client <url>] [--gateway http://localhost:7780]');
    process.exit(2);
}
const port = Number(arg('port', '7790'));
const bot = arg('bot', 'agent1')!;
const gateway = arg('gateway', 'http://localhost:7780')!;
const client = arg('client', `http://localhost:8888/bot?bot=${encodeURIComponent(bot)}&password=test`)!;
const eventsPath = join(logDir, 'events.jsonl');
const htmlPath = join(import.meta.dir, 'live.html');

function eventStream(signal: AbortSignal): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            let offset = 0;
            let buf = '';
            let closed = false;
            const send = (line: string) => { if (!closed) controller.enqueue(enc.encode(`data: ${line}\n\n`)); };
            const pump = () => {
                if (!existsSync(eventsPath)) return;
                const size = statSync(eventsPath).size;
                if (size < offset) { offset = 0; buf = ''; send(JSON.stringify({ type: 'reset' })); }
                if (size === offset) return;
                const fd = openSync(eventsPath, 'r');
                const chunk = Buffer.alloc(size - offset);
                try { readSync(fd, chunk, 0, chunk.length, offset); } finally { closeSync(fd); }
                offset = size;
                buf += chunk.toString('utf8');
                const parts = buf.split('\n');
                buf = parts.pop() ?? '';
                for (const p of parts) if (p.trim()) send(p);
            };
            send(JSON.stringify({ type: 'hello', bot, client, log_dir: logDir }));
            try { pump(); } catch { /* ignore */ }
            const timer = setInterval(() => { try { pump(); } catch { /* ignore */ } }, 300);
            const ping = setInterval(() => { if (!closed) controller.enqueue(enc.encode(': ping\n\n')); }, 15_000);
            signal.addEventListener('abort', () => {
                closed = true;
                clearInterval(timer);
                clearInterval(ping);
                try { controller.close(); } catch { /* ignore */ }
            });
        },
    });
}

Bun.serve({
    port,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/') return new Response(readFileSync(htmlPath, 'utf8'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/config') return Response.json({ bot, client, gateway, log_dir: logDir });
        if (url.pathname === '/status') {
            try {
                const r = await fetch(`${gateway}/status/${encodeURIComponent(bot)}`);
                return new Response(await r.text(), { headers: { 'content-type': 'application/json' } });
            } catch {
                return Response.json({ connected: false, inGame: false, gateway: 'unreachable' });
            }
        }
        if (url.pathname === '/events') {
            return new Response(eventStream(req.signal), {
                headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
            });
        }
        return new Response('not found', { status: 404 });
    },
});
console.log(`live dashboard at http://localhost:${port}/  (events: ${eventsPath}; game client: ${client})`);
