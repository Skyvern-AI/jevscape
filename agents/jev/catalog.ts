// Macro-action catalog for the Jev controller.
//
// Jev cannot write code, so the harness owns every actuator. Each ActionSpec
// is a bounded, deterministic routine built from rs-sdk `bot.*` / `sdk.*`
// calls. Jev's only job is to pick which one runs next, from the subset whose
// hard preconditions (level, required items, coins) are met right now.
//
// The descriptions deliberately state FACTS (level required, XP per unit,
// distance, what it consumes / produces) and never rank the options; ranking
// is the judgment under test.

import type { BotSDK } from '../../sdk/index';
import type { BotActions } from '../../sdk/actions';
import type { BotWorldState, NearbyNpc, NearbyLoc, InventoryItem } from '../../sdk/types';
import { Spells } from '../../sdk/spells';

// ───────────────────────────── hubs ─────────────────────────────

export interface Hub { key: string; x: number; z: number; label: string }

export const HUBS = {
    lumbridge_spawn: { key: 'lumbridge_spawn', x: 3222, z: 3218, label: 'Lumbridge castle courtyard' },
    lumbridge_trees: { key: 'lumbridge_trees', x: 3195, z: 3220, label: 'regular trees west of Lumbridge castle' },
    lumbridge_oaks: { key: 'lumbridge_oaks', x: 3206, z: 3261, label: 'oak trees north-west of Lumbridge castle' },
    lumbridge_willows: { key: 'lumbridge_willows', x: 3233, z: 3241, label: 'willow trees on the river bank just north of Lumbridge castle' },
    lumbridge_yews: { key: 'lumbridge_yews', x: 3158, z: 3225, label: 'yew trees on the road between Lumbridge and Draynor' },
    draynor_fishing: { key: 'draynor_fishing', x: 3087, z: 3230, label: 'Draynor shore net/bait fishing spots' },
    lumbridge_river_spots: { key: 'lumbridge_river_spots', x: 3241, z: 3249, label: 'lure fishing spots on the river east of Lumbridge castle' },
    port_sarim_gerrant: { key: 'port_sarim_gerrant', x: 3013, z: 3225, label: "Gerrant's fishing shop in Port Sarim" },
    lumbridge_range: { key: 'lumbridge_range', x: 3209, z: 3215, label: 'cooking range in the Lumbridge castle kitchen' },
    draynor_fireplace: { key: 'draynor_fireplace', x: 3100, z: 3256, label: 'fireplace in Draynor village' },
    varrock_se_mine: { key: 'varrock_se_mine', x: 3285, z: 3365, label: 'south-east Varrock mine (copper, tin, iron rocks)' },
    lumbridge_furnace: { key: 'lumbridge_furnace', x: 3225, z: 3256, label: 'Lumbridge furnace' },
    varrock_anvil: { key: 'varrock_anvil', x: 3188, z: 3421, label: 'anvils in west Varrock smithy' },
    lumbridge_general_store: { key: 'lumbridge_general_store', x: 3211, z: 3246, label: 'Lumbridge general store' },
    bobs_axes: { key: 'bobs_axes', x: 3231, z: 3204, label: 'Bob\'s Brilliant Axes in Lumbridge' },
    lumbridge_castle_men: { key: 'lumbridge_castle_men', x: 3222, z: 3218, label: 'men and women around Lumbridge castle' },
    lumbridge_chickens: { key: 'lumbridge_chickens', x: 3233, z: 3296, label: 'chicken pen north of Lumbridge' },
    lumbridge_cows: { key: 'lumbridge_cows', x: 3253, z: 3290, label: 'cow field north-east of Lumbridge' },
    lumbridge_goblins: { key: 'lumbridge_goblins', x: 3252, z: 3230, label: 'goblins east of Lumbridge castle' },
    lumbridge_rats: { key: 'lumbridge_rats', x: 3195, z: 3205, label: 'giant rats south-west of Lumbridge castle' },
    knife_spawn: { key: 'knife_spawn', x: 3224, z: 3202, label: 'knife ground spawn south-east of Lumbridge castle' },
    draynor_bank: { key: 'draynor_bank', x: 3092, z: 3243, label: 'Draynor bank' },
    varrock_west_bank: { key: 'varrock_west_bank', x: 3185, z: 3436, label: 'Varrock west bank' },
    aubury_runes: { key: 'aubury_runes', x: 3253, z: 3402, label: 'Aubury\'s rune shop in east Varrock' },
    al_kharid_gate: { key: 'al_kharid_gate', x: 3267, z: 3228, label: 'Al Kharid toll gate (10 coins)' },
    varrock_south_farmers: { key: 'varrock_south_farmers', x: 3227, z: 3290, label: 'farmers in the fields south of Varrock' },
    al_kharid_warriors: { key: 'al_kharid_warriors', x: 3282, z: 3176, label: 'Al Kharid warriors in the palace (through the toll gate)' },
    falador_guards: { key: 'falador_guards', x: 3006, z: 3321, label: 'guards in north Falador' },
    al_kharid_tanner: { key: 'al_kharid_tanner', x: 3276, z: 3193, label: 'Ellis the tanner in Al Kharid' },
    dommiks_crafting: { key: 'dommiks_crafting', x: 3322, z: 3194, label: 'Dommik\'s crafting store in Al Kharid' },
} as const satisfies Record<string, Hub>;

export type HubKey = keyof typeof HUBS;

// ───────────────────────────── context ─────────────────────────────

export interface Ctx {
    sdk: BotSDK;
    bot: BotActions;
    /** Task skill, PascalCase as the game names it (e.g. "Woodcutting"). */
    skill: string;
    /** Wall-clock deadline (ms since epoch). */
    deadline: number;
    log: (msg: string) => void;
    /** Set in tick mode: aborted when Jev switches to another action. Long waits must observe it. */
    signal?: AbortSignal;
    /** Scratch memory that survives across bursts. */
    notes: Record<string, unknown>;
    /**
     * Tick mode: click a skilling target once and hold. The script does not re-click after a
     * catch, does not close dialogs and never gives up on a quiet target; Jev does those through
     * this_tick (close_dialog, restart_current). Burst mode re-clicks after every XP drop.
     */
    hold?: boolean;
}

export type StopReason = 'budget' | 'exhausted' | 'failed' | 'blocked' | 'done' | 'deadline' | 'switched';

export interface Outcome {
    ok: boolean;
    message: string;
    reps: number;
    xpGained: number;
    seconds: number;
    stop: StopReason;
}

export interface ActionSpec {
    key: string;
    /** Task skills this action is offered for. '*' means every task. */
    skills: readonly string[];
    available: (s: BotWorldState, ctx: Ctx) => boolean;
    /** Contrastive rubric fields. Same field names on every option. */
    describe: (s: BotWorldState, ctx: Ctx) => { what: string; where: string; requires: string; gives: string; notes: string };
    run: (ctx: Ctx, budgetMs: number) => Promise<Outcome>;
}

// ───────────────────────────── helpers ─────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Game speed relative to real RuneScape (engine tick 400 ms / NODE_TICKRATE). The benchmark runs at 8. */
export const GAME_SPEED = Number(process.env.GAME_SPEED || 8);
/** Wall-clock multiplier for timeouts that were tuned at 8x. */
export const TIME_SCALE = 8 / GAME_SPEED;
const scaled = (ms: number) => Math.round(ms * TIME_SCALE);

/** Race a long wait against the run's abort signal so a switched action returns at once. */
function withAbort<T>(ctx: Ctx, p: Promise<T>): Promise<T> {
    const sig = ctx.signal;
    if (!sig) return p;
    if (sig.aborted) return Promise.reject(new Error('switched'));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error('switched'));
        sig.addEventListener('abort', onAbort, { once: true });
        p.then(v => { sig.removeEventListener('abort', onAbort); resolve(v); }, e => { sig.removeEventListener('abort', onAbort); reject(e); });
    });
}
const aborted = (ctx: Ctx) => !!ctx.signal?.aborted;

export function state(ctx: Ctx): BotWorldState {
    const s = ctx.sdk.getState();
    if (!s) throw new Error('no world state');
    return s;
}

export function level(s: BotWorldState, skill: string): number {
    return s.skills.find(k => k.name.toLowerCase() === skill.toLowerCase())?.baseLevel ?? 1;
}

export function xpOf(s: BotWorldState, skill: string): number {
    return s.skills.find(k => k.name.toLowerCase() === skill.toLowerCase())?.experience ?? 0;
}

export function inv(s: BotWorldState, re: RegExp): InventoryItem[] {
    return s.inventory.filter(i => re.test(i.name));
}

export function count(s: BotWorldState, re: RegExp): number {
    return inv(s, re).reduce((a, i) => a + i.count, 0);
}

export function has(s: BotWorldState, re: RegExp): boolean {
    return s.inventory.some(i => re.test(i.name)) || s.equipment.some(i => re.test(i.name));
}

export function equipped(s: BotWorldState, re: RegExp): boolean {
    return s.equipment.some(i => re.test(i.name));
}

export function freeSlots(s: BotWorldState): number {
    return 28 - s.inventory.length;
}

export function coins(s: BotWorldState): number {
    return count(s, /^coins$/i);
}

export function distTo(s: BotWorldState, hub: Hub): number {
    if (!s.player) return 9999;
    return Math.round(Math.hypot(s.player.worldX - hub.x, s.player.worldZ - hub.z));
}

export function nearestHub(s: BotWorldState): { hub: Hub; dist: number } {
    let best: { hub: Hub; dist: number } | null = null;
    for (const hub of Object.values(HUBS)) {
        const d = distTo(s, hub);
        if (!best || d < best.dist) best = { hub, dist: d };
    }
    return best!;
}

function fmtWhere(s: BotWorldState, hub: Hub): string {
    const d = distTo(s, hub);
    return `${hub.label} (${hub.x}, ${hub.z}); ${d <= 12 ? 'you are already there' : `${d} tiles away from you`}`;
}

const FOOD_RE = /^(bread|shrimps|anchovies|sardine|herring|trout|salmon|kebab|cake|cooked meat|cooked chicken|meat pie|pike|tuna|lobster|cod|mackerel)$/i;
const RAW_RE = /^raw /i;
const LOGS_RE = /logs$/i;
const ORE_RE = /ore$/i;
const BONES_RE = /bones$/i;
const AXE_RE = /axe$/i;
const PICK_RE = /pickaxe$/i;
const NET_RE = /small fishing net/i;
const FLYROD_RE = /^fly fishing rod$/i;
const FEATHER_RE = /^feather$/i;
const TINDERBOX_RE = /^tinderbox$/i;
const KNIFE_RE = /^knife$/i;
const HAMMER_RE = /^hammer$/i;
const BOW_RE = /bow$/i;
const MELEE_RE = /sword$|dagger$|scimitar$|mace$|battleaxe$|longsword$|axe$/i;
const SHIELD_RE = /shield$/i;
const ARROW_RE = /arrows?$/i;
const HIDE_RE = /^cow ?hide$/i;
const LEATHER_RE = /^leather$/i;
const NEEDLE_RE = /^needle$/i;
const THREAD_RE = /^thread$/i;

const GATHERED_RE = /logs$|ore$|^raw |^(shrimps|anchovies)$|^bones$|hide$|^arrow shaft$|bar$/i;
const KEEP_FOR_SKILL: Record<string, RegExp[]> = {
    Firemaking: [LOGS_RE],
    Fletching: [LOGS_RE, /^arrow shaft$/i],
    Cooking: [RAW_RE],
    Smithing: [ORE_RE, /bar$/i],
    Prayer: [BONES_RE],
    Crafting: [HIDE_RE, LEATHER_RE],
};

/** Gathered products the current task does not consume (safe to drop). */
function droppable(s: BotWorldState, ctx: Ctx): InventoryItem[] {
    const keep = KEEP_FOR_SKILL[ctx.skill] ?? [];
    return inv(s, GATHERED_RE).filter(i => !keep.some(re => re.test(i.name)));
}

