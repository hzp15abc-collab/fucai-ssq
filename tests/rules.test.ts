// Firestore 规则测试：需要先启动模拟器（127.0.0.1:8080）。npm run test:rules
import { initializeTestEnvironment, assertFails, assertSucceeds, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { readFileSync } from 'fs';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
let env: RulesTestEnvironment;
const T = { red: [1, 2, 3, 4, 5, 6], blue: 7, targetIssue: '2026125', cost: 2, createdAt: 1 };
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'demo-rules-test', firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } }); });
afterAll(() => env.cleanup());
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async c => {
  await setDoc(doc(c.firestore(), 'users/bob/tickets/t1'), { ...T, result: { tier: 0, prize: 0 } });
  await setDoc(doc(c.firestore(), 'users/alice/tickets/a1'), T);
  await setDoc(doc(c.firestore(), 'ssq_draws/2026124'), { issue: '2026124' }); await setDoc(doc(c.firestore(), 'admin/registrations'), { uids: ['alice', 'bob'] }); }); });
const alice = () => env.authenticatedContext('alice').firestore(), anon = () => env.unauthenticatedContext().firestore();
describe('票：只能访问自己的', () => {
  it('A 能读写自己的票', async () => { await assertSucceeds(getDocs(collection(alice(), 'users/alice/tickets'))); await assertSucceeds(addDoc(collection(alice(), 'users/alice/tickets'), T)); await assertSucceeds(deleteDoc(doc(alice(), 'users/alice/tickets/a1'))); });
  it('A 不能读/写/删 B 的票', async () => { await assertFails(getDocs(collection(alice(), 'users/bob/tickets'))); await assertFails(getDoc(doc(alice(), 'users/bob/tickets/t1')));
    await assertFails(addDoc(collection(alice(), 'users/bob/tickets'), T)); await assertFails(deleteDoc(doc(alice(), 'users/bob/tickets/t1'))); });
  it('未登录不能读写任何人的票', async () => { await assertFails(getDocs(collection(anon(), 'users/alice/tickets'))); await assertFails(addDoc(collection(anon(), 'users/alice/tickets'), T)); });
});
describe('result 只能服务端写', () => {
  it('新建时不能带 result', async () => { await assertFails(addDoc(collection(alice(), 'users/alice/tickets'), { ...T, result: { tier: 1, prize: 5000000 } })); });
  it('不能修改已有票（含 result）', async () => { await assertFails(updateDoc(doc(alice(), 'users/alice/tickets/a1'), { result: { tier: 1, prize: 5000000 } })); await assertFails(updateDoc(doc(alice(), 'users/alice/tickets/a1'), { cost: 0 })); });
  it('不能用 set 覆盖已有票', async () => { await assertFails(setDoc(doc(alice(), 'users/alice/tickets/a1'), { ...T, result: { tier: 1 } })); });
  it('字段校验', async () => { await assertFails(addDoc(collection(alice(), 'users/alice/tickets'), { ...T, cost: 0 })); await assertFails(addDoc(collection(alice(), 'users/alice/tickets'), { ...T, targetIssue: 'abc' }));
    await assertFails(addDoc(collection(alice(), 'users/alice/tickets'), { ...T, red: [1, 2, 3] })); });
  it('其他个人数据可写，但不能借此改 tickets', async () => { await assertSucceeds(setDoc(doc(alice(), 'users/alice/prefs/ui'), { x: 1 })); await assertFails(setDoc(doc(alice(), 'users/bob/prefs/ui'), { x: 1 })); });
});
describe('公共数据只读', () => {
  it('开奖可读不可写', async () => { await assertSucceeds(getDoc(doc(anon(), 'ssq_draws/2026124'))); await assertFails(setDoc(doc(alice(), 'ssq_draws/2026124'), { x: 1 })); await assertFails(setDoc(doc(alice(), 'meta/ssq_summary'), { x: 1 })); });
  it('注册名单不可读写', async () => { await assertFails(getDoc(doc(alice(), 'admin/registrations'))); await assertFails(setDoc(doc(alice(), 'admin/registrations'), { uids: [] })); });
});
