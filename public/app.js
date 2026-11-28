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
  const SOURCE_TEXT = { quick: '一句话', receipt: '小票', import: '导入', list: '购物清单' };
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
  function showLogin() { asrAbort(); $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); hideSubviews(); }
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
    loadReceiptStatus();
    loadAsrStatus();
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
  function compressImage(file, max = 1280, quality = 0.82, scaleFn = null) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = scaleFn ? scaleFn(img.width, img.height) : Math.min(1, max / Math.max(img.width, img.height));
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
  let cfSource = 'quick'; // 本次确认卡的来源：quick（一句话）或 receipt（小票），写库存时带在 ?source= 里
  // 一句话录入的解析流程：输入框提交和语音识别共用
  async function runQuick(text, notice = '') {
    text = String(text || '').trim(); if (!text) return;
    const btn = $('#quick-form button[type=submit]'); btn.disabled = true;
    try {
      const r = await postJson('/api/parse', { text });
      if (!r.intents.length) { toast('没听懂，换个说法试试，或直接点右下角添加按钮'); return; }
      if (r.truncated) r.notice = '只处理了前 5 句，后面的没有录入，请分开说。';
      else if (notice) r.notice = notice;
      showConfirm(r);
    } catch (err) { toast(err.message, 3000); }
    finally { btn.disabled = false; }
  }
  $('#quick-form').addEventListener('submit', e => { e.preventDefault(); runQuick($('#quick-text').value); });
  // ---------- 拍小票录入 ----------
  async function loadReceiptStatus() {
    let on = false;
    try { on = !!(await api('/api/receipt/status')).enabled; } catch {}
    $('#receipt-btn').classList.toggle('hidden', !on);
    $('#receipt-hint').classList.toggle('hidden', !on);
  }
  $('#receipt-btn').addEventListener('click', () => $('#receipt-file').click());
  $('#receipt-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = ''; // 允许再次选同一张
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('请选择图片'); return; }
    const btn = $('#receipt-btn'); btn.disabled = true;
    toast('识别中，请稍等…', 120000);
    try {
      const blob = await compressImage(file, 1800, 0.85, ImgScale.scaleFor); // 长截图按像素预算缩，避免字看不清
      const r = await api('/api/receipt/scan', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      $('#toast').classList.add('hidden');
      if (!r.intents.length) { toast('没识别出商品，换张更清晰的图试试', 3000); return; }
      showConfirm({
        text: r.text, intents: r.intents, source: 'receipt',
        notice: r.duplicate ? '这张小票好像已经录入过了，请确认不是重复。' : '',
        note: '按小票识别，请核对数量和单位。不想录入的行：新增的清空名称，补货的把数量改成 0。位置和到期日小票上没有，请自己选。',
      });
    } catch (err) { toast(err.message, 4000); }
    finally { btn.disabled = false; }
  });
  // ---------- 语音录入 ----------
  // state：idle（空闲）/ starting（等待麦克风权限）/ recording（录音中）/ busy（识别中）
  // gen：每次放弃（切换页面、退出登录）加 1，等权限期间用户已经离开时，权限一到就丢掉，不再录音
  // target：这次录音是哪个按钮发起的（'quick' 物品页一句话录入 / 'work' 每周工作），识别结果交给对应的处理
  const asr = { maxSeconds: 30, state: 'idle', gen: 0, target: null, snap: null, stream: null, rec: null, timer: null, tick: null, started: 0 };
  async function loadAsrStatus() {
    let on = false;
    try {
      const s = await api('/api/asr/status');
      asr.maxSeconds = s.maxSeconds || 30;
      // 浏览器只在 HTTPS 页面允许录音；缺少录音或解码能力的浏览器不显示按钮
      on = !!s.enabled && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder && !!(window.AudioContext || window.webkitAudioContext);
    } catch {}
    $$('.asr-btn').forEach(b => b.classList.toggle('hidden', !on));
    $('#asr-hint').classList.toggle('hidden', !on);
  }
  const asrIdleTitle = b => b.dataset.asr === 'work' ? '语音记录' : '语音录入';
  function asrUi(state) {
    asr.state = state;
    if (state === 'idle') { asr.target = null; asr.snap = null; }
    $$('.asr-btn').forEach(b => {
      const owner = b.dataset.asr === asr.target;   // 只有发起这次录音的按钮显示录音态
      b.classList.toggle('recording', state === 'recording' && owner);
      b.disabled = state === 'busy' || (state === 'recording' && !owner);   // 识别中都不可点；录音中另一处也不可点
      b.title = state === 'recording' && owner ? '再点一下结束' : asrIdleTitle(b);
      b.setAttribute('aria-label', b.title);
    });
  }
  function asrCleanup() { // 释放麦克风、清掉计时器和提示，保证不留残留状态
    clearTimeout(asr.timer); clearInterval(asr.tick); asr.timer = asr.tick = null;
    if (asr.stream) { asr.stream.getTracks().forEach(t => t.stop()); asr.stream = null; }
    asr.rec = null;
    $$('.asr-btn .asr-sec').forEach(s => { s.textContent = ''; });
  }
  function asrStop() { if (asr.rec && asr.rec.state === 'recording') asr.rec.stop(); }
  function asrAbort() { // 切换页面等情况：放弃这次录音
    if (asr.state === 'starting') { asr.gen++; return; } // 还在等麦克风权限：权限一到就丢掉
    if (asr.state !== 'recording') return;
    asr.gen++;
    if (asr.rec) { asr.rec.onstop = null; try { asr.rec.stop(); } catch {} }
    asrCleanup(); asrUi('idle');
  }
  function micErrorText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return '没有麦克风权限，请在浏览器设置里允许';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '没有找到麦克风';
    if (n === 'NotReadableError' || n === 'AbortError') return '麦克风正被别的程序占用，请稍后再试';
    return '无法使用麦克风';
  }
  async function asrStart() {
    const gen = asr.gen;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { if (gen === asr.gen) toast(micErrorText(e), 4000); return; }
    if (gen !== asr.gen) { stream.getTracks().forEach(t => t.stop()); return; } // 等权限期间用户已经离开
    let rec;
    try { rec = new MediaRecorder(stream); }
    catch { stream.getTracks().forEach(t => t.stop()); toast('这个浏览器暂时不支持语音录入', 4000); return; }
    const chunks = []; // 每次录音自己的数组，旧录音迟到的数据不会混进下一次
    asr.stream = stream; asr.rec = rec;
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => asrFinish(rec.mimeType, chunks);
    try { rec.start(); }
    catch { asrCleanup(); toast('这个浏览器暂时不支持语音录入', 4000); return; }
    asr.started = Date.now();
    asrUi('recording');
    const secEl = $(`.asr-btn[data-asr="${asr.target}"] .asr-sec`);   // 秒数只显示在发起录音的按钮上
    asr.tick = setInterval(() => { if (secEl) secEl.textContent = Math.floor((Date.now() - asr.started) / 1000) + 's'; }, 250);
    asr.timer = setTimeout(asrStop, asr.maxSeconds * 1000);
  }
  // 录音 → 解码 → 各声道平均成单声道 → 16kHz 16 位 WAV（最多 maxSeconds 秒，保证不超过服务器的请求体上限）
  async function asrToWav(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      let buf;
      try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); }
      catch { throw new Error('这个浏览器暂时不支持语音录入'); }
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
      return new Blob([WavEnc.encode(mono, buf.sampleRate, asr.maxSeconds)], { type: 'audio/wav' });
    } finally { Promise.resolve().then(() => ctx.close()).catch(() => {}); }
  }
  async function asrFinish(mime, chunks) {
    const target = asr.target, snap = asr.snap;   // 识别期间不会变，这里先记下来，交付时按它分发
    const secs = (Date.now() - asr.started) / 1000;
    asrCleanup(); asrUi('busy');
    toast('识别中，请稍等…', 120000);
    try {
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      if (!blob.size || secs < 0.5) { toast('没听清，再说一遍试试'); return; }
      const r = await api('/api/asr/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: await asrToWav(blob) });
      $('#toast').classList.add('hidden');
      const text = String(r.text || '').trim().slice(0, 200);
      if (!text) { toast('没听清，再说一遍试试'); return; }
      if (target === 'work') {
        // 每周工作：直接记到目标日（可撤销），不碰物品页的输入框
        await addWorkEntries(text, r.truncated ? '（录音太长，后面的没有识别）' : '', snap);
      } else {
        $('#quick-text').value = text; // 替换输入框里原有的内容，然后和点「录入」一样解析并弹出确认卡
        await runQuick(text, r.truncated ? '这段话太长，后面的没有录入，请分开说。' : '');
      }
    } catch (err) { toast(err.message, 4000); }
    finally { asrUi('idle'); }
  }
  $$('.asr-btn').forEach(btn => btn.addEventListener('click', () => {
    if (asr.state === 'idle') {
      asr.target = btn.dataset.asr;   // 记下是谁发起的，识别结果交给它
      asr.snap = asr.target === 'work' ? { person: work.person, date: work.target } : null;   // 每周工作：记下此刻选好的人员和日期
      asr.state = 'starting'; // 等待权限弹窗期间忽略再次点击
      asrStart().finally(() => { if (asr.state === 'starting') asrUi('idle'); });
    } else if (asr.state === 'recording' && asr.target === btn.dataset.asr) asrStop();
  }));
  function locationOptions(sel, create) {
    let html = '<option value="">（不设置位置）</option>';
    if (create) html += `<option value="new:${esc(create.path)}" ${sel === 'new' ? 'selected' : ''}>新建：${esc(create.path)}</option>`;
    html += state.locations.map(l => `<option value="${l.id}" ${String(sel) === String(l.id) ? 'selected' : ''}>${'　'.repeat(l.depth)}${esc(l.name)}</option>`).join('');
    return html;
  }
  function showConfirm(r) {
    cfIntents = r.intents;
    cfSource = r.source || 'quick';
    $('#cf-text').textContent = `「${r.text}」`;
    $('#cf-list').innerHTML = (r.notice ? `<p class="cf-notice">${ICO('alert')} ${esc(r.notice)}</p>` : '') + r.intents.map((it, i) => {
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
    $('#cf-note').innerHTML = r.note ? esc(r.note) : r.confidence === 'low' ? `${ICO('alert')} 这句话我不太确定，请核对后再确认。` : '核对无误后点「确认」，可直接修改任何一项。';
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
          await postJson(`/api/items?source=${cfSource}`, { name, quantity: qty, unit: v('unit'), category: v('category'), location_id, expires_at: v('expires_at') });
          done.push(`新增 ${name}`);
        } else if (it.action === 'restock') {
          const patch = { quantity: (ex.quantity || 0) + qty }; if (v('unit')) patch.unit = v('unit'); if (v('expires_at')) patch.expires_at = v('expires_at');
          await postJson(`/api/items/${ex.id}?source=${cfSource}`, patch, 'PUT'); done.push(`${ex.name} +${qty}`);
        } else if (it.action === 'move') {
          const patch = { location_id }; if (v('expires_at')) patch.expires_at = v('expires_at');
          await postJson(`/api/items/${ex.id}?source=${cfSource}`, patch, 'PUT'); done.push(`移动 ${ex.name}`);
        } else if (it.action === 'consume') {
          const r = await postJson(`/api/items/${ex.id}?source=${cfSource}`, { quantity: Math.max(0, (ex.quantity || 0) - qty) }, 'PUT'); done.push(r.auto_deleted ? `${ex.name} 用完，已移入回收站` : `${ex.name} −${qty}`);
        } else if (it.action === 'deplete') {
          await postJson(`/api/items/${ex.id}?source=${cfSource}`, { quantity: 0 }, 'PUT'); done.push(`${ex.name} 用完，已移入回收站`);
        } else if (it.action === 'set_quantity') {
          const patch = { quantity: qty }; if (v('unit')) patch.unit = v('unit');
          const r = await postJson(`/api/items/${ex.id}?source=${cfSource}`, patch, 'PUT'); done.push(r.auto_deleted ? `${ex.name} 用完，已移入回收站` : `${ex.name} = ${qty}`);
        } else if (it.action === 'expire') {
          await postJson(`/api/items/${ex.id}?source=${cfSource}`, { expires_at: v('expires_at') }, 'PUT'); done.push(`${ex.name} 到期日已更新`);
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
    // 离开发起录音的那个页面就放弃这次录音（物品页的录音只在物品页有效，每周工作页同理）
    if (!((view === 'items' && asr.target === 'quick') || (view === 'work' && asr.target === 'work'))) asrAbort();
    if (view === 'locations') { $('#view-locations').classList.remove('hidden'); renderLocations(); }
    if (view === 'plans') { $('#view-plans').classList.remove('hidden'); enterPlans(); }
    if (view === 'settings') { $('#view-settings').classList.remove('hidden'); loadReportStatus(); }
    if (view === 'home') { $('#view-home').classList.remove('hidden'); renderHome(); }
    if (view === 'shopping') { $('#view-shopping').classList.remove('hidden'); renderShopping(); }
    if (view === 'tools') $('#view-tools').classList.remove('hidden');
    if (view === 'menu') { $('#view-menu').classList.remove('hidden'); enterMenu(); }
    if (view === 'study') { $('#view-study').classList.remove('hidden'); enterStudy(); }
    if (view === 'work') { $('#view-work').classList.remove('hidden'); enterWork(); }
  }
  // ---------- 每周菜单 ----------
  const MEAL_NAMES = { breakfast: '早', lunch: '午', dinner: '晚' };
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const menuState = { start: null, week: null };
  const pad2 = n => String(n).padStart(2, '0');
  // 本地日期运算（不用 toISOString，避免时区差一天）
  const fmtLocalDate = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseLocalDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDaysStr = (s, n) => { const d = parseLocalDate(s); d.setDate(d.getDate() + n); return fmtLocalDate(d); };
  const todayStr = () => fmtLocalDate(new Date());
  function mondayOf(s) { const d = parseLocalDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return fmtLocalDate(d); }
  const mdLabel = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

  function renderMenuWeek() {
    const w = menuState.week;
    if (!w) return;
    const today = todayStr();
    $('#menu-range').innerHTML = `${mdLabel(w.start)} – ${mdLabel(w.end)}${w.start === mondayOf(today) ? ' <span class="badge menu-cur">本周</span>' : ''}`;
    $('#menu-body').innerHTML = MenuCal.render(w, today);
  }
  let menuSeq = 0;
  async function loadMenuWeek(start) {
    const seq = ++menuSeq;
    try {
      const week = await api('/api/menu/week?start=' + encodeURIComponent(start));
      if (seq !== menuSeq) return;  // 已有更新的请求，丢弃过期响应
      menuState.week = week; menuState.start = week.start;
      renderMenuWeek();
    } catch (err) { if (seq === menuSeq) toast(err.message); }
  }
  function enterMenu() { loadMenuWeek(menuState.start || mondayOf(todayStr())); }
  $('#menu-prev').addEventListener('click', () => loadMenuWeek(addDaysStr(menuState.start || mondayOf(todayStr()), -7)));
  $('#menu-next').addEventListener('click', () => loadMenuWeek(addDaysStr(menuState.start || mondayOf(todayStr()), 7)));
  $('#menu-today').addEventListener('click', () => loadMenuWeek(mondayOf(todayStr())));
  $('#menu-body').addEventListener('click', e => {
    const b = e.target.closest('.mc-entry');
    if (b) openMealEditor(b.dataset.date, b.dataset.meal);
  });

  // 单餐编辑弹层
  const mealEdit = { date: null, meal: null, saving: false, items: null, session: 0 };
  function ingHtml(g = {}) {
    return `<div class="ing-row">
      <input class="ing-name" placeholder="食材" autocomplete="off" value="${esc(g.name || '')}" data-item-id="${g.item_id != null ? esc(g.item_id) : ''}">
      <input class="ing-qty" inputmode="decimal" placeholder="数量" autocomplete="off" value="${g.quantity != null ? esc(g.quantity) : ''}">
      <input class="ing-unit" placeholder="单位" autocomplete="off" value="${esc(g.unit || '')}">
      <button type="button" class="btn small ing-del" title="删除食材" aria-label="删除食材">×</button>
    </div>`;
  }
  function dishHtml(d = {}) {
    return `<div class="dish-block">
      <div class="dish-head">
        <input class="dish-name" placeholder="菜名" autocomplete="off" value="${esc(d.name || '')}">
        <button type="button" class="btn small danger dish-del">删除菜</button>
      </div>
      <div class="ing-list">${(d.ingredients || []).map(ingHtml).join('')}</div>
      <button type="button" class="btn small ing-add">＋ 食材</button>
    </div>`;
  }
  function openMealEditor(date, meal) {
    mealEdit.date = date; mealEdit.meal = meal; mealEdit.saving = false;
    const day = menuState.week && menuState.week.days.find(d => d.date === date);
    const dishes = (day && day.meals[meal]) || [];
    $('#me-title').textContent = `${WEEKDAYS[parseLocalDate(date).getDay()]} ${mdLabel(date)} ${MEAL_NAMES[meal]}餐`;
    $('#me-list').innerHTML = (dishes.length ? dishes : [{}]).map(dishHtml).join('');
    hideSug();
    // 食材联想：本次编辑会话内缓存完整物品列表（state.items 只是当前筛选结果）；失败则静默跳过
    const session = ++mealEdit.session;
    mealEdit.items = null;
    api('/api/items').then(all => { if (session === mealEdit.session && Array.isArray(all)) mealEdit.items = all; }).catch(() => {});
    $('#menu-editor').classList.remove('hidden');
  }
  function closeMealEditor() { hideSug(); mealEdit.session++; $('#menu-editor').classList.add('hidden'); }

  // 联想列表（共享一个浮层，绝对定位于输入框下方）
  const sug = { input: null, seq: 0 };
  function hideSug() {
    sug.input = null; sug.seq++;
    const el = $('#me-sug'); if (el) el.remove();
  }
  function showSug(input, options) {  // options: [{ label, sub, pick }]
    const old = $('#me-sug'); if (old) old.remove();
    sug.input = input;
    if (!options.length) return;
    const box = $('#menu-editor .sheet-scroll');
    const el = document.createElement('div');
    el.id = 'me-sug'; el.className = 'sug-list';
    el.innerHTML = options.map((o, i) => `<button type="button" class="sug-item" data-i="${i}">${esc(o.label)}${o.sub ? `<span class="sug-sub">${esc(o.sub)}</span>` : ''}</button>`).join('');
    const ir = input.getBoundingClientRect(), br = box.getBoundingClientRect();
    el.style.top = (ir.bottom - br.top + box.scrollTop + 2) + 'px';
    el.style.left = Math.max(0, ir.left - br.left + box.scrollLeft) + 'px';
    el.style.width = Math.max(ir.width, 160) + 'px';
    // mousedown 只阻止默认行为（输入框保持焦点）；真正的选取放在 click 里，避免手机上点穿
    el.addEventListener('mousedown', e => { if (e.target.closest('.sug-item')) e.preventDefault(); });
    el.addEventListener('click', e => {
      const b = e.target.closest('.sug-item'); if (!b) return;
      const o = options[Number(b.dataset.i)];
      hideSug();
      o.pick();
    });
    box.appendChild(el);
  }
  document.addEventListener('click', e => {
    if (!sug.input) return;
    if (e.target === sug.input || e.target.closest('#me-sug')) return;
    hideSug();
  });
  let dishSugTimer = null;
  $('#me-list').addEventListener('input', e => {
    const t = e.target;
    if (t.classList.contains('ing-name')) {
      t.dataset.itemId = '';  // 手动改名即清除已关联的物品
      const q = t.value.trim().toLowerCase();
      const items = mealEdit.items;
      if (!q || !items) { hideSug(); return; }
      const seen = new Set(), opts = [];
      for (const it of items) {
        if (opts.length >= 6) break;
        if (!String(it.name || '').toLowerCase().includes(q) || seen.has(it.id)) continue;
        seen.add(it.id);
        opts.push({ label: it.name, sub: '', pick: () => { t.value = it.name; t.dataset.itemId = String(it.id); } });
      }
      showSug(t, opts);
    } else if (t.classList.contains('dish-name')) {
      clearTimeout(dishSugTimer);
      const q = t.value.trim();
      if (!q) { hideSug(); return; }
      const seq = ++sug.seq;
      dishSugTimer = setTimeout(async () => {
        let list;
        try { list = await api('/api/menu/suggest?q=' + encodeURIComponent(q)); } catch { return; }
        if (seq !== sug.seq || !t.isConnected || t.value.trim() !== q || !Array.isArray(list)) return;
        showSug(t, list.slice(0, 8).map(d => ({
          label: d.name,
          sub: (d.ingredients || []).map(g => g.name).join('、'),
          pick: () => {
            t.value = d.name;
            const block = t.closest('.dish-block');
            const rows = $$('.ing-row', block);
            const blank = rows.every(r => !$('.ing-name', r).value.trim() && !$('.ing-qty', r).value.trim() && !$('.ing-unit', r).value.trim());
            if (blank && (d.ingredients || []).length) $('.ing-list', block).innerHTML = d.ingredients.map(ingHtml).join('');
          },
        })));
      }, 250);
    }
  });
  $('#me-cancel').addEventListener('click', closeMealEditor);
  $('#menu-editor .sheet-backdrop').addEventListener('click', closeMealEditor);
  $('#me-add').addEventListener('click', () => {
    $('#me-list').insertAdjacentHTML('beforeend', dishHtml());
    const names = $$('#me-list .dish-name'); names[names.length - 1].focus();
  });
  $('#me-list').addEventListener('click', e => {
    const block = e.target.closest('.dish-block');
    if (!block) return;
    if (e.target.closest('.dish-del')) block.remove();
    else if (e.target.closest('.ing-del')) e.target.closest('.ing-row').remove();
    else if (e.target.closest('.ing-add')) {
      $('.ing-list', block).insertAdjacentHTML('beforeend', ingHtml());
      const names = $$('.ing-name', block); names[names.length - 1].focus();
    }
  });
  $('#me-save').addEventListener('click', async () => {
    if (mealEdit.saving) return;
    const orphan = $$('#me-list .dish-block').some(b => !$('.dish-name', b).value.trim() && $$('.ing-name', b).some(i => i.value.trim()));
    if (orphan) { toast('请填写菜名'); return; }
    const dishes = $$('#me-list .dish-block').map(b => ({
      name: $('.dish-name', b).value,
      ingredients: $$('.ing-row', b).map(r => ({
        name: $('.ing-name', r).value,
        item_id: Number($('.ing-name', r).dataset.itemId) || null,
        quantity: $('.ing-qty', r).value.trim(),
        unit: $('.ing-unit', r).value,
      })),
    }));
    mealEdit.saving = true;
    try {
      await postJson('/api/menu/meal', { date: mealEdit.date, meal: mealEdit.meal, dishes }, 'PUT');
    } catch (err) { mealEdit.saving = false; toast(err.message); return; }
    mealEdit.saving = false;
    closeMealEditor(); toast('已保存');
    await loadMenuWeek(menuState.start);
  });
  // 按菜单生成采购：先预览、勾选确认，再加入购物清单
  const purchase = { lines: [], busy: false };
  const PURCHASE_GROUPS = [
    { key: 'need', title: '需要买', checked: true, disabled: false },
    { key: 'enough', title: '库存里有，默认够用', checked: false, disabled: false },
    { key: 'exists', title: '清单里已有', checked: false, disabled: true },
  ];
  function purchaseRowHtml(l, idx, g) {
    const amount = l.kind === 'servings' ? `${l.servings} 份` : `${fmtQty(l.quantity)}${esc(l.unit || '')}`;
    const stock = l.stock ? `库存 ${fmtQty(l.stock.quantity)}${esc(l.stock.unit || '')}` : '库存没有';
    const dishes = (l.dishes || []).map(d => esc(d.name) + (d.count > 1 ? '×' + d.count : '')).join('、');
    return `<div class="pc-row${g.disabled ? ' disabled' : ''}" data-i="${idx}">
      <input type="checkbox" class="pc-ck" ${g.checked ? 'checked' : ''} ${g.disabled ? 'disabled' : ''} aria-label="勾选">
      <div class="pc-main">
        <input class="pc-name" value="${esc(l.name)}" ${g.disabled ? 'disabled' : ''}>
        <div class="pc-meta">${amount} · ${stock}${dishes ? ' · ' + dishes : ''}</div>
      </div>
    </div>`;
  }
  function updatePurchaseOk() {
    $('#pc-ok').disabled = purchase.busy || !$$('#pc-list .pc-row:not(.disabled) .pc-ck:checked').length;
  }
  function closePurchase() { $('#menu-purchase-sheet').classList.add('hidden'); }
  $('#menu-purchase').addEventListener('click', async () => {
    if (purchase.busy) return;
    purchase.busy = true;
    let r;
    try { r = await postJson('/api/menu/purchase/preview', { start: menuState.start }); }
    catch (err) { purchase.busy = false; toast(err.message); return; }
    purchase.busy = false;
    if (!r || !PURCHASE_GROUPS.some(g => (r[g.key] || []).length)) {
      const hasDish = menuState.week && menuState.week.days.some(d => Object.values(d.meals || {}).some(m => (m || []).length));
      toast(hasDish ? '本周的菜还没有填写食材' : '本周还没有菜单');
      return;
    }
    purchase.lines = [];
    $('#pc-list').innerHTML = PURCHASE_GROUPS.map(g => {
      const rows = r[g.key] || [];
      if (!rows.length) return '';
      return `<h3 class="pc-group">${g.title}</h3>` + rows.map(l => { purchase.lines.push(l); return purchaseRowHtml(l, purchase.lines.length - 1, g); }).join('');
    }).join('');
    updatePurchaseOk();
    $('#menu-purchase-sheet').classList.remove('hidden');
  });
  $('#pc-list').addEventListener('change', updatePurchaseOk);
  $('#pc-cancel').addEventListener('click', closePurchase);
  $('#menu-purchase-sheet .sheet-backdrop').addEventListener('click', closePurchase);
  $('#pc-ok').addEventListener('click', async () => {
    if (purchase.busy) return;
    const lines = $$('#pc-list .pc-row:not(.disabled)').filter(row => $('.pc-ck', row).checked).map(row => ({
      name: $('.pc-name', row).value.trim(),
      note: purchase.lines[Number(row.dataset.i)].note,
    })).filter(l => l.name);
    if (!lines.length) { toast('没有勾选的项目'); return; }
    purchase.busy = true; updatePurchaseOk();
    try {
      const res = await postJson('/api/menu/purchase', { lines });
      purchase.busy = false;
      closePurchase();
      toast(`已加入 ${res.added} 项，跳过 ${res.skipped} 项已有`);
      renderShopping().catch(() => {});  // 顺带刷新底部导航的购物角标
    } catch (err) { purchase.busy = false; updatePurchaseOk(); toast(err.message); }
  });
  $('#tools-back').addEventListener('click', () => switchView('home'));
  $('#menu-back').addEventListener('click', () => switchView('tools'));
  $$('.tool-card').forEach(b => b.addEventListener('click', () => switchView(b.dataset.tool)));
  // 从其他页跳到物品页并打开某件物品
  async function openItemById(id) {
    switchView('items');
    let item = state.items.find(i => i.id === id);
    if (!item) { try { const all = await api('/api/items'); item = all.find(i => i.id === id); } catch {} }
    if (item) openEditor(item); else toast('物品不存在');
  }

  // ---------- 学习计划 ----------
  const study = { pane: 'day', date: null, month: null, member: null, members: [], plans: [], openPlan: null, planItems: [], daySeq: 0, monthSeq: 0, planSeq: 0, editing: null, saving: false };
  const dayLabel = s => `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日 ${WEEKDAYS[parseLocalDate(s).getDay()]}`;
  const daysInclusive = (a, b) => Math.round((parseLocalDate(b) - parseLocalDate(a)) / 86400000) + 1;
  const monthOf = s => s.slice(0, 7);
  const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
  const monthText = m => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
  const rangeText = (a, b) => `${a.slice(0, 4) === b.slice(0, 4) ? '' : a.slice(0, 4) + '/'}${mdLabel(a)} – ${a.slice(0, 4) === b.slice(0, 4) ? '' : b.slice(0, 4) + '/'}${mdLabel(b)}`;
  const memberName = id => (study.members.find(m => m.id === id) || {}).name || '';
  // 选中的成员记在这台设备上；隐私模式下 localStorage 可能抛错，忽略即可
  const savedMember = () => { try { return Number(localStorage.getItem('study_member')); } catch { return 0; } };
  const saveMember = id => { try { localStorage.setItem('study_member', String(id)); } catch { /* 忽略 */ } };

  let studyEnterSeq = 0;
  async function enterStudy() {
    study.date = todayStr();   // 每次进入都回到今天：打开就能看到今天要学什么
    if (!study.month) study.month = monthOf(todayStr());
    const seq = ++studyEnterSeq;
    try {
      const members = await api('/api/study/members');
      if (seq !== studyEnterSeq) return;
      if (!members.length) throw new Error('没有可用的成员');
      study.members = members;
      // 本机记住的成员已不存在（或没记过）时，回退到第一位
      study.member = (members.find(m => m.id === savedMember()) || members[0]).id;
    } catch (err) {
      if (seq !== studyEnterSeq) return;
      toast(err.message);
      // 加载失败：给一个重试入口，并清空面板，免得和成员对不上
      study.member = null;
      $('#sd-body').innerHTML = ''; $('#sm-body').innerHTML = ''; $('#sp-body').innerHTML = '';
      $('#study-members').innerHTML = '<button type="button" class="btn small" id="study-retry">加载失败，点此重试</button>';
      return;
    }
    renderStudyMembers();
    showStudyPane(study.pane);
  }
  function renderStudyMembers() {
    $('#study-members').innerHTML = study.members.map(m => `<button type="button" class="study-member${m.id === study.member ? ' active' : ''}" data-id="${m.id}">${esc(m.name)}</button>`).join('')
      + '<button type="button" class="btn small" id="study-rename">改名</button>';
  }
  $('#study-members').addEventListener('click', async e => {
    if (e.target.closest('#study-retry')) { enterStudy(); return; }
    if (e.target.closest('#study-rename')) {
      const r = await askText('给「' + memberName(study.member) + '」改名', { value: memberName(study.member), placeholder: '最长 20 字' });
      if (r == null || r === '') return;
      try {
        const saved = await postJson('/api/study/members/' + study.member, { name: r }, 'PUT');
        study.members = study.members.map(m => m.id === saved.id ? { ...m, name: saved.name } : m);  // 直接用返回值，不再多请求一次
        renderStudyMembers();
      } catch (err) { toast(err.message); }
      return;
    }
    const b = e.target.closest('.study-member');
    if (!b || Number(b.dataset.id) === study.member) return;
    study.member = Number(b.dataset.id);
    saveMember(study.member);
    study.openPlan = null;
    // 三个面板在路上的旧请求全部作废（不只是当前面板），再清掉上一位的内容，避免回包把别人的数据写回隐藏的面板
    study.daySeq++; study.monthSeq++; study.planSeq++;
    study.plans = []; study.planItems = [];
    $('#sd-body').innerHTML = ''; $('#sm-body').innerHTML = ''; $('#sp-body').innerHTML = '';
    renderStudyMembers();
    showStudyPane(study.pane);
  });

  function showStudyPane(p) {
    study.pane = p;
    $$('.study-tab').forEach(t => t.classList.toggle('active', t.dataset.pane === p));
    $$('.study-pane').forEach(el => el.classList.toggle('hidden', el.id !== 'study-' + p));
    if (p === 'day') loadStudyDay(study.date);
    else if (p === 'month') loadStudyMonth(study.month);
    else loadStudyPlans();
  }
  $$('.study-tab').forEach(t => t.addEventListener('click', () => showStudyPane(t.dataset.pane)));
  $('#study-back').addEventListener('click', () => switchView('tools'));

  // 今天
  async function loadStudyDay(date) {
    const seq = ++study.daySeq;
    study.date = date;
    $('#sd-label').innerHTML = esc(dayLabel(date)) + (date === todayStr() ? ' <span class="badge menu-cur">今天</span>' : '');
    try {
      const data = await api('/api/study/day?date=' + encodeURIComponent(date) + '&member=' + study.member);
      if (seq !== study.daySeq) return;
      renderStudyDay(data);
    } catch (err) {
      if (seq !== study.daySeq) return;
      $('#sd-body').innerHTML = '<p class="muted sd-empty">加载失败，请点「今天」或翻页重试。</p>';  // 不留旧日期的列表，避免和标签对不上
      toast(err.message);
    }
  }
  function renderStudyDay(d) {
    const rows = d.items.map(it => `
      <div class="sd-row${it.checked ? ' done' : ''}">
        <button type="button" class="sd-check" data-id="${it.id}" data-date="${esc(d.date)}" data-checked="${it.checked ? 1 : 0}" aria-label="${it.checked ? '取消完成' : '标记学完'}：${esc(it.name)}">${it.checked ? '✓' : ''}</button>
        <div class="sd-main">
          <div class="sd-name">${esc(it.name)}</div>
          <div class="sd-meta">第 ${it.dayIndex} 天 / 共 ${it.total} 天　已学 ${it.done} 天　${esc(rangeText(it.start_date, it.end_date))}</div>
          ${it.note ? `<div class="sd-note">${esc(it.note)}</div>` : ''}
          <div class="sd-meta">${esc(it.plan_name)}${it.missed > 0 ? ` <span class="sd-missed">已落下 ${it.missed} 天</span>` : ''}</div>
        </div>
      </div>`).join('');
    const later = d.upcoming.length ? `
      <h3 class="sd-sub">即将开始</h3>
      <div class="home-list">${d.upcoming.map(u => `<div class="home-row"><span class="nm">${esc(u.name)}</span><span class="meta">${esc(mdLabel(u.start_date))} 开始 · ${esc(u.plan_name)}</span></div>`).join('')}</div>` : '';
    $('#sd-body').innerHTML = (rows ? `<h3 class="sd-sub">这一天要学（${d.items.length} 项）</h3><div class="sd-list">${rows}</div>`
      : `<p class="muted sd-empty">这一天没有安排。到「大计划」里添加学习项吧。</p>`) + later;
  }
  $('#sd-body').addEventListener('click', async e => {
    const b = e.target.closest('.sd-check');
    if (!b || b.disabled) return;
    b.disabled = true;
    const date = b.dataset.date;  // 用这一行渲染时的日期，而不是可能已被翻页改掉的 study.date
    try {
      await postJson('/api/study/check', { item_id: Number(b.dataset.id), date, checked: b.dataset.checked !== '1' }, 'PUT');
      if (study.date === date) await loadStudyDay(date);
    } catch (err) { toast(err.message); b.disabled = false; }
  });
  $('#sd-prev').addEventListener('click', () => loadStudyDay(addDaysStr(study.date, -1)));
  $('#sd-next').addEventListener('click', () => loadStudyDay(addDaysStr(study.date, 1)));
  $('#sd-today').addEventListener('click', () => loadStudyDay(todayStr()));

  // 按月看
  async function loadStudyMonth(month) {
    const seq = ++study.monthSeq;
    study.month = month;
    $('#sm-label').innerHTML = esc(monthText(month)) + (month === monthOf(todayStr()) ? ' <span class="badge menu-cur">本月</span>' : '');
    try {
      const data = await api('/api/study/month?month=' + encodeURIComponent(month) + '&member=' + study.member);
      if (seq !== study.monthSeq) return;
      renderStudyMonth(data);
    } catch (err) { if (seq === study.monthSeq) toast(err.message); }
  }
  function renderStudyMonth(d) {
    const today = todayStr();
    const todayDay = monthOf(today) === d.month ? Number(today.slice(8)) : 0;
    $('#sm-body').innerHTML = d.items.length ? d.items.map(it => {
      const on = new Set(it.days), done = new Set(it.checked);
      let cells = '';
      for (let i = 1; i <= d.daysInMonth; i++) cells += `<span class="sm-cell${on.has(i) ? ' on' : ''}${done.has(i) ? ' done' : ''}${i === todayDay ? ' today' : ''}" title="${i}日">${i}</span>`;
      return `<div class="sm-item"><div class="sm-title"><b>${esc(it.name)}</b><span class="meta">${esc(it.plan_name)} · ${esc(rangeText(it.start_date, it.end_date))}</span></div><div class="sm-grid">${cells}</div></div>`;
    }).join('') : '<p class="muted sd-empty">这个月没有安排。</p>';
  }
  $('#sm-prev').addEventListener('click', () => loadStudyMonth(addMonths(study.month, -1)));
  $('#sm-next').addEventListener('click', () => loadStudyMonth(addMonths(study.month, 1)));
  $('#sm-today').addEventListener('click', () => loadStudyMonth(monthOf(todayStr())));

  // 大计划
  async function loadStudyPlans() {
    const seq = ++study.planSeq;
    try {
      const plans = await api('/api/study/plans?member=' + study.member);
      const items = study.openPlan && plans.some(p => p.id === study.openPlan) ? await api('/api/study/items?plan=' + study.openPlan) : [];
      if (seq !== study.planSeq) return;
      study.plans = plans; study.planItems = items;
      if (study.openPlan && !plans.some(p => p.id === study.openPlan)) study.openPlan = null;
      renderStudyPlans();
    } catch (err) { if (seq === study.planSeq) toast(err.message); }
  }
  function renderStudyPlans() {
    const plan = study.plans.find(p => p.id === study.openPlan);
    const itemRows = it => {
      const done = new Set(it.checked.filter(c => c >= it.start_date && c <= it.end_date)).size;
      const out = plan && (it.start_date < plan.start_date || it.end_date > plan.end_date);
      return `<div class="si-row">
        <div class="si-main"><div class="sd-name">${esc(it.name)}</div>
          <div class="sd-meta">${esc(rangeText(it.start_date, it.end_date))}　已学 ${done} / ${daysInclusive(it.start_date, it.end_date)} 天${out ? ' <span class="sd-missed">超出计划范围</span>' : ''}</div>
          ${it.note ? `<div class="sd-note">${esc(it.note)}</div>` : ''}</div>
        <button type="button" class="btn small" data-act="edit-item" data-id="${it.id}">编辑</button>
        <button type="button" class="btn small danger" data-act="del-item" data-id="${it.id}">删除</button>
      </div>`;
    };
    $('#sp-body').innerHTML = (study.plans.length ? study.plans.map(p => `
      <div class="sp-card${p.id === study.openPlan ? ' open' : ''}">
        <div class="sp-head" data-act="toggle" data-id="${p.id}">
          <div class="sp-info"><b>${esc(p.name)}</b><span class="meta">${esc(rangeText(p.start_date, p.end_date))} · ${p.item_count} 项</span></div>
          <button type="button" class="btn small" data-act="edit-plan" data-id="${p.id}">编辑</button>
          <button type="button" class="btn small danger" data-act="del-plan" data-id="${p.id}">删除</button>
        </div>
        ${p.id === study.openPlan ? `<div class="sp-items">${study.planItems.map(itemRows).join('') || '<p class="muted">还没有学习项。</p>'}
          <button type="button" class="btn block" data-act="add-item" data-id="${p.id}">＋ 添加学习项</button></div>` : ''}
      </div>`).join('') : '<p class="muted sd-empty">还没有大计划。先建一个，比如「2027 上半年」。</p>')
      + '<button type="button" class="btn primary block" data-act="add-plan">＋ 新建大计划</button>';
  }
  $('#sp-body').addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = Number(el.dataset.id);
    const gone = () => { toast('这一项已经不存在了'); loadStudyPlans(); };
    if (act === 'toggle') { study.openPlan = study.openPlan === id ? null : id; loadStudyPlans(); return; }
    if (act === 'add-plan') return openStudyEditor({ kind: 'plan' });
    if (act === 'edit-plan') { const row = study.plans.find(p => p.id === id); return row ? openStudyEditor({ kind: 'plan', row }) : gone(); }
    if (act === 'add-item') return openStudyEditor({ kind: 'item', planId: id });
    if (act === 'edit-item') { const row = study.planItems.find(i => i.id === id); return row ? openStudyEditor({ kind: 'item', planId: study.openPlan, row }) : gone(); }
    try {
      if (act === 'del-plan') {
        const p = study.plans.find(x => x.id === id);
        if (!p) return gone();
        if (!await askConfirm(`删除大计划「${p.name}」？会同时删除其下 ${p.item_count} 个学习项及全部勾选记录，无法恢复。`, { okText: '删除', danger: true })) return;
        await api('/api/study/plans/' + id, { method: 'DELETE' });
        if (study.openPlan === id) study.openPlan = null;
      } else if (act === 'del-item') {
        const it = study.planItems.find(x => x.id === id);
        if (!it) return gone();
        if (!await askConfirm(`删除学习项「${it.name}」？它的勾选记录也会一起删除。`, { okText: '删除', danger: true })) return;
        await api('/api/study/items/' + id, { method: 'DELETE' });
      } else return;
      loadStudyPlans();
    } catch (err) { toast(err.message); }
  });

  // 新建 / 编辑弹层（大计划和学习项共用）
  function openStudyEditor(ctx) {
    study.editing = ctx;
    const row = ctx.row || {};
    $('#se-title').textContent = (ctx.row ? '编辑' : '新建') + (ctx.kind === 'plan' ? '大计划' : '学习项');
    $('#se-name').value = row.name || '';
    $('#se-start').value = row.start_date || '';
    $('#se-end').value = row.end_date || '';
    $('#se-note').value = row.note || '';
    $('#se-note-wrap').classList.toggle('hidden', ctx.kind === 'plan');
    // 「谁的计划」只在大计划里出现；新建默认当前选中的成员，编辑默认它现在的归属
    $('#se-member-wrap').classList.toggle('hidden', ctx.kind !== 'plan');
    $('#se-member').innerHTML = study.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    $('#se-member').value = String(row.member_id || study.member);
    $('#se-err').textContent = '';
    $('#study-editor').classList.remove('hidden');
    setTimeout(() => $('#se-name').focus(), 50);
  }
  function closeStudyEditor() { if (study.saving) return; $('#study-editor').classList.add('hidden'); study.editing = null; }  // 保存进行中不允许关闭，避免重复提交
  $('#se-cancel').addEventListener('click', closeStudyEditor);
  $('#study-editor .sheet-backdrop').addEventListener('click', closeStudyEditor);
  $('#se-form').addEventListener('submit', async e => {
    e.preventDefault();
    const ctx = study.editing;
    if (!ctx || study.saving) return;
    const body = { name: $('#se-name').value.trim(), start_date: $('#se-start').value, end_date: $('#se-end').value };
    if (!body.name) { $('#se-err').textContent = '名称不能为空'; return; }
    if (!body.start_date || !body.end_date) { $('#se-err').textContent = '请选择开始和结束日期'; return; }
    if (body.end_date < body.start_date) { $('#se-err').textContent = '结束日期不能早于开始日期'; return; }
    if (ctx.kind === 'item') { body.plan_id = ctx.planId; body.note = $('#se-note').value.trim(); }
    else body.member_id = Number($('#se-member').value);
    const url = '/api/study/' + (ctx.kind === 'plan' ? 'plans' : 'items') + (ctx.row ? '/' + ctx.row.id : '');
    study.saving = true; $('#se-save').disabled = true;
    try {
      await postJson(url, body, ctx.row ? 'PUT' : 'POST');
      study.saving = false;
      closeStudyEditor();
      if (ctx.kind === 'plan' && (!ctx.row || body.member_id !== study.member)) study.openPlan = null;
      // 计划转给了另一位（或新建时选了另一位）：它会从当前列表消失，给个提示
      if (ctx.kind === 'plan' && body.member_id !== study.member) toast(`已${ctx.row ? '转给' : '建给'}「${memberName(body.member_id)}」`);
      loadStudyPlans();
    } catch (err) { $('#se-err').textContent = err.message; }
    finally { study.saving = false; $('#se-save').disabled = false; }
  });

  // ---------- 每周工作 ----------
  const work = { person: null, people: [], start: null, target: null, addDate: null, week: null, weekSeq: 0, enterSeq: 0, editing: null, saving: false, adding: false,
    tab: 'records', todoFilter: 'open', todos: [], todoSeq: 0, todoAdding: false, todoEditing: null, todoSaving: false, focusAdd: false };
  // 选中的人员记在这台设备上；隐私模式下 localStorage 可能抛错，忽略即可
  const savedPerson = () => { try { return Number(localStorage.getItem('work_person')); } catch { return 0; } };
  const savePerson = id => { try { localStorage.setItem('work_person', String(id)); } catch { /* 忽略 */ } };
  const personName = id => (work.people.find(p => p.id === id) || {}).name || '';
  const findWorkEntry = id => work.week && work.week.days.flatMap(d => d.entries).find(e => e.id === id);

  async function enterWork() {
    const seq = ++work.enterSeq;
    work.weekSeq++;   // 在途的旧请求全部作废
    work.todoSeq++;
    work.addDate = null;
    work.todos = [];
    showWorkTabUi('records');   // 每次进入都回到「记录」标签
    $('#td-body').innerHTML = '';
    $('#wk-body').innerHTML = '';   // 先清掉上次离开时的内容，避免人员加载期间显示旧的一周还能点
    work.week = null;
    try {
      const people = await api('/api/work/people');
      if (seq !== work.enterSeq) return;
      if (!people.length) throw new Error('没有可用的人员');
      work.people = people;
      // 本机记住的人员已不存在（或没记过）时，回退到第一位
      work.person = (people.find(p => p.id === savedPerson()) || people[0]).id;
    } catch (err) {
      if (seq !== work.enterSeq) return;
      toast(err.message);
      work.person = null;
      $('#wk-body').innerHTML = '';
      $('#work-people').classList.remove('hidden');
      $('#work-people').innerHTML = '<button type="button" class="btn small" id="work-retry">加载失败，点此重试</button>';
      return;
    }
    renderWorkPeople();
    loadReportStatus();                   // 「整理成正式周报」按钮是否可用
    loadWorkWeek(mondayOf(todayStr()));   // 每次进入都回到本周
  }
  // 只有两个人以上才显示切换条
  function renderWorkPeople() {
    const box = $('#work-people');
    box.classList.toggle('hidden', work.people.length < 2);
    box.innerHTML = work.people.map(p => `<button type="button" class="study-member${p.id === work.person ? ' active' : ''}" data-id="${p.id}">${esc(p.name)}</button>`).join('');
  }
  $('#work-people').addEventListener('click', e => {
    if (e.target.closest('#work-retry')) { enterWork(); return; }
    const b = e.target.closest('.study-member');
    if (!b || Number(b.dataset.id) === work.person) return;
    switchWorkPerson(Number(b.dataset.id));
  });
  function switchWorkPerson(id) {
    work.person = id; savePerson(id);
    work.weekSeq++; work.week = null; work.addDate = null;
    work.todoSeq++; work.todos = [];
    $('#wk-body').innerHTML = '';   // 先清掉上一位的内容，再加载
    $('#td-body').innerHTML = '';
    renderWorkPeople();
    if (work.tab === 'todos') loadWorkTodos();
    else loadWorkWeek(work.start || mondayOf(todayStr()), { keepTarget: true });
  }

  function renderWorkHead() {
    const end = addDaysStr(work.start, 6);
    $('#wk-label').innerHTML = `${esc(mdLabel(work.start))} – ${esc(mdLabel(end))}${work.start === mondayOf(todayStr()) ? ' <span class="badge menu-cur">本周</span>' : ''}`;
    $('#wk-target').textContent = `记到：${dayLabel(work.target)}（点下面某一天的标题可以改）`;
  }
  async function loadWorkWeek(start, { keepTarget = false } = {}) {
    const seq = ++work.weekSeq;
    work.start = start;
    const inWeek = d => d >= start && d <= addDaysStr(start, 6);
    if (!keepTarget || !work.target || !inWeek(work.target)) work.target = inWeek(todayStr()) ? todayStr() : start;
    renderWorkHead();
    try {
      const week = await api(`/api/work/week?start=${encodeURIComponent(start)}&person=${work.person}`);
      if (seq !== work.weekSeq) return;   // 已有更新的请求，丢弃过期响应
      work.week = week;
      // 翻页加载期间屏幕上还是上一周，用户可能点了旧一周的标题；新一周回来时目标日若不在本周内就校正，免得记到看不见的那一天
      if (!inWeek(work.target)) { work.target = inWeek(todayStr()) ? todayStr() : start; renderWorkHead(); }
      renderWorkWeek();
    } catch (err) {
      if (seq !== work.weekSeq) return;
      work.week = null;
      $('#wk-body').innerHTML = '<p class="muted sd-empty">加载失败，请翻页或点「本周」重试。</p>';   // 不留旧内容，免得和标题对不上
      toast(err.message);
    }
  }
  function workEntryHtml(e) {
    return `<div class="wk-entry">
      <span class="wk-dot">·</span>
      <button type="button" class="wk-txt" data-act="edit" data-id="${e.id}">${esc(e.text)}</button>
      <button type="button" class="wk-del" data-act="del" data-id="${e.id}" title="删除" aria-label="删除：${esc(e.text)}">×</button>
    </div>`;
  }
  function renderWorkWeek() {
    const today = todayStr();
    // 重绘会丢掉行内输入框，先记下里面还没提交的文字，画完再放回去
    const oldInput = $('#wk-body .wk-day-input');
    const keepText = oldInput ? oldInput.value : '', hadFocus = !!oldInput && document.activeElement === oldInput;
    $('#wk-body').innerHTML = work.week.days.map(d => `
      <div class="wk-day${d.date === work.target ? ' target' : ''}${d.date === today ? ' today' : ''}">
        <div class="wk-day-bar">
          <button type="button" class="wk-day-head" data-date="${esc(d.date)}">${WEEKDAYS[parseLocalDate(d.date).getDay()]} ${esc(mdLabel(d.date))}${d.date === today ? ' <span class="badge menu-cur">今天</span>' : ''}</button>
          <button type="button" class="wk-day-plus${d.date === work.addDate ? ' on' : ''}" data-act="day-add" data-date="${esc(d.date)}" title="在这一天记一条" aria-label="在${esc(mdLabel(d.date))}记一条">${d.date === work.addDate ? '−' : '＋'}</button>
        </div>
        <div class="wk-list">${d.entries.map(workEntryHtml).join('') || '<div class="wk-empty">—</div>'}</div>
        ${d.date === work.addDate ? `<form class="wk-day-add" data-date="${esc(d.date)}"><input class="wk-day-input" maxlength="200" placeholder="在这一天记一条…" autocomplete="off" enterkeyhint="send"><button type="submit" class="btn small primary">记</button></form>` : ''}
      </div>`).join('');
    const input = $('#wk-body .wk-day-input');
    // 只在用户刚点了「＋」，或者重绘前焦点本来就在行内输入框里时才聚焦；
    // 否则（比如用户正在顶部输入框打字时后台重绘）不能抢走焦点
    if (input) { input.value = keepText; if (hadFocus || work.focusAdd) input.focus(); }
    work.focusAdd = false;
  }
  $('#wk-prev').addEventListener('click', () => { if (work.person != null) { work.addDate = null; loadWorkWeek(addDaysStr(work.start, -7)); } });
  $('#wk-next').addEventListener('click', () => { if (work.person != null) { work.addDate = null; loadWorkWeek(addDaysStr(work.start, 7)); } });
  $('#wk-today').addEventListener('click', () => { if (work.person != null) { work.addDate = null; loadWorkWeek(mondayOf(todayStr())); } });
  $('#work-back').addEventListener('click', () => switchView('tools'));

  // 打字记录（顶部输入框，记到「记到：…」那一天；只记「已做」，待办在「待办」标签里添加）
  $('#wk-form').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('#wk-text').value.trim();
    if (!text) return;
    if (work.person == null) { toast('人员还没有加载出来，请稍候或点上面的重试'); return; }
    if (work.adding) return;
    work.adding = true;
    try {
      await postJson('/api/work/entries', { person_id: work.person, date: work.target, text });
      $('#wk-text').value = '';
      await loadWorkWeek(work.start, { keepTarget: true });
    } catch (err) { toast(err.message); }
    finally { work.adding = false; $('#wk-text').focus(); }
  });
  // 每一天自己的输入行：记到这一天（不改顶部的「记到」），记完保持展开方便连续记
  $('#wk-body').addEventListener('submit', async e => {
    const form = e.target.closest('.wk-day-add');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('.wk-day-input');
    const text = input.value.trim();
    if (!text) return;
    if (work.person == null) { toast('人员还没有加载出来，请稍候或点上面的重试'); return; }
    if (work.adding) return;
    work.adding = true;
    const date = form.dataset.date;
    try {
      await postJson('/api/work/entries', { person_id: work.person, date, text });
      input.value = '';   // 重绘时会取这里的值，所以先清空
      await loadWorkWeek(work.start, { keepTarget: true });
    } catch (err) { toast(err.message); }
    finally { work.adding = false; const again = $('#wk-body .wk-day-input'); if (again) again.focus(); }
  });
  // 一段口述文字记成多条（语音录入调用），带「撤销」；出错时抛出，由调用方提示
  // snap：点麦克风那一刻的 {person, date}。录音和识别要几秒，期间用户可能切人员或翻周，结果仍记到当时选好的地方
  async function addWorkEntries(text, note = '', snap = null) {
    const person = snap ? snap.person : work.person;
    if (person == null) throw new Error('人员还没有加载出来');
    const date = snap ? snap.date : work.target;
    const r = await postJson('/api/work/entries/batch', { person_id: person, date, text });
    if (person === work.person) await loadWorkWeek(work.start, { keepTarget: true });
    const who = person === work.person ? '' : `（记在「${personName(person)}」名下）`;
    toast(`已记录 ${r.count} 条${r.truncated ? '（只记了前 5 条，后面的没有记）' : ''}${note}${who}`, 7000, {
      label: '撤销',
      onClick: async () => {
        try { await postJson('/api/work/entries/delete', { ids: r.ids }); toast('已撤销'); if (person === work.person) loadWorkWeek(work.start, { keepTarget: true }); }
        catch (err) { toast(err.message); }
      },
    });
  }
  // 周内的点击：改目标日、展开某天的输入行、删除（带撤销）、编辑
  $('#wk-body').addEventListener('click', async e => {
    const head = e.target.closest('.wk-day-head');
    if (head) { work.target = head.dataset.date; renderWorkHead(); renderWorkWeek(); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'day-add') {
      work.addDate = work.addDate === el.dataset.date ? null : el.dataset.date;   // 再点一次收起；同一时间只展开一天
      work.focusAdd = work.addDate !== null;   // 刚展开才聚焦输入框
      renderWorkWeek();
      return;
    }
    const id = Number(el.dataset.id);
    const entry = findWorkEntry(id);
    if (!entry) { toast('这条记录已经不存在了'); loadWorkWeek(work.start, { keepTarget: true }); return; }
    if (act === 'edit') { openWorkEditor(entry); return; }
    if (act === 'del') {
      if (el.disabled) return;
      el.disabled = true;
      const person = work.person, saved = { date: entry.date, text: entry.text };   // 撤销时用被删那一刻的人员、日期和文字
      try {
        await api('/api/work/entries/' + id, { method: 'DELETE' });
        await loadWorkWeek(work.start, { keepTarget: true });
        toast('已删除', 7000, {
          label: '撤销',
          onClick: async () => {
            try {
              await postJson('/api/work/entries', { person_id: person, date: saved.date, text: saved.text });   // 重新创建，会排在当天末尾
              toast('已恢复');
              if (person === work.person) loadWorkWeek(work.start, { keepTarget: true });
            } catch (err) { toast(err.message); }
          },
        });
      } catch (err) { toast(err.message); el.disabled = false; loadWorkWeek(work.start, { keepTarget: true }); }   // 失败也刷新：可能已在别的设备上删掉了，别让旧条目留在页面上
    }
  });

  // 编辑一条记录
  function openWorkEditor(entry) {
    work.editing = entry.id; work.saving = false;
    $('#we-text').value = entry.text; $('#we-date').value = entry.date;
    $('#we-err').textContent = '';
    $('#work-editor').classList.remove('hidden');
  }
  function closeWorkEditor() { if (work.saving) return; $('#work-editor').classList.add('hidden'); work.editing = null; }   // 保存中不允许关闭，避免重复提交
  $('#we-cancel').addEventListener('click', closeWorkEditor);
  $('#work-editor .sheet-backdrop').addEventListener('click', closeWorkEditor);
  $('#we-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = work.editing;
    if (id == null || work.saving) return;
    const body = { text: $('#we-text').value.trim(), date: $('#we-date').value };
    if (!body.text) { $('#we-err').textContent = '内容不能为空'; return; }
    if (!body.date) { $('#we-err').textContent = '请选择日期'; return; }
    work.saving = true; $('#we-save').disabled = true;
    try {
      await postJson('/api/work/entries/' + id, body, 'PUT');
      work.saving = false;
      closeWorkEditor();
      loadWorkWeek(work.start, { keepTarget: true });
    } catch (err) { $('#we-err').textContent = err.message; }
    finally { work.saving = false; $('#we-save').disabled = false; }
  });
  $('#we-del').addEventListener('click', async () => {
    const id = work.editing;
    if (id == null || work.saving) return;
    if (!await askConfirm('删除这条记录？', { okText: '删除', danger: true })) return;
    if (work.editing !== id || work.saving) return;   // 等确认期间编辑弹层可能已经关了或在保存
    work.saving = true; $('#we-save').disabled = true; $('#we-del').disabled = true;   // 删除期间不能再保存、再删或关闭
    try {
      await api('/api/work/entries/' + id, { method: 'DELETE' });
      work.saving = false;
      closeWorkEditor();
      loadWorkWeek(work.start, { keepTarget: true });
    } catch (err) { $('#we-err').textContent = err.message; }
    finally { work.saving = false; $('#we-save').disabled = false; $('#we-del').disabled = false; }
  });

  // ---- 待办标签 ----
  // 标签切换：只负责显示哪个面板；待办标签才会去请求待办
  function showWorkTabUi(tab) {
    work.tab = tab;
    $$('.wk-tab').forEach(b => b.classList.toggle('active', b.dataset.wtab === tab));
    $('#wk-records').classList.toggle('hidden', tab !== 'records');
    $('#wk-todos').classList.toggle('hidden', tab !== 'todos');
  }
  $$('.wk-tab').forEach(b => b.addEventListener('click', () => {
    if (work.person == null) return;   // 人员没加载出来时先别切（上面有重试按钮）
    showWorkTabUi(b.dataset.wtab);
    if (b.dataset.wtab === 'todos') loadWorkTodos();
    // 回到记录：如果周数据被清掉了（比如在待办标签里切了人员）就重新加载，否则会是一片空白
    else if (!work.week) loadWorkWeek(work.start || mondayOf(todayStr()), { keepTarget: true });
  }));
  $$('.td-filter').forEach(b => b.addEventListener('click', () => {
    if (work.person == null) return;
    setTodoFilter(b.dataset.filter);
    loadWorkTodos();
  }));
  function setTodoFilter(f) {
    work.todoFilter = f;
    $$('.td-filter').forEach(x => x.classList.toggle('active', x.dataset.filter === f));
  }
  async function loadWorkTodos() {
    if (work.person == null) return;
    const seq = ++work.todoSeq;
    try {
      const todos = await api(`/api/work/todos?person=${work.person}&filter=${work.todoFilter}`);
      if (seq !== work.todoSeq) return;   // 已有更新的请求，丢弃过期响应
      work.todos = todos;
      renderWorkTodos();
    } catch (err) {
      if (seq !== work.todoSeq) return;
      work.todos = [];
      $('#td-body').innerHTML = '<p class="muted sd-empty">加载失败，请切换一下标签或范围重试。</p>';   // 不留旧内容
      toast(err.message);
    }
  }
  const findWorkTodo = id => work.todos.find(t => t.id === id);
  function todoRowHtml(t, today) {
    const overdue = !t.done && t.due_date && t.due_date < today;
    const label = t.done ? `完成于 ${esc(mdLabel(t.done_date))}`
      : t.due_date ? `${esc(mdLabel(t.due_date))}${overdue ? ' <span class="td-overdue">已过期</span>' : ''}` : '<span class="td-nodate">没选日期</span>';
    return `<div class="wk-entry td-row${t.done ? ' done' : ''}">
      <button type="button" class="wk-check" data-act="check" data-id="${t.id}" aria-label="${t.done ? '取消完成' : '标记完成'}：${esc(t.text)}">${t.done ? '✓' : ''}</button>
      <button type="button" class="wk-txt" data-act="edit" data-id="${t.id}">${esc(t.text)}<span class="td-meta">${label}</span></button>
      ${!t.done && t.due_date ? `<button type="button" class="btn small" data-act="next" data-id="${t.id}">挪到下周</button>` : ''}
      <button type="button" class="wk-del" data-act="del" data-id="${t.id}" title="删除" aria-label="删除：${esc(t.text)}">×</button>
    </div>`;
  }
  function renderWorkTodos() {
    const today = todayStr();
    if (!work.todos.length) {
      $('#td-body').innerHTML = `<p class="muted sd-empty">${work.todoFilter === 'done' ? '还没有完成的待办。' : work.todoFilter === 'open' ? '没有没做完的待办。在上面添加一条吧。' : '还没有待办。'}</p>`;
      return;
    }
    $('#td-body').innerHTML = `<div class="td-list">${work.todos.map(t => todoRowHtml(t, today)).join('')}</div>`;
  }

  // 添加：日期可以不选
  $('#td-form').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('#td-text').value.trim();
    if (!text) return;
    if (work.person == null) { toast('人员还没有加载出来，请稍候或点上面的重试'); return; }
    if (work.todoAdding) return;
    work.todoAdding = true;
    try {
      await postJson('/api/work/todos', { person_id: work.person, text, due_date: $('#td-due').value || '' });
      $('#td-text').value = ''; $('#td-due').value = '';
      if (work.todoFilter === 'done') setTodoFilter('open');   // 新加的待办没完成，在「已完成」里看不到，切回「还没做」
      await loadWorkTodos();
    } catch (err) { toast(err.message); }
    finally { work.todoAdding = false; $('#td-text').focus(); }
  });

  // 列表里的操作：勾选 / 取消、挪到下周、编辑、删除（带撤销）
  $('#td-body').addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = Number(el.dataset.id);
    const t = findWorkTodo(id);
    if (!t) { toast('这条待办已经不存在了'); loadWorkTodos(); return; }
    if (act === 'edit') { openTodoEditor(t); return; }
    if (el.disabled) return;
    el.disabled = true;
    const person = work.person;
    try {
      if (act === 'check') {
        await postJson('/api/work/todos/' + id, t.done ? { done: false } : { done: true, done_date: todayStr() }, 'PUT');
      } else if (act === 'next') {
        // 新日期 = 「原日期和今天中较晚的那天」所在周的下一周周一（日期字符串可以直接比较大小）
        const base = t.due_date > todayStr() ? t.due_date : todayStr();
        await postJson('/api/work/todos/' + id, { due_date: addDaysStr(mondayOf(base), 7) }, 'PUT');
        toast('已挪到下周一');
      } else if (act === 'del') {
        const saved = { text: t.text, due_date: t.due_date, done: t.done, done_date: t.done_date };   // 撤销时原样恢复
        await api('/api/work/todos/' + id, { method: 'DELETE' });
        toast('已删除', 7000, {
          label: '撤销',
          onClick: async () => {
            try {
              await postJson('/api/work/todos', { person_id: person, ...saved });
              toast('已恢复');
              if (person === work.person && work.tab === 'todos') loadWorkTodos();
            } catch (err) { toast(err.message); }
          },
        });
      }
      await loadWorkTodos();
    } catch (err) { toast(err.message); el.disabled = false; loadWorkTodos(); }   // 失败也刷新：可能已在别的设备上变了
  });

  // 编辑一条待办：文字、日期（可以清除）、删除
  function openTodoEditor(t) {
    work.todoEditing = t.id; work.todoSaving = false;
    $('#td-edit-text').value = t.text; $('#td-edit-due').value = t.due_date || '';
    $('#td-edit-err').textContent = '';
    $('#todo-editor').classList.remove('hidden');
  }
  function closeTodoEditor() { if (work.todoSaving) return; $('#todo-editor').classList.add('hidden'); work.todoEditing = null; }   // 保存或删除中不允许关闭
  $('#td-edit-cancel').addEventListener('click', closeTodoEditor);
  $('#todo-editor .sheet-backdrop').addEventListener('click', closeTodoEditor);
  $('#td-clear-due').addEventListener('click', () => { $('#td-edit-due').value = ''; });
  $('#td-edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = work.todoEditing;
    if (id == null || work.todoSaving) return;
    const text = $('#td-edit-text').value.trim();
    if (!text) { $('#td-edit-err').textContent = '内容不能为空'; return; }
    work.todoSaving = true; $('#td-edit-save').disabled = true; $('#td-edit-del').disabled = true;
    try {
      await postJson('/api/work/todos/' + id, { text, due_date: $('#td-edit-due').value || '' }, 'PUT');   // 日期框为空 = 清除日期
      work.todoSaving = false;
      closeTodoEditor();
      loadWorkTodos();
    } catch (err) { $('#td-edit-err').textContent = err.message; }
    finally { work.todoSaving = false; $('#td-edit-save').disabled = false; $('#td-edit-del').disabled = false; }
  });
  $('#td-edit-del').addEventListener('click', async () => {
    const id = work.todoEditing;
    if (id == null || work.todoSaving) return;
    if (!await askConfirm('删除这条待办？', { okText: '删除', danger: true })) return;
    if (work.todoEditing !== id || work.todoSaving) return;   // 等确认期间弹层可能已经关了或在保存
    work.todoSaving = true; $('#td-edit-save').disabled = true; $('#td-edit-del').disabled = true;
    try {
      await api('/api/work/todos/' + id, { method: 'DELETE' });
      work.todoSaving = false;
      closeTodoEditor();
      loadWorkTodos();
    } catch (err) { $('#td-edit-err').textContent = err.message; }
    finally { work.todoSaving = false; $('#td-edit-save').disabled = false; $('#td-edit-del').disabled = false; }
  });

  // 周报
  $('#wk-report-btn').addEventListener('click', async e => {
    if (work.person == null) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api(`/api/work/report?start=${encodeURIComponent(work.start)}&person=${work.person}`);
      if (r.empty) { toast('这一周还没有记录（只有下周待办时也不生成，先记一条本周做的）'); return; }
      $('#wr-text').value = r.text;   // 纯文本，用 value 赋值，不经 innerHTML
      $('#work-report').classList.remove('hidden');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });
  $('#wr-close').addEventListener('click', () => $('#work-report').classList.add('hidden'));
  $('#work-report .sheet-backdrop').addEventListener('click', () => $('#work-report').classList.add('hidden'));
  $('#wr-copy').addEventListener('click', async () => {
    const ta = $('#wr-text');
    try { await navigator.clipboard.writeText(ta.value); toast('已复制'); }
    catch { ta.focus(); ta.select(); toast('已选中，请手动复制', 3000); }   // 剪贴板不可用（非 HTTPS、权限被拒）时的退路
  });

  // 人员
  function renderWorkPeopleSheet() {
    $('#wp-list').innerHTML = work.people.map(p => `<div class="wp-row"><span class="wp-name${p.id === work.person ? ' cur' : ''}">${esc(p.name)}</span><button type="button" class="btn small" data-act="rename" data-id="${p.id}">改名</button></div>`).join('');
  }
  $('#work-people-btn').addEventListener('click', () => {
    if (work.person == null) { toast('人员还没有加载出来'); return; }
    renderWorkPeopleSheet();
    $('#work-people-sheet').classList.remove('hidden');
  });
  $('#wp-close').addEventListener('click', () => $('#work-people-sheet').classList.add('hidden'));
  $('#work-people-sheet .sheet-backdrop').addEventListener('click', () => $('#work-people-sheet').classList.add('hidden'));
  $('#wp-list').addEventListener('click', async e => {
    const b = e.target.closest('[data-act="rename"]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (!work.people.some(p => p.id === id)) return;
    const r = await askText('给「' + personName(id) + '」改名', { value: personName(id), placeholder: '最长 20 字' });
    if (r == null || r === '') return;
    try {
      const saved = await postJson('/api/work/people/' + id, { name: r }, 'PUT');
      work.people = work.people.map(p => p.id === saved.id ? { ...p, name: saved.name } : p);   // 直接用返回值
      renderWorkPeople(); renderWorkPeopleSheet();
    } catch (err) { toast(err.message); }
  });
  $('#wp-add').addEventListener('click', async () => {
    const r = await askText('新人员的名字', { placeholder: '最长 20 字' });
    if (r == null || r === '') return;
    try {
      const p = await postJson('/api/work/people', { name: r });
      work.people = [...work.people, p];
      switchWorkPerson(p.id);   // 添加后直接切到新人员
      renderWorkPeopleSheet();
      toast(`已添加「${p.name}」`);
    } catch (err) { toast(err.message); }
  });

  // ---------- 正式周报（AI 整理 + 套用公司 Word 模板导出 docx） ----------
  // 流程：设置页上传模板和示例 → 每周工作页点「整理成正式周报」→ 先看将发给 AI 的内容 → 发送 → 草稿里修改 → 导出 docx。
  // 来自 AI 的文字只通过 .value / .textContent 进入页面，骨架里不带任何用户 / AI 的文字。
  const report = { status: null, prep: null, start: null, person: null, kind: 'single', dates: null, busy: false, dateSeq: 0 };

  async function loadReportStatus() {
    try { report.status = await api('/api/report/status'); } catch { report.status = null; }
    renderReportButton();
    renderReportSettings();
  }
  function renderReportButton() {
    const s = report.status;
    const reason = !s ? '暂时读不到周报设置' : !s.enabled ? 'AI 还没有配置' + (s.problem ? '：' + s.problem : '（沿用图片识别的配置，或在配置文件里单独配置）') : !s.hasTemplate ? '请先在设置里上传周报模板' : '';
    $('#wk-report2-btn').disabled = !!reason || report.busy;
    $('#wk-report2-hint').textContent = reason;
    $('#wk-report2-hint').classList.toggle('hidden', !reason);
  }

  // ---- 设置页：模板、示例、基准日期 ----
  function renderReportSettings() {
    const s = report.status;
    if (!s) { $('#rp-status').textContent = '读不到周报导出的状态'; return; }
    $('#rp-status').textContent = `AI：${s.enabled ? '可用' : '不可用' + (s.problem ? '（' + s.problem + '）' : '（还没有配置）')}　模板：${s.hasTemplate ? '已上传' : '还没上传'}　示例：${s.examples.length} 份`;
    if (document.activeElement !== $('#rp-anchor')) $('#rp-anchor').value = s.anchor;
    const box = $('#rp-examples');
    box.textContent = '';
    for (const ex of s.examples) {
      const row = document.createElement('div'); row.className = 'wp-row';
      const name = document.createElement('span'); name.className = 'wp-name'; name.textContent = `${ex.title}（${ex.chars} 字）`;
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn small danger'; del.textContent = '删除'; del.dataset.id = String(ex.id);
      row.append(name, del);
      box.appendChild(row);
    }
  }
  $('#rp-template-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';   // 清空后才能再次选择同一个文件
    if (!file) return;
    try {
      const r = await api('/api/report/template', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      toast('模板已上传' + (r.name ? `（姓名：${r.name}）` : ''), 4000);
    } catch (err) { toast(err.message, 6000); }
    loadReportStatus();
  });
  $('#rp-example-file').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    let okCount = 0;
    const failed = [], cut = [];
    for (const f of files) {   // 一份一份传，某一份失败不影响其他的
      try {
        const r = await api('/api/report/examples', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Report-Title': encodeURIComponent(f.name.replace(/\.docx$/i, '')) }, body: f });
        okCount++;
        if (r.truncated) cut.push(f.name);
      } catch (err) { failed.push(`${f.name}：${err.message}`); }
    }
    toast(`已上传 ${okCount} 份示例` + (cut.length ? `（${cut.join('、')} 超过 6000 字，只保留了前 6000 字）` : '') + (failed.length ? '；失败：' + failed.join('；') : ''), 8000);
    loadReportStatus();
  });
  $('#rp-examples').addEventListener('click', async e => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    if (!await askConfirm('删除这份示例周报？', { okText: '删除', danger: true })) return;
    try { await api('/api/report/examples/' + b.dataset.id, { method: 'DELETE' }); } catch (err) { toast(err.message); }
    loadReportStatus();
  });
  $('#rp-anchor-save').addEventListener('click', async () => {
    const v = $('#rp-anchor').value;
    if (!v) { toast('请选择一个日期'); return; }
    try { const r = await postJson('/api/report/settings', { anchor: v }, 'PUT'); toast(`已保存：${r.anchor} 那一周是单休`, 4000); }
    catch (err) { toast(err.message); }
    loadReportStatus();
  });

  // ---- 发送前预览 ----
  function closeReportPrepare() { if (report.busy) return; $('#report-prepare').classList.add('hidden'); report.prep = null; }
  $('#rpp-cancel').addEventListener('click', closeReportPrepare);
  $('#report-prepare .sheet-backdrop').addEventListener('click', closeReportPrepare);
  async function openReportPrepare() {
    if (report.busy || work.person == null || !work.start) return;
    report.busy = true; renderReportButton();
    try {
      const r = await postJson('/api/report/prepare', { person: work.person, start: work.start });
      if (r.empty) { toast('这一周还没有记录'); return; }
      report.prep = { hash: r.hash, start: work.start, person: work.person };
      $('#rpp-text').value = r.prompt;
      $('#rpp-info').textContent = `共 ${r.chars} 字，参考的示例周报 ${r.examples} 份。点「发送」后，这些内容会发给 AI 服务，不会保存在 AI 之外的地方。`;
      $('#rpp-err').textContent = '';
      $('#report-prepare').classList.remove('hidden');
    } catch (err) { toast(err.message, 5000); }
    finally { report.busy = false; renderReportButton(); }
  }
  $('#wk-report2-btn').addEventListener('click', openReportPrepare);
  $('#rpp-send').addEventListener('click', async () => {
    const prep = report.prep;
    if (!prep || report.busy) return;
    report.busy = true;
    $('#rpp-send').disabled = true; $('#rpp-cancel').disabled = true; $('#rpp-send').textContent = '整理中…'; $('#rpp-err').textContent = '';
    let again = false;
    try {
      const draft = await postJson('/api/report/generate', { person: prep.person, start: prep.start, hash: prep.hash });
      $('#report-prepare').classList.add('hidden');
      report.prep = null;
      await openReportDraft(draft, prep);
    } catch (err) {
      if (/内容在预览之后有变化/.test(err.message)) again = true;   // 预览之后记录变了：回到预览，让用户重新看一遍
      else $('#rpp-err').textContent = err.message;
    } finally {
      report.busy = false;
      $('#rpp-send').disabled = false; $('#rpp-cancel').disabled = false; $('#rpp-send').textContent = '发送';
      renderReportButton();
    }
    if (again) { $('#report-prepare').classList.add('hidden'); toast('内容在预览之后有变化，请重新确认', 4000); openReportPrepare(); }
  });

  // ---- 草稿 ----
  const draftErr = msg => { const el = $('#rpd-err'); el.textContent = msg; if (msg) el.scrollIntoView({ block: 'nearest' }); };
  const syncDraftButtons = () => {
    const items = $$('#rpd-items .rpd-item');
    items.forEach(box => { $('.rpd-del', box).disabled = items.length <= 1; });   // 至少保留一个项目
  };
  function addDraftItem(it = { title: '', lines: [], progress: 100 }) {
    const box = document.createElement('div');
    box.className = 'rpd-item';
    // 骨架里没有任何用户 / AI 的文字；内容下面用 .value 写入
    box.innerHTML = '<label>项目名称<input class="rpd-title" maxlength="60" autocomplete="off"></label>'
      + '<label>细节（每行一条）<textarea class="rpd-lines" rows="4" spellcheck="false"></textarea></label>'
      + '<div class="rpd-row"><label>完成度（%）<input class="rpd-progress" type="number" min="0" max="100" step="1"></label><button type="button" class="btn small danger rpd-del">删除这个项目</button></div>';
    $('.rpd-title', box).value = it.title;
    $('.rpd-lines', box).value = it.lines.join('\n');
    $('.rpd-progress', box).value = String(it.progress);
    $('#rpd-items').appendChild(box);
    syncDraftButtons();
  }
  function addDraftPlan(text = '') {
    const row = document.createElement('div');
    row.className = 'rpd-plan-row';
    row.innerHTML = '<input class="rpd-plan-text" maxlength="200" autocomplete="off" placeholder="计划内容"><button type="button" class="btn small danger rpd-plan-del" aria-label="删除这条计划">×</button>';
    $('.rpd-plan-text', row).value = text;
    $('#rpd-plan').appendChild(row);
  }
  function renderDraftDates() {
    const d = report.dates;
    $$('.rpd-kind').forEach(b => b.classList.toggle('active', b.dataset.kind === report.kind));
    $('#rpd-filename').textContent = d && d.filename ? '文件名：' + d.filename : '';
  }
  async function openReportDraft(draft, prep) {
    report.start = prep.start; report.person = prep.person;
    let d = null;
    try { d = await api(`/api/report/dates?start=${encodeURIComponent(prep.start)}&today=${encodeURIComponent(todayStr())}`); }
    catch (err) { toast('日期没有算出来，请手动填写：' + err.message, 5000); }
    report.dates = d; report.kind = d ? d.kind : 'single';
    $('#rpd-time').value = d ? d.time : '';
    $('#rpd-plan-range').value = d ? d.planRange : '';
    $('#rpd-issues').value = draft.issues;
    $('#rpd-items').textContent = ''; draft.items.forEach(addDraftItem);
    $('#rpd-plan').textContent = ''; draft.plan.forEach(addDraftPlan);
    draftErr('');
    renderDraftDates();
    $('#report-draft').classList.remove('hidden');
  }
  $('#rpd-add-item').addEventListener('click', () => addDraftItem());
  $('#rpd-add-plan').addEventListener('click', () => addDraftPlan());
  $('#rpd-items').addEventListener('click', e => {
    const b = e.target.closest('.rpd-del');
    if (!b || b.disabled) return;
    b.closest('.rpd-item').remove();
    syncDraftButtons();
  });
  $('#rpd-plan').addEventListener('click', e => { const b = e.target.closest('.rpd-plan-del'); if (b) b.closest('.rpd-plan-row').remove(); });
  // 切换单休 / 双休：重新算计划日期和文件名（「时间」不动）
  $$('.rpd-kind').forEach(b => b.addEventListener('click', async () => {
    const kind = b.dataset.kind;
    if (kind === report.kind || !report.start) return;
    const seq = ++report.dateSeq;
    try {
      const d = await api(`/api/report/dates?start=${encodeURIComponent(report.start)}&today=${encodeURIComponent(todayStr())}&kind=${kind}`);
      if (seq !== report.dateSeq) return;
      report.dates = d; report.kind = d.kind;
      $('#rpd-plan-range').value = d.planRange;
      renderDraftDates();
    } catch (err) { draftErr(err.message); }
  }));
  const closeReportDraft = () => { if (report.busy) return; $('#report-draft').classList.add('hidden'); };
  $('#rpd-cancel').addEventListener('click', closeReportDraft);   // 草稿里改了很多东西，所以不绑定点背景关闭，免得误触丢失
  $('#rpd-regen').addEventListener('click', () => { if (report.busy) return; $('#report-draft').classList.add('hidden'); openReportPrepare(); });

  // ---- 导出 ----
  $('#rpd-export').addEventListener('click', async () => {
    if (report.busy) return;
    const items = $$('#rpd-items .rpd-item').map(box => {
      const pv = $('.rpd-progress', box).value.trim();
      return {
        title: $('.rpd-title', box).value.trim(),
        lines: $('.rpd-lines', box).value.split('\n').map(s => s.trim()).filter(Boolean),
        progress: pv === '' ? null : Number(pv),   // 空着就交给服务端报「完成度应为 0–100 的整数」
      };
    });
    const body = {
      draft: { items, issues: $('#rpd-issues').value.trim(), plan: $$('#rpd-plan .rpd-plan-text').map(i => i.value.trim()).filter(Boolean) },
      time: $('#rpd-time').value.trim(), planRange: $('#rpd-plan-range').value.trim(), kind: report.kind, start: report.start,
    };
    report.busy = true; $('#rpd-export').disabled = true; draftErr('');
    try {
      const res = await fetch('/api/report/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok) {
        let msg = '导出失败';
        try { msg = (await res.json()).error || msg; } catch { /* 响应不是 JSON */ }
        draftErr(msg);   // 失败时弹层不关，用户的修改都还在
        return;
      }
      const blob = await res.blob();
      const m = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('content-disposition') || '');
      let name = '';
      try { name = m ? decodeURIComponent(m[1]) : ''; } catch { /* 取不到就用下面的备用名 */ }
      if (!name) name = (report.dates && report.dates.filename) || '周报.docx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('已导出：' + name, 4000);
      $('#report-draft').classList.add('hidden');
      loadReportStatus();   // 导出的周报自动成为示例，设置页的示例数跟着变
    } catch (err) { draftErr((err && err.message) || '导出失败'); }
    finally { report.busy = false; $('#rpd-export').disabled = false; renderReportButton(); }
  });

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
      <button type="button" class="home-tools" data-go="tools"><span class="tool-ico">${ICO('wrench')}</span><span class="tool-txt"><b>日常工具</b><span>每周菜单等小工具</span></span>${ICO('chevron-right')}</button>
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
