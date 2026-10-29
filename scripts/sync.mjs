// 免费 Spark 方案的「后端」：由 GitHub Actions 定时运行（也可本地对模拟器运行）。
// 1) 从 500.com 增量抓取新开奖 → 写 ssq_draws、meta/ssq、meta/ssq_summary
// 2) 对已开奖的票写入 result（服务端复盘）
// 3) 注册名额上限：按创建时间保留前 MAX_USERS 个账号，其余禁用（--delete-extra 则删除账号及其数据）
// 凭证：环境变量 FIREBASE_SERVICE_ACCOUNT（服务账号 JSON 原文）；有 FIRESTORE_EMULATOR_HOST 时连模拟器。
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchHistory, toShortIssue, applyDraws, checkTicket, isFuyunActive } from '@fucai/core';

export const MAX_USERS = Number(process.env.MAX_USERS ?? 10);
const emu = !!process.env.FIRESTORE_EMULATOR_HOST;
const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
if (!emu && !sa) { console.error('缺少 FIREBASE_SERVICE_ACCOUNT（或设置 FIRESTORE_EMULATOR_HOST 连模拟器）'); process.exit(1); }
initializeApp(sa ? { credential: cert(sa), projectId: sa.project_id } : { projectId: process.env.GCLOUD_PROJECT ?? 'demo-fucai-ssq' });
const db = getFirestore();
const DRAWS = 'ssq_draws', META = db.doc('meta/ssq'), SUMMARY = db.doc('meta/ssq_summary');

async function loadSummary() {
  const s = await SUMMARY.get(); if (s.exists) return s.data();
  const all = (await db.collection(DRAWS).orderBy('issue').get()).docs.map(d => d.data());
  return applyDraws(null, all);
}
/** 增量抓取：从已存最新一期（含，用于补全当晚尚未公布的奖金）开始 */
export async function syncLatest(fetchImpl = fetch) {
  const meta = (await META.get()).data();
  const fetched = await fetchHistory(meta?.latestIssue ? toShortIssue(meta.latestIssue) : undefined, fetchImpl);
  const added = fetched.filter(d => !meta?.latestIssue || d.issue > meta.latestIssue);
  const summary = applyDraws(await loadSummary(), fetched);
  for (let i = 0; i < fetched.length; i += 400) { const b = db.batch(); for (const d of fetched.slice(i, i + 400)) b.set(db.collection(DRAWS).doc(d.issue), d); await b.commit(); }
  const now = Date.now();
  await META.set({ latestIssue: summary.latestIssue, updatedAt: FieldValue.serverTimestamp(), checkedAt: now, source: '500.com' }, { merge: true });
  await SUMMARY.set({ ...summary, updatedAt: now });
  // 复盘：本次抓到的期 + 最近 30 期（补录到已开奖期的票也会被处理；重复写无害）
  const issues = new Map([...summary.recent.slice(-30), ...fetched].map(d => [d.issue, d]));
  const reviewed = await reviewIssues([...issues.values()], summary.recent);
  return { added, latestIssue: summary.latestIssue, reviewed, summary: { ...summary, updatedAt: now }, checkedAt: now };
}
/** 4) 生成同源静态 JSON（国内无需访问 Google 即可看开奖/走势/选号）：web/public/data/ */
export async function writeStatic(summary, checkedAt, dir = new URL('../web/public/data/', import.meta.url)) {
  const all = (await db.collection(DRAWS).orderBy('issue').get()).docs.map(d => d.data());
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('ssq_summary.json', dir), JSON.stringify(summary));
  writeFileSync(new URL('meta.json', dir), JSON.stringify({ latestIssue: summary.latestIssue, checkedAt, total: all.length }));
  // 紧凑全量：[期号, 日期, 红1..红6, 蓝]
  writeFileSync(new URL('draws.json', dir), JSON.stringify({ fields: ['issue', 'date', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'blue'], rows: all.map(d => [d.issue, d.date, ...d.red, d.blue]) }));
  return all.length;
}
async function reviewIssues(draws, recent) {
  let n = 0;
  for (let i = 0; i < draws.length; i += 30) { // 'in' 最多 30 个值
    const chunk = draws.slice(i, i + 30), map = new Map(chunk.map(d => [d.issue, d]));
    const snap = await db.collectionGroup('tickets').where('targetIssue', 'in', chunk.map(d => d.issue)).get();
    for (let j = 0; j < snap.docs.length; j += 400) { const b = db.batch();
      for (const doc of snap.docs.slice(j, j + 400)) { const t = doc.data(), d = map.get(t.targetIssue);
        const r = checkTicket(t, d, isFuyunActive(d.issue, recent));
        if (JSON.stringify(t.result && { ...t.result, checkedAt: 0 }) === JSON.stringify({ ...r, checkedAt: 0 })) continue; // 未变化不写，省配额
        b.update(doc.ref, { result: { ...r, checkedAt: Date.now() } }); n++; }
      await b.commit(); }
  }
  return n;
}
/** 名额上限：按创建时间排序，第 MAX_USERS+1 个起禁用（或删除） */
export async function enforceCap(deleteExtra = false) {
  const users = []; let token;
  do { const r = await getAuth().listUsers(1000, token); users.push(...r.users); token = r.pageToken; } while (token);
  // 已在名单里的人永远优先（顺序稳定，不会因为新注册挤掉老用户）；其余按创建时间（Auth 只精确到秒，同秒按 uid）
  const seated = (await db.doc('admin/registrations').get()).data()?.uids ?? [], rank = u => { const i = seated.indexOf(u.uid); return i < 0 ? Infinity : i; };
  users.sort((a, b) => ((rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1)) || (Date.parse(a.metadata.creationTime) - Date.parse(b.metadata.creationTime)) || a.uid.localeCompare(b.uid));
  const extra = users.slice(MAX_USERS), out = [];
  for (const u of extra) {
    if (deleteExtra) { await getAuth().deleteUser(u.uid); await db.recursiveDelete(db.doc(`users/${u.uid}`)); out.push({ uid: u.uid, email: u.email, action: 'deleted' }); }
    else if (!u.disabled) { await getAuth().updateUser(u.uid, { disabled: true }); out.push({ uid: u.uid, email: u.email, action: 'disabled' }); }
  }
  await db.doc('admin/registrations').set({ uids: users.slice(0, MAX_USERS).map(u => u.uid), total: users.length, max: MAX_USERS, updatedAt: Date.now() });
  return { total: users.length, kept: Math.min(users.length, MAX_USERS), changed: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const r = args.includes('--cap-only') ? null : await syncLatest();
  if (r && args.includes('--static')) console.log(`静态 JSON：${await writeStatic(r.summary, r.checkedAt)} 期 → web/public/data/`);
  if (r) console.log(`同步：新增 ${r.added.length} 期 ${r.added.map(d => d.issue).join(' ')}，最新 ${r.latestIssue}，复盘写入 ${r.reviewed} 注`);
  const c = await enforceCap(args.includes('--delete-extra'));
  console.log(`名额：共 ${c.total} 个账号，保留 ${c.kept}，本次处理 ${c.changed.length}`, c.changed.map(x => `${x.email}:${x.action}`).join(' '));
}
