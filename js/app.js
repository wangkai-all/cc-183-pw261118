/*
 * app.js — 界面主控（零依赖原生 JS）
 * 标签页：① 源数据与版本 ② 计算工作台 ③ 版本/运行比较 ④ 运行记录
 */
(function () {
  'use strict';
  var E = window.AllocEngine, S = window.AllocStore, Seed = window.AllocSeed;
  var store = new S.Store(Seed);
  var ui = {
    selectedVersion: store.state.versions[store.state.versions.length - 1].versionId,
    selectedRun: null,
    compareA: null,
    compareB: null,
    basisOverrides: {},
    policyDraft: null
  };

  /* ---------- 小工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 5) === 'data-') node.setAttribute(k, attrs[k]);
      else if (k === 'disabled' && !attrs[k]) { /* skip */ }
      else node[k] = attrs[k];
    });
    (Array.isArray(children) ? children : (children ? [children] : [])).forEach(function (c) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function money(cents) {
    if (cents === null || cents === undefined) return '—';
    var cls = cents < 0 ? 'num tag-neg' : 'num';
    return '<span class="' + cls + '">¥' + E.centsToDisplay(cents) + '</span>';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function toast(msg, kind) {
    var t = $('#toast');
    t.className = 'toast show ' + (kind || '');
    t.textContent = msg;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 3200);
  }
  function download(filename, content, mime) {
    var blob = new Blob(['﻿' + content], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }
  function getVersion(id) {
    return store.state.versions.find(function (v) { return v.versionId === id; });
  }

  /* ---------- Tab 切换 ---------- */
  function switchTab(name) {
    $all('.tabpane').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
    $all('nav.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    if (name === 'runs') renderRunsTab();
    if (name === 'compare') renderCompareTab();
    if (name === 'source') renderSourceTab();
    if (name === 'calc') renderCalcTab();
  }

  /* ========== ① 源数据与版本 ========== */
  function renderSourceTab() {
    var pane = $('#tab-source');
    pane.innerHTML = '';
    var v = getVersion(ui.selectedVersion);
    ui.policyDraft = JSON.parse(JSON.stringify(v.policy));

    var head = el('div', { class: 'panel' }, [
      el('h2', {}, ['源数据版本（费用、规则、商品版本固定在同一次计算里）']),
      el('div', { class: 'row' }, [
        label('选择版本', selectVersions('src-version-select', ui.selectedVersion)),
        el('button', { class: 'btn primary', text: '基于此版本修订（派生新版本）', onclick: openRevise }),
        el('button', { class: 'btn danger', text: '重置全部演示数据', onclick: function () {
          if (confirm('确定清空 localStorage 并重建合成演示数据？')) {
            store.reset(Seed);
            ui.selectedVersion = store.state.versions[store.state.versions.length - 1].versionId;
            toast('已重置为初始合成数据', 'success');
            switchTab('source');
          }
        } })
      ]),
      el('p', { class: 'muted', text: '版本一经生成即冻结；退款、补录等任何修订都会派生新版本，旧版本与其运行结果永久保留。' })
    ]);
    pane.appendChild(head);

    // 版本链时间线
    var chain = el('div', { class: 'panel' }, [el('h2', {}, ['版本链']), el('ul', { class: 'timeline' })]);
    store.state.versions.forEach(function (vv) {
      var li = el('li', {}, [
        el('div', { class: 'row' }, [
          el('strong', { text: vv.versionId }),
          el('span', { class: 'badge ' + (vv.frozen ? 'green' : 'amber'), text: vv.frozen ? '已冻结' : '草稿' }),
          el('span', { class: 'badge blue', text: '商品版本 ' + (vv.products[0] ? vv.products[0].version : '?') })
        ]),
        el('div', { class: 'meta', text: (vv.parentVersionId ? '父版本 ' + vv.parentVersionId + ' · ' : '根版本 · ') + vv.createdAt }),
        el('div', { text: vv.reason })
      ]);
      chain.querySelector('ul').appendChild(li);
    });
    pane.appendChild(chain);

    // 费用表
    var feePanel = el('div', { class: 'panel' }, [
      el('h2', {}, ['订单级费用（金额单位：分，最小货币单位）']),
      tableOf([
        ['费用ID', 'id'], ['名称', 'name'], ['金额(分)', 'amountCents', 'num'],
        ['金额(元)', null, 'num'], ['默认分摊规则', 'basis']
      ], v.fees, function (f) {
        return '<tr><td class="mono">' + esc(f.id) + '</td><td>' + esc(f.name) + '</td>' +
          '<td class="num ' + (f.amountCents < 0 ? 'tag-neg' : '') + '">' + f.amountCents + '</td>' +
          '<td>' + money(f.amountCents) + '</td><td><span class="badge blue">' + esc(E.BASIS_LABEL[f.basis]) + '</span></td></tr>';
      })
    ]);
    pane.appendChild(feePanel);

    // 商品行表
    var linePanel = el('div', { class: 'panel' }, [
      el('h2', {}, ['商品行（' + v.lines.length + ' 行）']),
      tableOf(
        ['行ID', '商品ID', '商品名称', '状态', '行金额(分)', '行金额(元)', '重量(g)', '自定义权重'],
        v.lines, function (ln) {
          var st = ln.status === 'refunded'
            ? '<span class="pill refund">已退款</span>'
            : '<span class="pill in">有效</span>';
          return '<tr><td class="mono">' + esc(ln.lineId) + '</td><td class="mono">' + esc(ln.productId) + '</td>' +
            '<td>' + esc(ln.productName) + '</td><td>' + st + '</td>' +
            '<td class="num">' + ln.amountCents + '</td><td>' + money(ln.amountCents) + '</td>' +
            '<td class="num">' + esc(ln.weightGrams) + '</td><td class="num">' + esc(ln.customWeight) + '</td></tr>';
        })
    ]);
    pane.appendChild(linePanel);

    // 商品主数据
    var prodPanel = el('div', { class: 'panel' }, [
      el('h2', {}, ['商品版本主数据（' + (v.products[0] ? v.products[0].version : '') + '）']),
      tableOf(['商品ID', '名称', '版本', '单价(分)', '单价(元)'], v.products, function (p) {
        return '<tr><td class="mono">' + esc(p.id) + '</td><td>' + esc(p.name) + '</td><td class="mono">' +
          esc(p.version) + '</td><td class="num">' + p.unitPriceCents + '</td><td>' + money(p.unitPriceCents) + '</td></tr>';
      })
    ]);
    pane.appendChild(prodPanel);

    // 策略说明（只读展示当前版本绑定的策略）
    var pol = v.policy;
    var policyPanel = el('div', { class: 'panel' }, [
      el('h2', {}, ['边界策略（随版本快照固定）']),
      el('div', { class: 'grid cols-3' }, [
        policyCard('零权重行', 'zeroWeight', pol.zeroWeight, Seed.POLICY_LABEL.zeroWeight),
        policyCard('负费用', 'negativeFee', pol.negativeFee, Seed.POLICY_LABEL.negativeFee),
        policyCard('缺失商品', 'missingProduct', pol.missingProduct, Seed.POLICY_LABEL.missingProduct)
      ])
    ]);
    pane.appendChild(policyPanel);

    $('#src-version-select').addEventListener('change', function () {
      ui.selectedVersion = this.value; renderSourceTab();
    });
  }

  function policyCard(title, key, val, labels) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: title }),
      el('div', { class: 'v', style: 'font-size:14px', text: labels[val] || val }),
      el('div', { class: 'muted', text: 'policy.' + key + ' = "' + val + '"' })
    ]);
  }

  function selectVersions(id, selected) {
    var sel = el('select', { id: id });
    store.state.versions.forEach(function (v) {
      sel.appendChild(el('option', { value: v.versionId, text: v.versionId + '（' + v.reason.slice(0, 18) + '…）',
        selected: v.versionId === selected }));
    });
    return sel;
  }

  function tableOf(headers, rows, renderRow) {
    var wrap = el('div', { class: 'table-wrap' });
    var table = el('table');
    table.innerHTML = '<thead><tr>' + headers.map(function (h) {
      return '<th' + (typeof h === 'object' && h[2] === 'num' ? ' class="num"' : '') + '>' +
        esc(typeof h === 'object' ? h[0] : h) + '</th>';
    }).join('') + '</tr></thead>';
    var body = el('tbody');
    if (!rows.length) body.innerHTML = '<tr><td colspan="' + headers.length + '" class="muted">无数据</td></tr>';
    else rows.forEach(function (r) { body.insertAdjacentHTML('beforeend', renderRow(r)); });
    table.appendChild(body); wrap.appendChild(table);
    return wrap;
  }
  function label(text, control) {
    return el('label', { class: 'fld' }, [el('span', { text: text }), control]);
  }

  /* ---------- 修订向导 ---------- */
  function openRevise() {
    var parent = getVersion(ui.selectedVersion);
    var draft = JSON.parse(JSON.stringify(parent));
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,37,.45);z-index:40;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;';
    var dlg = el('div', { class: 'panel', style: 'width:min(1100px,96vw);margin:0;' });
    mask.appendChild(dlg);
    dlg.appendChild(el('h2', {}, ['修订源数据 → 派生新版本（父版本 ' + parent.versionId + ' 保持不变）']));

    var reasonInput = el('input', { value: '人工修订：', style: 'width:100%' });
    dlg.appendChild(label('修订原因（写入新版本 reason）', reasonInput));

    // 快捷操作
    var quick = el('div', { class: 'row', style: 'margin:12px 0' }, [
      el('button', { class: 'btn sm', text: '模拟部分退款（首个有效行置退款）', onclick: function () {
        var target = draft.lines.find(function (x) { return x.status === 'active'; });
        if (target) {
          target.status = 'refunded'; target.amountCents = 0;
          target.weightGrams = '0'; target.customWeight = '0';
          toast('已将 ' + target.lineId + ' 置为退款', 'success'); fillEditors();
        }
      } }),
      el('button', { class: 'btn sm', text: '模拟补录商品行', onclick: function () {
        var n = draft.lines.length + 1;
        var pid = 'P' + (draft.products.length + 1);
        draft.products.push({ id: pid, name: '补录商品 ' + pid, version: 'v' + (draft.products.length + 1), unitPriceCents: 12900 });
        draft.lines.push({ lineId: 'L' + n, productId: pid, productName: '补录商品 ' + pid, status: 'active',
          amountCents: 12900, weightGrams: '300', customWeight: '1' });
        toast('已补录 ' + pid, 'success'); fillEditors();
      } }),
      el('button', { class: 'btn sm danger', text: '模拟缺失商品（从主数据删除首个商品）', onclick: function () {
        var removed = draft.products.shift();
        toast('已从商品主数据删除 ' + removed.id + '（对应行将触发缺失商品策略）', 'error'); fillEditors();
      } })
    ]);
    dlg.appendChild(quick);

    var feeHost = el('div');
    var lineHost = el('div');
    var prodHost = el('div');
    dlg.appendChild(el('h3', {}, ['费用（可改金额/规则；金额必须为整数分）']));
    dlg.appendChild(feeHost);
    dlg.appendChild(el('h3', {}, ['商品行']));
    dlg.appendChild(lineHost);
    dlg.appendChild(el('h3', {}, ['商品主数据']));
    dlg.appendChild(prodHost);

    // 策略编辑
    var pol = draft.policy;
    var polRow = el('div', { class: 'grid cols-3', style: 'margin-top:12px' });
    polRow.appendChild(policySelect('零权重', 'zeroWeight', pol, Seed.POLICY_LABEL.zeroWeight));
    polRow.appendChild(policySelect('负费用', 'negativeFee', pol, Seed.POLICY_LABEL.negativeFee));
    polRow.appendChild(policySelect('缺失商品', 'missingProduct', pol, Seed.POLICY_LABEL.missingProduct));
    dlg.appendChild(el('h3', {}, ['边界策略']));
    dlg.appendChild(polRow);

    function fillEditors() {
      feeHost.innerHTML = ''; lineHost.innerHTML = ''; prodHost.innerHTML = '';
      feeHost.appendChild(editTable(['id', 'name', 'amountCents', 'basis'], draft.fees, {
        basis: { type: 'select', options: ['amount', 'weight', 'custom'], labels: E.BASIS_LABEL }
      }));
      lineHost.appendChild(editTable(['lineId', 'productId', 'productName', 'status', 'amountCents', 'weightGrams', 'customWeight'],
        draft.lines, {
          status: { type: 'select', options: ['active', 'refunded'] }
        }));
      prodHost.appendChild(editTable(['id', 'name', 'version', 'unitPriceCents'], draft.products, {}));
    }
    fillEditors();

    dlg.appendChild(el('hr', { class: 'sep' }));
    var errBox = el('div', { id: 'revise-errors' });
    dlg.appendChild(errBox);
    dlg.appendChild(el('div', { class: 'row', style: 'justify-content:flex-end' }, [
      el('button', { class: 'btn', text: '取消', onclick: function () { mask.remove(); } }),
      el('button', { class: 'btn primary', text: '生成新版本（旧版本保留）', onclick: function () {
        var errs = validateDraft(draft);
        if (errs.length) {
          errBox.innerHTML = '';
          errBox.appendChild(el('div', { class: 'alert error',
            innerHTML: '<strong>草稿存在 ' + errs.length + ' 个问题，未生成版本：</strong><br>' +
              errs.map(function (e) { return '• ' + esc(e); }).join('<br>') }));
          return;
        }
        var nv = store.reviseVersion(parent.versionId, reasonInput.value || '人工修订（未填写原因）', function (d) {
          d.fees = draft.fees; d.lines = draft.lines; d.products = draft.products; d.policy = draft.policy;
        });
        mask.remove();
        ui.selectedVersion = nv.versionId;
        toast('已生成新版本 ' + nv.versionId + '，可在计算工作台运行', 'success');
        switchTab('source');
      } })
    ]));
    document.body.appendChild(mask);
  }

  function policySelect(title, key, pol, labels) {
    var sel = el('select');
    Object.keys(labels).forEach(function (opt) {
      sel.appendChild(el('option', { value: opt, text: labels[opt], selected: pol[key] === opt }));
    });
    sel.addEventListener('change', function () { pol[key] = this.value; });
    return label(title, sel);
  }

  function editTable(cols, rows, opts) {
    opts = opts || {};
    var wrap = el('div', { class: 'table-wrap editor-grid' });
    var table = el('table');
    table.innerHTML = '<thead><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead>';
    var tb = el('tbody');
    rows.forEach(function (row) {
      var tr = el('tr');
      cols.forEach(function (c) {
        var td = el('td');
        if (opts[c] && opts[c].type === 'select') {
          var s = el('select');
          opts[c].options.forEach(function (o) {
            s.appendChild(el('option', {
              value: o, text: opts[c].labels ? opts[c].labels[o] : o, selected: row[c] === o
            }));
          });
          s.addEventListener('change', function () { row[c] = this.value; });
          td.appendChild(s);
        } else {
          var inp = el('input', { value: String(row[c] === undefined || row[c] === null ? '' : row[c]) });
          inp.addEventListener('input', function () {
            var raw = this.value;
            if (c === 'amountCents' || c === 'unitPriceCents') {
              row[c] = raw === '' ? '' : Number(raw);
            } else row[c] = raw;
          });
          td.appendChild(inp);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb); wrap.appendChild(table);
    return wrap;
  }

  function validateDraft(d) {
    var errs = [];
    var ids = {};
    d.fees.forEach(function (f, i) {
      if (!f.id || ids[f.id]) errs.push('费用 #' + i + ' id 为空或重复');
      ids[f.id] = true;
      if (!Number.isInteger(f.amountCents)) errs.push('费用 ' + f.id + ' 金额必须是整数（分），当前: ' + f.amountCents);
      if (!E.BASIS_LABEL[f.basis]) errs.push('费用 ' + f.id + ' 分摊规则非法: ' + f.basis);
    });
    var lids = {}, pids = {};
    d.products.forEach(function (p) { pids[p.id] = true; });
    d.lines.forEach(function (ln, i) {
      if (!ln.lineId || lids[ln.lineId]) errs.push('商品行 #' + i + ' lineId 为空或重复');
      lids[ln.lineId] = true;
      if (!Number.isInteger(ln.amountCents) || ln.amountCents < 0) errs.push('行 ' + ln.lineId + ' 金额须为非负整数分');
      if (d.policy.missingProduct === 'error' && !pids[ln.productId])
        errs.push('行 ' + ln.lineId + ' 引用的商品 ' + ln.productId + ' 不在主数据中（缺失商品策略=报错，将导致运行失败）');
    });
    return errs;
  }

  /* ========== ② 计算工作台 ========== */
  function renderCalcTab() {
    var pane = $('#tab-calc');
    pane.innerHTML = '';
    var v = getVersion(ui.selectedVersion);

    var ctl = el('div', { class: 'panel' }, [
      el('h2', {}, ['计算工作台']),
      el('div', { class: 'row' }, [
        label('源版本', selectVersions('calc-version-select', ui.selectedVersion)),
        label('一键规则', el('select', { id: 'global-basis' }, [
          el('option', { value: '', text: '使用各费用自带规则' }),
          el('option', { value: 'amount', text: '全部按金额' }),
          el('option', { value: 'weight', text: '全部按重量' }),
          el('option', { value: 'custom', text: '全部按自定义权重' })
        ]))
      ]),
      el('p', { class: 'muted', text: '来源费用、分摊规则与商品版本随运行快照固定；运行后再修订源数据只会产生新版本，不影响本次结果。' })
    ]);
    pane.appendChild(ctl);

    // 每条费用的规则切换
    var feeCtl = el('div', { class: 'panel' }, [el('h2', {}, ['逐费用规则切换'])]);
    var grid = el('div', { class: 'grid cols-4' });
    v.fees.forEach(function (f) {
      var sel = el('select', { id: 'basis-' + f.id });
      ['amount', 'weight', 'custom'].forEach(function (b) {
        var cur = ui.basisOverrides[f.id] || f.basis;
        sel.appendChild(el('option', { value: b, text: E.BASIS_LABEL[b], selected: cur === b }));
      });
      sel.addEventListener('change', function () { ui.basisOverrides[f.id] = this.value; });
      var card = el('div', { class: 'stat' }, [
        el('div', { class: 'k', text: f.id + ' · ' + f.name }),
        el('div', { class: 'small', innerHTML: money(f.amountCents) }),
        sel
      ]);
      grid.appendChild(card);
    });
    feeCtl.appendChild(grid);
    feeCtl.appendChild(el('div', { class: 'row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn primary', text: '执行分摊（原子提交，失败不发布部分结果）', onclick: runAllocation }),
      el('button', { class: 'btn', text: '清空规则覆盖', onclick: function () {
        ui.basisOverrides = {}; renderCalcTab(); toast('已恢复各费用自带规则');
      } })
    ]));
    pane.appendChild(feeCtl);

    // 最近一次运行结果区
    var resultHost = el('div', { id: 'calc-result-host' });
    pane.appendChild(resultHost);

    $('#calc-version-select').addEventListener('change', function () {
      ui.selectedVersion = this.value; ui.basisOverrides = {}; renderCalcTab();
    });
    $('#global-basis').addEventListener('change', function () {
      var g = this.value;
      if (g) {
        v.fees.forEach(function (f) { ui.basisOverrides[f.id] = g; });
        renderCalcTab();
        $('#global-basis').value = g;
      }
    });

    if (ui.selectedRun) renderRunResult(resultHost, ui.selectedRun);
  }

  function runAllocation() {
    var host = $('#calc-result-host');
    host.innerHTML = '';
    var out = store.executeRun(ui.selectedVersion, ui.basisOverrides,
      '界面运行：版本 ' + ui.selectedVersion);
    if (out.duplicated) toast('相同输入与规则已存在运行 ' + out.run.runId + '，幂等复用（同一输入必得相同结果）', 'success');
    else if (out.ok) toast('分摊成功：' + out.run.runId + '，结果已发布并冻结', 'success');
    else toast('计算失败，未发布任何部分结果（见失败明细）', 'error');
    ui.selectedRun = out.run;
    renderRunResult(host, out.run);
    renderHeaderStats();
  }

  function renderRunResult(host, run) {
    host.innerHTML = '';
    if (run.status === 'failed') {
      var fp = el('div', { class: 'panel' });
      fp.appendChild(el('h2', {}, [
        el('span', { text: run.runId }), ' ',
        el('span', { class: 'badge red', text: '失败 · 未发布结果' })
      ]));
      fp.appendChild(el('div', { class: 'alert error',
        innerHTML: '<strong>原子性保证：</strong>引擎校验未通过，本次计算没有任何分摊结果落库；请修订源数据生成新版本后重试。' }));
      fp.appendChild(el('div', { class: 'table-wrap' }, (function () {
        var t = el('table');
        t.innerHTML = '<thead><tr><th>错误码</th><th>字段</th><th>说明</th></tr></thead>';
        var tb = el('tbody');
        run.errors.forEach(function (e) {
          tb.insertAdjacentHTML('beforeend', '<tr><td class="mono">' + esc(e.code) + '</td><td class="mono">' +
            esc(e.field) + '</td><td>' + esc(e.message) + '</td></tr>');
        });
        t.appendChild(tb); return t;
      })()));
      host.appendChild(fp);
      return;
    }

    var r = run.result, c = r.conservation;
    // 顶部守恒卡片
    var statPanel = el('div', { class: 'panel' }, [
      el('h2', {}, [
        el('span', { text: run.runId }), ' ',
        el('span', { class: 'badge green', text: '成功 · 已冻结' }), ' ',
        el('span', { class: 'badge gray', text: '输入签名 ' + run.inputHash })
      ]),
      el('div', { class: 'grid cols-4' }, [
        statCard('订单费用总额', c.totalFeeCents),
        statCard('已分配合计', c.totalAllocatedCents, 'pos'),
        statCard('未分配合计', c.totalUnallocatedCents, c.totalUnallocatedCents ? 'neg' : ''),
        statCard('守恒差额（必须为 0）', c.diffCents, c.diffCents ? 'neg' : 'pos')
      ]),
      el('div', { class: 'alert ' + (c.balanced ? 'success' : 'error'), style: 'margin-top:14px',
        innerHTML: c.balanced
          ? '<strong>订单级守恒核对通过：</strong>费用总额 ' + E.centsToDisplay(c.totalFeeCents) +
            ' 元 = 已分配 ' + E.centsToDisplay(c.totalAllocatedCents) + ' 元 + 未分配 ' +
            E.centsToDisplay(c.totalUnallocatedCents) + ' 元，无金额凭空丢失。'
          : '<strong>守恒核对失败！</strong>差额 ' + c.diffCents + ' 分。' })
    ]);
    host.appendChild(statPanel);

    // 每条费用的行明细
    r.feeResults.forEach(function (fr) {
      var p = el('div', { class: 'panel' });
      p.appendChild(el('h2', {}, [
        el('span', { text: fr.feeId + ' · ' + fr.feeName }), ' ',
        el('span', { class: 'badge blue', text: '规则：' + fr.basisLabel }), ' ',
        el('span', { innerHTML: money(fr.feeAmountCents) })
      ]));
      var wrap = el('div', { class: 'table-wrap' });
      var t = el('table');
      t.innerHTML = '<thead><tr><th>商品行</th><th>商品</th><th>分摊依据</th><th class="num">分摊金额</th>' +
        '<th>未分配原因</th><th>逐行依据（含尾差裁决）</th></tr></thead>';
      var tb = el('tbody');
      fr.details.forEach(function (d) {
        var tr = el('tr');
        tr.innerHTML =
          '<td class="mono">' + esc(d.lineId) + (d.qualified ? '' : ' <span class="pill out">未参与</span>') + '</td>' +
          '<td>' + esc(d.productId) + ' ' + esc(d.productName) + '</td>' +
          '<td>' + esc(d.basisLabel) + ' = <span class="mono">' + esc(d.basisRaw) + '</span>' +
             (d.basisUnit ? ' <span class="muted">(' + esc(d.basisUnit) + ')</span>' : '') +
             (d.excludeReason ? '<br><span class="pill out">' + esc(d.excludeReason) + '</span>' : '') + '</td>' +
          '<td class="num ' + (d.allocatedCents < 0 ? 'tag-neg' : '') + '"><strong>¥' +
            E.centsToDisplay(d.allocatedCents) + '</strong></td>' +
          '<td class="small">' + (d.unallocatedReason ? esc(d.unallocatedReason) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (d.exactShareText
            ? '<details class="basis"><summary>查看分摊依据' +
              (d.tieBreakOrder ? '（尾差裁决序 #' + d.tieBreakOrder + '）' : '') + '</summary>' +
              '<div class="body">' + esc(d.exactShareText) + '</div></details>'
            : '<span class="muted">不参与分摊</span>') + '</td>';
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      wrap.appendChild(t); p.appendChild(wrap);

      if (fr.unallocatedCents !== 0 || fr.unallocatedReasons.length) {
        p.appendChild(el('div', { class: 'alert warn',
          innerHTML: '<strong>未分配 ' + E.centsToDisplay(fr.unallocatedCents) + ' 元：</strong>' +
            esc(fr.unallocatedReasons.join('；')) }));
      }
      host.appendChild(p);
    });

    // 行级汇总
    var agg = el('div', { class: 'panel' });
    agg.appendChild(el('h2', {}, ['商品行汇总（跨费用）']));
    var at = el('table');
    at.innerHTML = '<thead><tr><th>行</th><th>商品</th><th>状态</th><th>命中规则</th><th class="num">行金额</th>' +
      '<th class="num">分摊合计</th></tr></thead>';
    var ab = el('tbody');
    r.lineResults.forEach(function (lr) {
      ab.insertAdjacentHTML('beforeend', '<tr><td class="mono">' + esc(lr.lineId) + '</td><td>' + esc(lr.productName) +
        '</td><td>' + (lr.status === 'refunded' ? '<span class="pill refund">已退款</span>' : '<span class="pill in">有效</span>') +
        '</td><td>' + lr.bases.map(function (b) { return '<span class="badge blue" style="margin-right:4px">' + esc(b) + '</span>'; }).join('') +
        '</td><td class="num">¥' + E.centsToDisplay(lr.lineAmountCents) + '</td>' +
        '<td class="num ' + (lr.totalAllocatedCents < 0 ? 'tag-neg' : '') + '"><strong>¥' +
        E.centsToDisplay(lr.totalAllocatedCents) + '</strong></td></tr>');
    });
    at.appendChild(ab); agg.appendChild(el('div', { class: 'table-wrap' }, [at]));
    host.appendChild(agg);

    // 下载
    var dl = el('div', { class: 'panel' }, [
      el('h2', {}, ['下载明细']),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', text: '下载 CSV 明细（UTF-8 BOM，Excel 可开）', onclick: function () {
          download(run.runId + '_' + run.versionId + '_分摊明细.csv', S.runToCSV(run));
        } }),
        el('button', { class: 'btn', text: '下载完整运行 JSON（含快照/依据/核对）', onclick: function () {
          download(run.runId + '_完整结果.json', JSON.stringify(run, null, 2), 'application/json');
        } })
      ])
    ]);
    host.appendChild(dl);
  }

  function statCard(title, cents, cls) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: title }),
      el('div', { class: 'v ' + (cls || ''), text: '¥' + E.centsToDisplay(cents) })
    ]);
  }

  /* ========== ③ 版本/运行比较 ========== */
  function renderCompareTab() {
    var pane = $('#tab-compare');
    pane.innerHTML = '';
    var successRuns = store.state.runs.filter(function (r) { return r.status === 'success'; });
    if (!ui.compareA) ui.compareA = successRuns[0] && successRuns[0].runId;
    if (!ui.compareB) ui.compareB = successRuns[1] && successRuns[1].runId;

    var ctl = el('div', { class: 'panel' }, [el('h2', {}, ['运行结果比较（版本差异 + 逐行金额差异）'])]);
    var row = el('div', { class: 'grid cols-2' });
    row.appendChild(label('运行 A', runSelect('cmp-a', ui.compareA)));
    row.appendChild(label('运行 B', runSelect('cmp-b', ui.compareB)));
    ctl.appendChild(row);
    ctl.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn primary', text: '比较', onclick: function () { doCompare(); } }),
      el('button', { class: 'btn', text: '比较所选两个源版本的数据差异', onclick: function () { doVersionDiff(); } })
    ]));
    ctl.appendChild(el('div', { id: 'cmp-host' }));
    pane.appendChild(ctl);
    doCompare();

    function runSelect(id, selected) {
      var sel = el('select', { id: id });
      store.state.runs.forEach(function (r) {
        sel.appendChild(el('option', {
          value: r.runId, selected: r.runId === selected,
          text: r.runId + ' · ' + r.versionId + ' · ' + r.status + ' · ' + r.note.slice(0, 24)
        }));
      });
      return sel;
    }
    function doCompare() {
      var host = $('#cmp-host'); host.innerHTML = '';
      var selA = $('#cmp-a'), selB = $('#cmp-b');
      if (!selA || !selA.value) return; // 桩环境或尚未渲染控件时跳过
      var a = store.state.runs.find(function (x) { return x.runId === selA.value; });
      var b = store.state.runs.find(function (x) { return x.runId === selB.value; });
      if (!a || !b) return;
      if (a.status === 'failed' || b.status === 'failed') {
        host.appendChild(el('div', { class: 'alert warn', text: '失败运行没有分摊结果，无法比较金额；请选择两个成功运行。' }));
        return;
      }
      var cmp = S.compareRuns(a, b);
      var meta = el('div', { class: 'grid cols-2', style: 'margin:12px 0' });
      meta.appendChild(compareMeta(a, cmp.conservationA));
      meta.appendChild(compareMeta(b, cmp.conservationB));
      host.appendChild(meta);

      var t = el('table');
      t.innerHTML = '<thead><tr><th>费用</th><th>商品行</th><th class="num">A 分摊(分)</th>' +
        '<th class="num">B 分摊(分)</th><th class="num">差额 B-A(分)</th></tr></thead>';
      var tb = el('tbody');
      if (!cmp.changedRows.length) {
        tb.innerHTML = '<tr><td colspan="5" class="muted">两次运行逐行金额完全一致（可能为同输入幂等运行）。</td></tr>';
      }
      cmp.changedRows.forEach(function (d) {
        var deltaCls = d.deltaCents > 0 ? 'diff-add' : (d.deltaCents < 0 ? 'diff-del' : '');
        tb.insertAdjacentHTML('beforeend', '<tr><td class="mono">' + esc(d.feeId) + '</td><td class="mono">' + esc(d.lineId) +
          '</td><td class="num">' + (d.beforeCents === null ? '缺失' : d.beforeCents) +
          '</td><td class="num">' + (d.afterCents === null ? '缺失' : d.afterCents) +
          '</td><td class="num ' + deltaCls + '">' + (d.deltaCents === null ? '—' : d.deltaCents) + '</td></tr>');
      });
      t.appendChild(tb);
      host.appendChild(el('div', { class: 'table-wrap' }, [t]));
    }
    function compareMeta(run, cons) {
      return el('div', { class: 'stat' }, [
        el('div', { class: 'k', text: run.runId + ' · ' + run.versionId }),
        el('div', { class: 'small', text: run.note }),
        el('div', { class: 'mono small', text: '签名 ' + run.inputHash }),
        el('div', { class: 'small', innerHTML: '守恒 ' + (cons.balanced ? '✅' : '❌') +
          '｜费用 ' + E.centsToDisplay(cons.totalFeeCents) + '｜已分 ' + E.centsToDisplay(cons.totalAllocatedCents) +
          '｜未分 ' + E.centsToDisplay(cons.totalUnallocatedCents) })
      ]);
    }
    function doVersionDiff() {
      var selA = $('#cmp-a'), selB = $('#cmp-b');
      if (!selA || !selA.value) return;
      var a = store.state.runs.find(function (x) { return x.runId === selA.value; });
      var b = store.state.runs.find(function (x) { return x.runId === selB.value; });
      if (!a || !b) return;
      var diff = store.diffVersions(a.versionId, b.versionId);
      var host = $('#cmp-host');
      var p = el('div', { class: 'panel', style: 'margin-top:16px' }, [el('h2', {}, ['源版本数据差异：' + diff.a + ' → ' + diff.b])]);
      [['fees', '费用'], ['lines', '商品行'], ['products', '商品主数据']].forEach(function (pair) {
        var list = diff[pair[0]];
        p.appendChild(el('h3', {}, [pair[1] + '（' + list.length + ' 项变化）']));
        if (!list.length) { p.appendChild(el('p', { class: 'muted', text: '无差异' })); return; }
        var t = el('table');
        t.innerHTML = '<thead><tr><th>类型</th><th>ID</th><th>变更前</th><th>变更后</th></tr></thead>';
        var tb = el('tbody');
        list.forEach(function (d) {
          var labelMap = { added: '新增', removed: '删除', changed: '修改' };
          var cls = d.kind === 'added' ? 'diff-add' : d.kind === 'removed' ? 'diff-del' : 'diff-chg';
          tb.insertAdjacentHTML('beforeend', '<tr><td class="' + cls + '">' + labelMap[d.kind] + '</td><td class="mono">' +
            esc(d.id) + '</td><td class="small mono">' + esc(d.before ? JSON.stringify(d.before) : '—') +
            '</td><td class="small mono">' + esc(d.after ? JSON.stringify(d.after) : '—') + '</td></tr>');
        });
        t.appendChild(tb); p.appendChild(el('div', { class: 'table-wrap' }, [t]));
      });
      host.appendChild(p);
    }
  }

  /* ========== ④ 运行记录 ========== */
  function renderRunsTab() {
    var pane = $('#tab-runs');
    pane.innerHTML = '';
    var p = el('div', { class: 'panel' }, [
      el('h2', {}, ['运行记录（不可变；失败记录保留但不含结果）']),
      el('p', { class: 'muted', text: '同一源版本 + 同一输入签名的重复提交会复用既有运行（幂等），保证「同一输入与规则得到相同结果」。' })
    ]);
    var t = el('table');
    t.innerHTML = '<thead><tr><th>运行ID</th><th>源版本</th><th>状态</th><th>规则覆盖</th><th>输入签名</th>' +
      '<th class="num">费用/已分/未分(分)</th><th>时间</th><th>说明</th><th>操作</th></tr></thead>';
    var tb = el('tbody');
    store.state.runs.slice().reverse().forEach(function (r) {
      var tr = el('tr');
      var cons = r.status === 'success' ? r.result.conservation : null;
      var ov = Object.keys(r.basisOverrides).length
        ? Object.keys(r.basisOverrides).map(function (k) { return k + '→' + E.BASIS_LABEL[r.basisOverrides[k]]; }).join('；')
        : '自带规则';
      tr.innerHTML =
        '<td class="mono">' + esc(r.runId) + '</td>' +
        '<td class="mono">' + esc(r.versionId) + '</td>' +
        '<td>' + (r.status === 'success'
          ? '<span class="badge green">成功</span>'
          : '<span class="badge red">失败</span>') + '</td>' +
        '<td class="small">' + esc(ov) + '</td>' +
        '<td class="mono small">' + (r.inputHash || '—') + '</td>' +
        '<td class="num small">' + (cons ? cons.totalFeeCents + ' / ' + cons.totalAllocatedCents + ' / ' + cons.totalUnallocatedCents
          : '—') + '</td>' +
        '<td class="small muted">' + esc(r.createdAt) + '</td>' +
        '<td class="small">' + esc(r.note) + '</td>';
      var tdAction = el('td');
      if (r.status === 'success') {
        tdAction.appendChild(el('button', { class: 'btn sm', text: '查看', onclick: function () {
          ui.selectedRun = r; ui.selectedVersion = r.versionId;
          switchTab('calc');
          setTimeout(function () { renderRunResult($('#calc-result-host'), r); }, 30);
        } }));
        tdAction.appendChild(document.createTextNode(' '));
        tdAction.appendChild(el('button', { class: 'btn sm', text: 'CSV', onclick: function () {
          download(r.runId + '_' + r.versionId + '_分摊明细.csv', S.runToCSV(r));
        } }));
        tdAction.appendChild(document.createTextNode(' '));
        tdAction.appendChild(el('button', { class: 'btn sm', text: 'JSON', onclick: function () {
          download(r.runId + '_完整结果.json', JSON.stringify(r, null, 2), 'application/json');
        } }));
      } else {
        tdAction.appendChild(el('button', { class: 'btn sm danger', text: '查看错误', onclick: function () {
          ui.selectedRun = r; switchTab('calc');
          setTimeout(function () { renderRunResult($('#calc-result-host'), r); }, 30);
        } }));
      }
      tr.appendChild(tdAction);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    p.appendChild(el('div', { class: 'table-wrap' }, [t]));
    pane.appendChild(p);
  }

  /* ---------- 顶部统计 ---------- */
  function renderHeaderStats() {
    var s = store.state;
    $('#hdr-stats').textContent = '版本 ' + s.versions.length + ' · 运行 ' + s.runs.length +
      '（成功 ' + s.runs.filter(function (r) { return r.status === 'success'; }).length +
      ' / 失败 ' + s.runs.filter(function (r) { return r.status === 'failed'; }).length + '）';
  }

  /* ---------- 启动 ---------- */
  function boot() {
    $all('nav.tabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
    renderHeaderStats();
    switchTab('calc');
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  // 暴露给自动化测试（生产环境无副作用）
  window.AllocApp = { switchTab: switchTab, getStore: function () { return store; }, renderRunResult: renderRunResult };
})();
