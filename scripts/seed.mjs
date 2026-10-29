// 把 500.com 全部双色球历史写入 Firestore（默认连接本地模拟器）
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { fetchHistory, applyDraws } from '@fucai/core';
initializeApp({ projectId: 'demo-fucai-ssq' });
const db = getFirestore();
const drop = Number(process.argv[2] || 0); // 可选：故意少写最后 N 期，用来测试增量抓取
const all = await fetchHistory(); const draws = drop ? all.slice(0, -drop) : all;
for (let i = 0; i < draws.length; i += 400) {
  const b = db.batch(); for (const d of draws.slice(i, i + 400)) b.set(db.collection('ssq_draws').doc(d.issue), d); await b.commit();
}
await db.doc('meta/ssq').set({ latestIssue: draws.at(-1).issue, updatedAt: FieldValue.serverTimestamp(), checkedAt: Date.now(), source: '500.com' });
await db.doc('meta/ssq_summary').set({ ...applyDraws(null, draws), updatedAt: Date.now() });
console.log(`seeded ${draws.length} draws (${draws[0].issue} ~ ${draws.at(-1).issue}), fetched ${all.length}`);
