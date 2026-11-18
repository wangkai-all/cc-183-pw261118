/*
 * invariant.test.js — 算法不变量 / 属性测试（零依赖，确定性伪随机）
 * 覆盖：任意整数费用、任意权重组合下的守恒；负费用；零权重策略；重复确定性。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

// 可复现的 LCG 伪随机（不用 Math.random，保证测试本身确定）
function lcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('属性测试：200 组随机费用/权重组合，订单级与单费用守恒恒成立', () => {
  const rand = lcg(20261118);
  for (let iter = 0; iter < 200; iter++) {
    const nLines = 1 + Math.floor(rand() * 8);
    const nFees = 1 + Math.floor(rand() * 4);
    const bases = ['amount', 'weight', 'custom'];
    const lines = [];
    for (let i = 0; i < nLines; i++) {
      lines.push({
        lineId: 'L' + i,
        productId: 'P' + i,
        productName: '商品' + i,
        amountCents: Math.floor(rand() * 200000),
        weightGrams: String(Math.floor(rand() * 6000)),
        customWeight: String(Math.floor(rand() * 10))
      });
    }
    const fees = [];
    for (let i = 0; i < nFees; i++) {
      const neg = rand() < 0.25;
      const mag = Math.floor(rand() * 50000) + 1; // 最小 1 分
      fees.push({
        id: 'F' + i, name: '费用' + i,
        amountCents: neg ? -mag : mag,
        basis: bases[Math.floor(rand() * 3)]
      });
    }
    const r = E.allocate({
      orderId: 'PROP', fees, lines,
      products: lines.map(l => ({ id: l.productId, version: 'v1' })),
      policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }
    });
    // 订单级守恒
    assert.equal(r.conservation.balanced, true, 'iter ' + iter + ' 订单级守恒');
    assert.equal(r.conservation.diffCents, 0);
    // 单费用守恒
    r.conservation.perFee.forEach(chk => assert.equal(chk.balanced, true, 'iter ' + iter + ' 单费用守恒'));
    // 每行分配的绝对值 ≤ 费用绝对值（不可能分出超过本金）
    r.feeResults.forEach(fr => {
      fr.details.forEach(d => {
        assert.ok(Math.abs(d.allocatedCents) <= Math.abs(fr.feeAmountCents) + 1,
          'iter ' + iter + ' 单行分配不超过费用本金');
      });
    });
    // 重复运行完全一致
    const r2 = E.allocate({
      orderId: 'PROP',
      fees: JSON.parse(JSON.stringify(fees)),
      lines: JSON.parse(JSON.stringify(lines)),
      products: lines.map(l => ({ id: l.productId, version: 'v1' })),
      policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }
    });
    assert.equal(r2.inputHash, r.inputHash);
    assert.deepEqual(
      r.feeResults.map(f => f.details.map(d => d.allocatedCents)),
      r2.feeResults.map(f => f.details.map(d => d.allocatedCents))
    );
  }
});

test('属性测试：含零权重行的 100 组随机组合，金额不丢', () => {
  const rand = lcg(424242);
  for (let iter = 0; iter < 100; iter++) {
    const lines = [];
    const n = 2 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const zero = rand() < 0.4;
      lines.push({
        lineId: 'L' + i, productId: 'P' + i, productName: 'x',
        amountCents: Math.floor(rand() * 100000),
        weightGrams: zero ? '0' : String(1 + Math.floor(rand() * 3000)),
        customWeight: zero ? '0' : String(1 + Math.floor(rand() * 9))
      });
    }
    const amount = 1 + Math.floor(rand() * 20000);
    const r = E.allocate({
      orderId: 'Z', fees: [{ id: 'F', name: 'f', amountCents: amount, basis: 'weight' }],
      lines, products: lines.map(l => ({ id: l.productId, version: 'v1' })),
      policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }
    });
    const allocated = r.feeResults[0].details.reduce((s, d) => s + d.allocatedCents, 0);
    const unalloc = r.feeResults[0].unallocatedCents;
    assert.equal(allocated + unalloc, amount, 'iter ' + iter + ' 零权重场景总额守恒');
    // 零权重行必须为 0 且有原因
    r.feeResults[0].details.filter(d => d.basisValue === 0).forEach(d => {
      assert.equal(d.allocatedCents, 0);
      assert.ok(d.unallocatedReason);
    });
  }
});

test('负费用尾差：-1000 按等权三行 → -334/-333/-333，符号与尾差标记正确', () => {
  const r = E.allocate({
    orderId: 'N',
    fees: [{ id: 'F', name: '冲减', amountCents: -1000, basis: 'custom' }],
    lines: [
      { lineId: 'L1', productId: 'P1', amountCents: 100, customWeight: '1' },
      { lineId: 'L2', productId: 'P2', amountCents: 100, customWeight: '1' },
      { lineId: 'L3', productId: 'P3', amountCents: 100, customWeight: '1' }
    ],
    products: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }],
    policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }
  });
  assert.deepEqual(r.feeResults[0].details.map(d => d.allocatedCents), [-334, -333, -333]);
  assert.ok(r.feeResults[0].details[0].exactShareText.includes('-1 分'));
  assert.equal(r.conservation.balanced, true);
});

test('最小金额 1 分：只可能分给一行，其余为 0，守恒', () => {
  const r = E.allocate({
    orderId: 'M',
    fees: [{ id: 'F', name: '一分钱', amountCents: 1, basis: 'amount' }],
    lines: [
      { lineId: 'L1', productId: 'P1', amountCents: 1000 },
      { lineId: 'L2', productId: 'P2', amountCents: 2000 },
      { lineId: 'L3', productId: 'P3', amountCents: 3000 }
    ],
    products: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }],
    policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }
  });
  const allocs = r.feeResults[0].details.map(d => d.allocatedCents);
  assert.equal(allocs.reduce((a, b) => a + b, 0), 1);
  assert.equal(allocs.filter(x => x === 1).length, 1);
});

test('小数字符串权重按 1e6 定点解析：0.1+0.2 场景比例正确且不引入浮点误差', () => {
  const r = E.allocate({
    orderId: 'D',
    fees: [{ id: 'F', name: 'f', amountCents: 300, basis: 'custom' }],
    lines: [
      { lineId: 'L1', productId: 'P1', amountCents: 100, customWeight: '0.1' },
      { lineId: 'L2', productId: 'P2', amountCents: 100, customWeight: '0.2' }
    ],
    products: [{ id: 'P1' }, { id: 'P2' }],
    policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }
  });
  // 权重比 1:2 → 100 / 200
  assert.deepEqual(r.feeResults[0].details.map(d => d.allocatedCents), [100, 200]);
});
