/*
 * engine.test.js — 分摊引擎测试（node --test，零依赖）
 * 运行：node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

const products = [
  { id: 'P1', name: '机械键盘', version: 'v1' },
  { id: 'P2', name: '显示器', version: 'v1' },
  { id: 'P3', name: '鼠标', version: 'v1' },
  { id: 'P4', name: '摄像头', version: 'v1' }
];
const lines = [
  { lineId: 'L1', productId: 'P1', productName: '机械键盘', amountCents: 30000, weightGrams: 900, customWeight: 3 },
  { lineId: 'L2', productId: 'P2', productName: '显示器', amountCents: 50000, weightGrams: 4500, customWeight: 5 },
  { lineId: 'L3', productId: 'P3', productName: '鼠标', amountCents: 20000, weightGrams: 120, customWeight: 2 }
];
const fee = (id, name, amountCents, basis) => ({ id, name, amountCents, basis });

function baseInput(over = {}) {
  return Object.assign({
    orderId: 'O-1001',
    fees: [fee('F1', '运费', 1000, 'amount')],
    lines: JSON.parse(JSON.stringify(lines)),
    products: JSON.parse(JSON.stringify(products)),
    defaultBasis: 'amount',
    policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }
  }, over);
}

test('按金额分摊：整数分守恒，无金额丢失', () => {
  const r = E.allocate(baseInput());
  assert.equal(r.conservation.balanced, true);
  assert.equal(r.conservation.diffCents, 0);
  const sum = r.feeResults[0].details.reduce((s, d) => s + d.allocatedCents, 0);
  assert.equal(sum, 1000);
  // 300/500/200 → 300/500/200 分
  assert.deepEqual(r.feeResults[0].details.map(d => d.allocatedCents), [300, 500, 200]);
});

test('尾差：不能整除时最大余数法 + 稳定排序，且总额守恒', () => {
  // 1000 分按 1:1:1 → 每行 333，余 1 分给排序最前者
  const input = baseInput({
    fees: [fee('F1', '包装费', 1000, 'custom')],
    lines: lines.map(l => Object.assign({}, l, { customWeight: 1 }))
  });
  const r = E.allocate(input);
  const allocs = r.feeResults[0].details.map(d => d.allocatedCents);
  assert.deepEqual(allocs, [334, 333, 333]);
  assert.equal(allocs.reduce((a, b) => a + b, 0), 1000);
  // 第一行记录了尾差调整与裁决序号
  const d0 = r.feeResults[0].details[0];
  assert.equal(d0.exactShareText.includes('+1 分'), true);
  assert.equal(d0.tieBreakOrder, 1);
});

test('确定性：相同输入重复运行，哈希与每行结果完全一致', () => {
  const input = baseInput({ fees: [fee('F1', '运费', 12345, 'weight')] });
  const r1 = E.allocate(JSON.parse(JSON.stringify(input)));
  const r2 = E.allocate(JSON.parse(JSON.stringify(input)));
  assert.equal(r1.inputHash, r2.inputHash);
  assert.deepEqual(
    r1.feeResults[0].details.map(d => d.allocatedCents),
    r2.feeResults[0].details.map(d => d.allocatedCents)
  );
});

test('相同权重尾差按输入行序稳定裁决（数组顺序属于输入快照的一部分）', () => {
  const a = baseInput({ fees: [fee('F1', '包装费', 1000, 'custom')],
    lines: lines.map(l => Object.assign({}, l, { customWeight: 1 })) });
  const b = JSON.parse(JSON.stringify(a));
  // 打乱数组顺序 —— 尾差裁决跟随各自输入顺序；同时签名哈希应反映快照差异
  b.lines = [b.lines[2], b.lines[0], b.lines[1]];
  const ra = E.allocate(a), rb = E.allocate(b);
  assert.notEqual(ra.inputHash, rb.inputHash);
  const get = (r, id) => r.feeResults[0].details.find(d => d.lineId === id).allocatedCents;
  assert.equal(get(ra, 'L1'), 334); // a 中 L1 行序第一
  assert.equal(get(rb, 'L3'), 334); // b 中 L3 行序第一
  // 两个结果各自守恒
  assert.equal(ra.conservation.balanced, true);
  assert.equal(rb.conservation.balanced, true);
});

test('按重量分摊：使用定点整数权重，守恒', () => {
  const r = E.allocate(baseInput({ fees: [fee('F1', '运费', 1000, 'weight')] }));
  const allocs = r.feeResults[0].details.map(d => d.allocatedCents);
  assert.equal(allocs.reduce((a, b) => a + b, 0), 1000);
  // 900:4500:120 = 总 5520 → 163/815/22（约）
  assert.equal(allocs[1] > allocs[0], true);
  assert.equal(r.conservation.balanced, true);
});

test('零权重默认策略 exclude：零权重行得 0 并给出原因，其余行全额分摊不丢钱', () => {
  const input = baseInput({
    fees: [fee('F1', '服务费', 1000, 'weight')],
    lines: [
      { lineId: 'L1', productId: 'P1', amountCents: 30000, weightGrams: 900 },
      { lineId: 'L2', productId: 'P2', amountCents: 50000, weightGrams: 0 },
      { lineId: 'L3', productId: 'P3', amountCents: 20000, weightGrams: 100 }
    ]
  });
  const r = E.allocate(input);
  const d = r.feeResults[0].details;
  assert.equal(d[1].allocatedCents, 0);
  assert.equal(d[1].qualified, false);
  assert.ok(d[1].unallocatedReason.includes('零权重'));
  assert.equal(d[0].allocatedCents + d[2].allocatedCents, 1000);
  assert.equal(r.conservation.balanced, true);
});

test('零权重策略 error：整体失败并抛 AllocationError，不产生结果', () => {
  const input = baseInput({
    policy: { zeroWeight: 'error', negativeFee: 'allow', missingProduct: 'error' },
    fees: [fee('F1', '服务费', 1000, 'weight')],
    lines: [
      { lineId: 'L1', productId: 'P1', amountCents: 30000, weightGrams: 0 },
      { lineId: 'L2', productId: 'P2', amountCents: 50000, weightGrams: 100 }
    ]
  });
  assert.throws(() => E.allocate(input), e => e.name === 'AllocationError' && e.errors[0].code === 'ZERO_WEIGHT');
});

test('零权重策略 equalShare：全零权重时按行均分且守恒', () => {
  const input = baseInput({
    policy: { zeroWeight: 'equalShare', negativeFee: 'allow', missingProduct: 'error' },
    fees: [fee('F1', '服务费', 1000, 'weight')],
    lines: [
      { lineId: 'L1', productId: 'P1', amountCents: 30000, weightGrams: 0 },
      { lineId: 'L2', productId: 'P2', amountCents: 50000, weightGrams: 0 },
      { lineId: 'L3', productId: 'P3', amountCents: 20000, weightGrams: 0 }
    ]
  });
  const r = E.allocate(input);
  assert.deepEqual(r.feeResults[0].details.map(d => d.allocatedCents), [334, 333, 333]);
});

test('负费用默认 allow：按绝对值算法同构分摊，符号为负且守恒', () => {
  const r = E.allocate(baseInput({ fees: [fee('F1', '优惠冲减', -1000, 'amount')] }));
  const allocs = r.feeResults[0].details.map(d => d.allocatedCents);
  assert.deepEqual(allocs, [-300, -500, -200]);
  assert.equal(r.conservation.balanced, true);
});

test('负费用策略 error：拒绝并报错', () => {
  const input = baseInput({
    policy: { zeroWeight: 'exclude', negativeFee: 'error', missingProduct: 'error' },
    fees: [fee('F1', '优惠冲减', -1000)]
  });
  assert.throws(() => E.allocate(input), e => e.errors[0].code === 'NEGATIVE_FEE');
});

test('缺失商品默认 error：硬失败', () => {
  const input = baseInput();
  input.lines.push({ lineId: 'L9', productId: 'PX', productName: '幽灵商品', amountCents: 1000 });
  assert.throws(() => E.allocate(input), e => e.errors.some(x => x.code === 'MISSING_PRODUCT'));
});

test('缺失商品策略 unallocated：金额保留未分配且守恒，不凭空丢钱', () => {
  const input = baseInput({
    policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'unallocated' }
  });
  input.lines = input.lines.concat([{ lineId: 'L9', productId: 'PX', productName: '幽灵商品', amountCents: 1000 }]);
  const r = E.allocate(input);
  const ghost = r.feeResults[0].details.find(d => d.lineId === 'L9');
  assert.equal(ghost.allocatedCents, 0);
  assert.ok(ghost.unallocatedReason.includes('缺失商品'));
  // 有效行分掉的 1000 不变，ghost 行本身不产生额外未分配（费用已被有效行全分）
  assert.equal(r.conservation.balanced, true);
  assert.equal(r.conservation.totalAllocatedCents, 1000);
  assert.equal(r.feeResults[0].unallocatedCents, 0);
  assert.deepEqual(r.feeResults[0].unallocatedReasons, []); // 全额分完时不报“保留未分配”
});

test('缺失商品策略 unallocated：有效行也无权重时，费用全额保留未分配且守恒', () => {
  const input = {
    orderId: 'O', defaultBasis: 'weight',
    policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'unallocated' },
    fees: [fee('F1', '运费', 1000, 'weight')],
    lines: [
      { lineId: 'L1', productId: 'P1', productName: '键盘', amountCents: 30000, weightGrams: 0 },
      { lineId: 'L9', productId: 'PX', productName: '幽灵', amountCents: 1000 }
    ],
    products: [{ id: 'P1', version: 'v1' }]
  };
  const r = E.allocate(input);
  assert.equal(r.conservation.balanced, true);
  assert.equal(r.conservation.totalAllocatedCents, 0);
  assert.equal(r.conservation.totalUnallocatedCents, 1000);
  assert.ok(r.feeResults[0].unallocatedReasons.join('；').includes('缺失商品'));
});

test('全部行零权重：费用全额挂未分配并附原因，守恒仍成立', () => {
  const input = baseInput({
    fees: [fee('F1', '服务费', 1000, 'weight')],
    lines: [
      { lineId: 'L1', productId: 'P1', amountCents: 30000, weightGrams: 0 },
      { lineId: 'L2', productId: 'P2', amountCents: 50000, weightGrams: 0 }
    ]
  });
  const r = E.allocate(input);
  assert.equal(r.feeResults[0].unallocatedCents, 1000);
  assert.ok(r.feeResults[0].unallocatedReasons[0].includes('未分配'));
  assert.equal(r.conservation.balanced, true);
});

test('零费用：允许，每行 0 分，守恒', () => {
  const r = E.allocate(baseInput({ fees: [fee('F1', '免运费', 0)] }));
  assert.deepEqual(r.feeResults[0].details.map(d => d.allocatedCents), [0, 0, 0]);
  assert.equal(r.conservation.balanced, true);
});

test('结果对象被冻结，不可篡改', () => {
  const r = E.allocate(baseInput());
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.feeResults[0]));
  assert.ok(Object.isFrozen(r.feeResults[0].details[0]));
  assert.ok(Object.isFrozen(r.lineResults[0]));
  const mutate = (obj, key, val) => function () { 'use strict'; obj[key] = val; };
  assert.throws(mutate(r.conservation, 'diffCents', 999));
  assert.throws(mutate(r.feeResults[0].details[0], 'allocatedCents', 1));
});

test('非法金额（非整数分）被拒绝', () => {
  const input = baseInput();
  input.fees[0].amountCents = 12.34;
  assert.throws(() => E.allocate(input), e => e.errors.some(x => x.code === 'INVALID_AMOUNT'));
});

test('多费用混合规则：订单级总守恒 + 行级汇总正确', () => {
  const input = baseInput({
    fees: [
      fee('F1', '运费', 1000, 'amount'),
      fee('F2', '重货附加', 500, 'weight'),
      fee('F3', '自定义服务费', 333, 'custom')
    ]
  });
  const r = E.allocate(input);
  assert.equal(r.conservation.totalFeeCents, 1833);
  assert.equal(r.conservation.balanced, true);
  const rowSum = r.lineResults.reduce((s, l) => s + l.totalAllocatedCents, 0);
  assert.equal(rowSum, 1833);
  assert.deepEqual(r.lineResults.map(l => l.bases).length, 3);
});