interface PickpocketTarget { key: string; hub: Hub; npcRe: RegExp; what: string; minLevel: number; xp: number; coins: number; damage: number; alKharid?: boolean }

function pickpocketAction(t: PickpocketTarget): ActionSpec {
    return {
        key: t.key,
        skills: t.minLevel > 1 ? ['Thieving'] : ALL,
        available: s => level(s, 'Thieving') >= t.minLevel && (!t.alKharid || coins(s) >= 10 || alKharidUnlocked(s)),
        describe: s => ({
            what: t.what,
            where: fmtWhere(s, t.hub),
            requires: `Thieving level ${t.minLevel}${t.alKharid ? '; 10 coins for the Al Kharid toll gate the first time' : ''}`,
            gives: `${t.xp} Thieving XP and about ${t.coins} coins per success; a failure stuns you for a few seconds and deals ${t.damage} damage`,
            notes: `Thieving level ${level(s, 'Thieving')}; you have ${coins(s)} coins; hitpoints ${s.player?.hp ?? '?'}/${s.player?.maxHp ?? '?'}`,
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                let s = state(ctx);
                if (s.player && s.player.hp <= t.damage + 1) {
                    const food = inv(s, FOOD_RE)[0];
                    if (food) await ctx.bot.eatFood(food);
                    else {
                        // No food: rest until hitpoints regenerate a little (about 1 HP per 7 s at 8x).
                        const target = Math.min(s.player.maxHp, t.damage + 3);
                        const restUntil = Math.min(ctx.deadline, Date.now() + scaled(45_000));
                        while (Date.now() < restUntil && !aborted(ctx) && (state(ctx).player?.hp ?? 0) < target) await sleep(1000);
                        s = state(ctx);
                        if ((s.player?.hp ?? 0) < target) return 'stop:resting for hitpoints; still too low to keep pickpocketing';
                    }
                }
                const pick = (st: BotWorldState) => nearbyNamed(st, t.npcRe).filter(n => n.optionsWithIndex.some(o => /pickpocket/i.test(o.text)))[0];
                let npc = pick(s);
                if (!npc) {
                    if (t.alKharid && !(await enterAlKharid(ctx))) return 'fail:could not get through the Al Kharid gate';
                    if (!(await goTo(ctx, t.hub, 4))) return `fail:could not walk to ${t.hub.label}`;
                    npc = pick(state(ctx));
                    if (!npc) return `fail:no ${t.npcRe.source.replace(/[\^$()]/g, '')} nearby`;
                }
                const r = await ctx.bot.pickpocketNpc(npc);
                if (!r.success && /stun/i.test(r.message ?? '')) { await sleep(900); return 'continue'; }
                if (!r.success) { await sleep(500); return `fail:${r.reason ?? ''} ${r.message}`; }
                return 'continue';
            }),
    };
}

const AXE_TIERS: Array<{ tier: string; price: number }> = [{ tier: 'steel', price: 200 }, { tier: 'iron', price: 56 }, { tier: 'bronze', price: 16 }];
function axeTier(s: BotWorldState): string | null {
    for (const t of AXE_TIERS) if (s.inventory.some(i => new RegExp(`^${t.tier} axe$`, 'i').test(i.name)) || s.equipment.some(i => new RegExp(`^${t.tier} axe$`, 'i').test(i.name))) return t.tier;
    return has(s, AXE_RE) ? 'other' : null;
}
/** Best axe tier the player can afford that beats the axe they hold, or null. */
function bestAxeAffordable(s: BotWorldState): string | null {
    const held = axeTier(s);
    const heldRank = held === null ? -1 : AXE_TIERS.findIndex(t => t.tier === held) === -1 ? 2 : AXE_TIERS.findIndex(t => t.tier === held);
    for (let i = 0; i < AXE_TIERS.length; i++) {
        if (coins(s) >= AXE_TIERS[i].price && (held === null || i < heldRank)) return AXE_TIERS[i].tier;
    }
    return null;
}

/** Walk to a hub with retries. Returns true when within `tol` tiles. */
/** walkTo with a hard time cap; the SDK walk has none and a blocked path can hang for minutes. */
async function walkCapped(ctx: Ctx, x: number, z: number, tol: number, ms = scaled(25_000)): Promise<{ success: boolean; message: string; reason?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ success: boolean; message: string; reason?: string }>(resolve => { timer = setTimeout(() => resolve({ success: false, message: `walk to (${x}, ${z}) timed out after ${ms / 1000}s`, reason: 'timeout' }), ms); });
    // The walk phase is reported to the controller (idle rule) and to Jev (current_activity.phase).
    ctx.notes.phase = `walking to (${x}, ${z})`;
    try {
        // The 4th argument is the cancellation signal added to rs-sdk's walkTo by agents/jev/patches;
        // an unpatched SDK ignores it and keeps walking until the next segment ends.
        return await withAbort(ctx, Promise.race([ctx.bot.walkTo(x, z, tol, ctx.signal), timeout]));
    } catch (err) {
        return { success: false, message: (err as Error).message, reason: 'aborted' };
    } finally {
        if (timer) clearTimeout(timer);
        if (ctx.notes.phase && String(ctx.notes.phase).startsWith('walking')) ctx.notes.phase = 'working';
    }
}

export async function goTo(ctx: Ctx, hub: Hub, tol = 10): Promise<boolean> {
    // Inside Al Kharid and heading out: the closed toll gate blocks every path.
    if (alKharidUnlocked(state(ctx)) && hub.x < 3268) {
        if (!(await exitAlKharid(ctx))) return false;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        if (distTo(state(ctx), hub) <= tol) return true;
        if (Date.now() > ctx.deadline || aborted(ctx)) return false;
        const r = await walkCapped(ctx, hub.x, hub.z, 3);
        if (!r.success) ctx.log(`walkTo ${hub.key} attempt ${attempt + 1}: ${r.reason ?? ''} ${r.message}`);
        await sleep(250);
    }
    return distTo(state(ctx), hub) <= tol + 6;
}

async function dismiss(ctx: Ctx): Promise<void> {
    try {
        await ctx.bot.dismissBlockingUI();
    } catch {
        // ignore
    }
}

/** Wait until the task-relevant skill's XP increases, or the timeout passes. */
async function waitForXp(ctx: Ctx, skill: string, timeoutMs: number): Promise<boolean> {
    const before = xpOf(state(ctx), skill);
    try {
        await withAbort(ctx, ctx.sdk.waitForCondition(s => xpOf(s, skill) > before, scaled(timeoutMs)));
        return true;
    } catch {
        return false;
    }
}

/**
 * The SDK reports a click as 'rejected' when the server discarded the op packet. For a fishing
 * spot that report is often wrong: the cast starts one tick after the click. A second click on
 * a running cast lands inside the engine's action-delay cycle and ends the fishing loop, so a
 * retry must first check whether the interaction is live (target set or animation playing).
 */
async function interactionStarted(ctx: Ctx, timeoutMs = 1600): Promise<boolean> {
    try {
        await withAbort(ctx, ctx.sdk.waitForCondition(s => !!s.player && (s.player.combat.targetType !== 'none' || s.player.animId !== -1), scaled(timeoutMs)));
        return true;
    } catch {
        return false;
    }
}

async function waitForInventoryChange(ctx: Ctx, re: RegExp, timeoutMs: number): Promise<boolean> {
    const before = count(state(ctx), re);
    try {
        await withAbort(ctx, ctx.sdk.waitForCondition(s => count(s, re) !== before, scaled(timeoutMs)));
        return true;
    } catch {
        return false;
    }
}

type StepResult = 'continue' | `stop:${string}` | `fail:${string}`;

/**
 * Run `step` repeatedly until the burst budget is spent, the deadline is
 * near, or the step says stop/fail. Returns a summary with XP gained in the
 * task skill.
 */
async function burst(ctx: Ctx, budgetMs: number, step: () => Promise<StepResult>): Promise<Outcome> {
    const startedAt = Date.now();
    const xpBefore = xpOf(state(ctx), ctx.skill);
    let reps = 0;
    let fails = 0;
    let message = '';
    let stop: StopReason = 'budget';
    while (true) {
        if (aborted(ctx)) { stop = 'switched'; message = 'switched by Jev'; break; }
        if (ctx.notes.phase === 'starting') ctx.notes.phase = 'working';
        if (Date.now() >= ctx.deadline - 1500) { stop = 'deadline'; break; }
        // Allow the first repetition to overrun (walking counts against the budget).
        if (Date.now() - startedAt >= budgetMs && reps > 0) { stop = 'budget'; break; }
        if (Date.now() - startedAt >= budgetMs * 2.5) { stop = 'budget'; message ||= 'ran out of time before completing one repetition'; break; }
        const s = state(ctx);
        if (s.player?.isDead) {
            message = 'died; waiting for respawn';
            try { await ctx.sdk.waitForCondition(st => !st.player?.isDead, 30_000); } catch { /* ignore */ }
            stop = 'blocked';
            break;
        }
        let r: StepResult;
        try {
            r = await step();
        } catch (err) {
            r = `fail:${(err as Error)?.message ?? String(err)}`;
        }
        if (r === 'continue') { reps++; fails = 0; continue; }
        if (r.startsWith('stop:')) { message = r.slice(5); stop = reps > 0 ? 'exhausted' : 'blocked'; break; }
        fails++;
        message = r.slice(5);
        if (fails >= 3) { stop = 'failed'; break; }
        await sleep(300);
    }
    const seconds = (Date.now() - startedAt) / 1000;
    const xpGained = xpOf(state(ctx), ctx.skill) - xpBefore;
    return { ok: stop !== 'failed' && stop !== 'blocked', message, reps, xpGained, seconds: +seconds.toFixed(1), stop };
}

/** Run a one-shot step once. `stop:` means done (ok), `fail:` means failed. */
async function once(ctx: Ctx, step: () => Promise<StepResult>): Promise<Outcome> {
    const startedAt = Date.now();
    const xpBefore = xpOf(state(ctx), ctx.skill);
    let r: StepResult;
    try {
        r = await step();
    } catch (err) {
        r = `fail:${(err as Error)?.message ?? String(err)}`;
    }
    const seconds = +((Date.now() - startedAt) / 1000).toFixed(1);
    const xpGained = xpOf(state(ctx), ctx.skill) - xpBefore;
    if (r.startsWith('fail:')) return { ok: false, message: r.slice(5), reps: 0, xpGained, seconds, stop: 'failed' };
    return { ok: true, message: r === 'continue' ? '' : r.slice(5), reps: 1, xpGained, seconds, stop: 'done' };
}

function nearbyNamed(s: BotWorldState, re: RegExp): NearbyNpc[] {
    return s.nearbyNpcs.filter(n => re.test(n.name) && n.reachable !== false).sort((a, b) => a.distance - b.distance);
}

function nearbyLocNamed(s: BotWorldState, re: RegExp, option?: RegExp): NearbyLoc[] {
    return s.nearbyLocs
        .filter(l => re.test(l.name) && l.reachable !== false && (!option || l.optionsWithIndex.some(o => option.test(o.text))))
        .sort((a, b) => a.distance - b.distance);
}

// ───────────────────────────── generic routines ─────────────────────────────

async function gatherLocStep(ctx: Ctx, hub: Hub, locRe: RegExp, option: RegExp | string, skill: string, waitMs: number): Promise<StepResult> {
    await dismiss(ctx);
    const s = state(ctx);
    if (freeSlots(s) === 0) return 'stop:inventory is full';
    let target = nearbyLocNamed(s, locRe, typeof option === 'string' ? new RegExp(`^${option}$`, 'i') : option)[0];
    if (!target) {
        if (!(await goTo(ctx, hub))) return 'fail:could not walk to the area';
        target = nearbyLocNamed(state(ctx), locRe, typeof option === 'string' ? new RegExp(`^${option}$`, 'i') : option)[0];
        if (!target) return 'fail:no matching object nearby after walking there';
    }
    const r = await ctx.bot.interactLoc(target, option);
    if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
    const gained = await waitForXp(ctx, skill, waitMs);
    return gained ? 'continue' : 'fail:no XP arrived after interacting';
}

