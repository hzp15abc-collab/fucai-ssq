import type { Summary } from '@fucai/core';
/** 公开数据走同源静态 JSON（Firebase Hosting 国内可访问），由 GitHub Actions 同步后重新部署 */
async function getJson<T>(path: string, ms = 8000): Promise<T | null> {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(`${path}?t=${Math.floor(Date.now() / 60000)}`, { signal: c.signal, cache: 'no-cache' }); return r.ok ? await r.json() as T : null; }
  finally { clearTimeout(t); }
}
export async function loadSummary(): Promise<Summary | null> {
  const s = await getJson<Summary>('/data/ssq_summary.json').catch(() => null);
  if (s) return s;
  if (import.meta.env.DEV) { const fb = await import('./firebase'); return fb.loadSummary(); } // 本地开发：模拟器
  throw new Error('暂时读不到开奖数据，请稍后点「刷新」');
}
export async function loadMeta(): Promise<{ latestIssue?: string; checkedAt?: number } | null> {
  return getJson<{ latestIssue?: string; checkedAt?: number }>('/data/meta.json').catch(() => null);
}
/** Google 服务（Firestore/Auth）是否可达：5 秒超时 */
export async function googleReachable(ms = 5000): Promise<boolean> {
  if (import.meta.env.VITE_USE_EMULATOR !== 'false') return true;
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { await fetch('https://firestore.googleapis.com/', { mode: 'no-cors', signal: c.signal, cache: 'no-store' }); return true; }
  catch { return false; } finally { clearTimeout(t); }
}
export const withTimeout = <T,>(p: Promise<T>, ms = 5000) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
