import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { beforeUserCreated } from 'firebase-functions/v2/identity';
import * as v1 from 'firebase-functions/v1';
import { getAuth } from 'firebase-admin/auth';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { fetchHistory, toShortIssue, Draw, Summary, applyDraws, checkTicket, isFuyunActive, SavedTicket } from '@fucai/core';

initializeApp();
const db = getFirestore();
const DRAWS = 'ssq_draws', META = db.doc('meta/ssq'), SUMMARY = db.doc('meta/ssq_summary');

/** 汇总文档不存在时（首次）从全量集合重建一次；之后只增量更新 */
async function loadSummary(): Promise<Summary> {
  const s = await SUMMARY.get(); if (s.exists) return s.data() as Summary;
  const all = (await db.collection(DRAWS).orderBy('issue').get()).docs.map(d => d.data() as Draw);
  return applyDraws(null, all);
}

/** 增量抓取：从最新一期（含，用于补全当晚尚未公布的奖金）开始请求 500.com，写入新期、更新汇总、自动复盘 */
export async function syncLatest(): Promise<{ added: Draw[]; latestIssue: string | null; reviewed: number }> {
  const meta = (await META.get()).data() as { latestIssue?: string } | undefined;
  const fetched = await fetchHistory(meta?.latestIssue ? toShortIssue(meta.latestIssue) : undefined);
  const added = fetched.filter(d => !meta?.latestIssue || d.issue > meta.latestIssue);
  const summary = applyDraws(await loadSummary(), fetched);
  const batch = db.batch();
  for (const d of fetched) batch.set(db.collection(DRAWS).doc(d.issue), d);
  if (fetched.length) batch.set(META, { latestIssue: summary.latestIssue, updatedAt: FieldValue.serverTimestamp(), source: '500.com' }, { merge: true });
  batch.set(SUMMARY, { ...summary, updatedAt: Date.now() });
  await batch.commit();
  const reviewed = await reviewIssues(fetched, summary.recent);
  return { added, latestIssue: summary.latestIssue || null, reviewed };
}

/** 对目标期号已开奖的票做复盘（重复执行无害：会用最新奖金信息覆盖） */
async function reviewIssues(draws: Draw[], recent: Draw[], uid?: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < draws.length; i += 30) { // Firestore 'in' 最多 30 个值
    const chunk = draws.slice(i, i + 30), map = new Map(chunk.map(d => [d.issue, d]));
    const q = (uid ? db.collection(`users/${uid}/tickets`) : db.collectionGroup('tickets')).where('targetIssue', 'in', chunk.map(d => d.issue));
    const snap = await q.get(); const b = db.batch();
    for (const doc of snap.docs) { const t = doc.data() as SavedTicket, d = map.get(t.targetIssue)!;
      b.update(doc.ref, { result: { ...checkTicket(t, d, isFuyunActive(d.issue, recent)), checkedAt: Date.now() } }); n++; }
    if (snap.size) await b.commit();
  }
  return n;
}

const http = { cors: true, region: 'asia-east1', timeoutSeconds: 60 } as const;
/** 网页「抓取最新开奖」按钮调用 */
export const fetchLatest = onRequest(http, async (_req, res) => {
  try { const r = await syncLatest(); logger.info('fetchLatest', { added: r.added.length, reviewed: r.reviewed }); res.json({ ok: true, addedCount: r.added.length, added: r.added, latestIssue: r.latestIssue, reviewed: r.reviewed }); }
  catch (e) { logger.error(e); res.status(502).json({ ok: false, error: String(e) }); }
});
/** 复盘当前登录用户的全部已开奖票（例如给已开奖的期号补录票后）。uid 来自登录凭证，不能指定别人 */
export const reviewMyTickets = onCall({ region: 'asia-east1', cors: true }, async (req) => {
  const uid = req.auth?.uid; if (!uid) throw new HttpsError('unauthenticated', '请先登录');
  const s = (await SUMMARY.get()).data() as Summary | undefined; if (!s) throw new HttpsError('unavailable', '汇总数据缺失');
  const issues = [...new Set((await db.collection(`users/${uid}/tickets`).get()).docs.map(d => (d.data() as SavedTicket).targetIssue))];
  const drawn = (await Promise.all(issues.map(i => db.collection(DRAWS).doc(i).get()))).filter(d => d.exists).map(d => d.data() as Draw);
  return { reviewed: await reviewIssues(drawn, s.recent, uid) };
});

