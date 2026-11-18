/*
 * seed.js — 合成订单数据（本地演示用）
 * 时间戳固定，保证任何环境首次加载得到完全相同的版本与运行记录。
 * 所有金额单位为「分」（最小货币单位）；重量单位克；自定义权重为小数字符串。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AllocSeed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var T0 = '2026-11-10T09:00:00.000Z';
  var T1 = '2026-11-12T14:30:00.000Z';
  var T2 = '2026-11-15T10:05:00.000Z';

  // 商品主数据（v3 增加补录商品 P5）
  var PRODUCT_VERSIONS = {
    v1: [
      { id: 'P1', name: '机械键盘 K87', version: 'v1', unitPriceCents: 29900 },
      { id: 'P2', name: '27 寸 4K 显示器', version: 'v1', unitPriceCents: 159900 },
      { id: 'P3', name: '无线鼠标 M2', version: 'v1', unitPriceCents: 8900 },
      { id: 'P4', name: '高清摄像头 C1', version: 'v1', unitPriceCents: 15900 }
    ],
    v2: [
      { id: 'P1', name: '机械键盘 K87', version: 'v2', unitPriceCents: 29900 },
      { id: 'P2', name: '27 寸 4K 显示器', version: 'v2', unitPriceCents: 159900 },
      { id: 'P3', name: '无线鼠标 M2', version: 'v2', unitPriceCents: 8900 },
      { id: 'P4', name: '高清摄像头 C1', version: 'v2', unitPriceCents: 15900 }
    ],
    v3: [
      { id: 'P1', name: '机械键盘 K87', version: 'v3', unitPriceCents: 29900 },
      { id: 'P2', name: '27 寸 4K 显示器', version: 'v3', unitPriceCents: 159900 },
      { id: 'P3', name: '无线鼠标 M2', version: 'v3', unitPriceCents: 8900 },
      { id: 'P4', name: '高清摄像头 C1', version: 'v3', unitPriceCents: 15900 },
      { id: 'P5', name: '补录：USB-C 扩展坞', version: 'v3', unitPriceCents: 22900 }
    ]
  };

  // 订单级费用（金额：分）。F4 为负费用（平台优惠冲减）
  var FEES = [
    { id: 'F1', name: '顺丰运费', amountCents: 1800, basis: 'amount' },
    { id: 'F2', name: '重货派送附加费', amountCents: 650, basis: 'weight' },
    { id: 'F3', name: '保价服务费', amountCents: 420, basis: 'custom' },
    { id: 'F4', name: '满减优惠冲减', amountCents: -500, basis: 'amount' }
  ];

  // 源数据三个版本：v1 原始订单；v2 部分退款（P3 鼠标退货）；v3 补录扩展坞
  var SOURCE_VERSIONS = [
    {
      versionId: 'SV1',
      parentVersionId: null,
      reason: '原始下单：4 件商品、4 笔订单级费用',
      createdAt: T0,
      frozen: true,
      defaultBasis: 'amount',
      policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' },
      fees: JSON.parse(JSON.stringify(FEES)),
      products: JSON.parse(JSON.stringify(PRODUCT_VERSIONS.v1)),
      lines: [
        { lineId: 'L1', productId: 'P1', productName: '机械键盘 K87', status: 'active',
          amountCents: 29900, weightGrams: '950', customWeight: '3' },
        { lineId: 'L2', productId: 'P2', productName: '27 寸 4K 显示器', status: 'active',
          amountCents: 159900, weightGrams: '5200', customWeight: '8' },
        { lineId: 'L3', productId: 'P3', productName: '无线鼠标 M2', status: 'active',
          amountCents: 8900, weightGrams: '95', customWeight: '1' },
        { lineId: 'L4', productId: 'P4', productName: '高清摄像头 C1', status: 'active',
          amountCents: 15900, weightGrams: '180', customWeight: '2' }
      ]
    },
    {
      versionId: 'SV2',
      parentVersionId: 'SV1',
      reason: '部分退款：鼠标 L3 退货（行状态置 refunded，金额清零），商品版本升级 v2',
      createdAt: T1,
      frozen: true,
      defaultBasis: 'amount',
      policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' },
      fees: JSON.parse(JSON.stringify(FEES)),
      products: JSON.parse(JSON.stringify(PRODUCT_VERSIONS.v2)),
      lines: [
        { lineId: 'L1', productId: 'P1', productName: '机械键盘 K87', status: 'active',
          amountCents: 29900, weightGrams: '950', customWeight: '3' },
        { lineId: 'L2', productId: 'P2', productName: '27 寸 4K 显示器', status: 'active',
          amountCents: 159900, weightGrams: '5200', customWeight: '8' },
        { lineId: 'L3', productId: 'P3', productName: '无线鼠标 M2', status: 'refunded',
          amountCents: 0, weightGrams: '0', customWeight: '0' },
        { lineId: 'L4', productId: 'P4', productName: '高清摄像头 C1', status: 'active',
          amountCents: 15900, weightGrams: '180', customWeight: '2' }
      ]
    },
    {
      versionId: 'SV3',
      parentVersionId: 'SV2',
      reason: '补录商品：新增 USB-C 扩展坞 L5，商品版本升级 v3',
      createdAt: T2,
      frozen: true,
      defaultBasis: 'amount',
      policy: { zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' },
      fees: JSON.parse(JSON.stringify(FEES)),
      products: JSON.parse(JSON.stringify(PRODUCT_VERSIONS.v3)),
      lines: [
        { lineId: 'L1', productId: 'P1', productName: '机械键盘 K87', status: 'active',
          amountCents: 29900, weightGrams: '950', customWeight: '3' },
        { lineId: 'L2', productId: 'P2', productName: '27 寸 4K 显示器', status: 'active',
          amountCents: 159900, weightGrams: '5200', customWeight: '8' },
        { lineId: 'L3', productId: 'P3', productName: '无线鼠标 M2', status: 'refunded',
          amountCents: 0, weightGrams: '0', customWeight: '0' },
        { lineId: 'L4', productId: 'P4', productName: '高清摄像头 C1', status: 'active',
          amountCents: 15900, weightGrams: '180', customWeight: '2' },
        { lineId: 'L5', productId: 'P5', productName: '补录：USB-C 扩展坞', status: 'active',
          amountCents: 22900, weightGrams: '140', customWeight: '2' }
      ]
    }
  ];

  // 用于演示「缺失商品硬失败」的草稿版本（基于 SV1，但商品主数据删掉 P4）
  function buildBrokenDraft() {
    var base = JSON.parse(JSON.stringify(SOURCE_VERSIONS[0]));
    base.versionId = 'SVD-BROKEN';
    base.parentVersionId = 'SV1';
    base.reason = '异常演示：商品主数据缺少 P4（草稿，不会产生成功运行）';
    base.createdAt = T2;
    base.frozen = false;
    base.products = base.products.filter(function (p) { return p.id !== 'P4'; });
    return base;
  }

  return {
    ORDER_ID: 'O-20261110-0087',
    CURRENCY: 'CNY',
    TIMESTAMPS: { T0: T0, T1: T1, T2: T2 },
    SOURCE_VERSIONS: SOURCE_VERSIONS,
    buildBrokenDraft: buildBrokenDraft,
    POLICY_LABEL: {
      zeroWeight: { exclude: '排除（零权重行不分摊，其余行全额分摊）', error: '报错（中止本次计算）', equalShare: '等权兜底（全部为零时均分）' },
      negativeFee: { allow: '允许（按同构规则分摊负金额）', error: '报错（拒绝负费用）' },
      missingProduct: { error: '报错（硬失败，不发布结果）', unallocated: '保留未分配（金额不丢，标注原因）' }
    }
  };
});
