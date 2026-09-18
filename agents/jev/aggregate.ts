// Summarize one or more local-bench.sh output directories into a markdown table
// and compare against the published 15-minute leaderboard (results/skills-15m/_data.js).
//
//   bun agents/jev/aggregate.ts --run jev=runs/jev-15m [--run random=runs/random-15m] [--minutes 15] [--md out.md] [--json out.json]
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Woodcutting', 'Fishing', 'Mining', 'Cooking', 'Fletching', 'Crafting', 'Smithing', 'Firemaking', 'Thieving'];

const args = process.argv.slice(2);
const runs: Array<{ label: string; dir: string }> = [];
let minutes = 15;
let mdOut: string | null = null;
let jsonOut: string | null = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') { const [label, dir] = args[++i].split('='); runs.push({ label, dir }); }
    else if (args[i] === '--minutes') minutes = parseInt(args[++i]);
    else if (args[i] === '--md') mdOut = args[++i];
    else if (args[i] === '--json') jsonOut = args[++i];
}
if (runs.length === 0) { console.error('need at least one --run label=dir'); process.exit(2); }

interface TaskResult { peak: number | null; level: number | null; xp: number | null; decisions: number | null; cost: number | null; tokens: number | null; actions: Record<string, number> | null; actionXp: Record<string, number> | null }

function readTask(dir: string, skill: string): TaskResult {
    const d = join(dir, `${skill.toLowerCase()}-xp-${minutes}m`);
    const rewardPath = join(d, 'verifier', 'reward.txt');
    const summaryPath = join(d, 'agent', 'summary.json');
    const peak = existsSync(rewardPath) ? parseFloat(readFileSync(rewardPath, 'utf8').trim()) : null;
    let s: any = null;
    if (existsSync(summaryPath)) s = JSON.parse(readFileSync(summaryPath, 'utf8'));
    return {
        peak: Number.isFinite(peak) ? Math.round(peak!) : null,
        level: s?.level_end ?? null,
        xp: s?.xp_gained ?? null,
        decisions: s?.decisions ?? null,
        cost: s?.jev_cost_usd ?? null,
        tokens: s?.jev_input_tokens ?? null,
        actions: s?.action_counts ?? null,
        actionXp: s?.action_xp ?? null,
    };
}

// Leaderboard
const lbPath = 'results/skills-15m/_data.js';
const lb: Record<string, Record<string, number | null>> = {};
if (existsSync(lbPath)) {
    const src = readFileSync(lbPath, 'utf8');
    const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
    for (const [model, skills] of Object.entries<any>(data)) {
        lb[model] = {};
        for (const sk of SKILLS) lb[model][sk] = skills[sk.toLowerCase()] ? Math.round(skills[sk.toLowerCase()].peakXpRate) : null;
    }
}
const lbModels = Object.keys(lb).filter(m => SKILLS.every(sk => lb[m][sk] !== null));
const lbAllModels = Object.keys(lb);
const meanOf = (vals: Array<number | null>) => { const v = vals.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const lbRanking = lbModels.map(m => ({ model: m, mean: meanOf(SKILLS.map(sk => lb[m][sk]))! })).sort((a, b) => b.mean - a.mean);

const results: Record<string, Record<string, TaskResult>> = {};
for (const r of runs) { results[r.label] = {}; for (const sk of SKILLS) results[r.label][sk] = readTask(r.dir, sk); }

// Markdown
const lines: string[] = [];
const header = ['Skill', ...runs.map(r => `${r.label} peak XP/min`), ...runs.map(r => `${r.label} total XP`), ...runs.map(r => `${r.label} level`), 'leaderboard best, any model', 'leaderboard median (16-skill models)'];
lines.push(`| ${header.join(' | ')} |`);
lines.push(`|${header.map(() => '---').join('|')}|`);
for (const sk of SKILLS) {
    const vals = lbModels.map(m => lb[m][sk]!).sort((a, b) => b - a);
    const allVals = lbAllModels.map(m => lb[m][sk]).filter((v): v is number => v !== null).sort((a, b) => b - a);
    const best = allVals.length ? `${allVals[0]} (${lbAllModels.find(m => lb[m][sk] === allVals[0])})` : '-';
    const median = vals.length ? String(vals[Math.floor(vals.length / 2)]) : '-';
    lines.push(`| ${sk} | ${runs.map(r => results[r.label][sk].peak ?? '-').join(' | ')} | ${runs.map(r => results[r.label][sk].xp?.toLocaleString() ?? '-').join(' | ')} | ${runs.map(r => results[r.label][sk].level ?? '-').join(' | ')} | ${best} | ${median} |`);
}
lines.push(`| **Mean** | ${runs.map(r => { const m = meanOf(SKILLS.map(sk => results[r.label][sk].peak)); return m === null ? '-' : `**${Math.round(m)}**`; }).join(' | ')} | ${runs.map(r => { const m = meanOf(SKILLS.map(sk => results[r.label][sk].xp)); return m === null ? '-' : `**${Math.round(m).toLocaleString()}**`; }).join(' | ')} | ${runs.map(() => '').join(' | ')} | ${lbRanking[0] ? `${Math.round(lbRanking[0].mean)} (${lbRanking[0].model})` : '-'} | ${lbRanking.length ? Math.round(lbRanking[Math.floor(lbRanking.length / 2)].mean) : '-'} |`);

lines.push('');
lines.push('Leaderboard mean of per-skill peak XP/min (models with all 16 skills), with the local runs inserted:');
lines.push('');
const merged = [...lbRanking.map(r => ({ model: r.model, mean: r.mean, local: false })), ...runs.map(r => ({ model: `${r.label} (this run)`, mean: meanOf(SKILLS.map(sk => results[r.label][sk].peak)) ?? -1, local: true }))].sort((a, b) => b.mean - a.mean);
lines.push('| Rank | Model | Mean peak XP/min |');
lines.push('|---|---|---|');
merged.forEach((r, i) => lines.push(`| ${i + 1} | ${r.local ? `**${r.model}**` : r.model} | ${r.mean < 0 ? '-' : Math.round(r.mean)} |`));

for (const r of runs) {
    const cost = SKILLS.reduce((a, sk) => a + (results[r.label][sk].cost ?? 0), 0);
    const tokens = SKILLS.reduce((a, sk) => a + (results[r.label][sk].tokens ?? 0), 0);
    const decisions = SKILLS.reduce((a, sk) => a + (results[r.label][sk].decisions ?? 0), 0);
    lines.push('');
    lines.push(`${r.label}: ${decisions} decisions, ${tokens.toLocaleString()} Jev input tokens, $${cost.toFixed(4)} total.`);
}

const md = lines.join('\n');
console.log(md);
if (mdOut) writeFileSync(mdOut, md + '\n');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ minutes, runs: results, leaderboard: lb, leaderboardRanking: lbRanking }, null, 1));
