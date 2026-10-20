import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import type { TradeRow } from '../engine/engine.js';
import type { ReviewRow } from './review.js';

let client: Anthropic | null = null;

export const aiCoachEnabled = () => config.AI_COACH_ENABLED && !!config.AI_COACH_API_KEY;

/**
 * Anonymized review data only: no names, emails, ids, or free-text notes (which might
 * contain personal details). Prices are rounded to rupees.
 */
export function anonymizedPayload(trade: TradeRow, review: ReviewRow, instrumentName: string) {
  const r = (p: number | null) => (p === null ? null : Math.round(p / 100));
  return {
    instrument: instrumentName,
    direction: trade.direction,
    quantityGrams: trade.qty_g,
    entryPrice: r(trade.entry_price),
    exitPrice: r(trade.exit_price),
    stopLoss: r(trade.initial_sl_price),
    target: r(trade.initial_tp_price),
    exitReason: trade.exit_reason,
    netPnlPoints: r(trade.net_pnl),
    rMultiple: trade.r_multiple,
    plannedRewardToRisk: trade.planned_rr,
    riskPercentOfAccount: trade.risk_pct,
    holdingMinutes: Math.round(trade.holding_seconds / 60),
    setupTag: trade.setup_tag,
    confidence1to5: trade.confidence,
    maxFavourablePoints: r(review.mfe_paise),
    maxAdversePoints: r(review.mae_paise),
    coachingFlags: review.flags.map((f) => f.title),
    whatIfs: Object.fromEntries(Object.entries(review.whatifs).map(([k, v]) => [k, v.available ? r(v.pnl) : null])),
  };
}

export async function aiCoach(payload: ReturnType<typeof anonymizedPayload>): Promise<string> {
  if (!aiCoachEnabled()) throw new AppError(404, 'ai_coach_disabled', 'The AI coach is not enabled.');
  client ??= new Anthropic({ apiKey: config.AI_COACH_API_KEY });
  const response = await client.beta.messages.create({
    model: config.AI_COACH_MODEL,
    max_tokens: 2048,
    output_config: { effort: 'low' },
    // Re-route automatically if the model declines a request.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system:
      'You are a calm, encouraging trading coach for beginners practising MCX gold and silver futures with virtual points. ' +
      'Given one simulated trade review, write one short paragraph (at most 90 words) of specific, practical coaching: one thing done well and the most important thing to improve. ' +
      'Plain language, no jargon without a brief explanation, no investment advice or price predictions.',
    messages: [{ role: 'user', content: `Trade review data (JSON):\n${JSON.stringify(payload)}` }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  if (response.stop_reason === 'refusal') throw new AppError(502, 'ai_coach_unavailable', 'The AI coach could not review this trade.');
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new AppError(502, 'ai_coach_unavailable', 'The AI coach returned no advice.');
  return text;
}
