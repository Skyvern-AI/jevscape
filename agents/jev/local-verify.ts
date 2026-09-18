// Local verifier: the same peak-rate computation as shared/check_skill_xp.ts,
// with the file locations taken from the environment so it can run outside
// the Docker image. Keep computePeakXpRate byte-for-byte in sync with the
// shared verifier.
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

import { BotSDK } from '../../sdk/index';

const SKILL_NAME = process.env.SKILL_NAME;
if (!SKILL_NAME) {
    console.error('SKILL_NAME environment variable is required');
    process.exit(1);
}
const TRACKING_FILE = process.env.TRACKING_FILE || '/logs/tracking/skill_tracking.json';
const OUT_DIR = process.env.OUT_DIR || '/logs/verifier';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:7780';
const BOT_NAME = process.env.BOT_NAME || 'agent';
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'test';

function getSkillXpFromSample(sample: any, skill: string): number {
    if (!sample?.skills) return 0;
    for (const [name, data] of Object.entries(sample.skills)) {
        if (name.toLowerCase() === skill.toLowerCase()) {
            return (data as any).xp || 0;
        }
    }
    return 0;
}

function computePeakXpRate(samples: any[], skill: string): number {
    let peak = 0;
    for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const curr = samples[i];
        const deltaXp = getSkillXpFromSample(curr, skill) - getSkillXpFromSample(prev, skill);
        const deltaMs = curr.elapsedMs - prev.elapsedMs;
        if (deltaMs <= 0 || deltaXp <= 0) continue;
        const rate = (deltaXp / deltaMs) * 60000 / 8 / 25; // real-game XP/min (÷8 game speed, ÷25 XP rate)
        if (rate > peak) peak = rate;
    }
    return Math.round(peak);
}

async function main() {
    const sdk = new BotSDK({
        botUsername: BOT_NAME,
        password: BOT_PASSWORD,
        gatewayUrl: GATEWAY_URL,
        connectionMode: 'observe',
        autoLaunchBrowser: false,
        autoReconnect: false,
    });
    mkdirSync(OUT_DIR, { recursive: true });
    let level = 1;
    let xp = 0;
    try {
        await sdk.connect();
        await sdk.waitForCondition(s => s.inGame && s.skills.length > 0, 15000);
        const skill = sdk.getSkill(SKILL_NAME as string);
        level = skill?.level ?? 1;
        xp = skill?.experience ?? 0;
    } catch (err) {
        console.error('could not read live state (using tracking data only):', err);
    } finally {
        try { sdk.disconnect(); } catch { /* ignore */ }
    }

    let trackingData: any = null;
    if (existsSync(TRACKING_FILE)) {
        trackingData = JSON.parse(readFileSync(TRACKING_FILE, 'utf-8'));
        const n = trackingData?.samples?.length ?? 0;
        console.log(`Tracking data: ${n} samples from ${TRACKING_FILE}`);
        if (n > 0 && xp === 0) {
            const last = trackingData.samples[n - 1];
            xp = getSkillXpFromSample(last, SKILL_NAME as string);
            level = last.skills?.[SKILL_NAME as string]?.level ?? level;
        }
    } else {
        console.log('No tracking data file found at', TRACKING_FILE);
    }
    const peakXpRate = computePeakXpRate(trackingData?.samples || [], SKILL_NAME as string);
    const rewardObj = { skill: SKILL_NAME, peakXpRate, xp, level, verifierStartTime: new Date().toISOString(), tracking: trackingData };
    writeFileSync(join(OUT_DIR, 'reward.json'), JSON.stringify(rewardObj, null, 2));
    writeFileSync(join(OUT_DIR, 'reward.txt'), peakXpRate.toString());
    console.log(`Reward: peakXpRate=${peakXpRate} XP/min, xp=${xp}, level=${level}`);
}

main().catch(err => {
    console.error('Verification error:', err);
    process.exit(1);
});
