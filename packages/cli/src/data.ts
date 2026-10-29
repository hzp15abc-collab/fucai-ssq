import { fetchHistory, Draw } from '@fucai/core';
/** 数据源：直接抓 500.com 全量历史，内存缓存 10 分钟 */
let cache: { at: number; draws: Draw[] } | null = null;
export async function loadDraws(): Promise<Draw[]> {
  if (cache && Date.now() - cache.at < 600_000) return cache.draws;
  cache = { at: Date.now(), draws: await fetchHistory() }; return cache.draws;
}