async function fightStep(ctx: Ctx, hub: Hub, npcRe: RegExp, lootRe: RegExp | null, useSpell?: number, style: 'melee' | 'ranged' = 'melee'): Promise<StepResult> {
    await dismiss(ctx);
    let s = state(ctx);
    if (s.player && s.player.hp <= 3) {
        const food = inv(s, FOOD_RE)[0];
        if (food) {
            await ctx.bot.eatFood(food);
        } else {
            return 'stop:hitpoints are very low and there is no food';
        }
    }
    if (useSpell !== undefined && (count(s, /^air rune$/i) < 1 || count(s, /^mind rune$/i) < 1)) {
        return 'stop:out of runes for this spell';
    }
    // Mechanical precondition: fight with the best melee weapon and a shield you carry.
    if (useSpell === undefined && style === 'ranged') {
        const s0 = state(ctx);
        if (!equipped(s0, BOW_RE)) { const b = inv(s0, BOW_RE)[0]; if (b) await ctx.bot.equipItem(b); }
        if (!equipped(state(ctx), ARROW_RE)) { const a = inv(state(ctx), ARROW_RE)[0]; if (a) await ctx.bot.equipItem(a); }
    } else if (useSpell === undefined) {
        const s0 = state(ctx);
        if (!equipped(s0, MELEE_RE)) { const w = inv(s0, /sword$/i)[0] ?? inv(s0, /dagger$/i)[0] ?? inv(s0, /scimitar$|mace$|axe$/i)[0]; if (w) await ctx.bot.equipItem(w); }
        if (!equipped(state(ctx), SHIELD_RE)) { const sh = inv(state(ctx), SHIELD_RE)[0]; if (sh) await ctx.bot.equipItem(sh); }
    }
    const pickTarget = (st: BotWorldState) => nearbyNamed(st, npcRe).filter(n => n.optionsWithIndex.some(o => /attack/i.test(o.text)) && !(n.inCombat && n.healthPercent !== null && n.healthPercent < 100))[0]
        ?? nearbyNamed(st, npcRe).filter(n => n.optionsWithIndex.some(o => /attack/i.test(o.text)))[0];
    let target = pickTarget(s);
    if (!target) {
        if (!(await goTo(ctx, hub))) return 'fail:could not walk to the area';
        await sleep(400);
        s = state(ctx);
        target = pickTarget(s);
        if (!target) return 'fail:no target nearby after walking there';
    }
    if (useSpell !== undefined) {
        const r = await ctx.bot.castSpell(target, useSpell);
        if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
        return 'continue';
    }
    const r = await ctx.bot.attack(target, scaled(6000));
    if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
    // Wait until the target is dead (gone from the nearby list or at 0 hp), bounded.
    const xpBefore = xpOf(state(ctx), 'Hitpoints');
    const idx = target.index;
    try {
        await withAbort(ctx, ctx.sdk.waitForCondition(st => {
            const t = st.nearbyNpcs.find(n => n.index === idx);
            return !t || t.hp === 0 || t.healthPercent === 0 || (st.player?.hp ?? 99) <= 3;
        }, scaled(20_000)));
    } catch {
        // still fighting; that is fine, the next step re-targets
    }
    if (lootRe) {
        try {
            const items = await ctx.sdk.scanGroundItems(4);
            for (const it of items.filter(i => lootRe.test(i.name) && i.reachable !== false).slice(0, 2)) {
                if (freeSlots(state(ctx)) === 0) break;
                await ctx.bot.pickupItem(it);
            }
        } catch {
            // ignore loot failures
        }
    }
    return xpOf(state(ctx), 'Hitpoints') > xpBefore || (state(ctx).player?.combat.inCombat ?? false) ? 'continue' : 'fail:no damage dealt';
}

async function openShopAt(ctx: Ctx, hub: Hub, keeperRe: RegExp): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!(await goTo(ctx, hub, attempt === 0 ? 8 : 3))) return false;
        await dismiss(ctx);
        await sleep(400);
        const r = await ctx.bot.openShop(keeperRe);
        if (r.success) return true;
        ctx.log(`openShop ${hub.key} attempt ${attempt + 1}: ${r.reason ?? ''} ${r.message}`);
        await sleep(800);
    }
    return false;
}

// ───────────────────────────── the catalog ─────────────────────────────

const ALL = ['*'] as const;

