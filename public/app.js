'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const ICO = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const state = { items: [], locations: [], categories: [], editing: null, pendingImage: null, view: 'items' };

  // ---------- 工具 ----------
  async function api(url, opts = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...opts });
    if (res.status === 401 && !url.endsWith('/api/login')) { showLogin(); throw new Error('请先登录'); }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(body.error || body || res.statusText);
    return body;
  }
  const postJson = (url, data, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  let toastTimer;
  // toast(msg, ms, { label, onClick })：带一个可点的动作按钮（如「撤销」）
  function toast(msg, ms = 2000, action = null) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    if (action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
      b.addEventListener('click', () => { t.classList.add('hidden'); clearTimeout(toastTimer); action.onClick(); });
      t.appendChild(b);
    }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 页面内对话框：代替 prompt / confirm（内嵌浏览器、PWA 独立模式常常不支持原生弹窗）
  // dialog({ title, message, input, value, placeholder, buttons:[{label, value, cls}] }) -> Promise<{ action, value } | null>
  let dialogResolve = null;
  function dialog({ title = '', message = '', input = false, value = '', placeholder = '', buttons }) {
    buttons = buttons || [{ label: '取消', value: 'cancel' }, { label: '确定', value: 'ok', cls: 'primary', submit: true }];
    $('#dlg-title').textContent = title; $('#dlg-title').classList.toggle('hidden', !title);
    $('#dlg-msg').textContent = message; $('#dlg-msg').classList.toggle('hidden', !message);
    const inp = $('#dlg-input'); inp.classList.toggle('hidden', !input); inp.value = value; inp.placeholder = placeholder;
    $('#dlg-buttons').innerHTML = buttons.map(b => `<button type="${b.submit ? 'submit' : 'button'}" class="btn ${b.cls || ''}" data-value="${esc(b.value)}">${esc(b.label)}</button>`).join('');
    $('#dialog').classList.remove('hidden');
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    return new Promise(resolve => { dialogResolve = resolve; });
  }
  function closeDialog(action) {
    const r = dialogResolve; dialogResolve = null;
    $('#dialog').classList.add('hidden');
    if (r) r(action == null || action === 'cancel' ? null : { action, value: $('#dlg-input').value.trim() });
  }
  $('#dialog-form').addEventListener('submit', e => { e.preventDefault(); const b = $('#dlg-buttons button[type=submit]'); closeDialog(b ? b.dataset.value : 'ok'); });
  $('#dlg-buttons').addEventListener('click', e => { const b = e.target.closest('button[type=button]'); if (b) closeDialog(b.dataset.value); });
  $('.dialog-backdrop').addEventListener('click', () => closeDialog(null));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && dialogResolve) closeDialog(null); });
  // 便捷封装：askText 返回字符串或 null；askConfirm 返回 true/false
  async function askText(title, { value = '', placeholder = '', message = '' } = {}) {
    const r = await dialog({ title, message, input: true, value, placeholder });
    return r && r.value ? r.value : null;
  }
  async function askConfirm(message, { title = '请确认', okText = '确定', danger = false } = {}) {
    const r = await dialog({ title, message, buttons: [{ label: '取消', value: 'cancel' }, { label: okText, value: 'ok', cls: danger ? 'danger' : 'primary', submit: true }] });
    return !!r;
  }
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function daysUntil(dateStr) { return Math.round((new Date(dateStr + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000); }
  function expiryBadge(d) {
    if (!d) return '';
    const n = daysUntil(d);
    if (n < 0) return `<span class="badge bad">已过期 ${-n} 天</span>`;
    if (n === 0) return `<span class="badge bad">今天到期</span>`;
    if (n <= 30) return `<span class="badge warn">${n} 天后到期</span>`;
    return `<span class="badge">${esc(d)} 到期</span>`;
  }
  const fmtQty = q => Number.isInteger(q) ? q : String(q);
  const isLow = i => i.min_quantity > 0 && i.quantity < i.min_quantity;
  const lowBadge = i => isLow(i) ? `<span class="badge low">${i.quantity <= 0 ? '缺货' : '库存低'}</span>` : '';
  // 删除物品 → 进回收站，toast 上给「撤销」
  async function deleteItem(item, after) {
    await api(`/api/items/${item.id}`, { method: 'DELETE' });
    toast(`已删除「${item.name}」`, 6000, { label: '撤销', onClick: async () => {
      try { await postJson(`/api/items/${item.id}/restore`, {}); toast('已恢复'); after && after(); } catch (err) { toast(err.message); }
    } });
    after && after();
  }
  // 服务端在数量归零时会自动把物品移入回收站并返回 auto_deleted；这里给一个可撤销的提示
  function noteAutoDeleted(saved, after) {
    if (!saved?.auto_deleted) return false;
    toast(`「${saved.name}」用完了，已移入回收站`, 6000, { label: '撤销', onClick: async () => {
      try { await postJson(`/api/items/${saved.id}/restore`, {}); await postJson(`/api/items/${saved.id}`, { quantity: 1 }, 'PUT'); toast('已恢复，数量设为 1'); after && after(); } catch (err) { toast(err.message); }
    } });
    return true;
  }
  const ACTION_TEXT = { create: '新增', update: '修改', quantity: '数量', move: '移到', delete: '删除', restore: '恢复', purge: '彻底删除' };
  const SOURCE_TEXT = { quick: '一句话', import: '导入', list: '购物清单' };
  function fmtTime(iso) {
    const d = new Date(iso); const diff = (Date.now() - d) / 60000;
    if (diff < 1) return '刚刚'; if (diff < 60) return `${Math.floor(diff)} 分钟前`; if (diff < 1440) return `${Math.floor(diff / 60)} 小时前`;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function logLine(r, withName = true) {
    let what = ACTION_TEXT[r.action] || r.action;
    if (r.action === 'quantity') what = `${r.delta > 0 ? '+' : ''}${fmtQty(r.delta)} → ${fmtQty(r.quantity)}`;
    else if (r.action === 'move') what = `移到 ${r.detail}`;
    else if (r.action === 'update' && r.detail) what = `修改：${r.detail}`;
    else if (r.action === 'create' && r.detail) what = `新增 → ${r.detail}`;
    const src = SOURCE_TEXT[r.source] ? `<span class="src">${SOURCE_TEXT[r.source]}</span>` : '';
    return `<div class="log-row"><span class="time">${fmtTime(r.created_at)}</span>${withName ? `<strong>${esc(r.item_name)}</strong>` : ''}<span>${esc(what)}</span>${src}</div>`;
  }

  // ---------- 登录 ----------
  function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); hideSubviews(); }
  function hideSubviews() { $$('.subview').forEach(v => v.classList.add('hidden')); }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#login-err').textContent = '';
    try { await postJson('/api/login', { password: $('#login-pw').value }); $('#login-pw').value = ''; await enterApp(); }
    catch (err) { $('#login-err').textContent = err.message; }
  });
  async function enterApp() {
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    await Promise.all([loadLocations(), loadCategories()]);
    await Promise.all([loadItems(), loadStats()]);
  }

  // ---------- 加载数据 ----------
  async function loadLocations() {
    state.locations = await api('/api/locations');
    const opts = ['<option value="">（未设置）</option>'].concat(state.locations.map(l => `<option value="${l.id}">${'　'.repeat(l.depth)}${esc(l.name)}</option>`)).join('');
    const fl = $('#f-location'); const keep = fl.value;
    fl.innerHTML = '<option value="">全部位置</option><option value="none">未设置位置</option>' + state.locations.map(l => `<option value="${l.id}">${'　'.repeat(l.depth)}${esc(l.name)}</option>`).join('');
    fl.value = keep;
    $('#ed-location').innerHTML = opts;
  }
  async function loadCategories() {
    state.categories = await api('/api/categories');
    const fc = $('#f-category'); const keep = fc.value;
    fc.innerHTML = '<option value="">全部分类</option>' + state.categories.map(c => `<option value="${esc(c.category)}">${esc(c.category)} (${c.n})</option>`).join('');
    fc.value = keep;
    $('#cat-list').innerHTML = state.categories.map(c => `<option value="${esc(c.category)}">`).join('');
  }
  async function loadStats() {
    const s = await api('/api/stats');
    $('#stats').innerHTML =
      `<span data-exp="">共 ${s.items} 件物品</span>` +
      (s.expired ? `<span class="bad" data-exp="0">已过期 ${s.expired}</span>` : '') +
      (s.expiringSoon ? `<span class="warn" data-exp="30">30 天内到期 ${s.expiringSoon}</span>` : '') +
      (s.low ? `<span class="low" data-low="1">库存低 ${s.low}</span>` : '');
    const b = $('#shop-badge'); b.textContent = s.low || ''; b.classList.toggle('hidden', !s.low);
  }
  let lowFilter = false;
  $('#stats').addEventListener('click', e => {
    const low = e.target.closest('[data-low]');
    if (low) { lowFilter = !lowFilter; low.classList.toggle('active', lowFilter); loadItems(); return; }
    const el = e.target.closest('[data-exp]'); if (!el) return;
    $('#f-expiring').value = el.dataset.exp; loadItems();
  });
  async function loadItems() {
    const p = new URLSearchParams();
    const q = $('#q').value.trim(); if (q) p.set('q', q);
    if ($('#f-category').value) p.set('category', $('#f-category').value);
    if ($('#f-location').value) p.set('location', $('#f-location').value);
    if ($('#f-expiring').value !== '') p.set('expiring', $('#f-expiring').value);
    if (lowFilter) p.set('low', '1');
    state.items = await api('/api/items?' + p.toString());
    renderItems();
  }
  function renderItems() {
    const list = $('#list');
    $('#empty').classList.toggle('hidden', state.items.length > 0);
    list.innerHTML = state.items.map(i => `
      <article class="card" data-id="${i.id}">
        ${i.image ? `<img class="thumb" src="/uploads/${esc(i.image)}" alt="" loading="lazy">` : `<div class="thumb">${ICO('box', 'thumb-ico')}</div>`}
        <div class="body">
          <div class="name"><span>${esc(i.name)}</span><span class="qty">× ${fmtQty(i.quantity)}${esc(i.unit)}</span>${expiryBadge(i.expires_at)}${lowBadge(i)}</div>
          <div class="meta">${ICO('map-pin')} ${i.location_path ? esc(i.location_path) : '<i>未设置位置</i>'}${i.category ? ` · ${esc(i.category)}` : ''}</div>
          ${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}
        </div>
        <div class="qty-ctl"><button type="button" data-d="1" aria-label="增加数量">${ICO('plus')}</button><button type="button" data-d="-1" aria-label="减少数量">${ICO('minus')}</button></div>
      </article>`).join('');
  }
  $('#list').addEventListener('click', async e => {
    const card = e.target.closest('.card'); if (!card) return;
    const id = Number(card.dataset.id);
    const item = state.items.find(i => i.id === id);
    const qbtn = e.target.closest('[data-d]');
    if (qbtn) {
      const quantity = Math.max(0, item.quantity + Number(qbtn.dataset.d));
      try {
        const updated = await postJson(`/api/items/${id}`, { quantity }, 'PUT');
        if (noteAutoDeleted(updated, refreshAll)) { refreshAll(); return; }
        Object.assign(item, updated); renderItems();
      } catch (err) { toast(err.message); }
      return;
    }
    openEditor(item);
  });

  // 搜索 & 筛选
  let qTimer;
  $('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadItems, 250); });
  $('#q-clear').addEventListener('click', () => { $('#q').value = ''; loadItems(); });
  $('#filter-btn').addEventListener('click', () => $('#filters').classList.toggle('hidden'));
  ['#f-location', '#f-category', '#f-expiring'].forEach(s => $(s).addEventListener('change', loadItems));
  $('#f-reset').addEventListener('click', () => { ['#f-location', '#f-category', '#f-expiring'].forEach(s => $(s).value = ''); $('#q').value = ''; lowFilter = false; loadItems(); });

  // ---------- 编辑器 ----------
  function openEditor(item) {
    state.editing = item || null; state.pendingImage = null;
    $('#ed-title').textContent = item ? '编辑物品' : '添加物品';
    $('#ed-name').value = item?.name || '';
    $('#ed-qty').value = item ? item.quantity : 1;
    $('#ed-unit').value = item?.unit || '';
    $('#ed-category').value = item?.category || '';
    $('#ed-location').value = item?.location_id ?? ($('#f-location').value && $('#f-location').value !== 'none' ? $('#f-location').value : '');
    $('#ed-expires').value = item?.expires_at || '';
    $('#ed-min').value = item?.min_quantity ? item.min_quantity : '';
    $('#ed-note').value = item?.note || '';
    $('#ed-delete').classList.toggle('hidden', !item);
    setEditorImage(item?.image ? `/uploads/${item.image}` : '');
    const log = $('#ed-log'); log.classList.add('hidden'); log.innerHTML = '';
    if (item) api(`/api/log?item=${item.id}&limit=8`).then(rows => { if (rows.length && state.editing?.id === item.id) { log.innerHTML = '<h4>变动记录</h4>' + rows.map(r => logLine(r, false)).join(''); log.classList.remove('hidden'); } }).catch(() => {});
    $('#editor').classList.remove('hidden');
    if (!item) setTimeout(() => $('#ed-name').focus(), 100);
  }
  function closeEditor() { $('#editor').classList.add('hidden'); state.editing = null; state.pendingImage = null; }
  function setEditorImage(src) {
    const img = $('#ed-img');
    img.classList.toggle('hidden', !src); $('#ed-img-placeholder').classList.toggle('hidden', !!src); $('#ed-img-remove').classList.toggle('hidden', !src);
    if (src) img.src = src;
  }
  $('#add-btn').addEventListener('click', () => openEditor(null));
  $('#ed-cancel').addEventListener('click', closeEditor);
  $('.sheet-backdrop').addEventListener('click', closeEditor);
  $('#ed-img-area').addEventListener('click', () => $('#ed-img-file').click());
  $('#ed-img-file').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try { state.pendingImage = await compressImage(file); setEditorImage(URL.createObjectURL(state.pendingImage)); }
    catch (err) { toast('图片处理失败：' + err.message); }
  });
  $('#ed-img-remove').addEventListener('click', () => { state.pendingImage = 'remove'; setEditorImage(''); });
  $('#ed-delete').addEventListener('click', async () => {
    if (!state.editing) return;
    const item = state.editing;
    try { closeEditor(); await deleteItem(item, refreshAll); }
    catch (err) { toast(err.message); }
  });
  $('#item-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      name: $('#ed-name').value, quantity: $('#ed-qty').value || 0, unit: $('#ed-unit').value, category: $('#ed-category').value,
      location_id: $('#ed-location').value || null, expires_at: $('#ed-expires').value, note: $('#ed-note').value, min_quantity: $('#ed-min').value || 0,
    };
    const btn = e.submitter || $('#item-form button[type=submit]'); btn.disabled = true;
    try {
      const saved = state.editing ? await postJson(`/api/items/${state.editing.id}`, data, 'PUT') : await postJson('/api/items', data);
      if (state.pendingImage === 'remove' && saved.image) await api(`/api/items/${saved.id}/image`, { method: 'DELETE' });
      else if (state.pendingImage instanceof Blob) await api(`/api/items/${saved.id}/image`, { method: 'POST', headers: { 'Content-Type': state.pendingImage.type }, body: state.pendingImage });
      closeEditor(); if (!noteAutoDeleted(saved, refreshAll)) toast('已保存'); refreshAll();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });
  async function refreshAll() { await Promise.all([loadCategories(), loadStats()]); await loadItems(); }

  // 手机拍照通常几 MB，上传前在浏览器里压缩到最长边 1280
  function compressImage(file, max = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => b ? resolve(b) : reject(new Error('无法编码图片')), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
      img.src = url;
    });
  }

  // ---------- 快速录入（一句话 → 确认 → 执行） ----------
  const ACTION_LABEL = { add: ['新增', ''], restock: ['补货 +', ''], move: ['移动位置', 'info'], consume: ['减少 −', 'minus'], deplete: ['用完 → 删除', 'zero'], set_quantity: ['设为数量', 'info'], expire: ['设置到期', 'info'] };
  let cfIntents = [];
  $('#quick-form').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('#quick-text').value.trim(); if (!text) return;
    const btn = e.submitter || $('#quick-form button[type=submit]'); btn.disabled = true;
    try {
      const r = await postJson('/api/parse', { text });
      if (!r.intents.length) { toast('没听懂，换个说法试试，或直接点右下角添加按钮'); return; }
      showConfirm(r);
    } catch (err) { toast(err.message, 3000); }
    finally { btn.disabled = false; }
  });
  function locationOptions(sel, create) {
    let html = '<option value="">（不设置位置）</option>';
    if (create) html += `<option value="new:${esc(create.path)}" ${sel === 'new' ? 'selected' : ''}>新建：${esc(create.path)}</option>`;
    html += state.locations.map(l => `<option value="${l.id}" ${String(sel) === String(l.id) ? 'selected' : ''}>${'　'.repeat(l.depth)}${esc(l.name)}</option>`).join('');
    return html;
  }
  function showConfirm(r) {
    cfIntents = r.intents;
    $('#cf-text').textContent = `「${r.text}」`;
    $('#cf-list').innerHTML = r.intents.map((it, i) => {
      const [label, cls] = ACTION_LABEL[it.action] || ['', ''];
      const qtyLabel = it.action === 'restock' ? '增加数量' : it.action === 'consume' ? '减少数量' : '数量';
      const showQty = ['add', 'restock', 'consume', 'set_quantity'].includes(it.action);
      const showLoc = ['add', 'move'].includes(it.action);
      const locSel = it.location ? (it.location.location ? it.location.location.id : it.location.create ? 'new' : '') : (it.existing?.location_id ?? '');
      const amb = it.location?.alternatives?.length ? `<div class="cf-exist">也可能是：${it.location.alternatives.map(a => esc(a.path)).join('、')}</div>` : '';
      return `<div class="cf-item" data-i="${i}">
        <div class="cf-head"><span class="cf-act ${cls}">${label}${['restock', 'consume'].includes(it.action) ? '' : ''}</span>
          ${it.existing ? `<span class="cf-exist">已有：${esc(it.existing.name)} ×${it.existing.quantity}${esc(it.existing.unit)}${it.existing.location_path ? ' @ ' + esc(it.existing.location_path) : ''}</span>` : '<span class="cf-exist">新物品</span>'}</div>
        ${it.warning ? `<p class="warn">${ICO('alert')} ${esc(it.warning)}</p>` : ''}
        <div class="row3">
          <label>名称<input data-k="name" value="${esc(it.action === 'add' ? it.name : (it.existing?.name || it.name))}" ${it.action === 'add' ? '' : 'readonly'}></label>
          <label class="${showQty ? '' : 'hidden'}">${qtyLabel}<input data-k="quantity" type="number" step="any" min="0" inputmode="decimal" value="${it.quantity ?? 1}"></label>
          <label class="${showQty ? '' : 'hidden'}">单位<input data-k="unit" value="${esc(it.unit || '')}" list="unit-list"></label>
        </div>
        <label class="${showLoc ? '' : 'hidden'}">位置<select data-k="location">${locationOptions(locSel, it.location?.create)}</select>${amb}</label>
        <div class="row2 ${it.action === 'add' || it.expires_at ? '' : 'hidden'}">
          <label class="${it.action === 'add' ? '' : 'hidden'}">分类<input data-k="category" value="${esc(it.category || '')}" list="cat-list" placeholder="自动归类"></label>
          <label>到期日<input data-k="expires_at" type="date" value="${esc(it.expires_at || '')}"></label>
        </div>
      </div>`;
    }).join('');
    $('#cf-note').innerHTML = r.confidence === 'low' ? `${ICO('alert')} 这句话我不太确定，请核对后再确认。` : '核对无误后点「确认」，可直接修改任何一项。';
    $('#confirm').classList.remove('hidden');
  }
  function hideConfirm() { $('#confirm').classList.add('hidden'); }
  $('#cf-cancel').addEventListener('click', hideConfirm);
  $('#confirm .sheet-backdrop').addEventListener('click', hideConfirm);
  $('#cf-ok').addEventListener('click', async () => {
    const btn = $('#cf-ok'); btn.disabled = true;
    const done = [];
    try {
      for (const el of $$('#cf-list .cf-item')) {
        const it = cfIntents[Number(el.dataset.i)];
        const v = k => el.querySelector(`[data-k="${k}"]`)?.value ?? '';
        const qty = Number(v('quantity')) || 0;
        let location_id = null;
        const locV = v('location');
        if (locV.startsWith('new:')) location_id = (await postJson('/api/locations/path', { path: locV.slice(4) })).id;
        else if (locV) location_id = Number(locV);
        const ex = it.existing;
        if (it.action === 'add') {
          const name = v('name').trim(); if (!name) continue;
          await postJson('/api/items?source=quick', { name, quantity: qty, unit: v('unit'), category: v('category'), location_id, expires_at: v('expires_at') });
          done.push(`新增 ${name}`);
        } else if (it.action === 'restock') {
          const patch = { quantity: (ex.quantity || 0) + qty }; if (v('unit')) patch.unit = v('unit'); if (v('expires_at')) patch.expires_at = v('expires_at');
          await postJson(`/api/items/${ex.id}?source=quick`, patch, 'PUT'); done.push(`${ex.name} +${qty}`);
        } else if (it.action === 'move') {
          const patch = { location_id }; if (v('expires_at')) patch.expires_at = v('expires_at');
          await postJson(`/api/items/${ex.id}?source=quick`, patch, 'PUT'); done.push(`移动 ${ex.name}`);
        } else if (it.action === 'consume') {
          const r = await postJson(`/api/items/${ex.id}?source=quick`, { quantity: Math.max(0, (ex.quantity || 0) - qty) }, 'PUT'); done.push(r.auto_deleted ? `${ex.name} 用完，已移入回收站` : `${ex.name} −${qty}`);
        } else if (it.action === 'deplete') {
          await postJson(`/api/items/${ex.id}?source=quick`, { quantity: 0 }, 'PUT'); done.push(`${ex.name} 用完，已移入回收站`);
        } else if (it.action === 'set_quantity') {
          const patch = { quantity: qty }; if (v('unit')) patch.unit = v('unit');
          const r = await postJson(`/api/items/${ex.id}?source=quick`, patch, 'PUT'); done.push(r.auto_deleted ? `${ex.name} 用完，已移入回收站` : `${ex.name} = ${qty}`);
        } else if (it.action === 'expire') {
          await postJson(`/api/items/${ex.id}?source=quick`, { expires_at: v('expires_at') }, 'PUT'); done.push(`${ex.name} 到期日已更新`);
        }
      }
      hideConfirm(); $('#quick-text').value = '';
      toast('已录入：' + done.join('，'), 3000);
      await loadLocations(); refreshAll();
    } catch (err) { toast('录入失败：' + err.message + (done.length ? `（已完成：${done.join('，')}）` : ''), 4000); }
    finally { btn.disabled = false; }
  });

  // ---------- 视图切换 ----------
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
  function switchView(view) {
    state.view = view;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    const main = view === 'items';
    $('#app .topbar').classList.toggle('hidden', !main); $('#filters').classList.toggle('hidden', true);
    $('#quick-form').classList.toggle('hidden', !main); $('#quick-hint').classList.toggle('hidden', !main);
    $('#stats').classList.toggle('hidden', !main); $('#list').classList.toggle('hidden', !main); $('#add-btn').classList.toggle('hidden', !main);
    if (!main) $('#empty').classList.add('hidden'); else $('#empty').classList.toggle('hidden', state.items.length > 0);
    hideSubviews();
    hidePinPop();
    if (view === 'locations') { $('#view-locations').classList.remove('hidden'); renderLocations(); }
    if (view === 'plans') { $('#view-plans').classList.remove('hidden'); enterPlans(); }
    if (view === 'settings') $('#view-settings').classList.remove('hidden');
    if (view === 'home') { $('#view-home').classList.remove('hidden'); renderHome(); }
    if (view === 'shopping') { $('#view-shopping').classList.remove('hidden'); renderShopping(); }
  }
  // 从其他页跳到物品页并打开某件物品
  async function openItemById(id) {
    switchView('items');
    let item = state.items.find(i => i.id === id);
    if (!item) { try { const all = await api('/api/items'); item = all.find(i => i.id === id); } catch {} }
    if (item) openEditor(item); else toast('物品不存在');
  }

  // ---------- 首页仪表盘 ----------
  async function renderHome() {
    const d = await api('/api/dashboard');
    $('#home-date').textContent = d.today;
    const c = d.counts;
    const tile = (n, label, cls, view, extra = '') => `<button type="button" class="tile ${cls} ${n ? '' : 'dim'}" data-go="${view}" ${extra}><b>${n}</b><span>${label}</span></button>`;
    const row = (i, right) => `<div class="home-row" data-item="${i.id}"><span class="nm">${esc(i.name)}</span><span class="meta">${esc(i.location_path || '')}</span><span class="rt">${right}</span></div>`;
    const expiring = d.expiring.map(i => row(i, expiryBadge(i.expires_at))).join('');
    const low = d.low.map(i => row(i, `<span class="badge low">${fmtQty(i.quantity)}/${fmtQty(i.min_quantity)}${esc(i.unit)}</span>`)).join('');
    const recent = d.recent.map(i => row(i, `<span class="muted">${fmtTime(i.updated_at)}</span>`)).join('');
    const log = d.log.map(r => logLine(r)).join('');
    $('#home-body').innerHTML = `
      <div class="tiles">
        ${tile(c.items, '件物品', '', 'items')}
        ${tile(c.expired, '已过期', 'bad', 'items', 'data-exp="0"')}
        ${tile(c.expiringSoon, '30 天内到期', 'warn', 'items', 'data-exp="30"')}
        ${tile(c.low + c.shoppingExtra, '待购买', 'low', 'shopping')}
      </div>
      ${d.expiring.length ? `<section class="home-block home-expiring"><h3>${ICO('clock')}快到期 / 已过期</h3><div class="home-list">${expiring}</div></section>` : ''}
      ${d.low.length ? `<section class="home-block home-low"><h3>${ICO('cart')}库存不足</h3><div class="home-list">${low}</div></section>` : ''}
      <section class="home-block home-recent"><h3>${ICO('plus-circle')}最近添加</h3><div class="home-list">${recent || '<p class="muted">还没有物品</p>'}</div></section>
      <section class="home-block home-log"><h3>${ICO('file-text')}最近变动</h3><div class="home-list log">${log || '<p class="muted">暂无记录</p>'}</div></section>
      ${!d.expiring.length && !d.low.length ? `<p class="muted center home-status">${ICO('check-circle')}没有到期或缺货的物品</p>` : ''}`;
  }
  $('#home-body').addEventListener('click', e => {
    const t = e.target.closest('[data-go]');
    if (t) {
      if (t.dataset.go === 'items') { ['#f-location', '#f-category'].forEach(s => $(s).value = ''); $('#f-expiring').value = t.dataset.exp ?? ''; lowFilter = false; loadItems(); }
      switchView(t.dataset.go); return;
    }
    const r = e.target.closest('[data-item]'); if (r) openItemById(Number(r.dataset.item));
  });

  // ---------- 购物清单 ----------
  async function renderShopping() {
    const s = await api('/api/shopping');
    const byCat = new Map();
    s.low.forEach(i => { const k = i.category || '其他'; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(i); });
    const lowHtml = [...byCat].map(([cat, arr]) => `<h4>${esc(cat)}</h4>` + arr.map(i => `
      <div class="shop-row" data-item="${i.id}">
        <div class="body"><span class="nm">${esc(i.name)}</span><span class="meta">现有 ${fmtQty(i.quantity)}${esc(i.unit)} / 最低 ${fmtQty(i.min_quantity)}${esc(i.unit)}${i.location_path ? ' · ' + esc(i.location_path) : ''}</span></div>
        <button type="button" class="btn small primary" data-bought="${i.id}">已买 +${fmtQty(i.need || 1)}</button>
      </div>`).join('')).join('');
    const extraHtml = s.extra.map(x => `
      <div class="shop-row ${x.done ? 'done' : ''}" data-extra="${x.id}">
        <label class="chk"><input type="checkbox" data-done="${x.id}" ${x.done ? 'checked' : ''}><span class="nm">${esc(x.name)}</span>${x.note ? `<span class="meta">${esc(x.note)}</span>` : ''}</label>
        <button type="button" class="icon-btn" data-remove="${x.id}" title="删除">${ICO('x')}</button>
      </div>`).join('');
    $('#shop-body').innerHTML =
      (s.low.length ? `<h3>库存不足（${s.low.length}）</h3>${lowHtml}` : '') +
      (s.extra.length ? `<h3>手动添加（${s.extra.filter(x => !x.done).length}）</h3>${extraHtml}` : '') +
      (!s.low.length && !s.extra.length ? `<p class="muted center empty-state">${ICO('check-circle')}清单是空的</p>` : '');
    const b = $('#shop-badge'); const n = s.low.length + s.extra.filter(x => !x.done).length; b.textContent = n || ''; b.classList.toggle('hidden', !n);
  }
  $('#shop-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#shop-text').value.trim(); if (!name) return;
    try { await postJson('/api/shopping', { name }); $('#shop-text').value = ''; renderShopping(); } catch (err) { toast(err.message); }
  });
  $('#shop-clear').addEventListener('click', async () => { try { const r = await api('/api/shopping', { method: 'DELETE' }); toast(`已清除 ${r.removed} 条`); renderShopping(); } catch (err) { toast(err.message); } });
  $('#shop-body').addEventListener('click', async e => {
    const bought = e.target.closest('[data-bought]');
    if (bought) {
      try { const it = await postJson(`/api/items/${bought.dataset.bought}/bought`, {}); toast(`${it.name} 现有 ${fmtQty(it.quantity)}${it.unit}`); renderShopping(); loadStats(); } catch (err) { toast(err.message); }
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) { try { await api(`/api/shopping/${rm.dataset.remove}`, { method: 'DELETE' }); renderShopping(); } catch (err) { toast(err.message); } return; }
    const row = e.target.closest('.shop-row[data-item]');
    if (row && !e.target.closest('button')) openItemById(Number(row.dataset.item));
  });
  $('#shop-body').addEventListener('change', async e => {
    const cb = e.target.closest('[data-done]'); if (!cb) return;
    try { await postJson(`/api/shopping/${cb.dataset.done}`, { done: cb.checked }, 'PUT'); renderShopping(); } catch (err) { toast(err.message); }
  });

  // ---------- 图纸 ----------
  const plan = { list: [], current: null, marking: null, zoom: 1, activePin: null };
  async function enterPlans() {
    await loadLocations();
    plan.list = await api('/api/plans');
    const sel = $('#plan-select');
    sel.innerHTML = plan.list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (!plan.list.some(p => p.id === plan.current)) plan.current = plan.list[0]?.id ?? null;
    if (plan.current != null) sel.value = String(plan.current);
    renderPlan();
  }
  function currentPlan() { return plan.list.find(p => p.id === plan.current) || null; }
  function renderPlan() {
    const p = currentPlan();
    $('#plan-empty').classList.toggle('hidden', !!p);
    $('#plan-stage').classList.toggle('hidden', !p);
    $('#plan-toolbar').classList.toggle('hidden', !p);
    $('#plan-more').classList.toggle('hidden', !p);
    $('#plan-select').classList.toggle('hidden', !p);
    if (!p) return;
    const img = $('#plan-img');
    const src = `/uploads/${p.image}`;
    if (!img.src.endsWith(src)) img.src = src;
    $('#plan-wrap').style.width = (plan.zoom * 100) + '%';
    renderPins();
  }
  function renderPins() {
    const pins = state.locations.filter(l => l.plan_id === plan.current && l.x != null && l.y != null);
    $('#plan-pins').innerHTML = pins.map(l => `
      <div class="pin${plan.activePin === l.id ? ' active' : ''}" data-id="${l.id}" style="left:${l.x}%;top:${l.y}%">
        <span class="pin-label">${esc(l.name)}${l.item_count_total ? `<b>${l.item_count_total}</b>` : ''}</span>
      </div>`).join('');
    $('#plan-wrap').classList.toggle('marking', plan.marking != null);
    const m = plan.marking != null && state.locations.find(l => l.id === plan.marking);
    $('#plan-hint').textContent = m ? `请点击图纸上「${m.name}」所在的位置` : '';
    $('#plan-mark').innerHTML = plan.marking != null ? `${ICO('x')}取消标记` : `${ICO('map-pin')}标记位置`;
  }
  $('#plan-select').addEventListener('change', e => { plan.current = Number(e.target.value); plan.activePin = null; hidePinPop(); renderPlan(); });
  $('#plan-zoom-in').addEventListener('click', () => { plan.zoom = Math.min(4, plan.zoom * 1.4); renderPlan(); });
  $('#plan-zoom-out').addEventListener('click', () => { plan.zoom = Math.max(1, plan.zoom / 1.4); renderPlan(); });

  // 上传 / 更换图片
  let planFilePurpose = 'new';
  $('#plan-upload').addEventListener('click', () => { planFilePurpose = 'new'; $('#plan-file').click(); });
  $('#plan-file').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      let name = '';
      if (planFilePurpose === 'new') {
        name = await askText('图纸名称', { value: plan.list.length ? `图纸 ${plan.list.length + 1}` : '我家', placeholder: '例如：一楼 / 二楼' });
        if (name == null) return;
      }
      toast('正在处理图片…', 60000);
      const blob = await compressImage(file, 2400, 0.88);
      if (planFilePurpose === 'new') {
        const created = await api('/api/plans?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        plan.current = created.id;
      } else {
        await api(`/api/plans/${plan.current}/image`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        $('#plan-img').removeAttribute('src');
      }
      toast('已保存'); await enterPlans();
    } catch (err) { toast(err.message, 3000); }
  });
  // 更多操作
  $('#plan-more').addEventListener('click', () => $('#plan-actions').classList.remove('hidden'));
  $('#plan-actions').addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act || (e.target.classList.contains('sheet-backdrop') ? 'close' : null);
    if (!act) return;
    $('#plan-actions').classList.add('hidden');
    const p = currentPlan(); if (!p || act === 'close') return;
    try {
      if (act === 'rename') { const name = await askText('图纸名称', { value: p.name }); if (name) { await postJson(`/api/plans/${p.id}`, { name }, 'PUT'); await enterPlans(); } }
      else if (act === 'replace') { planFilePurpose = 'replace'; $('#plan-file').click(); }
      else if (act === 'delete') { if (await askConfirm(`删除图纸「${p.name}」？\n图上的 ${p.pins} 个标记会一起移除，位置和物品不受影响。`, { okText: '删除', danger: true })) { await api(`/api/plans/${p.id}`, { method: 'DELETE' }); plan.current = null; await enterPlans(); } }
    } catch (err) { toast(err.message, 3000); }
  });

  // 标记位置：先选位置，再点图
  $('#plan-mark').addEventListener('click', () => {
    if (plan.marking != null) { plan.marking = null; renderPins(); return; }
    const sel = $('#pick-select');
    sel.innerHTML = state.locations.map(l => {
      const here = l.plan_id === plan.current && l.x != null;
      const other = !here && l.plan_id != null;
      return `<option value="${l.id}">${'　'.repeat(l.depth)}${esc(l.name)}${here ? ' ✓已标记' : other ? ' （在其他图纸）' : ''}</option>`;
    }).join('');
    const first = state.locations.find(l => l.plan_id == null); if (first) sel.value = String(first.id);
    $('#pick-loc').classList.remove('hidden');
  });
  $('#pick-cancel').addEventListener('click', () => $('#pick-loc').classList.add('hidden'));
  $('#pick-loc .sheet-backdrop').addEventListener('click', () => $('#pick-loc').classList.add('hidden'));
  $('#pick-ok').addEventListener('click', () => {
    plan.marking = Number($('#pick-select').value); $('#pick-loc').classList.add('hidden'); hidePinPop(); renderPins();
    $('#plan-stage').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  function pctFromEvent(e) {
    const r = $('#plan-img').getBoundingClientRect();
    const x = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
    const y = Math.min(100, Math.max(0, (e.clientY - r.top) / r.height * 100));
    return { x: +x.toFixed(2), y: +y.toFixed(2) };
  }
  async function savePin(locId, x, y) {
    const updated = await postJson(`/api/locations/${locId}`, { plan_id: plan.current, x, y }, 'PUT');
    const i = state.locations.findIndex(l => l.id === locId); if (i >= 0) state.locations[i] = updated;
  }
  $('#plan-img').addEventListener('click', async e => {
    if (plan.marking == null) { hidePinPop(); return; }
    const { x, y } = pctFromEvent(e); const id = plan.marking; plan.marking = null;
    try { await savePin(id, x, y); plan.activePin = id; renderPins(); showPinPop(id); toast('已标记，可拖动微调'); } catch (err) { toast(err.message, 3000); renderPins(); }
  });

  // 拖动标记 / 点击标记
  let drag = null;
  $('#plan-pins').addEventListener('pointerdown', e => {
    const pin = e.target.closest('.pin'); if (!pin || plan.marking != null) return;
    drag = { pin, id: Number(pin.dataset.id), startX: e.clientX, startY: e.clientY, moved: false };
    pin.setPointerCapture(e.pointerId);
  });
  $('#plan-pins').addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 8) return;
    drag.moved = true; drag.pin.classList.add('dragging');
    const { x, y } = pctFromEvent(e); drag.pin.style.left = x + '%'; drag.pin.style.top = y + '%'; drag.pos = { x, y };
  });
  const endDrag = async e => {
    if (!drag) return; const d = drag; drag = null; d.pin.classList.remove('dragging');
    if (d.moved && d.pos) { try { await savePin(d.id, d.pos.x, d.pos.y); } catch (err) { toast(err.message); } renderPins(); }
    else { plan.activePin = d.id; renderPins(); showPinPop(d.id); }
  };
  $('#plan-pins').addEventListener('pointerup', endDrag);
  $('#plan-pins').addEventListener('pointercancel', endDrag);

  function showPinPop(id) {
    const l = state.locations.find(x => x.id === id); if (!l) return;
    $('#pp-name').textContent = l.name;
    $('#pp-count').textContent = l.item_count_total ? `${l.item_count_total} 件物品${l.item_count_total !== l.item_count ? `（含下级 ${l.item_count_total - l.item_count} 件）` : ''}` : '暂无物品';
    $('#pp-path').textContent = l.path;
    $('#pin-pop').dataset.id = id; $('#pin-pop').classList.remove('hidden');
  }
  function hidePinPop() { $('#pin-pop').classList.add('hidden'); if (plan.activePin != null) { plan.activePin = null; if (state.view === 'plans') renderPins(); } }
  $('#pin-pop').addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    const id = Number($('#pin-pop').dataset.id);
    if (act === 'close') hidePinPop();
    else if (act === 'view') { $('#f-location').value = String(id); switchView('items'); loadItems(); }
    else if (act === 'add') { switchView('items'); $('#f-location').value = String(id); openEditor(null); }
    else if (act === 'unpin') {
      try { const updated = await postJson(`/api/locations/${id}`, { plan_id: null }, 'PUT'); const i = state.locations.findIndex(l => l.id === id); state.locations[i] = updated; hidePinPop(); renderPins(); }
      catch (err) { toast(err.message); }
    }
  });

  // ---------- 位置管理 ----------
  async function renderLocations() {
    await loadLocations();
    $('#loc-tree').innerHTML = state.locations.map(l => `
      <div class="loc-row" data-id="${l.id}" style="margin-left:${l.depth * 20}px">
        <span class="nm">${l.depth ? '<span class="tree-branch">└</span>' : ICO('home')}${esc(l.name)}${l.plan_id != null ? ` <span class="loc-pin" title="已标在图纸上">${ICO('map-pin')}</span>` : ''}</span>
        <span class="cnt">${l.item_count_total ? l.item_count_total + ' 件' : ''}</span>
        <button type="button" class="btn small" data-act="view">查看</button>
        <button type="button" class="btn small" data-act="child" aria-label="添加下级位置">${ICO('plus')}</button>
      </div>`).join('') || '<p class="muted pad">还没有位置，点右上角「房间」添加。</p>';
  }
  $('#loc-add-root').addEventListener('click', async () => {
    const name = await askText('添加房间', { placeholder: '例如：厨房、书房、车库' }); if (!name) return;
    try { await postJson('/api/locations', { name, parent_id: null }); renderLocations(); } catch (err) { toast(err.message); }
  });
  $('#loc-tree').addEventListener('click', async e => {
    const row = e.target.closest('.loc-row'); if (!row) return;
    const id = Number(row.dataset.id); const loc = state.locations.find(l => l.id === id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'child') {
        const name = await askText(`在「${loc.name}」下添加位置`, { placeholder: '例如：第二层、左侧抽屉' }); if (!name) return;
        await postJson('/api/locations', { name, parent_id: id }); renderLocations();
      } else if (act === 'view') {
        $('#f-location').value = String(id); switchView('items'); loadItems();
      } else if (e.target.closest('.nm')) {
        const r = await dialog({
          title: '编辑位置', input: true, value: loc.name, placeholder: '位置名称',
          message: loc.item_count_total ? `此处（含下级）有 ${loc.item_count_total} 件物品` : '',
          buttons: [{ label: '删除', value: 'delete', cls: 'danger' }, { label: '取消', value: 'cancel' }, { label: '保存', value: 'save', cls: 'primary', submit: true }],
        });
        if (!r) return;
        if (r.action === 'delete') {
          if (!await askConfirm(`删除「${loc.name}」及其所有下级位置？`, { okText: '删除', danger: true })) return;
          await api(`/api/locations/${id}`, { method: 'DELETE' });
        } else if (r.value && r.value !== loc.name) await postJson(`/api/locations/${id}`, { name: r.value }, 'PUT');
        renderLocations();
      }
    } catch (err) { toast(err.message, 3000); }
  });

  // ---------- 设置 ----------
  $('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    $('#import-result').textContent = '导入中…';
    try {
      const r = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await readTextFile(file) });
      $('#import-result').textContent = `成功导入 ${r.imported} 条` + (r.errors.length ? `，${r.errors.length} 条失败：\n` + r.errors.slice(0, 10).join('\n') : '');
      await loadLocations(); refreshAll();
    } catch (err) { $('#import-result').textContent = '导入失败：' + err.message; }
  });
  // Excel 另存的 CSV 常是 GBK 编码，自动识别
  async function readTextFile(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { return new TextDecoder('gbk').decode(buf); }
  }
  $('#pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    try { await postJson('/api/password', { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value }); $('#pw-msg').textContent = '密码已修改'; e.target.reset(); }
    catch (err) { $('#pw-msg').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await postJson('/api/logout', {}); switchView('items'); showLogin(); });

  // 回收站
  async function renderTrash() {
    const rows = await api('/api/trash');
    $('#trash-count').textContent = rows.length ? `（${rows.length}）` : '（空）';
    $('#trash-list').innerHTML = rows.map(i => `
      <div class="shop-row" data-id="${i.id}">
        <div class="body"><span class="nm">${esc(i.name)}</span><span class="meta">× ${fmtQty(i.quantity)}${esc(i.unit)}${i.location_path ? ' · ' + esc(i.location_path) : ''} · 删于 ${fmtTime(i.deleted_at)}</span></div>
        <button type="button" class="btn small" data-restore="${i.id}">恢复</button>
        <button type="button" class="icon-btn" data-purge="${i.id}" title="彻底删除">${ICO('x')}</button>
      </div>`).join('');
  }
  $('#trash-refresh').addEventListener('click', () => renderTrash().catch(err => toast(err.message)));
  $('#trash-empty').addEventListener('click', async () => {
    if (!await askConfirm('彻底删除回收站里的全部物品？此操作不可恢复。', { okText: '清空', danger: true })) return;
    try { const r = await api('/api/trash', { method: 'DELETE' }); toast(`已彻底删除 ${r.purged} 件`); renderTrash(); loadStats(); } catch (err) { toast(err.message); }
  });
  $('#trash-list').addEventListener('click', async e => {
    const rs = e.target.closest('[data-restore]'); const pg = e.target.closest('[data-purge]');
    try {
      if (rs) { const it = await postJson(`/api/items/${rs.dataset.restore}/restore`, {}); toast(`已恢复「${it.name}」`); renderTrash(); refreshAll(); }
      else if (pg) { await api(`/api/items/${pg.dataset.purge}?purge=1`, { method: 'DELETE' }); renderTrash(); }
    } catch (err) { toast(err.message); }
  });
  // 变动记录
  $('#log-more').addEventListener('click', async () => {
    try { const rows = await api('/api/log?limit=100'); $('#log-list').innerHTML = rows.length ? rows.map(r => logLine(r)).join('') : '<p class="muted">暂无记录</p>'; }
    catch (err) { toast(err.message); }
  });

  // ---------- 启动 ----------
  (async () => {
    const me = await api('/api/me');
    if (me.authed) await enterApp(); else showLogin();
  })();
})();
