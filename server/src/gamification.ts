import { get, getSettings, run } from './db.ts';
import { publish } from './events.ts';

export const ACHIEVEMENTS: Record<string, { name: string; emoji: string; hint: string }> = {
  first_reply: { name: 'Hello, World', emoji: '👋', hint: 'Send your first reply' },
  speed_demon: { name: 'Speed Demon', emoji: '⚡', hint: 'First response in under a minute' },
  closer: { name: 'The Closer', emoji: '🎯', hint: 'Resolve 10 conversations' },
  streak_7: { name: 'On Fire', emoji: '🔥', hint: 'Reply 7 days in a row' },
  xp_1000: { name: 'Quadruple Digits', emoji: '💎', hint: 'Earn 1,000 XP' },
};

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function unlock(userId: number, key: string): string | undefined {
  const res = run('INSERT OR IGNORE INTO achievements(user_id, key, at) VALUES(?, ?, ?)', userId, key, Date.now());
  return res.changes ? key : undefined;
}

function grant(userId: number, xp: number, achievement?: string) {
  run('UPDATE users SET xp = xp + ? WHERE id = ?', xp, userId);
  const total = get<{ xp: number }>('SELECT xp FROM users WHERE id = ?', userId)?.xp ?? 0;
  const won = achievement ?? (total >= 1000 ? unlock(userId, 'xp_1000') : undefined);
  publish({ type: 'celebrate', userId, xp, achievement: won });
}

function touchStreak(userId: number) {
  const u = get<{ streak: number; last_active_day: string | null }>('SELECT streak, last_active_day FROM users WHERE id = ?', userId);
  if (!u || u.last_active_day === dayKey()) return;
  const streak = u.last_active_day === dayKey(Date.now() - 864e5) ? u.streak + 1 : 1;
  run('UPDATE users SET streak = ?, last_active_day = ? WHERE id = ?', streak, dayKey(), userId);
  if (streak >= 7) unlock(userId, 'streak_7');
}

/** responseMs is set only for the first reply in a conversation. */
export function awardReply(userId: number, responseMs: number | null) {
  if (!getSettings().fun_mode) return;
  touchStreak(userId);
  const first = unlock(userId, 'first_reply');
  if (responseMs !== null && responseMs < 60e3) grant(userId, 15, unlock(userId, 'speed_demon') ?? first);
  else grant(userId, responseMs !== null ? 8 : 2, first);
}

export function awardResolve(userId: number) {
  if (!getSettings().fun_mode) return;
  const n = get<{ n: number }>("SELECT COUNT(*) n FROM conversations WHERE assignee_id = ? AND status = 'resolved'", userId)?.n ?? 0;
  grant(userId, 20, n >= 10 ? unlock(userId, 'closer') : undefined);
}