export const CATALOG: ActionSpec[] = [
    // ── generic ──
    {
        key: 'close_dialog',
        skills: ALL,
        available: s => s.dialog.isOpen || s.interface.isOpen,
        describe: s => ({
            what: `close the open ${s.dialog.isOpen ? 'dialog' : 'interface window'}${s.dialog.text ? ` ("${s.dialog.text.replace(/\s+/g, ' ').slice(0, 90)}")` : ''}${s.dialog.options.length ? `; its options are ${s.dialog.options.map(o => o.text).slice(0, 4).join(' / ')}` : ''}`,
            where: 'right here',
            requires: 'nothing',
            gives: 'no XP; the bot can act again once the window is gone (a level-up message or a shop window stops skilling until it is closed)',
            notes: 'takes one game tick; closing a shop or trade window abandons that transaction',
        }),
        run: ctx =>
            once(ctx, async () => {
                const before = state(ctx);
                if (!before.dialog.isOpen && !before.interface.isOpen) return 'stop:nothing to close';
                if (before.dialog.isOpen && before.dialog.options.length > 1) {
                    // A choice dialog: dismissBlockingUI leaves choices alone, so take the first option.
                    await ctx.sdk.sendClickDialog(before.dialog.options[0].index);
                } else {
                    await dismiss(ctx);
                }
                await ctx.sdk.waitForTicks(1);
                const after = state(ctx);
                return after.dialog.isOpen || after.interface.isOpen ? 'fail:the window is still open' : 'stop:closed';
            }),
    },
    {
        key: 'eat_food',
        skills: ALL,
        available: s => !!s.player && s.player.hp < s.player.maxHp && inv(s, FOOD_RE).length > 0,
        describe: s => ({
            what: `eat one piece of food (${inv(s, FOOD_RE).map(i => i.name).slice(0, 3).join(', ')})`,
            where: 'right here',
            requires: 'food in inventory',
            gives: `restores hitpoints (currently ${s.player?.hp}/${s.player?.maxHp})`,
            notes: 'takes about one game tick',
        }),
        run: ctx =>
            once(ctx, async () => {
                const food = inv(state(ctx), FOOD_RE)[0];
                if (!food) return 'stop:no food';
                const r = await ctx.bot.eatFood(food);
                return r.success ? 'stop:ate' : `fail:${r.message}`;
            }),
    },
    {
        key: 'drop_gathered_items',
        skills: ALL,
        available: (s, ctx) => freeSlots(s) <= 3 && droppable(s, ctx).length > 0,
        describe: (s, ctx) => ({
            what: `drop gathered products that ${ctx.skill} does not consume, to free inventory space (${[...new Set(droppable(s, ctx).map(i => i.name))].join(', ')})`,
            where: 'right here',
            requires: 'nothing',
            gives: `frees inventory slots (currently ${freeSlots(s)} free of 28); gives no XP`,
            notes: 'dropped items are lost',
        }),
        run: ctx =>
            once(ctx, async () => {
                let dropped = 0;
                for (const name of [...new Set(droppable(state(ctx), ctx).map(i => i.name))]) {
                    const r = await ctx.bot.dropItem(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), 'all');
                    if (r.success) dropped++;
                }
                return dropped > 0 ? 'stop:dropped' : 'fail:nothing dropped';
            }),
    },
    pickpocketAction({
        key: 'pickpocket_men_lumbridge', hub: HUBS.lumbridge_castle_men, npcRe: /^(man|woman)$/i,
        what: 'pickpocket men and women around Lumbridge castle repeatedly', minLevel: 1, xp: 8, coins: 3, damage: 1,
    }),
    pickpocketAction({
        key: 'pickpocket_farmers_varrock_south', hub: HUBS.varrock_south_farmers, npcRe: /^farmer$/i,
        what: 'pickpocket farmers in the fields between Lumbridge and Varrock repeatedly', minLevel: 10, xp: 14.5, coins: 9, damage: 1,
    }),
    pickpocketAction({
        key: 'pickpocket_warriors_al_kharid', hub: HUBS.al_kharid_warriors, npcRe: /^al-kharid warrior$/i, alKharid: true,
        what: 'pickpocket Al Kharid warriors inside the palace repeatedly', minLevel: 25, xp: 26, coins: 18, damage: 2,
    }),
    pickpocketAction({
        key: 'pickpocket_guards_falador', hub: HUBS.falador_guards, npcRe: /^guard$/i,
        what: 'pickpocket guards in north Falador repeatedly (a long walk west)', minLevel: 40, xp: 46.5, coins: 30, damage: 2,
    }),
    {
        key: 'rest_to_recover_hitpoints',
        skills: ALL,
        available: s => !!s.player && s.player.hp < s.player.maxHp && (s.player.hp <= 5 || s.player.hp < s.player.maxHp / 2) && inv(s, FOOD_RE).length === 0,
        describe: s => ({
            what: 'stand still and let hitpoints regenerate (no food in inventory)',
            where: 'right here',
            requires: 'nothing',
            gives: `about 1 hitpoint every ${Math.round(56 / GAME_SPEED)} seconds; you have ${s.player?.hp ?? '?'}/${s.player?.maxHp ?? '?'} hitpoints; gives no XP`,
            notes: 'useful when failed pickpockets or fights have drained hitpoints and there is no food',
        }),
        run: (ctx, budget) =>
            once(ctx, async () => {
                const s0 = state(ctx);
                const target = Math.min(s0.player?.maxHp ?? 10, (s0.player?.hp ?? 0) + 3);
                const until = Math.min(ctx.deadline, Date.now() + budget);
                while (Date.now() < until && !aborted(ctx) && (state(ctx).player?.hp ?? 0) < target) await sleep(1000);
                return `stop:rested to ${state(ctx).player?.hp ?? '?'} hitpoints`;
            }),
    },
    {
        key: 'sell_unneeded_gear_lumbridge',
        skills: ALL,
        available: (s, ctx) => sellable(s, ctx).length > 0,
        describe: (s, ctx) => ({
            what: `sell starting gear that ${ctx.skill} training does not use (${sellable(s, ctx).map(i => i.name).join(', ')}) at the general store`,
            where: fmtWhere(s, HUBS.lumbridge_general_store),
            requires: 'nothing',
            gives: `a handful of coins (general stores pay little); you have ${coins(s)} coins now; gives no XP`,
            notes: 'coins buy tools and runes from shops',
        }),
        run: ctx =>
            once(ctx, async () => {
                if (!(await openShopAt(ctx, HUBS.lumbridge_general_store, /shop keeper|shop assistant|shopkeeper/i))) return 'fail:could not open the general store';
                const items = sellable(state(ctx), ctx);
                let sold = 0;
                for (const it of items) {
                    const r = await ctx.bot.sellToShop(it, it.count);
                    if (r.success || (r as any).partial) sold++;
                }
                await ctx.bot.closeShop();
                return sold > 0 ? 'stop:sold items' : 'fail:nothing sold';
            }),
    },
    {
        key: 'buy_axe_bobs_lumbridge',
        skills: ['Woodcutting', 'Firemaking', 'Fletching'],
        available: s => coins(s) >= 16 && bestAxeAffordable(s) !== null && freeSlots(s) > 0,
        describe: s => ({
            what: `buy the best axe your coins allow at Bob's axe shop (${bestAxeAffordable(s) ?? 'none'}); bronze 16, iron 56, steel 200 coins`,
            where: fmtWhere(s, HUBS.bobs_axes),
            requires: `coins (you have ${coins(s)}); you currently ${axeTier(s) === null ? 'have no axe' : 'have a ' + axeTier(s) + ' axe'}`,
            gives: 'a better axe chops trees faster (iron is better than bronze, steel better than iron); an axe is required to chop at all; gives no XP',
            notes: 'the shop is next to Lumbridge castle',
        }),
        run: ctx =>
            once(ctx, async () => {
                const want = bestAxeAffordable(state(ctx));
                if (!want) return 'fail:cannot afford an upgrade';
                if (!(await openShopAt(ctx, HUBS.bobs_axes, /^bob$/i))) return 'fail:could not open the shop';
                const r = await ctx.bot.buyFromShop(new RegExp(`^${want} axe$`, 'i'), 1);
                await ctx.bot.closeShop();
                return r.success || (r as any).amountBought > 0 ? `stop:bought a ${want} axe` : `fail:${r.reason ?? ''} ${r.message}`;
            }),
    },
    {
        key: 'buy_bronze_pickaxe_bobs_lumbridge',
        skills: ['Mining', 'Smithing'],
        available: s => !has(s, PICK_RE) && coins(s) >= 1 && freeSlots(s) > 0,
        describe: s => ({
            what: "buy a bronze pickaxe (1 coin) at Bob's axe shop",
            where: fmtWhere(s, HUBS.bobs_axes),
            requires: `1 coin (you have ${coins(s)}); you have no pickaxe`,
            gives: 'a pickaxe, required to mine; gives no XP',
            notes: 'the shop is next to Lumbridge castle',
        }),
        run: ctx => buyRoutine(ctx, HUBS.bobs_axes, /^bob$/i, /^bronze pickaxe$/i, 1),
    },
    {
        key: 'buy_hammer_lumbridge',
        skills: ['Smithing'],
        available: s => !has(s, HAMMER_RE) && coins(s) >= 1,
        describe: s => ({
            what: 'buy a hammer from the Lumbridge general store',
            where: fmtWhere(s, HUBS.lumbridge_general_store),
            requires: `1 coin (you have ${coins(s)})`,
            gives: 'a hammer, needed to smith bars into items at an anvil; gives no XP',
            notes: 'smelting bars at a furnace does not need a hammer',
        }),
        run: ctx => buyRoutine(ctx, HUBS.lumbridge_general_store, /shop keeper|shop assistant|shopkeeper/i, /^hammer$/i, 1),
    },
    {
        key: 'buy_runes_aubury_varrock',
        skills: ['Magic'],
        available: s => coins(s) >= 7,
        describe: s => ({
            what: 'buy as many mind runes and air runes as your coins allow from Aubury',
            where: fmtWhere(s, HUBS.aubury_runes),
            requires: `coins (you have ${coins(s)}); mind runes cost about 3 and air runes about 4 each`,
            gives: 'runes for Wind Strike (1 air + 1 mind per cast); gives no XP',
            notes: 'a long walk from Lumbridge',
        }),
        run: ctx =>
            once(ctx, async () => {
                if (!(await openShopAt(ctx, HUBS.aubury_runes, /aubury/i))) return 'fail:could not open the rune shop';
                let bought = 0;
                for (let i = 0; i < 20; i++) {
                    const s = state(ctx);
                    if (coins(s) < 7) break;
                    const a = await ctx.bot.buyFromShop(/^mind rune$/i, 1);
                    const b = await ctx.bot.buyFromShop(/^air rune$/i, 1);
                    if (!a.success && !b.success) break;
                    bought++;
                }
                await ctx.bot.closeShop();
                return bought > 0 ? 'stop:bought runes' : 'fail:could not buy runes';
            }),
    },

    // ── woodcutting ──
    {
        key: 'chop_regular_trees_lumbridge',
        skills: ['Woodcutting', 'Firemaking', 'Fletching', 'Cooking'],
        available: s => has(s, AXE_RE) && freeSlots(s) > 0,
        describe: s => ({
            what: 'chop regular trees for logs, one log per chop',
            where: fmtWhere(s, HUBS.lumbridge_trees),
            requires: `an axe (you ${has(s, AXE_RE) ? 'have one' : 'have none'}); Woodcutting level 1`,
            gives: `25 Woodcutting XP per log (before the server multiplier); logs are used by Firemaking, Fletching and for cooking fires`,
            notes: `Woodcutting level ${level(s, 'Woodcutting')}; ${freeSlots(s)} free inventory slots`,
        }),
        run: (ctx, budget) => chopRoutine(ctx, budget, HUBS.lumbridge_trees, /^tree$/i),
    },
    {
        key: 'chop_oak_trees_lumbridge',
        skills: ['Woodcutting', 'Firemaking', 'Fletching'],
        available: s => has(s, AXE_RE) && level(s, 'Woodcutting') >= 15 && freeSlots(s) > 0,
        describe: s => ({
            what: 'chop oak trees for oak logs; an oak gives several logs before it falls',
            where: fmtWhere(s, HUBS.lumbridge_oaks),
            requires: `an axe; Woodcutting level 15 (you are ${level(s, 'Woodcutting')})`,
            gives: '37.5 Woodcutting XP per oak log (before the server multiplier); oak logs burn for 60 Firemaking XP and fletch oak bows at level 20',
            notes: `${freeSlots(s)} free inventory slots`,
        }),
        run: (ctx, budget) => chopRoutine(ctx, budget, HUBS.lumbridge_oaks, /^oak$/i),
    },
    {
        key: 'chop_willow_trees_lumbridge',
        skills: ['Woodcutting', 'Firemaking', 'Fletching'],
        available: s => has(s, AXE_RE) && level(s, 'Woodcutting') >= 30 && freeSlots(s) > 0,
        describe: s => ({
            what: 'chop willow trees for willow logs; a willow gives many logs before it falls',
            where: fmtWhere(s, HUBS.lumbridge_willows),
            requires: `an axe; Woodcutting level 30 (you are ${level(s, 'Woodcutting')})`,
            gives: '67.5 Woodcutting XP per willow log (before the server multiplier); willow logs burn for 90 Firemaking XP',
            notes: `${freeSlots(s)} free inventory slots; two willows stand a few steps from the castle`,
        }),
        run: (ctx, budget) => chopRoutine(ctx, budget, HUBS.lumbridge_willows, /^willow$/i),
    },

    {
        key: 'chop_yew_trees_lumbridge_road',
        skills: ['Woodcutting', 'Firemaking', 'Fletching'],
        available: s => has(s, AXE_RE) && level(s, 'Woodcutting') >= 60 && freeSlots(s) > 0,
        describe: s => ({
            what: 'chop yew trees for yew logs; a yew gives many logs before it falls but each log takes longer to cut',
            where: fmtWhere(s, HUBS.lumbridge_yews),
            requires: `an axe; Woodcutting level 60 (you are ${level(s, 'Woodcutting')})`,
            gives: '175 Woodcutting XP per yew log (before the server multiplier); yew logs burn for 202.5 Firemaking XP',
            notes: `${freeSlots(s)} free inventory slots; a better axe matters most on slow trees like yews`,
        }),
        run: (ctx, budget) => chopRoutine(ctx, budget, HUBS.lumbridge_yews, /^yew$/i),
    },

    // ── firemaking ──
    {
        key: 'burn_logs_here',
        skills: ['Firemaking', 'Cooking'],
        available: s => has(s, TINDERBOX_RE) && inv(s, LOGS_RE).length > 0,
        describe: s => ({
            what: `light the logs in your inventory one after another with the tinderbox (${count(s, LOGS_RE)} logs carried)`,
            where: 'right here, stepping aside after each fire',
            requires: 'a tinderbox and logs',
            gives: '40 Firemaking XP per regular log, 60 per oak log, 90 per willow log (before the server multiplier); each fire can cook raw food',
            notes: 'fires cannot be lit inside buildings or on a tile that already has a fire',
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                const s = state(ctx);
                const logs = inv(s, LOGS_RE)[0];
                if (!logs) return 'stop:no logs left';
                const r = await ctx.bot.burnLogs(logs);
                if (r.success) return 'continue';
                if (/can't light|cannot light|here/i.test(r.message ?? '') || (r as any).reason === 'cant_light_here') {
                    const p = s.player!;
                    await ctx.sdk.sendWalk(p.worldX + (Math.random() < 0.5 ? 1 : -1), p.worldZ + (Math.random() < 0.5 ? 1 : -1), true);
                    await sleep(400);
                    return 'continue';
                }
                return `fail:${(r as any).reason ?? ''} ${r.message}`;
            }),
    },

    // ── fletching ──
    {
        key: 'pick_up_knife_lumbridge',
        skills: ['Fletching'],
        available: s => !has(s, KNIFE_RE),
        describe: s => ({
            what: 'walk to the knife ground spawn and pick up a knife',
            where: fmtWhere(s, HUBS.knife_spawn),
            requires: 'nothing',
            gives: 'a knife, needed to fletch logs into arrow shafts or bows; gives no XP',
            notes: 'the knife respawns a few seconds after someone takes it',
        }),
        run: ctx =>
            once(ctx, async () => {
                if (!(await goTo(ctx, HUBS.knife_spawn, 4))) return 'fail:could not walk to the knife spawn';
                // The ground-item scan is slow; read the state first and scan once, bounded to ~15 s.
                const until = Date.now() + scaled(15_000);
                let scanned = false;
                while (Date.now() < until) {
                    let knife = state(ctx).groundItems.find(it => KNIFE_RE.test(it.name));
                    if (!knife && !scanned) {
                        scanned = true;
                        try { knife = (await ctx.sdk.scanGroundItems(6)).find(it => KNIFE_RE.test(it.name)); } catch { /* ignore */ }
                    }
                    if (knife) {
                        const r = await ctx.bot.pickupItem(knife);
                        if (r.success || has(state(ctx), KNIFE_RE)) return 'stop:picked up a knife';
                    }
                    await sleep(1000);
                }
                return 'fail:no knife at the spawn right now';
            }),
    },
    {
        key: 'fletch_arrow_shafts',
        skills: ['Fletching'],
        available: s => has(s, KNIFE_RE) && inv(s, /^logs$/i).length > 0,
        describe: s => ({
            what: `cut regular logs into arrow shafts with the knife, 15 shafts per log (${count(s, /^logs$/i)} logs carried)`,
            where: 'right here',
            requires: 'a knife and regular logs; Fletching level 1',
            gives: '5 Fletching XP per log (before the server multiplier)',
            notes: `Fletching level ${level(s, 'Fletching')}`,
        }),
        run: (ctx, budget) => fletchRoutine(ctx, budget, 'arrow shaft', /^logs$/i),
    },
    {
        key: 'fletch_shortbow',
        skills: ['Fletching'],
        available: s => has(s, KNIFE_RE) && inv(s, /^logs$/i).length > 0 && level(s, 'Fletching') >= 5,
        describe: s => ({
            what: `cut regular logs into unstrung shortbows, one per log (${count(s, /^logs$/i)} logs carried)`,
            where: 'right here',
            requires: `a knife and regular logs; Fletching level 5 (you are ${level(s, 'Fletching')})`,
            gives: '5 Fletching XP per bow (before the server multiplier)',
            notes: 'same XP as arrow shafts per log',
        }),
        run: (ctx, budget) => fletchRoutine(ctx, budget, 'short', /^logs$/i),
    },
    {
        key: 'fletch_longbow',
        skills: ['Fletching'],
        available: s => has(s, KNIFE_RE) && inv(s, /^logs$/i).length > 0 && level(s, 'Fletching') >= 10,
        describe: s => ({
            what: `cut regular logs into unstrung longbows, one per log (${count(s, /^logs$/i)} logs carried)`,
            where: 'right here',
            requires: `a knife and regular logs; Fletching level 10 (you are ${level(s, 'Fletching')})`,
            gives: '10 Fletching XP per bow (before the server multiplier)',
            notes: 'twice the XP per log of arrow shafts',
        }),
        run: (ctx, budget) => fletchRoutine(ctx, budget, 'long', /^logs$/i),
    },
    {
        key: 'fletch_oak_shortbow',
        skills: ['Fletching'],
        available: s => has(s, KNIFE_RE) && inv(s, /^oak logs$/i).length > 0 && level(s, 'Fletching') >= 20,
        describe: s => ({
            what: `cut oak logs into unstrung oak shortbows (${count(s, /^oak logs$/i)} oak logs carried)`,
            where: 'right here',
            requires: `a knife and oak logs; Fletching level 20 (you are ${level(s, 'Fletching')})`,
            gives: '16.5 Fletching XP per bow (before the server multiplier)',
            notes: 'oak logs come from oak trees (Woodcutting 15)',
        }),
        run: (ctx, budget) => fletchRoutine(ctx, budget, 'oak short', /^oak logs$/i),
    },
    {
        key: 'fletch_oak_longbow',
        skills: ['Fletching'],
        available: s => has(s, KNIFE_RE) && inv(s, /^oak logs$/i).length > 0 && level(s, 'Fletching') >= 25,
        describe: s => ({
            what: `cut oak logs into unstrung oak longbows (${count(s, /^oak logs$/i)} oak logs carried)`,
            where: 'right here',
            requires: `a knife and oak logs; Fletching level 25 (you are ${level(s, 'Fletching')})`,
            gives: '25 Fletching XP per bow (before the server multiplier)',
            notes: 'oak logs come from oak trees (Woodcutting 15)',
        }),
        run: (ctx, budget) => fletchRoutine(ctx, budget, 'oak long', /^oak logs$/i),
    },

    // ── fishing ──
    {
        key: 'net_fish_draynor',
        skills: ['Fishing', 'Cooking'],
        available: s => has(s, NET_RE) && freeSlots(s) > 0,
        describe: s => ({
            what: 'net fish shrimps (and anchovies from level 15) at the Draynor shore',
            where: fmtWhere(s, HUBS.draynor_fishing),
            requires: `a small fishing net (you ${has(s, NET_RE) ? 'have one' : 'have none'}); Fishing level 1`,
            gives: '10 Fishing XP per shrimp, 40 per anchovy (before the server multiplier); raw fish can be cooked',
            notes: `Fishing level ${level(s, 'Fishing')}; ${freeSlots(s)} free inventory slots; dark wizards wander a few tiles north of the spots`,
        }),
        run: (ctx, budget) => {
            let holding = false;
            return burst(ctx, budget, async () => {
                if (ctx.hold && holding) {
                    // Clicked already: the game keeps fishing by itself. Count catches, never re-click.
                    if (freeSlots(state(ctx)) === 0) return 'stop:inventory is full';
                    await waitForXp(ctx, 'Fishing', 10_000);
                    return 'continue';
                }
                if (!ctx.hold) await dismiss(ctx);
                const s = state(ctx);
                if (freeSlots(s) === 0) return 'stop:inventory is full';
                let spot = nearbyNamed(s, /fishing spot/i).filter(n => n.optionsWithIndex.some(o => /^net$/i.test(o.text)))[0];
                if (!spot) {
                    if (!(await goTo(ctx, HUBS.draynor_fishing, 8))) return 'fail:could not walk to the fishing spots';
                    await sleep(500);
                    spot = nearbyNamed(state(ctx), /fishing spot/i).filter(n => n.optionsWithIndex.some(o => /^net$/i.test(o.text)))[0];
                    if (!spot) return 'fail:no net fishing spot nearby';
                }
                let r = await ctx.bot.interactNpc(spot, 'Net');
                if (!r.success && r.reason === 'rejected') {
                    if (await interactionStarted(ctx)) {
                        r = { ...r, success: true, message: 'the cast started although the SDK reported the click as rejected' };
                    } else {
                        const again = nearbyNamed(state(ctx), /fishing spot/i).filter(n => n.optionsWithIndex.some(o => /^net$/i.test(o.text)))[0] ?? spot;
                        r = await ctx.bot.interactNpc(again, 'Net');
                    }
                }
                if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
                holding = true;
                const caught = await waitForXp(ctx, 'Fishing', 10_000);
                return caught || ctx.hold ? 'continue' : 'fail:no fish caught';
            });
        },
    },

    {
        key: 'buy_small_fishing_net_port_sarim',
        skills: ['Fishing'],
        available: s => !has(s, NET_RE) && coins(s) >= 5 && freeSlots(s) > 0,
        describe: s => ({
            what: 'buy a small fishing net (5 coins) at Gerrant\'s shop in Port Sarim',
            where: fmtWhere(s, HUBS.port_sarim_gerrant),
            requires: `5 coins (you have ${coins(s)}); a long walk west and back`,
            gives: 'a small fishing net, which net fishing at Draynor needs; gives no XP itself',
            notes: `you have no small fishing net (a death drops it); Fishing level ${level(s, 'Fishing')}`,
        }),
        run: ctx =>
            once(ctx, async () => {
                if (!(await openShopAt(ctx, HUBS.port_sarim_gerrant, /gerrant/i))) return 'fail:could not open the shop';
                const r = await ctx.bot.buyFromShop(NET_RE, 1);
                await ctx.bot.closeShop();
                return has(state(ctx), NET_RE) ? 'stop:bought a small fishing net' : `fail:${r.message ?? 'nothing bought'}`;
            }),
    },
    {
        key: 'buy_fly_fishing_rod_and_feathers_port_sarim',
        skills: ['Fishing'],
        available: s => coins(s) >= 7 && (!has(s, FLYROD_RE) || count(s, FEATHER_RE) < 20),
        describe: s => ({
            what: `buy a fly fishing rod (5 coins) and as many feathers (2 coins each) as your coins allow at Gerrant's shop in Port Sarim`,
            where: fmtWhere(s, HUBS.port_sarim_gerrant),
            requires: `coins (you have ${coins(s)}); a long walk west and back`,
            gives: `a fly fishing rod and about ${Math.min(300, Math.floor((coins(s) - (has(s, FLYROD_RE) ? 0 : 5)) / 2))} feathers; fly fishing needs Fishing level 20 and gives 50 XP per trout (70 per salmon from level 30), one feather per fish; gives no XP itself`,
            notes: `Fishing level ${level(s, 'Fishing')}; you ${has(s, FLYROD_RE) ? 'already have a fly fishing rod' : 'have no fly fishing rod'} and ${count(s, FEATHER_RE)} feathers`,
        }),
        run: ctx =>
            once(ctx, async () => {
                if (!(await openShopAt(ctx, HUBS.port_sarim_gerrant, /gerrant/i))) return 'fail:could not open the shop';
                let bought = 0;
                if (!has(state(ctx), FLYROD_RE)) {
                    const r = await ctx.bot.buyFromShop(FLYROD_RE, 1);
                    if (r.success || (r as any).amountBought > 0) bought++;
                }
                const n = Math.min(300, Math.floor(coins(state(ctx)) / 2));
                if (n > 0) {
                    const r = await ctx.bot.buyFromShop(FEATHER_RE, n);
                    if (r.success || (r as any).amountBought > 0) bought++;
                }
                await ctx.bot.closeShop();
                const st = state(ctx);
                return bought > 0 ? `stop:bought; now ${count(st, FEATHER_RE)} feathers${has(st, FLYROD_RE) ? ' and a fly fishing rod' : ''}` : 'fail:nothing bought';
            }),
    },
    {
        key: 'fly_fish_lumbridge_river',
        skills: ['Fishing', 'Cooking'],
        available: s => has(s, FLYROD_RE) && count(s, FEATHER_RE) > 0 && level(s, 'Fishing') >= 20 && freeSlots(s) > 0,
        describe: s => ({
            what: 'fly fish trout (and salmon from level 30) at the river spots east of Lumbridge castle',
            where: fmtWhere(s, HUBS.lumbridge_river_spots),
            requires: `a fly fishing rod and feathers (you have ${count(s, FEATHER_RE)}); Fishing level 20`,
            gives: '50 Fishing XP per trout, 70 per salmon (before the server multiplier); one feather per fish; raw fish can be cooked',
            notes: `Fishing level ${level(s, 'Fishing')}; ${freeSlots(s)} free inventory slots`,
        }),
        run: (ctx, budget) => {
            let holding = false;
            return burst(ctx, budget, async () => {
                if (ctx.hold && holding) {
                    const st = state(ctx);
                    if (freeSlots(st) === 0) return 'stop:inventory is full';
                    if (count(st, FEATHER_RE) === 0) return 'stop:out of feathers';
                    await waitForXp(ctx, 'Fishing', 10_000);
                    return 'continue';
                }
                if (!ctx.hold) await dismiss(ctx);
                const s = state(ctx);
                if (freeSlots(s) === 0) return 'stop:inventory is full';
                if (count(s, FEATHER_RE) === 0) return 'stop:out of feathers';
                let spot = nearbyNamed(s, /fishing spot/i).filter(n => n.optionsWithIndex.some(o => /^lure$/i.test(o.text)))[0];
                if (!spot) {
                    if (!(await goTo(ctx, HUBS.lumbridge_river_spots, 6))) return 'fail:could not walk to the river spots';
                    await sleep(500);
                    spot = nearbyNamed(state(ctx), /fishing spot/i).filter(n => n.optionsWithIndex.some(o => /^lure$/i.test(o.text)))[0];
                    if (!spot) return 'fail:no lure fishing spot nearby';
                }
                let r = await ctx.bot.interactNpc(spot, 'Lure');
                if (!r.success && r.reason === 'rejected') {
                    if (await interactionStarted(ctx)) {
                        r = { ...r, success: true, message: 'the cast started although the SDK reported the click as rejected' };
                    } else {
                        const again = nearbyNamed(state(ctx), /fishing spot/i).filter(n => n.optionsWithIndex.some(o => /^lure$/i.test(o.text)))[0] ?? spot;
                        r = await ctx.bot.interactNpc(again, 'Lure');
                    }
                }
                if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
                holding = true;
                const caught = await waitForXp(ctx, 'Fishing', 10_000);
                return caught || ctx.hold ? 'continue' : 'fail:no fish caught';
            });
        },
    },

    // ── cooking ──
    {
        key: 'cook_raw_food_lumbridge_range',
        skills: ['Cooking'],
        available: s => inv(s, RAW_RE).length > 0,
        describe: s => ({
            what: `cook the raw food you carry on the range (${[...new Set(inv(s, RAW_RE).map(i => i.name))].join(', ')})`,
            where: fmtWhere(s, HUBS.lumbridge_range),
            requires: 'raw food',
            gives: '30 Cooking XP per shrimp, 30 per anchovy, 30 per meat (before the server multiplier); some food burns at low levels',
            notes: `Cooking level ${level(s, 'Cooking')}; ranges burn less food than open fires`,
        }),
        run: (ctx, budget) => cookRoutine(ctx, budget, HUBS.lumbridge_range, /^(cooking )?range$/i),
    },
    {
        key: 'cook_raw_food_draynor_fireplace',
        skills: ['Cooking'],
        available: s => inv(s, RAW_RE).length > 0,
        describe: s => ({
            what: `cook the raw food you carry on the Draynor fireplace (${[...new Set(inv(s, RAW_RE).map(i => i.name))].join(', ')})`,
            where: fmtWhere(s, HUBS.draynor_fireplace),
            requires: 'raw food',
            gives: '30 Cooking XP per shrimp or anchovy (before the server multiplier)',
            notes: `close to the Draynor fishing spots; Cooking level ${level(s, 'Cooking')}`,
        }),
        run: (ctx, budget) => cookRoutine(ctx, budget, HUBS.draynor_fireplace, /^fireplace$/i),
    },
    {
        key: 'light_fire_and_cook_here',
        skills: ['Cooking'],
        available: s => inv(s, RAW_RE).length > 0 && has(s, TINDERBOX_RE) && inv(s, LOGS_RE).length > 0,
        describe: s => ({
            what: `light one of your ${count(s, LOGS_RE)} logs here and cook your raw food on the fire`,
            where: 'right here (outdoors)',
            requires: 'a tinderbox, logs and raw food',
            gives: '30 Cooking XP per shrimp or anchovy plus 40 Firemaking XP for the fire (before the server multiplier)',
            notes: 'no walking to a range needed; open fires burn slightly more food',
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                let s = state(ctx);
                if (inv(s, RAW_RE).length === 0) return 'stop:no raw food left';
                let fire = nearbyLocNamed(s, /^fire$/i)[0];
                if (!fire || fire.distance > 3) {
                    const logs = inv(s, LOGS_RE)[0];
                    if (!logs) return 'stop:no logs left to make a fire';
                    const lit = await ctx.bot.burnLogs(logs);
                    if (!lit.success) {
                        const p = s.player!;
                        await ctx.sdk.sendWalk(p.worldX + 1, p.worldZ, true);
                        await sleep(400);
                        return `fail:${lit.message}`;
                    }
                    s = state(ctx);
                    fire = nearbyLocNamed(s, /^fire$/i)[0];
                    if (!fire) return 'fail:fire not found after lighting';
                }
                const raw = inv(state(ctx), RAW_RE)[0];
                const r = await ctx.bot.useItemOnLoc(raw, fire);
                if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
                return (await waitForInventoryChange(ctx, RAW_RE, 6000)) ? 'continue' : 'fail:nothing cooked';
            }),
    },

    // ── mining ──
    {
        key: 'mine_copper_and_tin_varrock_se',
        skills: ['Mining', 'Smithing'],
        available: s => has(s, PICK_RE) && freeSlots(s) > 0,
        describe: s => ({
            what: 'mine copper and tin rocks in alternation, one ore per swing',
            where: fmtWhere(s, HUBS.varrock_se_mine),
            requires: `a pickaxe (you ${has(s, PICK_RE) ? 'have one' : 'have none'}); Mining level 1`,
            gives: '17.5 Mining XP per ore (before the server multiplier); one copper plus one tin smelt into a bronze bar',
            notes: `Mining level ${level(s, 'Mining')}; ${freeSlots(s)} free inventory slots; the mine is a long walk from Lumbridge`,
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                const s = state(ctx);
                if (freeSlots(s) === 0) return 'stop:inventory is full';
                const wantTin = count(s, /^tin ore$/i) < count(s, /^copper ore$/i);
                // Rock objects are named by ore: "Rocks copper ore" (ids 2090/2091), "Rocks tin ore" (2094/2095).
                const want = wantTin ? /^rocks tin ore$/i : /^rocks copper ore$/i;
                const alt = wantTin ? /^rocks copper ore$/i : /^rocks tin ore$/i;
                const pick = (st: BotWorldState) => nearbyLocNamed(st, want, /^mine$/i)[0] ?? nearbyLocNamed(st, alt, /^mine$/i)[0] ?? null;
                let rock = pick(s);
                if (!rock) {
                    if (!(await goTo(ctx, HUBS.varrock_se_mine, 8))) return 'fail:could not walk to the mine';
                    rock = pick(state(ctx));
                    if (!rock) return 'fail:no copper or tin rocks nearby';
                }
                const r = await ctx.bot.interactLoc(rock, 'Mine');
                if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
                return (await waitForXp(ctx, 'Mining', 9000)) ? 'continue' : 'fail:no ore mined';
            }),
    },

    {
        key: 'mine_iron_rocks_varrock_se',
        skills: ['Mining'],
        available: s => has(s, PICK_RE) && level(s, 'Mining') >= 15 && freeSlots(s) > 0,
        describe: s => ({
            what: 'mine iron rocks, one ore per swing (iron is slower to mine than copper or tin at low levels)',
            where: fmtWhere(s, HUBS.varrock_se_mine),
            requires: `a pickaxe (you ${has(s, PICK_RE) ? 'have one' : 'have none'}); Mining level 15 (you are ${level(s, 'Mining')})`,
            gives: '35 Mining XP per iron ore (before the server multiplier)',
            notes: `${freeSlots(s)} free inventory slots; four iron rocks stand in the same mine as the copper and tin`,
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                const s = state(ctx);
                if (freeSlots(s) === 0) return 'stop:inventory is full';
                const pick = (st: BotWorldState) => nearbyLocNamed(st, /^rocks iron ore$/i, /^mine$/i)[0] ?? null;
                let rock = pick(s);
                if (!rock) {
                    if (!(await goTo(ctx, HUBS.varrock_se_mine, 8))) return 'fail:could not walk to the mine';
                    rock = pick(state(ctx));
                    if (!rock) return 'fail:no iron rocks nearby';
                }
                const r = await ctx.bot.interactLoc(rock, 'Mine');
                if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
                return (await waitForXp(ctx, 'Mining', 9000)) ? 'continue' : 'fail:no ore mined';
            }),
    },

    // ── smithing ──
    {
        key: 'smelt_bronze_bars_lumbridge_furnace',
        skills: ['Smithing'],
        available: s => count(s, /^copper ore$/i) > 0 && count(s, /^tin ore$/i) > 0,
        describe: s => ({
            what: `smelt bronze bars at the furnace (${Math.min(count(s, /^copper ore$/i), count(s, /^tin ore$/i))} pairs of copper and tin ore carried)`,
            where: fmtWhere(s, HUBS.lumbridge_furnace),
            requires: 'copper ore and tin ore; Smithing level 1',
            gives: '6.2 Smithing XP per bronze bar (before the server multiplier); bars can then be smithed at an anvil',
            notes: `Smithing level ${level(s, 'Smithing')}`,
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                let s = state(ctx);
                const copper = inv(s, /^copper ore$/i)[0];
                if (!copper || count(s, /^tin ore$/i) === 0) return 'stop:out of copper or tin ore';
                let furnace = ctx.sdk.findNearbyLoc(/furnace/i, { withOption: /smelt/i, reachable: true });
                if (!furnace || furnace.distance > 8) {
                    if (!(await goTo(ctx, HUBS.lumbridge_furnace, 6))) return 'fail:could not walk to the furnace';
                    furnace = ctx.sdk.findNearbyLoc(/furnace/i, { withOption: /smelt/i, reachable: true });
                    if (!furnace) return 'fail:no furnace nearby';
                }
                s = state(ctx);
                const r = await ctx.sdk.sendUseItemOnLoc(inv(s, /^copper ore$/i)[0].slot, furnace.x, furnace.z, furnace.id);
                if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
                return (await waitForXp(ctx, 'Smithing', 9000)) ? 'continue' : 'fail:no bar produced';
            }),
    },
    {
        key: 'smith_bronze_daggers_varrock_anvil',
        skills: ['Smithing'],
        available: s => has(s, HAMMER_RE) && count(s, /^bronze bar$/i) > 0,
        describe: s => ({
            what: `hammer bronze bars into bronze daggers at an anvil (${count(s, /^bronze bar$/i)} bars carried)`,
            where: fmtWhere(s, HUBS.varrock_anvil),
            requires: 'a hammer and bronze bars; Smithing level 1',
            gives: '12.5 Smithing XP per dagger (before the server multiplier), one bar each',
            notes: `Smithing level ${level(s, 'Smithing')}; the anvils are a long walk from the Lumbridge furnace`,
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                const s = state(ctx);
                if (count(s, /^bronze bar$/i) === 0) return 'stop:no bars left';
                if (!(await goTo(ctx, HUBS.varrock_anvil, 6))) return 'fail:could not walk to the anvils';
                const r = await ctx.bot.smithAtAnvil('dagger', { barPattern: /^bronze bar$/i, timeout: scaled(12_000) });
                return r.success ? 'continue' : `fail:${r.reason ?? ''} ${r.message}`;
            }),
    },

    // ── prayer ──
    {
        key: 'bury_bones',
        skills: ['Prayer'],
        available: s => inv(s, BONES_RE).length > 0,
        describe: s => ({
            what: `bury the ${count(s, BONES_RE)} bones you carry, one at a time`,
            where: 'right here',
            requires: 'bones in inventory',
            gives: '4.5 Prayer XP per regular bones (before the server multiplier)',
            notes: `Prayer level ${level(s, 'Prayer')}`,
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                const bones = inv(state(ctx), BONES_RE)[0];
                if (!bones) return 'stop:no bones left';
                const opt = bones.optionsWithIndex.find(o => /bury/i.test(o.text));
                const r = await ctx.sdk.sendUseItem(bones.slot, opt?.opIndex ?? 1);
                if (!r.success) return `fail:${r.message}`;
                return (await waitForXp(ctx, 'Prayer', 3000)) ? 'continue' : 'fail:no prayer XP from burying';
            }),
    },

    // ── combat (melee) ──
    ...(['Attack', 'Strength', 'Defence'] as const).map<ActionSpec>(sk => ({
        key: `set_combat_style_${sk.toLowerCase()}`,
        skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'],
        available: s => !!s.combatStyle?.known && !currentStyleTrains(s, sk) && !!s.combatStyle.styles.find(st => st.trainsSkills.includes(sk)),
        describe: s => ({
            what: `switch the melee combat style to one that trains ${sk}`,
            where: 'right here',
            requires: 'a melee weapon equipped',
            gives: `every melee hit then gives ${sk} XP (4 per damage) plus Hitpoints XP (1.33 per damage); gives no XP by itself`,
            notes: `current style "${currentStyleName(s)}" trains ${currentStyleTrainsList(s)}`,
        }),
        run: ctx =>
            once(ctx, async () => {
                const s = state(ctx);
                const style = s.combatStyle?.styles.find(st => st.trainsSkills.includes(sk));
                if (!style) return 'fail:no such style';
                const r = await ctx.sdk.sendSetCombatStyle(style.index);
                if (!r.success) return `fail:${r.message}`;
                try { await ctx.sdk.waitForCondition(st => st.combatStyle?.currentStyle === style.index, scaled(4000)); } catch { /* ignore */ }
                return 'stop:style set';
            }),
    })),
    ...([
        { npc: 'chicken', re: /^chicken$/i, hub: HUBS.lumbridge_chickens, lvl: 1, hp: 3, note: 'very weak; drops bones and feathers; fights are short so much of the time is spent re-targeting' },
        { npc: 'cow', re: /^cow$/i, hub: HUBS.lumbridge_cows, lvl: 2, hp: 8, note: 'weak; drops bones and cowhide; more hitpoints per kill than chickens' },
        { npc: 'goblin', re: /^goblin$/i, hub: HUBS.lumbridge_goblins, lvl: 2, hp: 5, note: 'weak; drops bones; hits back for up to 1' },
        { npc: 'giant rat', re: /^giant rat$/i, hub: HUBS.lumbridge_rats, lvl: 1, hp: 2, note: 'very weak; drops bones' },
    ] as const).map<ActionSpec>(t => ({
        key: `fight_${t.npc.replace(' ', '_')}s_lumbridge`,
        skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Crafting'],
        available: () => true,
        describe: (s, ctx) => ({
            what: `fight ${t.npc}s in melee, one after another${lootFor(ctx.skill) ? `, picking up ${lootFor(ctx.skill)!.label} they drop` : ''}`,
            where: fmtWhere(s, t.hub),
            requires: 'a melee weapon (a bronze sword is fine)',
            gives: `4 XP per point of damage to the skill your combat style trains, plus 1.33 Hitpoints XP per damage (before the server multiplier); ${t.npc} has ${t.hp} hitpoints and combat level ${t.lvl}`,
            notes: `${t.note}; your combat style trains ${currentStyleTrainsList(s)}; your hitpoints ${s.player?.hp}/${s.player?.maxHp}`,
        }),
        run: (ctx, budget) => burst(ctx, budget, () => fightStep(ctx, t.hub, t.re, lootFor(ctx.skill)?.re ?? null)),
    })),

    // ── magic ──
    {
        key: 'cast_wind_strike_on_chickens',
        skills: ['Magic'],
        available: s => count(s, /^air rune$/i) >= 1 && count(s, /^mind rune$/i) >= 1,
        describe: s => ({
            what: `cast Wind Strike on chickens until the runes run out (${Math.min(count(s, /^air rune$/i), count(s, /^mind rune$/i))} casts possible)`,
            where: fmtWhere(s, HUBS.lumbridge_chickens),
            requires: '1 air rune and 1 mind rune per cast; Magic level 1',
            gives: '5.5 Magic XP per cast plus 2 Magic XP per damage dealt (before the server multiplier); a splash still gives the base XP',
            notes: `Magic level ${level(s, 'Magic')}; more runes are sold by Aubury in Varrock`,
        }),
        run: (ctx, budget) => burst(ctx, budget, () => fightStep(ctx, HUBS.lumbridge_chickens, /^chicken$/i, null, Spells.WIND_STRIKE)),
    },
    {
        key: 'cast_wind_strike_on_cows',
        skills: ['Magic'],
        available: s => count(s, /^air rune$/i) >= 1 && count(s, /^mind rune$/i) >= 1,
        describe: s => ({
            what: `cast Wind Strike on cows until the runes run out (${Math.min(count(s, /^air rune$/i), count(s, /^mind rune$/i))} casts possible)`,
            where: fmtWhere(s, HUBS.lumbridge_cows),
            requires: '1 air rune and 1 mind rune per cast; Magic level 1',
            gives: '5.5 Magic XP per cast plus 2 Magic XP per damage dealt (before the server multiplier)',
            notes: `cows have 8 hitpoints so more casts land on one target; Magic level ${level(s, 'Magic')}`,
        }),
        run: (ctx, budget) => burst(ctx, budget, () => fightStep(ctx, HUBS.lumbridge_cows, /^cow$/i, null, Spells.WIND_STRIKE)),
    },

    // ── ranged ──
    {
        key: 'equip_shortbow_and_arrows',
        skills: ['Ranged'],
        available: s => (has(s, BOW_RE) && !equipped(s, BOW_RE)) || (has(s, ARROW_RE) && !equipped(s, ARROW_RE)),
        describe: s => ({
            what: 'wield the shortbow and equip the bronze arrows',
            where: 'right here',
            requires: 'a bow and arrows in inventory',
            gives: 'lets you shoot instead of melee; gives no XP by itself',
            notes: `bow ${equipped(s, BOW_RE) ? 'already wielded' : 'not wielded'}; arrows ${equipped(s, ARROW_RE) ? 'already equipped' : 'not equipped'}`,
        }),
        run: ctx =>
            once(ctx, async () => {
                const s = state(ctx);
                if (!equipped(s, BOW_RE)) { const b = inv(s, BOW_RE)[0]; if (b) await ctx.bot.equipItem(b); }
                if (!equipped(state(ctx), ARROW_RE)) { const a = inv(state(ctx), ARROW_RE)[0]; if (a) await ctx.bot.equipItem(a); }
                const t = state(ctx);
                return equipped(t, BOW_RE) && equipped(t, ARROW_RE) ? 'stop:equipped' : 'fail:could not equip';
            }),
    },
    ...([
        { npc: 'chicken', re: /^chicken$/i, hub: HUBS.lumbridge_chickens, hp: 3 },
        { npc: 'cow', re: /^cow$/i, hub: HUBS.lumbridge_cows, hp: 8 },
    ] as const).map<ActionSpec>(t => ({
        key: `shoot_${t.npc}s_lumbridge`,
        skills: ['Ranged'],
        available: s => equipped(s, BOW_RE) && equipped(s, ARROW_RE),
        describe: s => ({
            what: `shoot ${t.npc}s with the bow, picking up arrows that land nearby`,
            where: fmtWhere(s, t.hub),
            requires: 'a bow wielded and arrows equipped',
            gives: `4 Ranged XP per damage plus 1.33 Hitpoints XP per damage (before the server multiplier); ${t.npc} has ${t.hp} hitpoints`,
            notes: `arrows equipped: ${s.equipment.filter(i => ARROW_RE.test(i.name)).reduce((a, i) => a + i.count, 0)}; some arrows break on impact`,
        }),
        run: (ctx, budget) => burst(ctx, budget, () => fightStep(ctx, t.hub, t.re, /arrow$/i, undefined, 'ranged')),
    })),
    {
        key: 'pick_up_arrows_here',
        skills: ['Ranged'],
        available: s => s.groundItems.some(g => ARROW_RE.test(g.name)),
        describe: s => ({
            what: `pick up the ${s.groundItems.filter(g => ARROW_RE.test(g.name)).reduce((a, g) => a + g.count, 0)} arrows lying on the ground nearby and re-equip them`,
            where: 'right here',
            requires: 'nothing',
            gives: 'arrows back; gives no XP',
            notes: 'without arrows you cannot shoot',
        }),
        run: ctx =>
            once(ctx, async () => {
                const items = await ctx.sdk.scanGroundItems(8);
                let n = 0;
                for (const it of items.filter(i => ARROW_RE.test(i.name)).slice(0, 6)) {
                    const r = await ctx.bot.pickupItem(it);
                    if (r.success) n++;
                }
                const a = inv(state(ctx), ARROW_RE)[0];
                if (a) await ctx.bot.equipItem(a);
                return n > 0 ? 'stop:picked up arrows' : 'fail:no arrows picked up';
            }),
    },

    // ── crafting ──
    {
        key: 'tan_cowhides_al_kharid',
        skills: ['Crafting'],
        available: s => count(s, HIDE_RE) > 0 && coins(s) >= (alKharidUnlocked(s) ? 1 : 11),
        describe: s => ({
            what: `take your ${count(s, HIDE_RE)} cowhides to the tanner and pay to turn them into soft leather`,
            where: fmtWhere(s, HUBS.al_kharid_tanner),
            requires: `1 coin per hide, plus a 10 coin toll at the Al Kharid gate the first time (you have ${coins(s)} coins)`,
            gives: 'leather, which is crafted into leather gloves with a needle and thread; gives no XP',
            notes: 'a long walk east from Lumbridge',
        }),
        run: ctx =>
            once(ctx, async () => {
                if (!(await enterAlKharid(ctx))) return 'fail:could not get through the Al Kharid gate';
                if (!(await goTo(ctx, HUBS.al_kharid_tanner, 5))) return 'fail:could not walk to the tanner';
                const before = count(state(ctx), LEATHER_RE);
                await dismiss(ctx);
                // The tanner's "Trade" option -> two "continue" pages -> tanning interface (id 679).
                const tanner = nearbyNamed(state(ctx), /^tanner$|ellis/i)[0];
                if (!tanner) return 'fail:no tanner nearby';
                const trade = tanner.optionsWithIndex.find(o => /trade/i.test(o.text));
                if (trade) await ctx.sdk.sendInteractNpc(tanner.index, trade.opIndex);
                else { const talk = await ctx.bot.talkTo(/^tanner$|ellis/i); if (!talk.success) return `fail:${talk.message}`; }
                for (let i = 0; i < 12; i++) {
                    await ctx.sdk.waitForTicks(2);
                    const s = state(ctx);
                    if (count(s, LEATHER_RE) > before) return `stop:tanned hides; now ${count(s, LEATHER_RE)} leather`;
                    if (s.interface.isOpen && s.interface.options.length) {
                        const opt = s.interface.options.find(o => /^tan all soft leather/i.test(o.text)) ?? s.interface.options.find(o => /soft leather/i.test(o.text));
                        if (!opt) return 'fail:tanning interface has no soft leather option';
                        await ctx.sdk.clickInterfaceOption(opt);
                        await ctx.sdk.waitForTicks(3);
                        const after = state(ctx);
                        return count(after, LEATHER_RE) > before ? `stop:tanned hides; now ${count(after, LEATHER_RE)} leather` : 'fail:tanning did not produce leather (not enough coins?)';
                    }
                    if (s.dialog.isOpen) {
                        const yes = s.dialog.options.find(o => /yes|leather/i.test(o.text));
                        await ctx.sdk.sendClickDialog(yes ? yes.index : 0);
                    }
                }
                return count(state(ctx), LEATHER_RE) > before ? 'stop:tanned hides' : 'fail:tanning interface not handled';
            }),
    },
    {
        key: 'buy_needle_and_thread_al_kharid',
        skills: ['Crafting'],
        available: s => (!has(s, NEEDLE_RE) || count(s, THREAD_RE) < 2) && coins(s) >= (alKharidUnlocked(s) ? 2 : 12),
        describe: s => ({
            what: 'buy a needle and thread from Dommik\'s crafting store',
            where: fmtWhere(s, HUBS.dommiks_crafting),
            requires: `about 2 coins, plus the 10 coin Al Kharid gate toll the first time (you have ${coins(s)} coins)`,
            gives: 'a needle and thread, needed to craft leather; gives no XP',
            notes: 'a long walk east from Lumbridge',
        }),
        run: ctx =>
            once(ctx, async () => {
                if (!(await enterAlKharid(ctx))) return 'fail:could not get through the Al Kharid gate';
                if (!(await openShopAt(ctx, HUBS.dommiks_crafting, /dommik/i))) return 'fail:could not open the crafting store';
                if (!has(state(ctx), NEEDLE_RE)) await ctx.bot.buyFromShop(/^needle$/i, 1);
                if (count(state(ctx), THREAD_RE) < 5) await ctx.bot.buyFromShop(/^thread$/i, Math.max(1, Math.min(10, coins(state(ctx)) - 1)));
                await ctx.bot.closeShop();
                const s = state(ctx);
                return has(s, NEEDLE_RE) && has(s, THREAD_RE) ? 'stop:bought needle and thread' : 'fail:could not buy both';
            }),
    },
    {
        key: 'craft_leather_gloves',
        skills: ['Crafting'],
        available: s => has(s, NEEDLE_RE) && has(s, THREAD_RE) && count(s, LEATHER_RE) > 0,
        describe: s => ({
            what: `sew leather gloves from the ${count(s, LEATHER_RE)} leather you carry`,
            where: 'right here',
            requires: 'a needle, thread and leather; Crafting level 1',
            gives: '13.8 Crafting XP per pair of gloves (before the server multiplier)',
            notes: `Crafting level ${level(s, 'Crafting')}; boots need level 7 (16.3 XP), a body needs level 14 (25 XP)`,
        }),
        run: (ctx, budget) =>
            burst(ctx, budget, async () => {
                await dismiss(ctx);
                if (count(state(ctx), LEATHER_RE) === 0) return 'stop:no leather left';
                const r = await ctx.bot.craftLeather('gloves');
                return r.success ? 'continue' : `fail:${r.reason ?? ''} ${r.message}`;
            }),
    },
];

