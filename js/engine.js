/*
 * engine.js — 订单级费用分摊引擎（纯函数、确定性、零依赖）
 *
 * 设计约束：
 *  1. 金额一律以最小货币单位（整数分）参与运算，全程不出现浮点。
 *  2. 权重（重量/自定义权重）按 1e6 定点缩放为整数，允许小数。
 *  3. 最大余数法（largest remainder）分摊，余数相同时按稳定排序（显式行序）裁决。
 *  4. 纯函数：同一输入与规则必然得到相同结果；不含时钟、随机数、持久化。
 *  5. 校验失败时抛出 AllocationError（携带全部错误），调用方不发布任何部分结果。
 *
 * 同时支持浏览器（挂到 window.AllocEngine）与 Node（module.exports）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AllocEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCALE = 1000000; // 权重定点缩放因子
  var BASIS = { AMOUNT: 'amount', WEIGHT: 'weight', CUSTOM: 'custom' };
  var BASIS_LABEL = { amount: '商品金额', weight: '重量', custom: '自定义权重' };

  /* ---------- 基础工具 ---------- */

  function isInt(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  // 十进制小数字符串/数字 -> 定点整数；scale 为 10 的幂
  function decimalToScaled(value, scale, field, errors) {
    if (typeof value === 'number' && isInt(value)) return value * scale;
    if (typeof value !== 'string') value = String(value);
    var m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!m) {
      errors.push({ code: 'INVALID_DECIMAL', field: field, message: field + ' 不是合法数字: ' + value });
      return 0;
    }
    var frac = m[3] || '';
    if (frac.length > 6) {
      errors.push({ code: 'PRECISION_OVERFLOW', field: field, message: field + ' 小数位超过 6 位: ' + value });
      frac = frac.slice(0, 6);
    }
    var whole = m[1] + m[2] + frac;
    var n = parseInt(whole, 10) * Math.pow(10, 6 - frac.length);
    return n;
  }

  // 分（整数）-> 展示金额字符串（两位小数，千分位）
  function centsToDisplay(c) {
    var neg = c < 0;
    var abs = Math.abs(c);
    var whole = Math.floor(abs / 100);
    var frac = String(abs % 100).padStart(2, '0');
    var s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + s + '.' + frac;
  }

  // 定点整数权重 -> 展示（去掉末尾多余的零，保留原始量级感知）
  function weightToDisplay(wScaled) {
    var neg = wScaled < 0;
    var abs = Math.abs(wScaled);
    var s = String(abs).padStart(7, '0');
    var whole = s.slice(0, s.length - 6);
    var frac = s.slice(s.length - 6).replace(/0+$/, '');
    var out = frac ? whole + '.' + frac : whole;
    return (neg ? '-' : '') + out;
  }

  // 确定性 32 位 FNV-1a 哈希（hex 字符串）
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  // 规范化 JSON：对象键排序，保证相同数据序列化结果一致
  function canonicalJSON(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonicalJSON(value[k]); }).join(',') + '}';
  }

  // 稳定排序：先按 keySelector 排，相等时回退到原始索引
  function stableSort(arr, keySelector) {
    return arr.map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) {
        var ka = keySelector(a.x), kb = keySelector(b.x);
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return a.i - b.i;
      })
      .map(function (r) { return r.x; });
  }

  function AllocationError(errors) {
    this.name = 'AllocationError';
    this.message = '分摊校验失败，共 ' + errors.length + ' 项错误，未生成任何结果';
    this.errors = errors;
  }
  AllocationError.prototype = Object.create(Error.prototype);

  /* ---------- 输入校验 ---------- */

  function validateInput(input) {
    var errors = [];
    if (!input || typeof input !== 'object') {
      throw new AllocationError([{ code: 'EMPTY_INPUT', field: '-', message: '输入为空' }]);
    }
    var fees = input.fees, lines = input.lines, products = input.products || [];
    var policy = input.policy || {};
    var missPolicy = policy.missingProduct !== undefined ? policy.missingProduct : 'error';

    if (!Array.isArray(fees) || fees.length === 0)
      errors.push({ code: 'NO_FEE', field: 'fees', message: '至少需要一条订单级费用' });
    if (!Array.isArray(lines) || lines.length === 0)
      errors.push({ code: 'NO_LINE', field: 'lines', message: '至少需要一条商品行' });

    var feeIds = {}, lineIds = {}, productIds = {};

    (fees || []).forEach(function (f, idx) {
      var where = 'fees[' + idx + ']';
      if (!f || typeof f !== 'object') { errors.push({ code: 'BAD_RECORD', field: where, message: '费用记录格式错误' }); return; }
      if (!f.id) errors.push({ code: 'MISSING_ID', field: where + '.id', message: '费用缺少 id' });
      else if (feeIds[f.id]) errors.push({ code: 'DUP_ID', field: where + '.id', message: '费用 id 重复: ' + f.id });
      else feeIds[f.id] = true;
      if (!f.name) errors.push({ code: 'MISSING_FIELD', field: where + '.name', message: '费用 ' + f.id + ' 缺少名称' });
      if (!isInt(f.amountCents))
        errors.push({ code: 'INVALID_AMOUNT', field: where + '.amountCents', message: '费用 ' + f.id + ' 金额必须为整数（最小货币单位）' });
      var basis = f.basis || input.defaultBasis || BASIS.AMOUNT;
      if (!BASIS_LABEL[basis])
        errors.push({ code: 'INVALID_BASIS', field: where + '.basis', message: '费用 ' + f.id + ' 分摊规则非法: ' + basis });
    });

    (products || []).forEach(function (p) { if (p && p.id) productIds[p.id] = true; });

    (lines || []).forEach(function (ln, idx) {
      var where = 'lines[' + idx + ']';
      if (!ln || typeof ln !== 'object') { errors.push({ code: 'BAD_RECORD', field: where, message: '商品行记录格式错误' }); return; }
      if (!ln.lineId) errors.push({ code: 'MISSING_ID', field: where + '.lineId', message: '商品行缺少 lineId' });
      else if (lineIds[ln.lineId]) errors.push({ code: 'DUP_ID', field: where + '.lineId', message: '商品行 lineId 重复: ' + ln.lineId });
      else lineIds[ln.lineId] = true;
      if (!ln.productId) errors.push({ code: 'MISSING_FIELD', field: where + '.productId', message: '行 ' + ln.lineId + ' 缺少 productId' });
      else if (products.length && !productIds[ln.productId] && missPolicy === 'error')
        errors.push({ code: 'MISSING_PRODUCT', field: where + '.productId',
          message: '行 ' + ln.lineId + ' 引用的商品 ' + ln.productId + ' 在商品版本中不存在（缺失商品）' });
      if (!isInt(ln.amountCents))
        errors.push({ code: 'INVALID_AMOUNT', field: where + '.amountCents', message: '行 ' + ln.lineId + ' 商品金额必须为整数（最小货币单位）' });
      else if (ln.amountCents < 0)
        errors.push({ code: 'NEGATIVE_LINE_AMOUNT', field: where + '.amountCents', message: '行 ' + ln.lineId + ' 商品金额为负，不允许' });
      if (ln.weightGrams !== undefined && ln.weightGrams !== null && ln.weightGrams !== '') {
        var w = decimalToScaled(ln.weightGrams, SCALE, where + '.weightGrams', errors);
        if (w < 0) errors.push({ code: 'NEGATIVE_WEIGHT', field: where + '.weightGrams', message: '行 ' + ln.lineId + ' 重量为负，不允许' });
      }
      if (ln.customWeight !== undefined && ln.customWeight !== null && ln.customWeight !== '') {
        var cw = decimalToScaled(ln.customWeight, SCALE, where + '.customWeight', errors);
        if (cw < 0) errors.push({ code: 'NEGATIVE_CUSTOM_WEIGHT', field: where + '.customWeight', message: '行 ' + ln.lineId + ' 自定义权重为负，不允许' });
      }
    });

    // 策略开关校验
    var allowedZero = policy.zeroWeight !== undefined ? policy.zeroWeight : 'exclude';
    if (['exclude', 'error', 'equalShare'].indexOf(allowedZero) < 0)
      errors.push({ code: 'INVALID_POLICY', field: 'policy.zeroWeight', message: '零权重策略非法: ' + allowedZero });
    var negPolicy = policy.negativeFee !== undefined ? policy.negativeFee : 'allow';
    if (['allow', 'error'].indexOf(negPolicy) < 0)
      errors.push({ code: 'INVALID_POLICY', field: 'policy.negativeFee', message: '负费用策略非法: ' + negPolicy });
    if (['error', 'unallocated'].indexOf(missPolicy) < 0)
      errors.push({ code: 'INVALID_POLICY', field: 'policy.missingProduct', message: '缺失商品策略非法: ' + missPolicy });

    if (errors.length) throw new AllocationError(errors);
  }

  /* ---------- 单行权重解析 ---------- */

  function resolveBasisValue(line, basis, errors) {
    if (basis === BASIS.AMOUNT) {
      return { value: line.amountCents, rawDisplay: centsToDisplay(line.amountCents), unit: '分' };
    }
    if (basis === BASIS.WEIGHT) {
      if (line.weightGrams === undefined || line.weightGrams === null || line.weightGrams === '') {
        return { value: 0, rawDisplay: '（未填写）', unit: 'g', missing: true };
      }
      return { value: decimalToScaled(line.weightGrams, SCALE, 'weight', errors), rawDisplay: line.weightGrams + 'g', unit: 'g' };
    }
    // custom
    if (line.customWeight === undefined || line.customWeight === null || line.customWeight === '') {
      return { value: 0, rawDisplay: '（未填写）', unit: '权重', missing: true };
    }
    return { value: decimalToScaled(line.customWeight, SCALE, 'customWeight', errors), rawDisplay: String(line.customWeight), unit: '权重' };
  }

  /* ---------- 单条费用的最大余数法分摊 ---------- */

  function allocateOneFee(fee, basis, lines, policy, errors) {
    var feeId = fee.id, amount = fee.amountCents;
    var resolved = lines.map(function (ln) {
      var r = resolveBasisValue(ln, basis, errors);
      return { line: ln, basisValue: r.value, rawDisplay: r.rawDisplay, unit: r.unit, missing: !!r.missing };
    });

    // 参与分摊资格判定
    resolved.forEach(function (r) {
      r.qualified = true;
      r.excludeReason = null;
      if (r.basisValue === 0) {
        if (policy.zeroWeight === 'error') {
          errors.push({ code: 'ZERO_WEIGHT', field: 'lines.' + r.line.lineId,
            message: '行 ' + r.line.lineId + ' 在「' + BASIS_LABEL[basis] + '」规则下权重为 0，策略要求中止' });
          r.qualified = false;
          r.excludeReason = r.missing ? '未填写分摊依据（按零权重处理），策略禁止' : '零权重，策略禁止';
        } else if (policy.zeroWeight === 'exclude') {
          r.qualified = false;
          r.excludeReason = r.missing ? '未填写分摊依据，按零权重排除' : '零权重，不参与分摊';
        }
        // equalShare: 保留资格，后续按等权处理
      }
    });
    if (errors.length) return null;

    var candidates = resolved.filter(function (r) { return r.qualified; });
    var unallocatedCents = 0;
    var unallocatedReasons = [];

    if (candidates.length === 0) {
      // 没有任何可分摊对象：金额不得凭空丢弃，全额挂未分配
      unallocatedCents = amount;
      unallocatedReasons.push('全部商品行在该规则下权重为 0 或被排除，费用保留为未分配');
    }

    var absAmount = Math.abs(amount);
    var sign = amount < 0 ? -1 : 1;
    var allocMap = {}; // lineId -> 有符号整数分

    if (candidates.length) {
      var equalMode = candidates.every(function (r) { return r.basisValue === 0; }); // equalShare 或全零
      var totalWeight = candidates.reduce(function (s, r) { return s + (equalMode ? 1 : r.basisValue); }, 0);

      var quotas = candidates.map(function (r) {
        var w = equalMode ? 1 : r.basisValue;
        // 精确份额 = absAmount * w / totalWeight（整数乘除，不丢精度）
        var exactNum = absAmount * w;
        var floorBase = Math.floor(exactNum / totalWeight);
        var remainder = exactNum - floorBase * totalWeight; // 余数：0..totalWeight-1
        return { r: r, base: floorBase, floorBase: floorBase, remainder: remainder, exactNum: exactNum, w: w };
      });

      var distributed = quotas.reduce(function (s, q) { return s + q.base; }, 0);
      var left = absAmount - distributed; // 尾差数量（最小货币单位个数）

      // 稳定排序裁决尾差：余数大者优先；余数相同按输入行序（stableSort 保证确定性）
      var byRemainder = stableSort(quotas, function (q) { return -q.remainder; });
      for (var i = 0; i < left; i++) byRemainder[i % byRemainder.length].base++;

      quotas.forEach(function (q) {
        allocMap[q.r.line.lineId] = sign * q.base;
      });
      // 回写明细用
      candidates._quotas = quotas;
    }

    // 组装每条商品行的明细
    var totalW = candidates._quotas
      ? candidates._quotas.reduce(function (s, x) { return s + x.w; }, 0) : 0;
    var details = resolved.map(function (r) {
      var allocated = r.qualified ? (allocMap[r.line.lineId] || 0) : 0;
      var q = null;
      if (candidates._quotas) {
        for (var i = 0; i < candidates._quotas.length; i++) {
          if (candidates._quotas[i].r.line.lineId === r.line.lineId) { q = candidates._quotas[i]; break; }
        }
      }
      return {
        feeId: feeId,
        lineId: r.line.lineId,
        productId: r.line.productId,
        productName: r.line.productName || '',
        basis: basis,
        basisLabel: BASIS_LABEL[basis],
        basisValue: r.basisValue,
        basisRaw: r.rawDisplay,
        basisUnit: r.unit,
        qualified: r.qualified,
        excludeReason: r.excludeReason,
        allocatedCents: allocated,
        unallocatedCents: 0,
        unallocatedReason: r.qualified ? null : (r.excludeReason + '；该费用不向此行分配'),
        exactShareText: q
          ? centsToDisplay(Math.abs(fee.amountCents)) + ' × ' + q.w + '/' + totalW +
            ' → 精确值 ' + q.exactNum + '/' + totalW + '（' + rationalText(q.exactNum, totalW) +
            '），保底 ' + centsToDisplay(q.floorBase) +
            '，尾差调整 ' + (q.base - q.floorBase === 0 ? '无' : (fee.amountCents < 0 ? '-1 分' : '+1 分'))
          : null,
        remainderCents: q ? q.remainder : null,
        tieBreakOrder: q ? byRemainderIndex(candidates._quotas || [], q) : null
      };
    });

    // 守恒核对（单条费用）
    var sumAllocated = details.reduce(function (s, d) { return s + d.allocatedCents; }, 0);
    var feeCheck = {
      feeId: feeId,
      feeAmountCents: amount,
      allocatedCents: sumAllocated,
      unallocatedCents: unallocatedCents,
      balanced: sumAllocated + unallocatedCents === amount
    };

    return {
      feeId: feeId,
      feeName: fee.name,
      basis: basis,
      basisLabel: BASIS_LABEL[basis],
      feeAmountCents: amount,
      details: details,
      unallocatedCents: unallocatedCents,
      unallocatedReasons: unallocatedReasons,
      check: feeCheck
    };
  }

  function byRemainderIndex(quotas, target) {
    var sorted = stableSort(quotas, function (q) { return -q.remainder; });
    for (var i = 0; i < sorted.length; i++) if (sorted[i] === target) return i + 1;
    return null;
  }

  // 精确理论份额的有理展示，保留 6 位小数并标注
  function rationalText(num, den) {
    if (!den) return '0';
    var sign = num < 0 ? '-' : '';
    var abs = Math.abs(num);
    var whole = Math.floor(abs / den);
    var rem = abs - whole * den;
    var scaled = Math.floor(rem * 1000000 / den);
    return sign + whole + '.' + String(scaled).padStart(6, '0') + '…';
  }

  /* ---------- 主入口 ---------- */

  /**
   * allocate(input)
   * input: {
   *   orderId, fees:[{id,name,amountCents,basis?}], lines:[{lineId,productId,productName,
   *       amountCents,weightGrams,customWeight,status}], products:[{id,name,version}],
   *   defaultBasis, policy:{zeroWeight,negativeFee,missingProduct}
   * }
   * 返回不可变（调用方冻结）的完整结果；校验失败抛 AllocationError。
   */
  function allocate(input) {
    validateInput(input);
    var errors = [];
    var policy = Object.assign({ zeroWeight: 'exclude', negativeFee: 'allow', missingProduct: 'error' }, input.policy || {});
    var defaultBasis = input.defaultBasis || BASIS.AMOUNT;

    // 负费用策略
    if (policy.negativeFee === 'error') {
      input.fees.forEach(function (f) {
        if (f.amountCents < 0) errors.push({ code: 'NEGATIVE_FEE', field: 'fees.' + f.id,
          message: '费用 ' + f.id + ' 金额为负（' + f.amountCents + ' 分），策略禁止负费用' });
      });
      if (errors.length) throw new AllocationError(errors);
    }
    // 缺失商品策略：error 已在 validateInput 拦截；unallocated 时本地记录缺失行（不修改入参）
    var missingLineIds = {};
    if (policy.missingProduct === 'unallocated') {
      var productIds = {};
      (input.products || []).forEach(function (p) { productIds[p.id] = true; });
      input.lines.forEach(function (ln) {
        if (input.products && input.products.length && !productIds[ln.productId]) {
          missingLineIds[ln.lineId] = true;
        }
      });
    }

    var feeResults = input.fees.map(function (f) {
      var basis = f.basis || defaultBasis;
      var effectiveLines = input.lines.filter(function (ln) { return !missingLineIds[ln.lineId]; });
      var missingLines = input.lines.filter(function (ln) { return missingLineIds[ln.lineId]; });
      var result = allocateOneFee(f, basis, effectiveLines, policy, errors);
      if (errors.length) return null;
      // 缺失商品行：补齐明细（不参与分摊），再据实结算未分配额
      missingLines.forEach(function (ln) {
        result.details.push({
          feeId: f.id, lineId: ln.lineId, productId: ln.productId, productName: ln.productName || '',
          basis: basis, basisLabel: BASIS_LABEL[basis], basisValue: 0, basisRaw: '-', basisUnit: '',
          qualified: false, excludeReason: '商品 ' + ln.productId + ' 在当前商品版本中缺失',
          allocatedCents: 0, unallocatedCents: 0,
          unallocatedReason: '缺失商品：费用不能向不存在的商品行分配',
          exactShareText: null, remainderCents: null, tieBreakOrder: null
        });
      });
      if (missingLines.length) {
        // 有效行按自身权重分掉其应得部分；未分配额 = 费用总额 - 已分配，差额随缺失行保留，绝不凭空丢弃
        var sumAl = result.details.reduce(function (s, d) { return s + d.allocatedCents; }, 0);
        result.unallocatedCents = f.amountCents - sumAl;
        if (result.unallocatedCents !== 0 &&
            result.unallocatedReasons.indexOf('存在缺失商品行，对应金额保留为未分配') < 0) {
          result.unallocatedReasons.push('存在缺失商品行，对应金额保留为未分配');
        }
        result.check.allocatedCents = sumAl;
        result.check.unallocatedCents = result.unallocatedCents;
        result.check.balanced = sumAl + result.unallocatedCents === f.amountCents;
      }
      return result;
    });

    if (errors.length) throw new AllocationError(errors);

    // 行级汇总
    var lineAgg = {};
    input.lines.forEach(function (ln) {
      lineAgg[ln.lineId] = {
        lineId: ln.lineId, productId: ln.productId, productName: ln.productName || '',
        status: ln.status || 'active',
        lineAmountCents: ln.amountCents,
        totalAllocatedCents: 0, feeCount: 0, bases: [], perFee: []
      };
    });
    feeResults.forEach(function (fr) {
      fr.details.forEach(function (d) {
        var agg = lineAgg[d.lineId];
        if (!agg) return;
        agg.totalAllocatedCents += d.allocatedCents;
        if (d.qualified) agg.feeCount++;
        if (agg.bases.indexOf(fr.basisLabel) < 0) agg.bases.push(fr.basisLabel);
        agg.perFee.push({ feeId: fr.feeId, feeName: fr.feeName, basis: fr.basisLabel, allocatedCents: d.allocatedCents });
      });
    });

    // 订单级守恒
    var totalFee = input.fees.reduce(function (s, f) { return s + f.amountCents; }, 0);
    var totalAllocated = feeResults.reduce(function (s, fr) {
      return s + fr.details.reduce(function (x, d) { return x + d.allocatedCents; }, 0);
    }, 0);
    var totalUnallocated = feeResults.reduce(function (s, fr) { return s + fr.unallocatedCents; }, 0);

    var signatureInput = {
      orderId: input.orderId,
      fees: input.fees.map(function (f) { return { id: f.id, amountCents: f.amountCents, basis: f.basis || defaultBasis }; }),
      lines: input.lines.map(function (ln) {
        return {
          lineId: ln.lineId, productId: ln.productId, amountCents: ln.amountCents,
          weightGrams: ln.weightGrams === undefined ? null : String(ln.weightGrams),
          customWeight: ln.customWeight === undefined ? null : String(ln.customWeight),
          status: ln.status || 'active'
        };
      }),
      products: (input.products || []).map(function (p) { return { id: p.id, version: p.version || null }; }),
      defaultBasis: defaultBasis,
      policy: policy
    };
    var inputHash = fnv1a(canonicalJSON(signatureInput));

    function deepFreeze(o) {
      if (o === null || typeof o !== 'object') return o;
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
      return Object.freeze(o);
    }

    var result = {
      schemaVersion: 1,
      orderId: input.orderId || null,
      basis: defaultBasis,
      policy: policy,
      basisLabels: BASIS_LABEL,
      feeResults: feeResults,
      lineResults: Object.keys(lineAgg).map(function (k) { return lineAgg[k]; }),
      unallocatedSummary: feeResults.map(function (fr) {
        return { feeId: fr.feeId, feeName: fr.feeName, unallocatedCents: fr.unallocatedCents, reasons: fr.unallocatedReasons };
      }).filter(function (u) { return u.unallocatedCents !== 0 || u.reasons.length; }),
      conservation: {
        totalFeeCents: totalFee,
        totalAllocatedCents: totalAllocated,
        totalUnallocatedCents: totalUnallocated,
        diffCents: totalFee - totalAllocated - totalUnallocated,
        balanced: totalFee === totalAllocated + totalUnallocated,
        perFee: feeResults.map(function (fr) { return fr.check; })
      },
      inputHash: inputHash,
      signatureCanonical: canonicalJSON(signatureInput)
    };
    return deepFreeze(result);
  }

  return {
    SCALE: SCALE,
    BASIS: BASIS,
    BASIS_LABEL: BASIS_LABEL,
    AllocationError: AllocationError,
    allocate: allocate,
    centsToDisplay: centsToDisplay,
    weightToDisplay: weightToDisplay,
    decimalToScaled: decimalToScaled,
    canonicalJSON: canonicalJSON,
    fnv1a: fnv1a,
    stableSort: stableSort
  };
});
