// Thin wrapper around the Supabase RPC endpoints. No SDK needed: fewer bytes on mobile.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const TIMEOUT_MS = 12000;

export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

async function rpc(fn, args) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError('NETWORK');
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Functions raise stable codes like NAME_TAKEN as the error message.
    const msg = body && typeof body.message === 'string' ? body.message : '';
    throw new ApiError(/^[A-Z_]+$/.test(msg) ? msg : 'SERVER', msg);
  }
  return body;
}

export const joinGame = (code, name) => rpc('join_game', { p_code: code, p_name: name });
export const getCurrentQuestion = (token) => rpc('get_current_question', { p_token: token });
export const submitAnswer = (token, questionId, choice) =>
  rpc('submit_answer', { p_token: token, p_question_id: questionId, p_choice: choice });
export const useFiftyFifty = (token) => rpc('use_fifty_fifty', { p_token: token });
export const getMyAnswers = (token) => rpc('get_my_answers', { p_token: token });
export const getLeaderboard = (code) => rpc('get_leaderboard', { p_code: code });
