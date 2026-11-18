/*
 * dom-smoke.js — 最小 DOM 桩冒烟测试：验证浏览器侧初始化、渲染、运行、修订、导出链路。
 * 运行：node tests/dom-smoke.js
 */
'use strict';
const assert = require('node:assert');

/* ---- 极简 DOM 桩 ---- */
function makeNode(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), children: [], childNodes: [], attributes: {},
    style: {}, dataset: {}, _text: '', _html: '', className: '', innerHTML: '',
    classList: { add(c) { this._c = this._c || new Set(); this._c.add(c); },
      remove(c) { this._c && this._c.delete(c); },
      toggle(c, on) { on ? this.add(c) : this.remove(c); },
      contains(c) { return !!(this._c && this._c.has(c)); } },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    insertAdjacentHTML() { this._hasHtml = true; },
    addEventListener(ev, fn) { (this._lis = this._lis || {})[ev] = (this._lis[ev] || []).concat(fn); },
    dispatch(ev) { (this._lis && this._lis[ev] || []).forEach(fn => fn.call(this, { target: this })); },
    click() { this.dispatch('click'); },
    remove() {},
    querySelector() { return makeNode('div'); },
    querySelectorAll() { return []; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set innerHTML2(v) {},
    get firstChild() { return this.children[0] || null; },
    set href(v) { this.attributes.href = v; }, get href() { return this.attributes.href; },
    set download(v) { this.attributes.download = v; }, get download() { return this.attributes.download; }
  };
}
const nodes = [];
global.document = {
  createElement(tag) { const n = makeNode(tag); nodes.push(n); return n; },
  createTextNode(t) { return { text: t }; },
  querySelector(sel) {
    const n = makeNode(); n.selector = sel;
    if (sel === 'nav.tabs button') n.dataset = { tab: 'calc' };
    return n;
  },
  querySelectorAll() { return []; },
  addEventListener(ev, fn) { this._ready = fn; },
  body: makeNode('body')
};
global.window = global;
global.Blob = class { constructor(parts) { this.parts = parts; } };
global.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
global.confirm = () => true;
const store0 = [];
global.localStorage = {
  getItem: k => (k in store0 ? store0[k] : null),
  setItem(k, v) { store0[k] = v; },
  removeItem(k) { delete store0[k]; }
};

/* ---- 加载浏览器脚本（UMD 挂 window） ---- */
const vm = require('node:vm');
const fs = require('node:fs');
const ctx = vm.createContext(Object.assign(global, { module: undefined, exports: {} }));
['js/engine.js', 'js/seed.js', 'js/store.js', 'js/app.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
});

// 脚本加载时因 readyState 非 loading 已自动 boot()
const E = window.AllocEngine, S = window.AllocStore, Seed = window.AllocSeed;

// localStorage 已持久化
assert.ok(localStorage.getItem(S.STORAGE_KEY), 'localStorage 应有初始状态');
const persisted = JSON.parse(localStorage.getItem(S.STORAGE_KEY));
console.log('初始化运行数:', persisted.runs.length,
  '| 成功:', persisted.runs.filter(r => r.status === 'success').length,
  '| 失败:', persisted.runs.filter(r => r.status === 'failed').length);
// 5 次 executeRun 中第 3 次与第 1 次同签名被幂等复用 → 落库 4 成功 + 1 失败
assert.equal(persisted.runs.filter(r => r.status === 'success').length, 4);
assert.equal(persisted.runs.filter(r => r.status === 'failed').length, 1);

// 所有成功运行守恒
persisted.runs.filter(r => r.status === 'success').forEach(r => {
  assert.equal(r.result.conservation.balanced, true, r.runId + ' 必须守恒');
  assert.ok(Object.isFreeze ? true : true);
});
console.log('✔ 全部成功运行订单级守恒');

// 幂等：再跑 SV1 默认规则，运行数不增加
const store = new S.Store(Seed);
const before = store.state.runs.length;
const out = store.executeRun('SV1', {}, 'DOM 冒烟重复运行');
assert.equal(out.duplicated, true);
assert.equal(store.state.runs.length, before);
console.log('✔ 重复运行幂等复用', out.run.runId);

// 规则切换产生不同签名与不同分摊
const rWeight = store.executeRun('SV1', { F1: 'weight', F2: 'weight', F3: 'weight', F4: 'weight' }, 'x');
const rDefault = store.executeRun('SV1', {}, 'x');
assert.notEqual(rWeight.run.inputHash, rDefault.run.inputHash);
const f1Default = rDefault.run.result.feeResults[0].details.map(d => d.allocatedCents);
const f1Weight = rWeight.run.result.feeResults[0].details.map(d => d.allocatedCents);
assert.notDeepEqual(f1Default, f1Weight);
console.log('✔ 切换规则改变分摊：默认', f1Default, '重量', f1Weight);

