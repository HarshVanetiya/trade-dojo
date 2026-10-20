import { Router } from 'express';
import { config } from '../config.js';
import { h, requireAuth } from '../lib/http.js';
import { getSettings } from '../services/settings.js';

export const settingsPublicRouter = Router();

/** Settings the app needs to render (no secrets). */
settingsPublicRouter.get(
  '/public',
  requireAuth,
  h(async (_req, res) => {
    const s = getSettings();
    res.json({
      startingPoints: s.starting_points,
      riskWarnPct: s.risk_warn_pct,
      resetThresholdPct: s.reset_threshold_pct,
      resetCooldownDays: s.reset_cooldown_days,
      leaderboardEnabled: s.leaderboard_enabled,
      leaderboardMinTrades: s.leaderboard_min_trades,
      aiCoachEnabled: config.AI_COACH_ENABLED && !!config.AI_COACH_API_KEY,
      setupTags: ['Breakout', 'Pullback', 'Trend-follow', 'Reversal', 'News', 'Other'],
    });
  }),
);