// ───────────────────────────── routine builders ─────────────────────────────

function chopRoutine(ctx: Ctx, budget: number, hub: Hub, treeRe: RegExp): Promise<Outcome> {
    return burst(ctx, budget, async () => {
        await dismiss(ctx);
        const s = state(ctx);
        if (freeSlots(s) === 0) return 'stop:inventory is full';
        let tree = nearbyLocNamed(s, treeRe, /chop/i)[0];
        if (!tree) {
            if (!(await goTo(ctx, hub))) return 'fail:could not walk to the trees';
            tree = nearbyLocNamed(state(ctx), treeRe, /chop/i)[0];
            if (!tree) return 'fail:no such tree nearby';
        }
        const r = await ctx.bot.chopTree(tree);
        return r.success ? 'continue' : `fail:${(r as any).reason ?? ''} ${r.message}`;
    });
}

function fletchRoutine(ctx: Ctx, budget: number, product: string, logRe: RegExp): Promise<Outcome> {
    return burst(ctx, budget, async () => {
        await dismiss(ctx);
        if (inv(state(ctx), logRe).length === 0) return 'stop:no suitable logs left';
        const r = await ctx.bot.fletchLogs(product);
        return r.success ? 'continue' : `fail:${(r as any).reason ?? ''} ${r.message}`;
    });
}

