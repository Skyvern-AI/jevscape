// Minimal TypeSafe System One client for Bun.
//
// POST https://api.typesafe.ai/v1/systemone with { state, model, questions }.
// Jev returns typed answers (choice / noul / score) with calibrated
// probabilities. It never generates text, so every decision the controller
// needs must be expressed as a closed question.
//
// Retries 429 / 529 / 5xx / network errors with exponential backoff and
// honours `retry-after`. Every request and response is appended to a JSONL
// log so a run can be audited decision by decision.

import { appendFileSync } from 'fs';

export const TYPESAFE_URL = process.env.TYPESAFE_URL || 'https://api.typesafe.ai/v1/systemone';
export const JEV_USD_PER_M_INPUT = 0.042; // published price; output tokens are free

export type JevQuestion =
    | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
    | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
    | { type: 'score'; instructions: unknown; criteria: unknown[] };

export interface ChoiceAnswer {
    type: 'choice';
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}
export interface NoulAnswer { type: 'noul'; noul: number }
export interface ScoreAnswer {
    type: 'score';
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}
export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface JevResponse {
    model: string;
    answers: Record<string, JevAnswer>;
    usage: { input_tokens: number; output_tokens: number };
}

export interface JevUsage {
    calls: number;
    attempts: number;
    input_tokens: number;
    output_tokens: number;
    seconds: number;
}

export class JevClient {
    readonly usage: JevUsage = { calls: 0, attempts: 0, input_tokens: 0, output_tokens: 0, seconds: 0 };
    modelVersion: string | null = null;

    constructor(
        private readonly opts: {
            apiKey: string;
            model?: string;
            logPath?: string;
            timeoutMs?: number;
            maxAttempts?: number;
        },
    ) {
        if (!opts.apiKey) throw new Error('TYPESAFE_API_KEY is required');
    }

    get model(): string {
        return this.opts.model || 'jev-latest';
    }

    costUsd(): number {
        return (this.usage.input_tokens * JEV_USD_PER_M_INPUT) / 1_000_000;
    }

    async ask(
        state: unknown,
        questions: Record<string, JevQuestion>,
        meta: Record<string, unknown> = {},
    ): Promise<JevResponse & { seconds: number }> {
        const body = { state, model: this.model, questions };
        const maxAttempts = this.opts.maxAttempts ?? 6;
        const timeoutMs = this.opts.timeoutMs ?? 30_000;
        let delay = 1000;
        let lastError: unknown = null;
        const started = performance.now();

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            this.usage.attempts++;
            let res: Response;
            try {
                res = await fetch(TYPESAFE_URL, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.opts.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (err) {
                lastError = err;
                await sleep(delay);
                delay = Math.min(delay * 2, 16_000);
                continue;
            }

            if ([429, 529, 500, 502, 503, 504].includes(res.status)) {
                const retryAfter = Number(res.headers.get('retry-after'));
                lastError = new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
                await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay);
                delay = Math.min(delay * 2, 16_000);
                continue;
            }
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`typesafe ${res.status}: ${text.slice(0, 800)}`);
            }

            const data = (await res.json()) as JevResponse;
            const seconds = (performance.now() - started) / 1000;
            this.usage.calls++;
            this.usage.input_tokens += data.usage?.input_tokens ?? 0;
            this.usage.output_tokens += data.usage?.output_tokens ?? 0;
            this.usage.seconds += seconds;
            this.modelVersion = data.model || this.modelVersion;

            if (this.opts.logPath) {
                try {
                    appendFileSync(
                        this.opts.logPath,
                        JSON.stringify({ ts: new Date().toISOString(), ...meta, attempt, seconds: +seconds.toFixed(3), request: body, response: data }) + '\n',
                    );
                } catch {
                    // logging must never break a decision
                }
            }
            return { ...data, seconds };
        }
        throw new Error(`typesafe call failed after ${maxAttempts} attempts: ${String(lastError)}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
