/*
 * store.js — 版本化存储与计算编排（零依赖，localStorage 持久化）
 *
 * 不变量：
 *  - 源版本（SourceVersion）一旦存在即冻结；修订 = 派生新版本，旧版本与旧运行永久保留。
 *  - 每次运行（Run）绑定 源版本 + 规则覆盖 + 策略 的快照；运行记录不可变。
 *  - 同一输入签名（engine.inputHash）重复提交返回既有运行，不产生重复结果（幂等）。
 *  - 引擎抛 AllocationError 时只记录一条 failed 运行，绝不发布部分分摊结果。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.AllocStore = factory(root.AllocEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var STORAGE_KEY = 'fee-alloc-app-v1';

  function uid(prefix) {
    // 不带随机数的可读序号；真实唯一性由调用方结合计数保证（确定性演示友好）
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- 运行构造 ---------- */

  function buildEngineInput(version, basisOverrides) {
    var fees = version.fees.map(function (f) {
      return Object.assign({}, f, { basis: basisOverrides[f.id] || f.basis || version.defaultBasis });
    });
    return {
      orderId: version.orderId || null,
      fees: fees,
      lines: clone(version.lines),
      products: clone(version.products),
      defaultBasis: version.defaultBasis,
      policy: clone(version.policy)
    };
  }

  /**
   * 执行一次计算。成功返回 {ok:true, run, duplicated:bool}；
   * 失败返回 {ok:false, run}（run.status='failed'，不含分摊结果）。
   */
  function executeRun(state, versionId, basisOverrides, note) {
    var version = state.versions.find(function (v) { return v.versionId === versionId; });
    if (!version) throw new Error('源版本不存在: ' + versionId);
    basisOverrides = basisOverrides || {};
    var input = buildEngineInput(version, basisOverrides);

    var runBase = {
      runId: null,
      versionId: versionId,
      orderId: state.orderId,
      note: note || '',
      basisOverrides: clone(basisOverrides),
      effectivePolicy: clone(version.policy),
      productVersion: (version.products[0] && version.products[0].version) || null,
      createdAt: new Date().toISOString(),
      sourceSnapshot: {
        fees: clone(input.fees),
        lines: clone(input.lines),
        products: clone(input.products),
        defaultBasis: input.defaultBasis,
        policy: clone(input.policy)
      }
    };

    var result, failure = null;
    try {
      result = E.allocate(input);
    } catch (err) {
      if (err.name === 'AllocationError') failure = err.errors;
      else failure = [{ code: 'UNEXPECTED', field: '-', message: err.message }];
    }

    if (failure) {
      // 失败：仅登记失败记录，不发布任何部分结果
      var failedRun = Object.assign({}, runBase, {
        runId: 'RUN-F-' + (state.failureSeq++),
        status: 'failed',
        errors: failure,
        inputHash: null,
        result: null
      });
      state.runs.push(failedRun);
      persist(state);
      return { ok: false, run: failedRun, duplicated: false };
    }

    // 成功：幂等检查（同版本 + 同输入签名 → 复用既有运行）
    var existing = state.runs.find(function (r) {
      return r.status === 'success' && r.versionId === versionId && r.inputHash === result.inputHash;
    });
    if (existing) return { ok: true, run: existing, duplicated: true };

    var run = Object.assign({}, runBase, {
      runId: 'RUN-' + (state.runSeq++),
      status: 'success',
      errors: [],
      inputHash: result.inputHash,
      result: clone(result)
    });
    state.runs.push(run);
    persist(state);
    return { ok: true, run: run, duplicated: false };
  }

  /* ---------- 版本管理 ---------- */

  function addVersion(state, draft) {
    if (state.versions.some(function (v) { return v.versionId === draft.versionId; }))
      throw new Error('版本 id 已存在: ' + draft.versionId);
    var version = Object.assign({ frozen: true, createdAt: new Date().toISOString() }, clone(draft));
    version.frozen = true; // 落库即冻结
    state.versions.push(version);
    persist(state);
    return version;
  }

  /**
   * 修订源数据：基于父版本复制为新版本（深拷贝），应用 mutator 后冻结。
   * mutator(draft) 可改 fees/lines/products/policy/defaultBasis。
   */
  function reviseVersion(state, parentVersionId, reason, mutator) {
    var parent = state.versions.find(function (v) { return v.versionId === parentVersionId; });
    if (!parent) throw new Error('父版本不存在: ' + parentVersionId);
    var draft = clone(parent);
    draft.versionId = 'SV' + (state.versionSeq++);
    draft.parentVersionId = parent.versionId;
    draft.reason = reason;
    draft.createdAt = new Date().toISOString();
    draft.frozen = false;
    mutator(draft);
    draft.frozen = true;
    state.versions.push(draft);
    persist(state);
    return draft;
  }

  /* ---------- 版本比较 ---------- */

  function diffVersions(state, idA, idB) {
    var a = state.versions.find(function (v) { return v.versionId === idA; });
    var b = state.versions.find(function (v) { return v.versionId === idB; });
    if (!a || !b) throw new Error('版本不存在');
    var index = function (arr, key) {
      var m = {}; arr.forEach(function (x) { m[x[key]] = x; }); return m;
    };
    var diff = { a: a.versionId, b: b.versionId, fees: [], lines: [], products: [] };

    var fa = index(a.fees, 'id'), fb = index(b.fees, 'id');
    Object.keys(Object.assign({}, fa, fb)).forEach(function (id) {
      if (!fa[id]) diff.fees.push({ kind: 'added', id: id, after: fb[id] });
      else if (!fb[id]) diff.fees.push({ kind: 'removed', id: id, before: fa[id] });
      else if (E.canonicalJSON(fa[id]) !== E.canonicalJSON(fb[id]))
        diff.fees.push({ kind: 'changed', id: id, before: fa[id], after: fb[id] });
    });

    var la = index(a.lines, 'lineId'), lb = index(b.lines, 'lineId');
    Object.keys(Object.assign({}, la, lb)).forEach(function (id) {
      if (!la[id]) diff.lines.push({ kind: 'added', id: id, after: lb[id] });
      else if (!lb[id]) diff.lines.push({ kind: 'removed', id: id, before: la[id] });
      else if (E.canonicalJSON(la[id]) !== E.canonicalJSON(lb[id]))
        diff.lines.push({ kind: 'changed', id: id, before: la[id], after: lb[id] });
    });

    var pa = index(a.products, 'id'), pb = index(b.products, 'id');
    Object.keys(Object.assign({}, pa, pb)).forEach(function (id) {
      if (!pa[id]) diff.products.push({ kind: 'added', id: id, after: pb[id] });
      else if (!pb[id]) diff.products.push({ kind: 'removed', id: id, before: pa[id] });
      else if (E.canonicalJSON(pa[id]) !== E.canonicalJSON(pb[id]))
        diff.products.push({ kind: 'changed', id: id, before: pa[id], after: pb[id] });
    });
    return diff;
  }

  function compareRuns(runA, runB) {
    if (runA.status !== 'success' || runB.status !== 'success') return null;
    var map = function (run) {
      var m = {};
      run.result.feeResults.forEach(function (fr) {
        fr.details.forEach(function (d) { m[fr.feeId + '|' + d.lineId] = d.allocatedCents; });
      });
      return m;
    };
    var ma = map(runA), mb = map(runB);
    var rows = [];
    Object.keys(Object.assign({}, ma, mb)).sort().forEach(function (k) {
      var parts = k.split('|');
      var va = ma[k] === undefined ? null : ma[k];
      var vb = mb[k] === undefined ? null : mb[k];
      if (va !== vb) rows.push({ feeId: parts[0], lineId: parts[1], beforeCents: va, afterCents: vb,
        deltaCents: (va === null || vb === null) ? null : vb - va });
    });
    return {
      runA: runA.runId, runB: runB.runId,
      conservationA: runA.result.conservation,
      conservationB: runB.result.conservation,
      changedRows: rows
    };
  }

  /* ---------- 导出 ---------- */

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function runToCSV(run) {
    if (run.status !== 'success') throw new Error('失败运行无明细可导出');
    var rows = [['运行ID', '源版本', '费用ID', '费用名称', '分摊规则', '商品行', '商品ID', '商品名称',
      '分摊依据', '是否参与', '排除/未分配原因', '分摊金额(分)', '分摊金额(元)', '理论份额与尾差依据', '尾差裁决序']];
    run.result.feeResults.forEach(function (fr) {
      fr.details.forEach(function (d) {
        rows.push([run.runId, run.versionId, fr.feeId, fr.feeName, fr.basisLabel,
          d.lineId, d.productId, d.productName,
          d.basisLabel + '=' + d.basisRaw + (d.basisUnit ? '(' + d.basisUnit + ')' : ''),
          d.qualified ? '是' : '否',
          d.unallocatedReason || '',
          d.allocatedCents, E.centsToDisplay(d.allocatedCents),
          d.exactShareText || '', d.tieBreakOrder === null ? '' : d.tieBreakOrder]);
      });
      if (fr.unallocatedCents !== 0 || fr.unallocatedReasons.length) {
        rows.push([run.runId, run.versionId, fr.feeId, fr.feeName, fr.basisLabel, '-', '-', '【未分配】',
          '-', '否', fr.unallocatedReasons.join('；'),
          fr.unallocatedCents, E.centsToDisplay(fr.unallocatedCents), '订单级守恒保留项', '']);
      }
    });
    var c = run.result.conservation;
    rows.push([]);
    rows.push(['【订单级守恒核对】']);
    rows.push(['费用总额(分)', c.totalFeeCents, '已分配(分)', c.totalAllocatedCents,
      '未分配(分)', c.totalUnallocatedCents, '差额(分)', c.diffCents, '是否守恒', c.balanced ? '是' : '否']);
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n');
  }

  /* ---------- 持久化 ---------- */
  /* 浏览器用 localStorage；Node/无 localStorage 时降级为内存态。 */

  var mem = null;
  function persist(state) {
    mem = state;
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch (e) { /* 配额或隐私模式：保留内存态 */ }
    }
  }

  function load() {
    if (typeof localStorage !== 'undefined') {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* 损坏则重建 */ }
    }
    return mem;
  }

  function reset() {
    mem = null;
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  }

  /* ---------- 状态装配（含合成演示数据的预置运行） ---------- */

  function createInitialState(seed) {
    var state = {
      orderId: seed.ORDER_ID,
      currency: seed.CURRENCY,
      versions: clone(seed.SOURCE_VERSIONS),
      runs: [],
      runSeq: 1,
      failureSeq: 1,
      versionSeq: 4
    };

    // 预置运行 1：SV1 按各费用默认规则（金额/重量/自定义混合）
    var r1 = executeRun(state, 'SV1', {}, '首次分摊：混合规则（运费按金额、重货费按重量、保价按自定义权重）');
    // 预置运行 2：SV1 全部切到按重量 —— 规则可切换
    var r2 = executeRun(state, 'SV1',
      { F1: 'weight', F2: 'weight', F3: 'weight', F4: 'weight' },
      '规则切换：全部改为按重量分摊');
    // 预置运行 3：SV1 重复运行（与 r1 同签名，应幂等复用）
    var r3 = executeRun(state, 'SV1', {}, '重复运行：与首次分摊同输入（验证幂等，不产生新记录）');
    // 预置运行 4：SV2 退款后重新分摊
    var r4 = executeRun(state, 'SV2', {}, '部分退款后重新分摊：鼠标行金额/权重清零，旧版本 SV1 结果保留');
    // 预置运行 5：SV3 补录商品后重新分摊
    var r5 = executeRun(state, 'SV3', {}, '补录扩展坞后重新分摊：新增 L5 参与全部分摊');

    // 预置失败运行：缺失商品硬失败（草稿版本不进入 versions，仅作为失败快照）
    var broken = seed.buildBrokenDraft();
    var brokenInput = buildEngineInput(broken, {});
    var brokenErrors = null;
    try { E.allocate(brokenInput); }
    catch (err) { brokenErrors = err.name === 'AllocationError' ? err.errors :
      [{ code: 'UNEXPECTED', field: '-', message: err.message }]; }
    state.runs.push({
      runId: 'RUN-F-' + (state.failureSeq++),
      versionId: broken.versionId,
      orderId: state.orderId,
      note: '失败演示：商品主数据缺失 P4，硬失败且不发布部分结果',
      basisOverrides: {},
      effectivePolicy: clone(broken.policy),
      productVersion: 'v1(缺P4)',
      createdAt: broken.createdAt,
      sourceSnapshot: {
        fees: clone(brokenInput.fees), lines: clone(brokenInput.lines),
        products: clone(brokenInput.products),
        defaultBasis: brokenInput.defaultBasis, policy: clone(brokenInput.policy)
      },
      status: 'failed',
      errors: brokenErrors,
      inputHash: null,
      result: null
    });

    // 固定运行时间戳，保证演示环境一致
    var stamps = [seed.TIMESTAMPS.T0, seed.TIMESTAMPS.T0, seed.TIMESTAMPS.T0,
      seed.TIMESTAMPS.T1, seed.TIMESTAMPS.T2, seed.TIMESTAMPS.T2];
    state.runs.forEach(function (r, i) { if (stamps[i]) r.createdAt = stamps[i]; });
    persist(state);
    state._idempotencyCheck = { firstRunId: r1.run.runId, repeatRunId: r3.run.runId, duplicated: r3.duplicated };
    return state;
  }

  function Store(seed) {
    var loaded = load();
    this.state = loaded || createInitialState(seed);
  }
  Store.prototype.executeRun = function (versionId, basisOverrides, note) {
    var out = executeRun(this.state, versionId, basisOverrides, note);
    return out;
  };
  Store.prototype.reviseVersion = function (parentId, reason, mutator) {
    return reviseVersion(this.state, parentId, reason, mutator);
  };
  Store.prototype.addVersion = function (draft) { return addVersion(this.state, draft); };
  Store.prototype.diffVersions = function (a, b) { return diffVersions(this.state, a, b); };
  Store.prototype.compareRuns = compareRuns;
  Store.prototype.runToCSV = runToCSV;
  Store.prototype.reset = function (seed) { reset(); this.state = createInitialState(seed); };
  Store.prototype.persist = function () { persist(this.state); };

  return {
    Store: Store,
    buildEngineInput: buildEngineInput,
    executeRun: executeRun,
    runToCSV: runToCSV,
    compareRuns: compareRuns,
    STORAGE_KEY: STORAGE_KEY,
    uid: uid
  };
});