function cookRoutine(ctx: Ctx, budget: number, hub: Hub, locRe: RegExp): Promise<Outcome> {
    return burst(ctx, budget, async () => {
        await dismiss(ctx);
        let s = state(ctx);
        const raw = inv(s, RAW_RE)[0];
        if (!raw) return 'stop:no raw food left';
        let src = nearbyLocNamed(s, locRe)[0];
        if (!src || src.distance > 10) {
            if (!(await goTo(ctx, hub, 6))) return 'fail:could not walk to the cooking spot';
            await sleep(600);
            s = state(ctx);
            src = nearbyLocNamed(s, locRe)[0];
            if (!src) return 'fail:no cooking spot nearby';
        }
        const r = await ctx.bot.useItemOnLoc(inv(s, RAW_RE)[0], src);
        if (!r.success) return `fail:${r.reason ?? ''} ${r.message}`;
        return (await waitForInventoryChange(ctx, RAW_RE, 6000)) ? 'continue' : 'fail:nothing cooked';
    });
}

function buyRoutine(ctx: Ctx, hub: Hub, keeperRe: RegExp, itemRe: RegExp, amount: number): Promise<Outcome> {
    return once(ctx, async () => {
        if (!(await openShopAt(ctx, hub, keeperRe))) return 'fail:could not open the shop';
        const r = await ctx.bot.buyFromShop(itemRe, amount);
        await ctx.bot.closeShop();
        return r.success || (r as any).amountBought > 0 ? 'stop:bought' : `fail:${r.reason ?? ''} ${r.message}`;
    });
}