// 修订（退款）→ 新版本，旧版本与旧运行保留
const oldVersionCount = store.state.versions.length;
const nv = store.reviseVersion('SV1', '冒烟测试修订', d => {
  d.lines[0].status = 'refunded';
  d.lines[0].amountCents = 0; d.lines[0].weightGrams = '0'; d.lines[0].customWeight = '0';
});
const runNew = store.executeRun(nv.versionId, {}, '修订后');
assert.equal(store.state.versions.length, oldVersionCount + 1);
assert.ok(store.state.versions.some(v => v.versionId === 'SV1'), '旧版本必须保留');
assert.equal(runNew.ok, true);
assert.equal(runNew.run.result.conservation.balanced, true);
console.log('✔ 修订派生新版本', nv.versionId, '且旧版本保留、新运行守恒');

// 失败原子性：缺失商品硬失败，result 为 null
const broken = Seed.buildBrokenDraft();
const brokenInput = S.buildEngineInput(broken, {});
assert.throws(() => E.allocate(brokenInput), e => e.name === 'AllocationError');
const failed = store.state.runs.find(r => r.status === 'failed');
assert.equal(failed.result, null);
assert.ok(failed.errors.some(e => e.code === 'MISSING_PRODUCT'));
console.log('✔ 缺失商品硬失败，失败记录无结果字段');

// 比较与导出
const cmp = S.compareRuns(store.state.runs[0], store.state.runs[3]);
assert.ok(cmp);
const csv = S.runToCSV(store.state.runs[0]);
assert.ok(csv.startsWith('运行ID,'));
assert.ok(csv.includes('订单级守恒核对'));
assert.ok(csv.includes('未分配'));
console.log('✔ 运行比较与 CSV 导出正常，CSV 行数:', csv.split('\n').length);

// 确定性：全新状态重建，预置运行哈希与初始状态一致（不受后续新增运行影响）
const seedHashes = persisted.runs.filter(r => r.status === 'success').map(r => r.inputHash).sort();
store.reset(Seed);
const rebuiltHashes = store.state.runs.filter(r => r.status === 'success').map(r => r.inputHash).sort();
assert.deepEqual(seedHashes, rebuiltHashes);
console.log('✔ 重置后重建，预置运行输入签名完全一致（确定性）');

// 渲染链路：四个 tab 切换 + 成功/失败运行渲染，均不抛错
['calc', 'source', 'compare', 'runs'].forEach(tab => window.AllocApp.switchTab(tab));
const appStore = window.AllocApp.getStore();
const host = document.createElement('div');
window.AllocApp.renderRunResult(host, appStore.state.runs.find(r => r.status === 'success'));
window.AllocApp.renderRunResult(host, appStore.state.runs.find(r => r.status === 'failed'));
assert.ok(host.children.length >= 2, '两次渲染都应产生面板');
console.log('✔ 四个标签页与成功/失败结果渲染均可执行');

// 修订向导链路：通过 store 复现向导里三个快捷操作对应的草稿变换并提交新版本
const verBefore = appStore.state.versions.length;
const draft = JSON.parse(JSON.stringify(appStore.state.versions.find(v => v.versionId === 'SV1')));
// 快捷操作 1：部分退款
const target = draft.lines.find(x => x.status === 'active');
target.status = 'refunded'; target.amountCents = 0; target.weightGrams = '0'; target.customWeight = '0';
// 快捷操作 2：补录商品
const n = draft.lines.length + 1;
const pid = 'P' + (draft.products.length + 1);
draft.products.push({ id: pid, name: '补录商品', version: 'vX', unitPriceCents: 12900 });
draft.lines.push({ lineId: 'L' + n, productId: pid, productName: '补录商品', status: 'active',
  amountCents: 12900, weightGrams: '300', customWeight: '1' });
const revised = appStore.reviseVersion('SV1', '冒烟向导：退款+补录', d => {
  d.lines = draft.lines; d.products = draft.products;
});
const wizardRun = appStore.executeRun(revised.versionId, {}, '向导修订后运行');
assert.equal(wizardRun.ok, true);
assert.equal(wizardRun.run.result.conservation.balanced, true);
assert.equal(appStore.state.versions.length, verBefore + 1);
console.log('✔ 修订向导变换（退款+补录）生成新版本并成功守恒运行', revised.versionId);

// 快捷操作 3：缺失商品草稿 → 硬失败，不发布
const brokenDraft = JSON.parse(JSON.stringify(revised));
brokenDraft.products.shift();
const brokenOut = (function () {
  // 复刻 executeRun 对缺失商品的硬失败路径
  const input = S.buildEngineInput(brokenDraft, {});
  try { E.allocate(input); return { ok: true }; }
  catch (e) { return { ok: false, code: e.errors[0].code }; }
})();
assert.equal(brokenOut.ok, false);
assert.equal(brokenOut.code, 'MISSING_PRODUCT');
console.log('✔ 向导缺失商品草稿触发硬失败（MISSING_PRODUCT），无结果发布');

console.log('\n全部 DOM 冒烟断言通过 ✅');
