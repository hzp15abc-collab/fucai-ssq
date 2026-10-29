#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkTicket, isFuyunActive, generateCandidates, computeStats, generateTickets, coverDesign, verifyCover, DEFAULT_FILTERS, fetchHistory, Draw } from '@fucai/core';
let cache: { at: number; d: Draw[] } | null = null;
const load = async () => (cache && Date.now() - cache.at < 600_000) ? cache.d : (cache = { at: Date.now(), d: await fetchHistory() }).d;
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 1) }] });
const DISC = '仅供娱乐：过滤与覆盖不改变任何一注的中奖概率。';
const s = new McpServer({ name: 'fucai-ssq', version: '0.1.0' });
s.tool('get_latest_draw', '获取最新一期双色球开奖号码（数据源 500.com）', {}, async () => text((await load()).at(-1)));
s.tool('get_stats', '双色球统计：冷热号、遗漏、奇偶大小、和值', { window: z.number().int().min(10).max(5000).default(100) }, async ({ window }) => {
  const st = computeStats(await load(), window); return text({ window: st.window, total: st.total, latest: st.latest, hotRed: st.hotRed, coldRed: st.coldRed, hotBlue: st.hotBlue, coldBlue: st.coldBlue, latestShape: st.latestShape, sumP5_P95: [st.sumP5, st.sumP95], note: DISC }); });
s.tool('generate_tickets', '生成双色球号码：随机+过滤；或给 pool 做红球覆盖组合', {
  count: z.number().int().min(1).max(100).default(5), pool: z.array(z.number().int().min(1).max(33)).optional(),
  m: z.number().int().min(3).max(6).default(4), g: z.number().int().min(2).max(6).default(4) }, async ({ count, pool, m, g }) => {
  if (pool?.length) { const c = coverDesign(pool, m, g); return text({ mode: 'cover', rule: `池内中≥${m}个红球时，至少一注中≥${g}个`, tickets: c.length, cost: c.length * 2, verified: verifyCover(pool, m, g, c), list: c, note: DISC }); }
  const last = (await load()).at(-1)!; return text({ mode: 'filtered-random', tickets: generateTickets(count, { ...DEFAULT_FILTERS, excludeRecent: { numbers: last.red, maxOverlap: 1 } }), note: DISC }); });
s.tool('check_ticket', '复盘：把一注双色球号码和某期开奖对比，返回中红/中蓝/奖级/奖金（三到六等奖固定；一二等奖用 500.com 公布的单注金额）', {
  red: z.array(z.number().int().min(1).max(33)).length(6), blue: z.number().int().min(1).max(16), issue: z.string().regex(/^\d{7}$/).optional() }, async ({ red, blue, issue }) => {
  const all = await load(); const d = issue ? all.find(x => x.issue === issue) : all.at(-1); if (!d) return text({ error: `没有第 ${issue} 期开奖数据（可能尚未开奖）` });
  return text({ issue: d.issue, draw: { red: d.red, blue: d.blue }, ...checkTicket({ red, blue }, d, isFuyunActive(d.issue, all)), note: '奖金为税前' }); });
s.tool('rank_candidates', '生成按冷门度排序的候选号码（只减少与人分奖，不提高中奖概率）', { count: z.number().int().min(1).max(50).default(10) }, async ({ count }) => {
  const last = (await load()).at(-1)!; return text({ candidates: generateCandidates(count, { ...DEFAULT_FILTERS, excludeRecent: { numbers: last.red, maxOverlap: 1 } }, last), note: DISC }); });
await s.connect(new StdioServerTransport());