// ================= 注册名额：最多 MAX_USERS 人（服务端强制） =================
export const MAX_USERS = 10;
const SEATS = db.doc('admin/registrations'); // { uids: string[] }，客户端规则不可读写
const FULL_MSG = `注册名额已满（最多 ${MAX_USERS} 人），请联系管理员。`;
/** 事务占位：已在名单里的 uid 直接通过；名单满则拒绝。并发注册也不会超额 */
async function reserveSeat(uid: string): Promise<boolean> {
  return db.runTransaction(async tx => { const doc = await tx.get(SEATS); const uids: string[] = doc.data()?.uids ?? [];
    if (uids.includes(uid)) return true; if (uids.length >= MAX_USERS) return false;
    tx.set(SEATS, { uids: [...uids, uid], updatedAt: Date.now() }); return true; });
}
/**
 * 方案 A（默认）：阻塞函数，在 Auth 真正创建用户之前执行，客户端 SDK 的 createUserWithEmailAndPassword 也绕不过。
 * 正式部署需要把项目升级到 Identity Platform（GCIP），且需 Blaze 套餐。
 */
export const beforecreated = beforeUserCreated({ region: 'asia-east1' }, async (event) => {
  const uid = event.data?.uid; if (!uid) throw new HttpsError('invalid-argument', '缺少用户信息');
  if (!(await reserveSeat(uid))) throw new HttpsError('resource-exhausted', FULL_MSG);
});
/** 用户被删除时释放名额 */
export const releaseSeat = v1.region('asia-east1').auth.user().onDelete(async (user) => {
  await db.runTransaction(async tx => { const d = await tx.get(SEATS); tx.set(SEATS, { uids: (d.data()?.uids ?? []).filter((u: string) => u !== user.uid), updatedAt: Date.now() }); });
  await db.recursiveDelete(db.doc(`users/${user.uid}`));
});
/**
 * 方案 B（备用，不用 Identity Platform 时）：可调用函数注册。Admin SDK 建用户不会触发阻塞函数，所以这里自己占位。
 * 用这个方案时，应在 Firebase 控制台关闭「允许用户注册」（Authentication → Settings → User actions → Enable create (sign-up)），
 * 否则客户端仍可直接注册绕过上限。
 */
export const registerUser = onCall({ region: 'asia-east1', cors: true }, async (req) => {
  const email = String(req.data?.email ?? '').trim().toLowerCase(), password = String(req.data?.password ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError('invalid-argument', '邮箱格式不正确');
  if (password.length < 6) throw new HttpsError('invalid-argument', '密码至少 6 位');
  if (await getAuth().getUserByEmail(email).then(() => true, () => false)) throw new HttpsError('already-exists', '该邮箱已注册');
  const uid = db.collection('_').doc().id; // 先生成 uid 占位，再建用户
  if (!(await reserveSeat(uid))) throw new HttpsError('resource-exhausted', FULL_MSG);
  try { await getAuth().createUser({ uid, email, password }); return { uid }; }
  catch (e: any) { await db.runTransaction(async tx => { const d = await tx.get(SEATS); tx.set(SEATS, { uids: (d.data()?.uids ?? []).filter((u: string) => u !== uid) }); });
    throw new HttpsError('already-exists', e?.code === 'auth/email-already-exists' ? '该邮箱已注册' : String(e?.message ?? e)); }
});

/** 双色球周二/四/日 21:15 开奖；21:45、22:30 各跑一次（北京时间）。需 Blaze 套餐 */
export const scheduledFetch = onSchedule({ schedule: '45 21 * * 0,2,4', timeZone: 'Asia/Shanghai', region: 'asia-east1', retryCount: 3 }, async () => {
  const r = await syncLatest(); logger.info('scheduledFetch', { added: r.added.length, latest: r.latestIssue, reviewed: r.reviewed });
});
export const scheduledFetchRetry = onSchedule({ schedule: '30 22 * * 0,2,4', timeZone: 'Asia/Shanghai', region: 'asia-east1' }, async () => {
  const r = await syncLatest(); logger.info('scheduledFetchRetry', { added: r.added.length, reviewed: r.reviewed });
});