async function enterAlKharid(ctx: Ctx): Promise<boolean> {
    const s = state(ctx);
    if (alKharidUnlocked(s)) return true;
    if (!(await goTo(ctx, HUBS.al_kharid_gate, 3))) return false;
    const gate = ctx.sdk.findNearbyLoc(/gate/i, { reachable: true });
    if (!gate) return false;
    await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, 1);
    await ctx.sdk.waitForTicks(2);
    for (let i = 0; i < 10; i++) {
        const st = state(ctx);
        const yes = st.dialog.options.find(o => /yes/i.test(o.text));
        if (yes) await ctx.sdk.sendClickDialog(yes.index);
        else if (st.dialog.isOpen) await ctx.sdk.sendClickDialog(0);
        await ctx.sdk.waitForTicks(1);
    }
    const r = await walkCapped(ctx, 3277, 3227, 2);
    const after = state(ctx);
    const inside = !!after.player && after.player.worldX >= 3273;
    if (inside) ctx.notes.alKharid = true;
    return inside || r.success;
}

/** Leave Al Kharid through the toll gate (same dialog as entering). */
async function exitAlKharid(ctx: Ctx): Promise<boolean> {
    if (!alKharidUnlocked(state(ctx))) return true;
    await walkCapped(ctx, 3277, 3227, 2);
    const gate = ctx.sdk.findNearbyLoc(/gate/i, { reachable: true });
    if (!gate) return false;
    await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, 1);
    await ctx.sdk.waitForTicks(2);
    for (let i = 0; i < 10; i++) {
        const st = state(ctx);
        const yes = st.dialog.options.find(o => /yes/i.test(o.text));
        if (yes) await ctx.sdk.sendClickDialog(yes.index);
        else if (st.dialog.isOpen) await ctx.sdk.sendClickDialog(0);
        await ctx.sdk.waitForTicks(1);
    }
    await walkCapped(ctx, 3265, 3228, 2);
    return !alKharidUnlocked(state(ctx));
}

