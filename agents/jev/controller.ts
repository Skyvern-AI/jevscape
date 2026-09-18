// Jev controller: a System One decision loop over the macro-action catalog.
//
// Two modes share the same catalog, safety rules and bookkeeping:
//
//   burst (benchmark): observe -> ask Jev ONE choice question -> run the chosen
//         macro-action for one burst (20 s at 8x) -> record -> repeat.
//   tick (live):       every game tick, ask Jev the same question with the running
//         action marked CURRENT. The same answer keeps the action running; a
//         different answer stops it and starts the new one at once. A call that
//         exceeds the tick timeout keeps the current action.
//
// Code owns the control flow, preconditions, safety rules and actuators.
// Jev owns the judgment: which of the currently-possible actions is the best
// use of the next moment for the task skill.

import { mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { BotSDK } from '../../sdk/index';
import { BotActions } from '../../sdk/actions';
import type { BotWorldState } from '../../sdk/types';
import { JevClient, type JevQuestion, type ChoiceAnswer, type NoulAnswer } from './jev-client';
import { candidates, nearestHub, level, xpOf, freeSlots, coins, REFERENCE, GAME_SPEED, TIME_SCALE, type Ctx, type ActionSpec, type Outcome } from './catalog';

export type Policy = 'jev' | 'random' | 'first';
export type Mode = 'burst' | 'tick';

export interface ControllerOptions {
    skill: string;
    minutes: number;
    logDir: string;
    policy: Policy;
    botUsername: string;
    password: string;
    gatewayUrl: string;
    apiKey?: string;
    model?: string;
    burstMs: number;
    seed?: number;
    /** burst (default): one decision per burst. tick: one decision per game tick. */
    mode?: Mode;
    /** HTTP timeout for one Jev call. Defaults: 30 s in burst mode, one game tick in tick mode. */
    jevTimeoutMs?: number;
    /** Tick mode: ask Jev every N game ticks (default 1). Jev can stretch it with poll_again_in_ticks. */
    pollEvery?: number;
}

export interface DecisionRecord {
    n: number;
    ts: string;
    elapsed_s: number;
    candidates: string[];
    choice: string;
    probability: number | null;
    confidence: number | null;
    eat_first: number | null;
    jev_seconds: number | null;
    input_tokens: number;
    output_tokens: number;
    outcome: Outcome;
    skill_level: number;
    skill_xp: number;
}

export interface Summary {
    skill: string;
    minutes: number;
    policy: Policy;
    mode: Mode;
    model: string | null;
    decisions: number;
    xp_start: number;
    xp_end: number;
    xp_gained: number;
    level_start: number;
    level_end: number;
    peak_window_xp_per_min_normalized: number;
    jev_calls: number;
    jev_input_tokens: number;
    jev_output_tokens: number;
    jev_cost_usd: number;
    jev_seconds: number;
    jev_timeouts: number;
    ticks: number;
    kept: number;
    switched: number;
    restarts: number;
    polls_skipped: number;
    action_counts: Record<string, number>;
    action_xp: Record<string, number>;
    deaths: number;
}

const XP_MULTIPLIER = 25;
const NORMALIZATION = GAME_SPEED * XP_MULTIPLIER;
/** Engine tick length in wall-clock ms (400 ms at 1x, 50 ms at the benchmark's 8x). */
export const TICK_MS = Math.round(400 / GAME_SPEED);
// The benchmark samples every 15 s at 8x; keep the same amount of game time at other speeds.
const SAMPLE_MS = Math.round(15_000 * TIME_SCALE);
const RECENT_ACTIONS = 6;
/** How many recent events (clicks, messages, XP drops, restarts) Jev is told about. */
const RECENT_EVENTS = 8;
/** Per-tick action in tick mode: stop the running action and start it again (re-click its target). */
const RESTART_KEY = 'restart_current';
/** Catalog actions that are per-tick actions in tick mode rather than goals. */
const INTERVENTION_KEYS = new Set(['close_dialog', 'eat_food']);
const SUPPRESS_MS = 90_000;
const FOOD_RE = /^(bread|shrimps|anchovies|kebab|cake|cooked meat|sardine|herring|trout|salmon)$/i;

const SKILL_NAMES = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Woodcutting', 'Fishing', 'Mining', 'Cooking', 'Fletching', 'Crafting', 'Smithing', 'Firemaking', 'Thieving'];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type CandidateDescription = ReturnType<ActionSpec['describe']>;

/** What the character is doing right now, as reported to Jev every decision. */
interface PlayerStatus {
    status: 'idle' | 'moving' | 'animating' | 'skilling' | 'in_combat' | 'under_attack' | 'in_dialog' | 'dead';
    /** Seconds since anything happened: movement, animation, dialog, target, XP or a server message. */
    idle_for_seconds: number;
    seconds_since_last_xp: number;
    seconds_since_last_message: number;
    last_message: string | null;
    /** "7/10" */
    hitpoints: string;
    /** -1 when the player has not been hit in this run. */
    seconds_since_last_damage: number;
    damage_taken_last_10s: number;
    /** Name of the NPC the player is interacting with or fighting, if any. */
    target: string | null;
}

interface Choice {
    chosen: ActionSpec | null;
    probability: number | null;
    probabilities: Record<string, number> | null;
    confidence: number | null;
    eatFirst: number | null;
    jevSeconds: number | null;
    inTok: number;
    outTok: number;
    /** The Jev call failed or timed out; `chosen` is then the fallback (or null in tick mode). */
    failed: boolean;
    /** Tick mode: how many ticks Jev wants to wait before it is asked again (1 to 10). */
    pollIn: number;
    /** Tick mode: Jev chose restart_current (chosen is then the running action's spec). */
    restart: boolean;
    /** Tick mode: the action for this tick (do_nothing, close_dialog, eat_food, restart_current). */
    intervention: string;
    interventions: Record<string, number> | null;
}

/** One started macro-action (a "run"), in either mode. */
interface ActiveRun {
    n: number;
    spec: ActionSpec;
    startedAt: number;
    xpAtStart: number;
    xpEvents: number;
    lastXpAt: number;
    lastXp: number;
    controller: AbortController;
    promise: Promise<Outcome>;
    outcome: Outcome | null;
    candidates: string[];
    choice: Choice;
    description: CandidateDescription;
}

export async function runController(opts: ControllerOptions): Promise<Summary> {
    const mode: Mode = opts.mode ?? 'burst';
    mkdirSync(opts.logDir, { recursive: true });
    const logPath = join(opts.logDir, 'controller.log');
    const decisionsPath = join(opts.logDir, 'decisions.jsonl');
    const eventsPath = join(opts.logDir, 'events.jsonl');
    // Live event stream for the dashboard (agents/jev/live.ts): one JSON object per line.
    const emit = (event: Record<string, unknown>) => {
        try { appendFileSync(eventsPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'); } catch { /* ignore */ }
    };
    const log = (msg: string) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        console.log(line);
        try { appendFileSync(logPath, line + '\n'); } catch { /* ignore */ }
        emit({ type: 'log', text: msg });
    };

    const sdk = new BotSDK({
        botUsername: opts.botUsername,
        password: opts.password,
        gatewayUrl: opts.gatewayUrl,
        connectionMode: 'control',
        autoLaunchBrowser: false,
        autoReconnect: true,
        showChat: false,
    });
    log(`connecting to ${opts.gatewayUrl} as ${opts.botUsername} (skill=${opts.skill}, minutes=${opts.minutes}, policy=${opts.policy}, mode=${mode})`);
    await sdk.connect();
    await sdk.waitForCondition(s => s.inGame && s.skills.length > 0 && !!s.player && s.player.worldX > 0, 90_000);
    const bot = new BotActions(sdk);

    // Tutorial Island guard (the benchmark save starts in Lumbridge, but be safe).
    for (let i = 0; i < 20; i++) {
        const p = sdk.getState()?.player;
        if (!p) break;
        const onTutorial = p.worldX >= 3050 && p.worldX <= 3156 && p.worldZ >= 3056 && p.worldZ <= 3136;
        if (!onTutorial) break;
        log('on Tutorial Island; skipping tutorial');
        await Promise.race([bot.skipTutorial(), sleep(10_000)]);
        await sleep(500);
    }

    const pollEvery = Math.max(1, Math.round(opts.pollEvery ?? 1));
    const jevTimeoutMs = opts.jevTimeoutMs ?? (mode === 'tick' ? TICK_MS * pollEvery : 30_000);
    const jev = opts.policy === 'jev'
        ? new JevClient({
            apiKey: opts.apiKey ?? '',
            model: opts.model,
            logPath: join(opts.logDir, 'jev-calls.jsonl'),
            timeoutMs: jevTimeoutMs,
            // In tick mode a slow call is simply skipped: the next tick asks again.
            maxAttempts: mode === 'tick' ? 1 : undefined,
        })
        : null;
    const rand = mulberry32(opts.seed ?? 1234);

    const startedAt = Date.now();
    const deadline = startedAt + opts.minutes * 60_000;
    const ctx: Ctx = { sdk, bot, skill: opts.skill, deadline, log, notes: {}, hold: mode === 'tick' };

    const xpStart = xpOf(state(sdk), opts.skill);
    const levelStart = level(state(sdk), opts.skill);

    // Own sampler so the state can carry live progress feedback.
    const samples: Array<{ t: number; xp: number }> = [{ t: Date.now(), xp: xpStart }];
    const sampler = setInterval(() => {
        const s = sdk.getState();
        if (s) samples.push({ t: Date.now(), xp: xpOf(s, opts.skill) });
    }, SAMPLE_MS);
    const peakNormalized = () => {
        let peak = 0;
        for (let i = 1; i < samples.length; i++) {
            const dx = samples[i].xp - samples[i - 1].xp;
            const dt = samples[i].t - samples[i - 1].t;
            if (dx <= 0 || dt <= 0) continue;
            peak = Math.max(peak, (dx / dt) * 60_000 / NORMALIZATION);
        }
        return Math.round(peak);
    };

    const history: Array<{ action: string; outcome: string; xp_gained: number; seconds: number }> = [];
    const suppressedUntil = new Map<string, number>();
    const consecutiveNoProgress = new Map<string, number>();
    const actionCounts: Record<string, number> = {};
    const actionXp: Record<string, number> = {};
    let n = 0;
    let lastKey: string | null = null;
    let deathsSeen = 0;
    let deaths = 0;
    let lastInvCount = 0;
    let sameKeyStreak = 0;
    let sameKeyXp = 0;
    let jevTimeouts = 0;
    let ticks = 0;
    let kept = 0;
    let switched = 0;
    let restarts = 0;
    let pollsSkipped = 0;
    let lastEatAt = 0;

    // Player activity tracker: sampled every tick so idle time is measured, not guessed.
    const act = { lastMoveAt: Date.now(), lastAnimAt: Date.now(), lastDialogAt: 0, lastCombatAt: 0, lastXpAt: Date.now(), lastMsgAt: 0, lastMsg: null as string | null, msgSeen: 0, lastX: -1, lastZ: -1, lastXp: xpStart, lastHp: -1, lastDamageAt: 0, damage: [] as Array<{ t: number; n: number }> };
    // Short event history for Jev and the dashboard: what the bot did and what the server said, newest last.
    const events: Array<{ t: number; text: string }> = [];
    const note = (text: string) => { events.push({ t: Date.now(), text }); if (events.length > RECENT_EVENTS) events.shift(); };
    const recentEvents = () => events.map(e => `${Math.round((Date.now() - e.t) / 1000)} s ago: ${e.text}`);
    const trackActivity = (s: BotWorldState) => {
        const now = Date.now();
        const p = s.player;
        if (p) {
            if (p.worldX !== act.lastX || p.worldZ !== act.lastZ) { act.lastMoveAt = now; act.lastX = p.worldX; act.lastZ = p.worldZ; }
            if (p.animId !== -1) act.lastAnimAt = now;
            if (p.combat.inCombat) act.lastCombatAt = now;
            // Hitpoints going down is the only reliable sign of being attacked: fishing also sets a target.
            if (act.lastHp >= 0 && !p.isDead && p.hp < act.lastHp) {
                const n = act.lastHp - p.hp;
                act.lastDamageAt = now;
                act.damage.push({ t: now, n });
                note(`took ${n} damage (hitpoints ${p.hp}/${p.maxHp})`);
            }
            act.lastHp = p.isDead ? -1 : p.hp;
            act.damage = act.damage.filter(d => now - d.t <= 10_000);
        }
        if (s.dialog.isOpen) act.lastDialogAt = now;
        const xp = xpOf(s, opts.skill);
        if (xp > act.lastXp) { note(`gained ${xp - act.lastXp} ${opts.skill} XP`); act.lastXp = xp; act.lastXpAt = now; }
        // The message buffer is cumulative; anything beyond what we have seen is new server output.
        const msgs = s.gameMessages.filter(m => m.type === 0);
        if (msgs.length < act.msgSeen) act.msgSeen = 0;
        for (const m of msgs.slice(act.msgSeen)) {
            if (!/^Welcome to RuneScape/i.test(m.text)) note(`server: "${m.text}"`);
            act.lastMsgAt = now; act.lastMsg = m.text;
        }
        act.msgSeen = msgs.length;
    };
    const tracker = setInterval(() => { const s = sdk.getState(); if (s) trackActivity(s); }, TICK_MS);
    const targetName = (s: BotWorldState): string | null => {
        const c = s.player?.combat;
        if (!c || c.targetType === 'none') return null;
        if (c.targetType === 'npc') return s.nearbyNpcs.find(n => n.index === c.targetIndex)?.name ?? 'an npc';
        return 'a player';
    };
    const playerStatus = (s: BotWorldState): PlayerStatus => {
        const now = Date.now();
        const busyAt = Math.max(act.lastMoveAt, act.lastAnimAt, act.lastDialogAt, act.lastCombatAt, act.lastXpAt, act.lastMsgAt);
        const target = targetName(s);
        let status: PlayerStatus['status'];
        if (s.player?.isDead) status = 'dead';
        else if (act.lastDamageAt > 0 && now - act.lastDamageAt <= 6_000) status = 'under_attack';
        else if (s.player?.combat.inCombat) status = target && /fishing spot|tree|rock/i.test(target) ? 'skilling' : 'in_combat';
        else if (s.dialog.isOpen) status = 'in_dialog';
        else if (s.player && s.player.animId !== -1) status = 'animating';
        else if (now - act.lastMoveAt <= 2 * TICK_MS + 50) status = 'moving';
        else status = 'idle';
        return {
            status,
            idle_for_seconds: status === 'idle' ? +((now - busyAt) / 1000).toFixed(1) : 0,
            seconds_since_last_xp: +((now - act.lastXpAt) / 1000).toFixed(1),
            seconds_since_last_message: act.lastMsgAt ? +((now - act.lastMsgAt) / 1000).toFixed(1) : -1,
            last_message: act.lastMsg,
            hitpoints: s.player ? `${s.player.hp}/${s.player.maxHp}` : '?',
            seconds_since_last_damage: act.lastDamageAt ? +((now - act.lastDamageAt) / 1000).toFixed(1) : -1,
            damage_taken_last_10s: act.damage.reduce((a, d) => a + d.n, 0),
            target,
        };
    };
    /** One sentence of facts about the player for Jev's option notes. */
    const statusFacts = (ps: PlayerStatus) => `the player is ${ps.status.replace(/_/g, ' ')}${ps.status === 'idle' ? ` and has been quiet for ${ps.idle_for_seconds} s` : ''}${ps.target ? ` (target: ${ps.target})` : ''}; hitpoints ${ps.hitpoints}${ps.damage_taken_last_10s > 0 ? `, took ${ps.damage_taken_last_10s} damage in the last 10 s (last hit ${ps.seconds_since_last_damage} s ago): something is attacking the player` : ''}${ps.last_message ? `; last server message ${ps.seconds_since_last_message} s ago: "${ps.last_message}"` : ''}`;

    const elapsedS = () => +((Date.now() - startedAt) / 1000).toFixed(1);
    const jevStats = () => ({ jev_calls: jev?.usage.calls ?? 0, jev_cost_usd: +(jev?.costUsd() ?? 0).toFixed(5) });

    log(`start: ${opts.skill} level ${levelStart}, xp ${xpStart}`);
    emit({
        type: 'start', skill: opts.skill, minutes: opts.minutes, policy: opts.policy, mode,
        model: opts.policy === 'jev' ? opts.model ?? 'jev-latest' : null, bot: opts.botUsername,
        burst_ms: opts.burstMs, tick_ms: TICK_MS, poll_every: pollEvery, jev_timeout_ms: jevTimeoutMs, game_speed: GAME_SPEED,
        level: levelStart, xp: xpStart, started_at: startedAt,
    });

    // ── shared pieces ─────────────────────────────────────────────────────

    /** Hard safety rules and death bookkeeping. Returns false when the loop should skip this round. */
    async function safety(s: BotWorldState): Promise<boolean> {
        // Never let the bot die with food in the bag.
        if (s.player && s.player.hp <= 3 && s.inventory.some(i => FOOD_RE.test(i.name))) {
            const food = s.inventory.find(i => FOOD_RE.test(i.name))!;
            log(`safety: hp ${s.player.hp}, eating ${food.name}`);
            await bot.eatFood(food).catch(() => undefined);
        }
        if (s.player?.isDead) {
            log('dead; waiting for respawn');
            try { await sdk.waitForCondition(st => !st.player?.isDead, 30_000); } catch { /* ignore */ }
            return false;
        }
        // A death during an action respawns the player in Lumbridge with three items.
        // Make it visible to the model as a recent event.
        const deathMsgs = s.gameMessages.filter(m => m.type === 0 && /oh dear,? you are dead/i.test(m.text)).length;
        const wiped = lastInvCount >= 8 && s.inventory.length <= 3 && !!s.player && s.player.hp === s.player.maxHp && s.player.worldX >= 3218 && s.player.worldX <= 3226 && s.player.worldZ >= 3214 && s.player.worldZ <= 3222;
        lastInvCount = s.inventory.length;
        if (deathMsgs > deathsSeen || wiped) {
            deathsSeen = Math.max(deathsSeen, deathMsgs);
            deaths++;
            log(`death #${deaths} detected; inventory now ${s.inventory.map(i => i.name).join(', ') || 'empty'}`);
            note('died and respawned in Lumbridge; all but the three most valuable items were lost');
            history.push({ action: '(you died and respawned in Lumbridge; all but your three most valuable items were lost)', outcome: 'died', xp_gained: 0, seconds: 0 });
            if (history.length > RECENT_ACTIONS) history.shift();
        }
        return true;
    }

    function pickCandidates(s: BotWorldState): ActionSpec[] {
        const now = Date.now();
        for (const [k, until] of suppressedUntil) if (until <= now) suppressedUntil.delete(k);
        // In tick mode, closing a dialog and eating are per-tick actions (this_tick), not goals.
        const goals = (list: ActionSpec[]) => mode === 'tick' ? list.filter(a => !INTERVENTION_KEYS.has(a.key)) : list;
        let cands = goals(candidates(s, ctx, new Set(suppressedUntil.keys())));
        if (cands.length === 0) {
            // Everything is suppressed or impossible; clear suppression rather than idle.
            suppressedUntil.clear();
            cands = goals(candidates(s, ctx, new Set()));
        }
        return cands;
    }

    /** Per-tick actions Jev can take without changing what the bot works on. */
    function tickActions(s: BotWorldState, current: ActiveRun | null): Record<string, CandidateDescription> {
        const ps = playerStatus(s);
        const phase = String(ctx.notes.phase ?? 'working');
        const status = `${statusFacts(ps)}`;
        const facts = current
            ? `the running action has run for ${Math.round((Date.now() - current.startedAt) / 1000)} s (${phase}), produced ${current.xpEvents} XP drops, last XP ${ps.seconds_since_last_xp} s ago; ${status}`
            : `nothing is running; the action chosen in next_action starts right after this; ${status}`;
        const acts: Record<string, CandidateDescription> = {
            do_nothing: { what: current ? 'do nothing this tick and let the running action continue untouched' : 'do nothing extra this tick', where: 'right here', requires: 'nothing', gives: 'no interruption', notes: `${facts}. Skilling is silent between attempts (a cast net or a swung axe shows nothing until the next attempt), so a quiet spell of a few seconds is normal. The script clicks its target once and then holds; it never re-clicks by itself` },
        };
        if (current) {
            acts[RESTART_KEY] = { what: `stop "${current.description.what}" and start it again from scratch, re-clicking its target`, where: 'right here', requires: 'nothing', gives: 'the same action once the target is re-acquired; the walk resumes from where the player stands, only the interaction is redone', notes: `${facts}. A target that moved or vanished (a fishing spot that changed, a tree that fell, a rock that emptied) stays silent until it is re-clicked, and so does the player after a level-up message is closed: the game stops the skilling and only a new click starts it again. While the status is skilling the game is still working on the target even when nothing is visible (failed attempts are silent); a click then interrupts that attempt and often ends the interaction. Restarting while the player is still walking throws that progress away` };
        }
        if (s.dialog.isOpen || s.interface.isOpen) {
            acts.close_dialog = { what: `close the open ${s.dialog.isOpen ? 'dialog' : 'interface window'}${s.dialog.text ? ` ("${s.dialog.text.replace(/\s+/g, ' ').slice(0, 90)}")` : ''} without stopping the running action`, where: 'right here', requires: 'nothing', gives: 'the running action can continue once the window is gone; a level-up message pauses skilling until it is closed', notes: `${facts}. Closing a shop or trade window abandons that transaction` };
        }
        if (s.player && s.player.hp < s.player.maxHp && s.inventory.some(i => FOOD_RE.test(i.name))) {
            acts.eat_food = { what: `eat one piece of food now (${s.inventory.filter(i => FOOD_RE.test(i.name)).map(i => i.name).slice(0, 3).join(', ')}) without stopping the running action`, where: 'right here', requires: 'food in inventory', gives: `restores hitpoints (currently ${s.player.hp}/${s.player.maxHp})`, notes: `${facts}. Eating takes one game tick; the running action continues afterwards` };
        }
        return acts;
    }

    /** Execute the per-tick action Jev chose (everything except restart_current, which the caller handles). */
    async function intervene(s: BotWorldState, choice: Choice) {
        if (choice.failed || choice.intervention === 'do_nothing' || choice.intervention === RESTART_KEY) return;
        if (choice.intervention === 'close_dialog') {
            note('Jev closed the open dialog');
            log('this tick: close_dialog');
            try {
                if (s.dialog.isOpen && s.dialog.options.length > 1) await sdk.sendClickDialog(s.dialog.options[0].index);
                else await bot.dismissBlockingUI();
            } catch { /* ignore */ }
            return;
        }
        if (choice.intervention === 'eat_food') {
            const food = s.inventory.find(i => FOOD_RE.test(i.name));
            if (!food) return;
            note(`Jev ate ${food.name}`);
            log(`this tick: eat_food (${food.name})`);
            await bot.eatFood(food).catch(() => undefined);
        }
    }

    async function choose(s: BotWorldState, cands: ActionSpec[], criteria: Record<string, CandidateDescription>, snapshot: unknown, current: ActiveRun | null): Promise<Choice> {
        const empty: Choice = { chosen: null, probability: null, probabilities: null, confidence: null, eatFirst: null, jevSeconds: null, inTok: 0, outTok: 0, failed: false, pollIn: 1, restart: false, intervention: 'do_nothing', interventions: null };
        if (opts.policy === 'jev' && jev) {
            const questions = buildQuestions(ctx, s, criteria, opts.burstMs, mode, current?.spec.key ?? null, mode === 'tick' ? tickActions(s, current) : null, pollEvery);
            const before = { i: jev.usage.input_tokens, o: jev.usage.output_tokens };
            let res;
            try {
                res = await jev.ask(snapshot, questions, { decision: n + 1, tick: s.tick, skill: opts.skill });
            } catch (err) {
                const msg = (err as Error).message;
                if (/timeout|abort/i.test(msg)) jevTimeouts++;
                if (mode === 'burst') log(`jev call failed: ${msg}; falling back to the first candidate`);
                return { ...empty, chosen: mode === 'burst' ? cands[0] : null, failed: true };
            }
            const ans = res.answers.next_action as ChoiceAnswer | undefined;
            const byKey = new Map(cands.map(c => [c.key, c]));
            let key = ans?.choice ?? '';
            if (!byKey.has(key)) {
                const ranked = Object.entries(ans?.probabilities ?? {}).filter(([k]) => byKey.has(k)).sort((a, b) => b[1] - a[1]);
                key = ranked[0]?.[0] ?? cands[0].key;
                log(`jev returned an out-of-catalog key "${ans?.choice}"; using ${key}`);
            }
            const eat = res.answers.eat_first as NoulAnswer | undefined;
            const poll = res.answers.poll_again_in_ticks as ChoiceAnswer | undefined;
            const pollIn = Math.min(10, Math.max(1, parseInt(poll?.choice ?? '1', 10) || 1));
            const tickAns = res.answers.this_tick as ChoiceAnswer | undefined;
            const offered = questions.this_tick ? Object.keys((questions.this_tick as { criteria: Record<string, unknown> }).criteria) : [];
            let intervention = tickAns?.choice ?? 'do_nothing';
            if (!offered.includes(intervention)) {
                const ranked = Object.entries(tickAns?.probabilities ?? {}).filter(([k]) => offered.includes(k)).sort((a, b) => b[1] - a[1]);
                intervention = ranked[0]?.[0] ?? 'do_nothing';
            }
            return {
                pollIn,
                restart: intervention === RESTART_KEY,
                intervention,
                interventions: tickAns?.probabilities ?? null,
                chosen: byKey.get(key)!,
                probability: ans?.probabilities?.[key] ?? null,
                probabilities: ans?.probabilities ?? null,
                confidence: ans?.confidence ?? null,
                eatFirst: eat?.noul ?? null,
                jevSeconds: +res.seconds.toFixed(3),
                inTok: jev.usage.input_tokens - before.i,
                outTok: jev.usage.output_tokens - before.o,
                failed: false,
            };
        }
        // Non-model policies: in tick mode they only choose when nothing is running,
        // otherwise a random policy would switch every tick.
        if (mode === 'tick' && current) return { ...empty, chosen: current.spec };
        if (opts.policy === 'random') return { ...empty, chosen: cands[Math.floor(rand() * cands.length)] };
        return { ...empty, chosen: cands[0] };
    }

    /** Narrow noul composed in code: eat before/while acting when Jev says so (at most once per 5 s). */
    async function maybeEat(s: BotWorldState, choice: Choice, key: string) {
        if (choice.eatFirst === null || choice.eatFirst < 0.6 || key === 'eat_food') return;
        if (Date.now() - lastEatAt < 5000) return;
        const food = s.inventory.find(i => FOOD_RE.test(i.name));
        if (!food) return;
        lastEatAt = Date.now();
        log(`eat_first=${choice.eatFirst.toFixed(2)}: eating ${food.name} before ${key}`);
        await bot.eatFood(food).catch(() => undefined);
    }

    function startRun(s: BotWorldState, chosen: ActionSpec, cands: ActionSpec[], criteria: Record<string, CandidateDescription>, choice: Choice): ActiveRun {
        n++;
        const c = choice;
        log(`#${n} ${chosen.key}  (p=${c.probability?.toFixed(2) ?? '-'} conf=${c.confidence?.toFixed(2) ?? '-'} of ${cands.length} options; ${opts.skill} lvl ${level(s, opts.skill)} xp ${xpOf(s, opts.skill)})`);
        emit({
            type: 'decision', n, elapsed_s: elapsedS(), mode,
            choice: chosen.key, description: criteria[chosen.key], probability: c.probability, probabilities: c.probabilities, confidence: c.confidence, eat_first: c.eatFirst,
            jev_seconds: c.jevSeconds, input_tokens: c.inTok, output_tokens: c.outTok, policy: opts.policy,
            candidates: cands.map(x => x.key), skill_level: level(s, opts.skill), skill_xp: xpOf(s, opts.skill), burst_ms: mode === 'burst' ? opts.burstMs : null,
        });
        const controller = new AbortController();
        act.lastAnimAt = Date.now(); // a fresh action counts as activity: idle is measured from here
        ctx.notes.phase = 'starting';
        note(`started ${chosen.key} (${criteria[chosen.key]?.what ?? chosen.key})`);
        // Each run gets its own ctx so an aborted run never observes the next run's signal.
        const runCtx: Ctx = { ...ctx, signal: controller.signal };
        const xpNow = xpOf(s, opts.skill);
        const run: ActiveRun = {
            n, spec: chosen, startedAt: Date.now(), xpAtStart: xpNow, xpEvents: 0, lastXpAt: Date.now(), lastXp: xpNow,
            controller, outcome: null, candidates: cands.map(x => x.key), choice, description: criteria[chosen.key],
            promise: Promise.resolve().then(() => chosen.run(runCtx, mode === 'burst' ? opts.burstMs : Number.POSITIVE_INFINITY))
                .catch((err): Outcome => ({ ok: false, message: `exception: ${(err as Error).message}`, reps: 0, xpGained: 0, seconds: 0, stop: 'failed' })),
        };
        run.promise = run.promise.then(o => { run.outcome = o; return o; });
        actionCounts[chosen.key] = (actionCounts[chosen.key] ?? 0) + 1;
        return run;
    }

    /** Book-keeping once a run has ended (by itself, by the budget, or because Jev switched). */
    function finalize(run: ActiveRun, outcome: Outcome) {
        const key = run.spec.key;
        log(`   -> ${outcome.stop} ok=${outcome.ok} reps=${outcome.reps} xp=+${outcome.xpGained} ${outcome.seconds}s ${outcome.message}`.trimEnd());
        history.push({ action: key, outcome: `${outcome.stop}${outcome.message ? ': ' + outcome.message : ''}`, xp_gained: outcome.xpGained, seconds: outcome.seconds });
        if (history.length > RECENT_ACTIONS) history.shift();
        actionXp[key] = (actionXp[key] ?? 0) + outcome.xpGained;

        // Suppression rules (code, not the model): repeated dead ends are removed for a while.
        // A switch is not a dead end.
        const noProgress = !outcome.ok && outcome.stop !== 'switched';
        if (noProgress) {
            const c = (consecutiveNoProgress.get(key) ?? 0) + 1;
            consecutiveNoProgress.set(key, c);
            if (c >= 2) {
                suppressedUntil.set(key, Date.now() + SUPPRESS_MS);
                consecutiveNoProgress.delete(key);
                log(`   suppressing ${key} for ${SUPPRESS_MS / 1000}s after repeated dead ends`);
            } else if (outcome.seconds < 1) {
                // An action that dead-ends instantly must not be restarted on the very next tick.
                suppressedUntil.set(key, Date.now() + 3000);
            }
        } else if (outcome.stop !== 'switched') {
            consecutiveNoProgress.delete(key);
        }
        if (key === lastKey) {
            sameKeyStreak++;
            sameKeyXp += outcome.xpGained;
        } else {
            lastKey = key;
            sameKeyStreak = 1;
            sameKeyXp = outcome.xpGained;
        }
        if (sameKeyStreak >= 3 && sameKeyXp === 0 && outcome.stop !== 'switched' && !/^(set_combat_style|equip_|buy_|pick_up|sell_|tan_|light_)/.test(key)) {
            suppressedUntil.set(key, Date.now() + SUPPRESS_MS);
            log(`   suppressing ${key} for ${SUPPRESS_MS / 1000}s: chosen ${sameKeyStreak} times in a row with no ${opts.skill} XP`);
            sameKeyStreak = 0;
            sameKeyXp = 0;
        }

        const s = state(sdk);
        const rec: DecisionRecord = {
            n: run.n,
            ts: new Date().toISOString(),
            elapsed_s: elapsedS(),
            candidates: run.candidates,
            choice: key,
            probability: run.choice.probability,
            confidence: run.choice.confidence,
            eat_first: run.choice.eatFirst,
            jev_seconds: run.choice.jevSeconds,
            input_tokens: run.choice.inTok,
            output_tokens: run.choice.outTok,
            outcome,
            skill_level: level(s, opts.skill),
            skill_xp: xpOf(s, opts.skill),
        };
        try { appendFileSync(decisionsPath, JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
        emit({
            type: 'outcome', n: run.n, elapsed_s: rec.elapsed_s, choice: key, outcome,
            skill_level: rec.skill_level, skill_xp: rec.skill_xp, xp_gained_total: rec.skill_xp - xpStart, peak: peakNormalized(),
            ...jevStats(), deaths, suppressed: [...suppressedUntil.keys()],
        });
    }

    /** Stop a running action now (Jev chose something else, or the task ended). */
    async function stopRun(run: ActiveRun, reason: string): Promise<Outcome> {
        run.controller.abort();
        const settled = await Promise.race([run.promise, sleep(3000).then(() => null)]);
        if (settled) return settled.stop === 'switched' || settled.stop === 'deadline' ? settled : { ...settled, stop: 'switched', message: reason };
        const s = state(sdk);
        return { ok: true, message: `${reason} (the action did not stop within 3 s)`, reps: run.xpEvents, xpGained: xpOf(s, opts.skill) - run.xpAtStart, seconds: +((Date.now() - run.startedAt) / 1000).toFixed(1), stop: 'switched' };
    }

    function snapshotFor(s: BotWorldState, current: ActiveRun | null, status: PlayerStatus) {
        return buildSnapshot(ctx, s, {
            status,
            recentEvents: recentEvents(),
            minutesTotal: opts.minutes,
            elapsedMs: Date.now() - startedAt,
            history,
            xpStart,
            peak: peakNormalized(),
            burstSec: Math.round(opts.burstMs / 1000),
            mode,
            current: current ? {
                action: current.spec.key,
                what: current.description.what,
                running_for_seconds: +((Date.now() - current.startedAt) / 1000).toFixed(1),
                xp_gained_by_it: xpOf(s, opts.skill) - current.xpAtStart,
                xp_events: current.xpEvents,
                seconds_since_last_xp: +((Date.now() - current.lastXpAt) / 1000).toFixed(1),
                player_status: status.status,
                idle_for_seconds: status.idle_for_seconds,
                phase: String(ctx.notes.phase ?? 'working'),
            } : null,
        });
    }

    // ── burst mode: the benchmark loop ─────────────────────────────────────
    if (mode === 'burst') {
        while (Date.now() < deadline - 500) {
            const s = state(sdk);
            if (!(await safety(s))) continue;
            const cands = pickCandidates(s);
            if (cands.length === 0) {
                log('no candidate actions at all; waiting 3s');
                await sleep(3000);
                continue;
            }
            const snapshot = snapshotFor(s, null, playerStatus(s));
            const criteria = describeCandidates(ctx, s, cands);
            emit({ type: 'deciding', n: n + 1, elapsed_s: elapsedS(), snapshot, candidates: cands.map(c => ({ key: c.key, ...criteria[c.key] })) });
            const choice = await choose(s, cands, criteria, snapshot, null);
            const chosen = choice.chosen ?? cands[0];
            await maybeEat(s, choice, chosen.key);
            const run = startRun(s, chosen, cands, criteria, choice);
            const outcome = await run.promise;
            // An action that dead-ends instantly must not turn the loop into an API spin.
            if (!outcome.ok && outcome.seconds < 1) await sleep(2000);
            finalize(run, outcome);
        }
    }

    // ── tick mode: re-decide every game tick ──────────────────────────────
    if (mode === 'tick') {
        let current: ActiveRun | null = null;
        let lastTick = state(sdk).tick;
        let lastCandidateKeys = '';
        let pollWait = 0;   // ticks left before Jev is asked again
        let lastPollIn = 1;

        /** Jev chose restart_current: stop the running action and start it again (re-click its target). */
        const restartCurrent = async (choice: Choice) => {
            if (!current) return;
            const spec = current.spec;
            log(`Jev chose ${RESTART_KEY}: restarting ${spec.key} after ${Math.round((Date.now() - current.startedAt) / 1000)} s`);
            note(`Jev restarted ${spec.key} (re-clicking its target)`);
            const outcome = await stopRun(current, 'restarted by Jev');
            restarts++;
            finalize(current, outcome);
            const s2 = state(sdk);
            const cands = pickCandidates(s2);
            const criteria = describeCandidates(ctx, s2, cands);
            current = startRun(s2, spec, cands.length ? cands : [spec], criteria[spec.key] ? criteria : { ...criteria, [spec.key]: current.description }, choice);
        };
        while (Date.now() < deadline - 500) {
            // Wait for the next game tick (wall-clock fallback if the state stalls).
            try { await sdk.waitForCondition(st => st.tick !== lastTick, TICK_MS * 3); } catch { /* fall through */ }
            const s = state(sdk);
            lastTick = s.tick;
            ticks++;
            trackActivity(s);
            const ps = playerStatus(s);

            if (current) {
                const xpNow = xpOf(s, opts.skill);
                if (xpNow > current.lastXp) { current.xpEvents++; current.lastXpAt = Date.now(); current.lastXp = xpNow; }
                if (current.outcome) {
                    // The action stopped by itself (done, exhausted, failed).
                    finalize(current, current.outcome);
                    current = null;
                }
            }
            if (!(await safety(s))) continue;

            // Jev asked to wait: keep the action running, watch for a stuck target, ask again later.
            if (current && pollWait > 0) {
                pollWait--;
                pollsSkipped++;
                emit({
                    type: 'tick', tick: s.tick, ticks, elapsed_s: elapsedS(), n: current.n, current: current.spec.key,
                    running_for_s: +((Date.now() - current.startedAt) / 1000).toFixed(1),
                    player_status: ps.status, idle_for_s: ps.idle_for_seconds, since_xp_s: ps.seconds_since_last_xp, since_msg_s: ps.seconds_since_last_message, last_msg: ps.last_message,
                    restarted: false, phase: String(ctx.notes.phase ?? 'working'), poll_every: pollEvery, polled: false, poll_in: lastPollIn, poll_wait: pollWait,
                    choice: current.spec.key, kept: true, timed_out: false, jev_seconds: null, probabilities: null, confidence: null, eat_first: null,
                    ...jevStats(), skill_level: level(s, opts.skill), skill_xp: xpOf(s, opts.skill), xp_gained_total: xpOf(s, opts.skill) - xpStart,
                    peak: peakNormalized(), kept_total: kept, switched_total: switched, timeouts_total: jevTimeouts, restarts_total: restarts, polls_skipped: pollsSkipped,
                });
                continue;
            }
            pollWait = 0;

            const cands = pickCandidates(s);
            if (cands.length === 0) {
                if (ticks % 25 === 0) log('no candidate actions at all');
                continue;
            }
            const criteria = describeCandidates(ctx, s, cands);
            if (current) {
                const cur = criteria[current.spec.key];
                const ranFor = Math.round((Date.now() - current.startedAt) / 1000);
                const phase = String(ctx.notes.phase ?? 'working');
                const facts = `it has run for ${ranFor} s (${phase}), produced ${current.xpEvents} XP drops, last XP ${ps.seconds_since_last_xp} s ago; ${statusFacts(ps)}`;
                if (cur) cur.notes = `CURRENT: the bot is doing this right now; ${facts}. Choosing it again keeps it running without interruption; the separate this_tick question is where you close a dialog, eat or restart it without changing what it works on. ${cur.notes}`;
            }
            const snapshot = snapshotFor(s, current, ps);
            const candKeys = Object.keys(criteria).join(',');
            const candidatesChanged = candKeys !== lastCandidateKeys;
            lastCandidateKeys = candKeys;

            const choice = await choose(s, cands, criteria, snapshot, current);
            const chosenKey = choice.chosen?.key ?? null;
            const keep = !!current && (chosenKey === null || chosenKey === current.spec.key);
            if (keep) kept++;
            if (!choice.failed) lastPollIn = choice.pollIn;
            const idleRestart = keep && choice.restart;
            emit({
                type: 'tick', tick: s.tick, ticks, elapsed_s: elapsedS(), n: current?.n ?? null, current: current?.spec.key ?? null,
                running_for_s: current ? +((Date.now() - current.startedAt) / 1000).toFixed(1) : null,
                player_status: ps.status, idle_for_s: ps.idle_for_seconds, since_xp_s: ps.seconds_since_last_xp, since_msg_s: ps.seconds_since_last_message, last_msg: ps.last_message, restarted: idleRestart, phase: String(ctx.notes.phase ?? 'working'),
                poll_every: pollEvery, polled: true, poll_in: choice.failed ? lastPollIn : choice.pollIn, poll_wait: choice.failed ? pollEvery - 1 : Math.max(pollEvery, choice.pollIn) - 1, polls_skipped: pollsSkipped,
                choice: chosenKey, kept: keep, timed_out: choice.failed, jev_seconds: choice.jevSeconds, probabilities: choice.probabilities, confidence: choice.confidence,
                eat_first: choice.eatFirst, ...jevStats(), skill_level: level(s, opts.skill), skill_xp: xpOf(s, opts.skill), xp_gained_total: xpOf(s, opts.skill) - xpStart,
                peak: peakNormalized(), kept_total: kept, switched_total: switched, timeouts_total: jevTimeouts, restarts_total: restarts,
                intervention: choice.failed ? null : choice.intervention, interventions: choice.interventions,
                candidates: candidatesChanged ? Object.keys(criteria).map(k => ({ key: k, what: criteria[k]?.what ?? k })) : undefined,
            });
            if (idleRestart && current) {
                await restartCurrent(choice);
                pollWait = Math.max(pollEvery, choice.pollIn) - 1;
                continue;
            }
            if (keep) {
                await intervene(s, choice);
                pollWait = choice.failed ? pollEvery - 1 : Math.max(pollEvery, choice.pollIn) - 1;
                continue;
            }
            if (!choice.chosen) continue; // nothing running and no usable answer this tick

            if (current) {
                note(`Jev switched from ${current.spec.key} to ${choice.chosen.key}`);
                const outcome = await stopRun(current, `switched by Jev to ${choice.chosen.key} after ${Math.round((Date.now() - current.startedAt) / 1000)} s`);
                switched++;
                finalize(current, outcome);
                current = null;
            }
            emit({ type: 'deciding', n: n + 1, elapsed_s: elapsedS(), snapshot, candidates: cands.map(c => ({ key: c.key, ...criteria[c.key] })) });
            await intervene(s, choice);
            current = startRun(state(sdk), choice.chosen, cands, criteria, choice);
            pollWait = Math.max(pollEvery, choice.pollIn) - 1;
        }
        if (current) {
            const outcome = await stopRun(current, 'task time is over');
            finalize(current, { ...outcome, stop: 'deadline' });
        }
    }

    clearInterval(sampler);
    clearInterval(tracker);
    const final = state(sdk);
    samples.push({ t: Date.now(), xp: xpOf(final, opts.skill) });
    const summary: Summary = {
        skill: opts.skill,
        minutes: opts.minutes,
        policy: opts.policy,
        mode,
        model: jev?.modelVersion ?? (opts.policy === 'jev' ? opts.model ?? 'jev-latest' : null),
        decisions: n,
        xp_start: xpStart,
        xp_end: xpOf(final, opts.skill),
        xp_gained: xpOf(final, opts.skill) - xpStart,
        level_start: levelStart,
        level_end: level(final, opts.skill),
        peak_window_xp_per_min_normalized: peakNormalized(),
        jev_calls: jev?.usage.calls ?? 0,
        jev_input_tokens: jev?.usage.input_tokens ?? 0,
        jev_output_tokens: jev?.usage.output_tokens ?? 0,
        jev_cost_usd: +(jev?.costUsd() ?? 0).toFixed(5),
        jev_seconds: +(jev?.usage.seconds ?? 0).toFixed(1),
        jev_timeouts: jevTimeouts,
        ticks,
        kept,
        switched,
        restarts,
        polls_skipped: pollsSkipped,
        action_counts: actionCounts,
        action_xp: actionXp,
        deaths,
    };
    writeFileSync(join(opts.logDir, 'summary.json'), JSON.stringify(summary, null, 2));
    emit({ type: 'summary', summary });
    log(`done: ${summary.xp_gained} ${opts.skill} XP in ${n} decisions${mode === 'tick' ? ` over ${ticks} ticks (${kept} kept, ${switched} switched, ${restarts} restarted, ${jevTimeouts} timeouts)` : ''}; own peak window ≈ ${summary.peak_window_xp_per_min_normalized} normalized XP/min; jev ${summary.jev_calls} calls, ${summary.jev_input_tokens} input tokens, $${summary.jev_cost_usd}`);
    try { await sdk.disconnect(); } catch { /* ignore */ }
    return summary;
}

function state(sdk: BotSDK): BotWorldState {
    const s = sdk.getState();
    if (!s) throw new Error('no world state');
    return s;
}

function groupNearby<T extends { name: string; distance: number }>(items: T[], limit: number, extra?: (t: T) => Record<string, unknown>) {
    const byName = new Map<string, { name: string; count: number; nearest_distance: number; sample: T }>();
    for (const it of items) {
        const g = byName.get(it.name);
        if (!g) byName.set(it.name, { name: it.name, count: 1, nearest_distance: Math.round(it.distance), sample: it });
        else {
            g.count++;
            if (it.distance < g.nearest_distance) { g.nearest_distance = Math.round(it.distance); g.sample = it; }
        }
    }
    return [...byName.values()]
        .sort((a, b) => a.nearest_distance - b.nearest_distance)
        .slice(0, limit)
        .map(g => ({ name: g.name, count: g.count, nearest_distance: g.nearest_distance, ...(extra ? extra(g.sample) : {}) }));
}

interface CurrentActivity {
    action: string;
    what: string;
    running_for_seconds: number;
    xp_gained_by_it: number;
    xp_events: number;
    seconds_since_last_xp: number;
    player_status: PlayerStatus['status'];
    idle_for_seconds: number;
    /** What the action's script is doing: starting, walking to (x, z), working. */
    phase: string;
}

function buildSnapshot(
    ctx: Ctx,
    s: BotWorldState,
    p: { minutesTotal: number; elapsedMs: number; history: Array<{ action: string; outcome: string; xp_gained: number; seconds: number }>; xpStart: number; peak: number; burstSec: number; mode: Mode; current: CurrentActivity | null; status: PlayerStatus; recentEvents: string[] },
) {
    const near = nearestHub(s);
    const skillLevels: Record<string, number> = {};
    for (const name of SKILL_NAMES) skillLevels[name] = level(s, name);
    const cs = s.combatStyle;
    const currentStyle = cs?.known ? cs.styles.find(st => st.index === cs.currentStyle) : undefined;
    const last = p.history[p.history.length - 1];
    const cadence = p.mode === 'tick'
        ? { decision_cadence: `you are asked again every game tick (${TICK_MS} ms); the option marked CURRENT keeps running if you choose it again, any other choice stops it and starts the new action at once` }
        : { each_action_runs_for_seconds: p.burstSec };
    return {
        task: {
            skill: ctx.skill,
            goal: `gain ${ctx.skill} XP as fast as possible`,
            scoring: `only the best 15-second window of ${ctx.skill} XP counts; XP in other skills does not count`,
            minutes_total: p.minutesTotal,
            minutes_elapsed: +(p.elapsedMs / 60_000).toFixed(1),
            minutes_remaining: +Math.max(0, (p.minutesTotal * 60_000 - p.elapsedMs) / 60_000).toFixed(1),
            ...cadence,
            xp_multiplier: 'the server multiplies every XP reward by 25; XP numbers inside the options are base values before that multiplier',
            movement: GAME_SPEED === 1 ? 'the game runs at normal speed: walking covers roughly 3 to 5 tiles per second' : `the game runs at ${GAME_SPEED}x speed, so walking is fast: roughly ${Math.round(3 * GAME_SPEED)} to ${Math.round(5 * GAME_SPEED)} tiles per second`,
        },
        current_activity: p.current
            ? { ...p.current, note: 'this action is running now; choosing it again keeps it going, choosing another stops it. Skilling is silent between attempts: a cast net or a swung axe shows no animation until the next attempt, so a short quiet spell is normal' }
            : { action: null, note: 'the bot is idle; whatever you choose starts now' },
        recent_events: p.recentEvents,
        player: {
            status: p.status.status,
            status_meaning: 'what the character is doing this very moment: under_attack = lost hitpoints in the last 6 s (see damage_taken_last_10s; a low-level character dies in a few hits), skilling = the game is still working on a fishing spot, tree or rock for the player (the target stays set even when attempts fail silently; a new click interrupts it), in_combat = has another target, animating = skilling or fighting animation, moving = walking, idle = no animation, movement, dialog, target, XP or server message. Skilling is silent between attempts (net fishing at a low level can take 10-20 s per catch with nothing visible); a target that moved or vanished stays silent until it is re-clicked',
            hitpoints_now: p.status.hitpoints,
            damage_taken_last_10s: p.status.damage_taken_last_10s,
            seconds_since_last_damage: p.status.seconds_since_last_damage,
            target: p.status.target,
            idle_for_seconds: p.status.idle_for_seconds,
            seconds_since_last_xp: p.status.seconds_since_last_xp,
            seconds_since_last_server_message: p.status.seconds_since_last_message,
            last_server_message: p.status.last_message,
            position: { x: s.player?.worldX, z: s.player?.worldZ, nearest_known_place: near.hub.label, distance_to_it: near.dist },
            hitpoints: `${s.player?.hp}/${s.player?.maxHp}`,
            combat_level: s.player?.combatLevel,
            in_combat: s.player?.combat.inCombat ?? false,
            dialog_open: s.dialog.isOpen,
            dialog: s.dialog.isOpen
                ? { text: s.dialog.text?.replace(/\s+/g, ' ').slice(0, 160) ?? null, options: s.dialog.options.map(o => o.text).slice(0, 5), note: 'an open dialog stops skilling until it is closed; the close_dialog option closes it' }
                : (s.interface.isOpen ? { interface_open: true, note: 'an interface window is open; the close_dialog option closes it' } : null),
        },
        target_skill: { name: ctx.skill, level: level(s, ctx.skill), xp: xpOf(s, ctx.skill), xp_gained_this_task: xpOf(s, ctx.skill) - p.xpStart },
        skill_levels: skillLevels,
        inventory: {
            items: s.inventory.map(i => ({ name: i.name, count: i.count })),
            free_slots: freeSlots(s),
            coins: coins(s),
        },
        equipment: s.equipment.map(i => (i.count > 1 ? `${i.name} x${i.count}` : i.name)),
        combat_style: cs?.known
            ? { current: currentStyle?.name ?? 'unknown', trains: currentStyle?.trainsSkills ?? [], weapon: cs.weaponName, available: cs.styles.map(st => ({ name: st.name, trains: st.trainsSkills })) }
            : 'unknown',
        nearby: {
            npcs: groupNearby(s.nearbyNpcs, 10, n => ({ options: n.options.filter(Boolean).slice(0, 4) })),
            objects: groupNearby(s.nearbyLocs.filter(l => l.options.some(Boolean)), 12, l => ({ options: l.options.filter(Boolean).slice(0, 3) })),
            ground_items: groupNearby(s.groundItems, 6),
        },
        recent_game_messages: s.gameMessages.filter(m => m.type === 0).slice(-6).map(m => m.text),
        recent_actions: p.history.map(h => ({ action: h.action, result: h.outcome, [`${ctx.skill.toLowerCase()}_xp_gained`]: h.xp_gained, seconds: h.seconds })),
        progress: {
            best_15s_window_so_far_xp_per_min: p.peak,
            last_action_xp_per_min: last && last.seconds > 0 ? Math.round((last.xp_gained / last.seconds) * 60 / NORMALIZATION) : 0,
            note: 'rates are normalized to real-game XP per minute',
        },
        reference: REFERENCE[ctx.skill] ?? {},
    };
}

function describeCandidates(ctx: Ctx, s: BotWorldState, cands: ActionSpec[]): Record<string, CandidateDescription> {
    const criteria: Record<string, CandidateDescription> = {};
    for (const c of cands) {
        try {
            criteria[c.key] = c.describe(s, ctx);
        } catch (err) {
            criteria[c.key] = { what: c.key, where: 'unknown', requires: 'unknown', gives: 'unknown', notes: `describe failed: ${(err as Error).message}` };
        }
    }
    return criteria;
}

function buildQuestions(ctx: Ctx, s: BotWorldState, criteria: Record<string, CandidateDescription>, burstMs: number, mode: Mode, currentKey: string | null, tickActions: Record<string, CandidateDescription> | null = null, pollEvery = 1): Record<string, JevQuestion> {
    const every = pollEvery === 1 ? 'game tick' : `${pollEvery} game ticks (${(pollEvery * TICK_MS / 1000).toFixed(1)} s)`;
    const cadence = mode === 'tick'
        ? (currentKey
            ? `You are asked again every ${every}. This question is about what the bot should be working on. The option "${currentKey}" is what it is doing right now (see current_activity, recent_events and its notes); choosing it again keeps it running untouched. Any other choice stops it and starts the new action at once and throws away the walking and set-up already done. Closing a dialog, eating or restarting the running action are NOT choices here: they are answered in the separate this_tick question.`
            : 'You are asked again every ${every}. Nothing is running right now; whatever you choose starts at once.')
        : `Each option runs for about ${Math.round(burstMs / 1000)} seconds and then you choose again; walking to a far place spends part of that time.`;
    const questions: Record<string, JevQuestion> = {
        next_action: {
            type: 'choice',
            instructions: {
                question: `Which action should the bot run ${mode === 'tick' ? 'now' : 'next'} to reach the highest ${ctx.skill} XP per minute?`,
                focus: [
                    `Only ${ctx.skill} XP counts. XP in any other skill is worth nothing unless it unlocks faster ${ctx.skill} XP soon.`,
                    'The score is the best XP gained in any single 15-second window, so reach the fastest sustainable activity and stay in it.',
                    cadence,
                    'Every XP number in the options is a base value; the server multiplies all XP by the same factor, so compare them relative to each other.',
                    'Compare each option\'s `requires`, `gives` and `where` against `player`, `target_skill`, `inventory` and `recent_actions`.',
                    'An option that just failed twice in `recent_actions` for the same reason is unlikely to work now.',
                ],
            },
            criteria,
        },
    };
    if (mode === 'tick' && tickActions) {
        questions.this_tick = {
            type: 'choice',
            instructions: {
                question: 'What, if anything, should the bot do right now, this tick, without changing what it is working on?',
                focus: [
                    'do_nothing is the normal answer: the running action continues by itself.',
                    'Use close_dialog when a dialog or window is open (a level-up message pauses skilling until it is closed); the running action then carries on.',
                    'Use eat_food when hitpoints are low enough that the next hit or stun could kill the bot.',
                    `Use ${RESTART_KEY} when the running action has gone quiet for longer than a normal attempt (see current_activity.seconds_since_last_xp, player.status and recent_events) or the server said the target cannot be reached; it re-clicks the target.`,
                ],
            },
            criteria: tickActions,
        };
    }
    if (mode === 'tick') {
        const secs = (n: number) => `${(n * TICK_MS / 1000).toFixed(1)} s`;
        const pollChoices = [...new Set([pollEvery, pollEvery * 2, 5, 10].filter(n => n >= pollEvery && n <= 10))].sort((a, b) => a - b);
        questions.poll_again_in_ticks = {
            type: 'choice',
            instructions: {
                question: 'After the chosen action starts or continues, how many game ticks should pass before you are asked again?',
                focus: [
                    `One tick is ${secs(1)}. Asking every tick costs a call each time; a longer gap means a stuck or finished action is noticed later.`,
                    'Ask again soon when the situation is about to change (a walk about to arrive, a dialog open, low hitpoints, inventory nearly full); wait longer when the bot is settled into a steady activity.',
                ],
            },
            criteria: Object.fromEntries(pollChoices.map(n => [String(n), n === pollEvery ? `ask again at the normal cadence, in ${n} tick${n > 1 ? 's' : ''} (${secs(n)})` : `ask again in ${n} ticks (${secs(n)})`])),
        };
    }
    if (mode === 'burst' && s.player && s.player.hp < s.player.maxHp * 0.5 && s.inventory.some(i => FOOD_RE.test(i.name))) {
        questions.eat_first = {
            type: 'noul',
            instructions: {
                question: 'Should the bot eat one piece of food before running the chosen action?',
                inspect: '`player.hitpoints` and `nearby.npcs`',
            },
            criteria: {
                true: 'hitpoints are low enough that the next fight or stun could kill the bot',
                false: 'hitpoints are fine for what comes next, or nothing nearby can hurt the bot',
            },
        };
    }
    return questions;
}