function alKharidUnlocked(s: BotWorldState): boolean {
    return !!s.player && s.player.worldX >= 3273 && s.player.worldZ < 3230;
}

function currentStyleName(s: BotWorldState): string {
    const cs = s.combatStyle;
    if (!cs?.known) return 'unknown';
    return cs.styles.find(st => st.index === cs.currentStyle)?.name ?? 'unknown';
}

function currentStyleTrainsList(s: BotWorldState): string {
    const cs = s.combatStyle;
    if (!cs?.known) return 'unknown';
    const st = cs.styles.find(x => x.index === cs.currentStyle);
    return st ? st.trainsSkills.join(' + ') || 'nothing known' : 'unknown';
}

function currentStyleTrains(s: BotWorldState, skill: string): boolean {
    const cs = s.combatStyle;
    if (!cs?.known) return false;
    return cs.styles.find(x => x.index === cs.currentStyle)?.trainsSkills.includes(skill) ?? false;
}

function lootFor(skill: string): { re: RegExp; label: string } | null {
    if (skill === 'Prayer') return { re: BONES_RE, label: 'the bones' };
    if (skill === 'Crafting') return { re: HIDE_RE, label: 'the cowhides' };
    return null;
}

/** Starting-kit items the current task does not need. */
function sellable(s: BotWorldState, ctx: Ctx): InventoryItem[] {
    const combat = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Crafting'].includes(ctx.skill);
    const keep: RegExp[] = [/coins/i, FOOD_RE, /rune$/i, RAW_RE, LOGS_RE, ORE_RE, BONES_RE, HIDE_RE, LEATHER_RE, /bar$/i, KNIFE_RE, HAMMER_RE, NEEDLE_RE, THREAD_RE];
    if (['Woodcutting', 'Firemaking', 'Fletching', 'Cooking'].includes(ctx.skill)) keep.push(AXE_RE);
    if (['Firemaking', 'Cooking'].includes(ctx.skill)) keep.push(TINDERBOX_RE);
    if (['Fishing', 'Cooking'].includes(ctx.skill)) keep.push(NET_RE);
    if (['Mining', 'Smithing'].includes(ctx.skill)) keep.push(PICK_RE);
    if (combat) keep.push(/sword$|dagger$|shield$/i);
    if (ctx.skill === 'Ranged') keep.push(BOW_RE, ARROW_RE);
    if (ctx.skill === 'Magic') keep.push(/rune$/i);
    return s.inventory.filter(i => !keep.some(re => re.test(i.name)) && /axe$|pickaxe$|dagger$|sword$|shield$|bow$|arrows?$|^pot$|^bucket$|^jug$|fishing net$|^tinderbox$/i.test(i.name));
}

// ───────────────────────────── reference tables (from rs-sdk/wiki) ─────────────────────────────

export const REFERENCE: Record<string, unknown> = {
    Woodcutting: {
        trees: [
            { tree: 'regular tree', level: 1, xp_per_log: 25, where: 'west of Lumbridge castle' },
            { tree: 'oak', level: 15, xp_per_log: 37.5, where: 'north-west Varrock, east of Draynor bank' },
            { tree: 'willow', level: 30, xp_per_log: 67.5, where: 'Draynor shore (dark wizards nearby)' },
        ],
        notes: ['higher tier trees give several logs before falling', 'a bronze axe works on every tree; better axes chop faster'],
    },
    Firemaking: {
        logs: [
            { log: 'regular logs', level: 1, xp: 40 },
            { log: 'oak logs', level: 1, xp: 60 },
            { log: 'willow logs', level: 15, xp: 90 },
        ],
        notes: ['you need a tinderbox and logs', 'fires cannot be lit indoors'],
    },
    Fletching: {
        products: [
            { product: 'arrow shafts (15 per log)', level: 1, xp_per_log: 5, logs: 'regular' },
            { product: 'shortbow', level: 5, xp: 5, logs: 'regular' },
            { product: 'longbow', level: 10, xp: 10, logs: 'regular' },
            { product: 'oak shortbow', level: 20, xp: 16.5, logs: 'oak' },
            { product: 'oak longbow', level: 25, xp: 25, logs: 'oak' },
        ],
        notes: ['you need a knife; one spawns on the ground south-east of Lumbridge castle'],
    },
    Fishing: {
        methods: [
            { fish: 'shrimps', level: 1, xp: 10, gear: 'small fishing net', where: 'Draynor shore' },
            { fish: 'anchovies', level: 15, xp: 40, gear: 'small fishing net', where: 'Draynor shore' },
            { fish: 'trout', level: 20, xp: 50, gear: 'fly fishing rod + feathers (you have neither)', where: 'Lumbridge river' },
        ],
        notes: ['fishing spots are NPCs that move around occasionally'],
    },
    Cooking: {
        food: [
            { food: 'shrimps', level: 1, xp: 30 },
            { food: 'anchovies', level: 1, xp: 30 },
            { food: 'cooked meat', level: 1, xp: 30 },
            { food: 'trout', level: 15, xp: 70 },
        ],
        notes: ['raw fish come from fishing at Draynor', 'ranges burn less than open fires', 'burnt food gives no XP'],
    },
    Mining: {
        ores: [
            { ore: 'copper', level: 1, xp: 17.5, where: 'south-east Varrock mine' },
            { ore: 'tin', level: 1, xp: 17.5, where: 'south-east Varrock mine' },
            { ore: 'iron', level: 15, xp: 35, where: 'south-east Varrock mine, Al Kharid mine' },
        ],
        notes: ['rocks respawn a few seconds after being mined'],
    },
    Smithing: {
        methods: [
            { method: 'smelt bronze bar (1 copper + 1 tin)', level: 1, xp: 6.2, where: 'Lumbridge furnace' },
            { method: 'smith bronze dagger (1 bar)', level: 1, xp: 12.5, where: 'Varrock anvils; needs a hammer' },
            { method: 'smith bronze axe (1 bar)', level: 1, xp: 12.5, where: 'Varrock anvils; needs a hammer' },
        ],
        notes: ['ores come from mining', 'a hammer costs 1 coin at the Lumbridge general store'],
    },
    Thieving: {
        targets: [
            { target: 'man / woman', level: 1, xp: 8, loot: '3 coins', where: 'Lumbridge castle' },
            { target: 'farmer', level: 10, xp: 14.5, loot: '9 coins' },
            { target: 'warrior', level: 25, xp: 26, loot: '18 coins', where: 'Al Kharid palace' },
        ],
        notes: ['a failed attempt stuns you briefly and deals 1 damage'],
    },
    Prayer: {
        bones: [
            { bones: 'regular bones', xp: 4.5, from: 'chickens, cows, goblins, giant rats' },
            { bones: 'big bones', xp: 15, from: 'hill giants (dangerous)' },
        ],
        notes: ['bury bones from your inventory for XP'],
    },
    Magic: {
        spells: [
            { spell: 'Wind Strike', level: 1, runes: '1 air + 1 mind', xp: '5.5 base + 2 per damage' },
            { spell: 'Confuse', level: 3, runes: '3 body + 2 earth + 2 water', xp: 13 },
            { spell: 'Water Strike', level: 5, runes: '1 water + 1 air + 1 mind', xp: '7.5 base + 2 per damage' },
        ],
        notes: ['runes are consumed per cast', 'Aubury sells runes in east Varrock'],
    },
    Ranged: {
        notes: ['4 Ranged XP per damage', 'wield the shortbow and equip arrows, then attack', 'arrows can be picked up after a fight; some break'],
    },
    Attack: { notes: ['4 Attack XP per damage with an accurate style', 'weak targets die fast, so hitpoints per kill and re-targeting time matter'] },
    Strength: { notes: ['4 Strength XP per damage with an aggressive style'] },
    Defence: { notes: ['4 Defence XP per damage with a defensive style'] },
    Hitpoints: { notes: ['1.33 Hitpoints XP per damage dealt with any melee, ranged or magic attack'] },
    Crafting: {
        methods: [
            { method: 'leather gloves', level: 1, xp: 13.8, needs: 'leather + needle + thread' },
            { method: 'leather boots', level: 7, xp: 16.3, needs: 'leather + needle + thread' },
            { method: 'leather body', level: 14, xp: 25, needs: 'leather + needle + thread' },
        ],
        notes: ['cowhides drop from cows; the tanner in Al Kharid turns them into leather for 1 coin each', 'Al Kharid is behind a 10 coin toll gate'],
    },
};

export function candidates(s: BotWorldState, ctx: Ctx, suppressed: Set<string>): ActionSpec[] {
    return CATALOG.filter(a => (a.skills.includes('*') || a.skills.includes(ctx.skill)) && !suppressed.has(a.key) && safeAvailable(a, s, ctx));
}

function safeAvailable(a: ActionSpec, s: BotWorldState, ctx: Ctx): boolean {
    try {
        return a.available(s, ctx);
    } catch {
        return false;
    }
}
