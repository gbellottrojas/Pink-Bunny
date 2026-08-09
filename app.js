/* =========================================================================
   Pink Bunny — Offline Inventory & Cashier
   Everything in this file runs fully client-side against IndexedDB, so the
   app works with zero connection. When online, it can push queued changes
   to the Apps Script backend (see Code.gs -> doPost) and pull the latest
   shared inventory. A local "sales" log mirrors what gets written to the
   Sales sheet, so the Reports tab works offline too.
   ========================================================================= */

var LOW_STOCK_THRESHOLD = 5;
var DEFAULT_EXCHANGE_RATE = 6.96;
var DB_NAME = 'pinkBunnyOffline';
var DB_VERSION = 1;

var db = null;
var productCache = {};   // code(upper) -> product
var cart = {};           // cartKey -> {product, quantity, dedType}
var currentProductCode = null;
var lastSaleResult = null;

function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function money(n) { return '$' + (Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100).toFixed(2); }
function bs(n) { return 'Bs ' + (Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100).toFixed(2); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ------------------------------ IndexedDB -------------------------------- */

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var d = req.result;
      if (!d.objectStoreNames.contains('products')) d.createObjectStore('products', { keyPath: 'code' });
      if (!d.objectStoreNames.contains('ops')) d.createObjectStore('ops', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('sales')) d.createObjectStore('sales', { keyPath: 'id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}
function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
function idbAll(store) {
  return new Promise(function (resolve, reject) {
    var req = tx(store, 'readonly').getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  });
}
function idbPut(store, value) {
  return new Promise(function (resolve, reject) {
    var req = tx(store, 'readwrite').put(value);
    req.onsuccess = function () { resolve(); };
    req.onerror = function () { reject(req.error); };
  });
}
function idbDelete(store, key) {
  return new Promise(function (resolve, reject) {
    var req = tx(store, 'readwrite').delete(key);
    req.onsuccess = function () { resolve(); };
    req.onerror = function () { reject(req.error); };
  });
}
function idbClear(store) {
  return new Promise(function (resolve, reject) {
    var req = tx(store, 'readwrite').clear();
    req.onsuccess = function () { resolve(); };
    req.onerror = function () { reject(req.error); };
  });
}
function getMeta(key) {
  return new Promise(function (resolve, reject) {
    var req = tx('meta', 'readonly').get(key);
    req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
    req.onerror = function () { reject(req.error); };
  });
}
function setMeta(key, value) { return idbPut('meta', { key: key, value: value }); }

/* --------------------------- Local business logic ------------------------ */

function generateProductCode() {
  var code;
  do {
    var n = Math.floor(100000 + Math.random() * 900000);
    code = 'ST' + n;
  } while (productCache[code]);
  return code;
}

function addPendingOp(type, payload) {
  var op = { id: uid(), type: type, payload: payload, createdAt: new Date().toISOString(), error: null };
  return idbPut('ops', op).then(function () { return op; });
}

function addProductLocal(input) {
  var code = (input.code || '').trim().toUpperCase() || generateProductCode();
  if (productCache[code]) throw new Error('A product with code "' + code + '" already exists.');
  var quantity = Number(input.quantity) || 0;
  var pricePerUnit = Number(input.pricePerUnit) || 0;
  var price = (input.price !== '' && input.price != null) ? Number(input.price) : pricePerUnit;
  var costUsd = Number(input.costUsd) || 0;
  var chargeUsd = Number(input.chargeUsd) || 0;
  var product = {
    code: code, name: input.name || '', color: input.color || '', category: input.category || '',
    quantity: quantity, purchaseDate: input.purchaseDate || '', pricePerUnit: pricePerUnit, price: price,
    costUsd: costUsd, chargeUsd: chargeUsd,
    repurchaseStatus: quantity <= LOW_STOCK_THRESHOLD ? 'Needed' : 'Not needed'
  };
  productCache[code] = product;
  return idbPut('products', product)
    .then(function () { return addPendingOp('addProduct', JSON.parse(JSON.stringify(product))); })
    .then(function () { return product; });
}

function updateQuantityLocal(code, quantity) {
  var upper = String(code || '').trim().toUpperCase();
  var product = productCache[upper];
  if (!product) throw new Error('Product "' + code + '" not found.');
  quantity = Number(quantity);
  if (isNaN(quantity) || quantity < 0) throw new Error('Quantity must be a number of 0 or more.');
  product.quantity = quantity;
  product.repurchaseStatus = quantity <= LOW_STOCK_THRESHOLD ? 'Needed' : 'Not needed';
  return idbPut('products', product)
    .then(function () { return addPendingOp('updateQuantity', { code: product.code, quantity: quantity }); })
    .then(function () { return product; });
}

/**
* lines: [{code, quantity, dedType}]  dedType: null | 'Sponsor' | 'Gift' | 'Collaboration'
* Mirrors checkoutCart() in Code.gs: validates combined stock across lines
* of the same product, decrements quantity, and snapshots Cost/Charge (USD)
* into a local sales record so the Reports tab works fully offline.
*/
function checkoutCartLocal(lines, priceType) {
  if (!lines.length) throw new Error('Cart is empty.');
  var usePricePerUnit = priceType === 'pricePerUnit';
  var resolved = [];
  for (var i = 0; i < lines.length; i++) {
    var item = lines[i];
    var p = productCache[String(item.code).toUpperCase()];
    if (!p) throw new Error('Product "' + item.code + '" not found.');
    if (item.quantity <= 0) throw new Error('Invalid quantity for "' + p.name + '".');
    resolved.push({ product: p, quantity: item.quantity, dedType: item.dedType || null, unitPrice: item.unitPrice != null ? Number(item.unitPrice) : null });
  }
  var totalsByCode = {};
  resolved.forEach(function (l) {
    var key = l.product.code.toUpperCase();
    totalsByCode[key] = (totalsByCode[key] || 0) + l.quantity;
  });
  Object.keys(totalsByCode).forEach(function (key) {
    var p = productCache[key];
    if (totalsByCode[key] > p.quantity) {
      throw new Error('Not enough stock for "' + p.name + '" (have ' + p.quantity + ', tried to take ' + totalsByCode[key] + ' total).');
    }
  });

  var saleId = 'OFFLINE-' + Date.now();
  var now = new Date();
  var total = 0;
  var receiptLines = [];
  var puts = [];
  var salesRecords = [];

  resolved.forEach(function (line) {
    var p = line.product;
    var unitPrice = line.dedType ? 0 : (line.unitPrice != null ? line.unitPrice : (usePricePerUnit ? p.pricePerUnit : p.price));
    var lineTotal = line.quantity * unitPrice;
    total += lineTotal;
    p.quantity -= line.quantity;
    p.repurchaseStatus = p.quantity <= LOW_STOCK_THRESHOLD ? 'Needed' : 'Not needed';
    puts.push(idbPut('products', p));
    receiptLines.push({
      code: p.code, name: p.name, quantity: line.quantity, pricePerUnit: unitPrice,
      lineTotal: lineTotal, remainingStock: p.quantity,
      type: line.dedType ? 'Deduction' : 'Sale', reason: line.dedType || ''
    });
    salesRecords.push({
      id: uid(), timestamp: now.toISOString(), saleId: saleId, code: p.code, name: p.name, category: p.category,
      quantity: line.quantity, lineTotal: lineTotal, costUsd: p.costUsd || 0, chargeUsd: p.chargeUsd || 0,
      type: line.dedType ? 'Deduction' : 'Sale', reason: line.dedType || ''
    });
  });

  var cartPayload = resolved.map(function (l) { return { code: l.product.code, quantity: l.quantity, dedType: l.dedType, unitPrice: l.unitPrice }; });
  return Promise.all(puts)
    .then(function () { return Promise.all(salesRecords.map(function (r) { return idbPut('sales', r); })); })
    .then(function () { return addPendingOp('sale', { cart: cartPayload, priceType: priceType }); })
    .then(function () {
      return {
        saleId: saleId,
        timestamp: now.toLocaleString(),
        lines: receiptLines,
        total: total,
        pendingSync: true
      };
    });
}

/* -------------------------------- Sync ------------------------------------ */

function pendingOpsCount() {
  return idbAll('ops').then(function (ops) { return ops.length; });
}

function updateStatusUI() {
  var online = navigator.onLine;
  $('status-dot').className = 'dot' + (online ? ' online' : '');
  $('status-text').textContent = online ? 'Online' : 'Offline';
  $('whatsapp-btn').disabled = !online;
  Promise.all([pendingOpsCount(), getMeta('lastSync')]).then(function (r) {
    var count = r[0], lastSync = r[1];
    var pill = $('pending-pill');
    if (count > 0) { pill.style.display = 'inline-block'; pill.textContent = count; }
    else { pill.style.display = 'none'; }
    $('status-sub').textContent = 'Last synced: ' + (lastSync ? new Date(lastSync).toLocaleString() : 'never');
    $('sync-btn').disabled = !online;
  });
}

/**
* Loads a URL via a <script> tag instead of fetch(). Script-tag loading
* isn't subject to the cross-origin restriction that blocks fetch() from
* reading a response on a different domain — this is what lets the PWA
* actually talk to the Apps Script deployment from GitHub Pages.
*/
function jsonp(baseUrl, params) {
  return new Promise(function (resolve, reject) {
    var cbName = 'pb_jsonp_' + uid();
    var timeout = setTimeout(function () { cleanup(); reject(new Error('Request timed out.')); }, 20000);
    function cleanup() {
      clearTimeout(timeout);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cbName] = function (data) { cleanup(); resolve(data); };
    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var script = document.createElement('script');
    script.src = baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '?') + qs + '&callback=' + cbName;
    script.onerror = function () { cleanup(); reject(new Error('Could not reach the Web App URL. Double check it in Settings and that it\'s deployed with access set to "Anyone".')); };
    document.head.appendChild(script);
  });
}

var SYNC_CHUNK_SIZE = 15; // ops per request, keeps the URL a safe length

function syncNow() {
  var syncMsgTarget = $('settings-msg');
  if (!navigator.onLine) { syncMsgTarget.textContent = 'No connection right now — will sync once you\'re back online.'; syncMsgTarget.className = 'msg info'; return Promise.resolve(); }
  return getMeta('webAppUrl').then(function (url) {
    if (!url) { syncMsgTarget.textContent = 'Add your Apps Script Web App URL in Settings first.'; syncMsgTarget.className = 'msg error'; return; }
    url = url.trim();
    return idbAll('ops').then(function (ops) {
      if (!ops.length) {
        return getAllProductsRemote(url).then(function (data) {
          if (!data.ok) throw new Error(data.error || 'Could not load products.');
          return replaceAllProducts(data.products)
            .then(function () { if (data.exchangeRate) return setMeta('exchangeRate', data.exchangeRate); })
            .then(function () { return setMeta('lastSync', new Date().toISOString()); });
        });
      }
      $('sync-btn').disabled = true;
      return syncOpsInChunks(url, ops, syncMsgTarget);
    });
  }).catch(function (err) {
    syncMsgTarget.textContent = 'Sync failed: ' + (err.message || err); syncMsgTarget.className = 'msg error';
  }).finally(function () {
    $('sync-btn').disabled = !navigator.onLine;
    updateStatusUI();
    populateSearchOptions(); populateScanOptions();
  });
}

function syncOpsInChunks(url, ops, syncMsgTarget) {
  var chunks = [];
  for (var i = 0; i < ops.length; i += SYNC_CHUNK_SIZE) chunks.push(ops.slice(i, i + SYNC_CHUNK_SIZE));
  var allFailed = [];
  var latestData = null;

  function runChunk(idx) {
    if (idx >= chunks.length) return Promise.resolve();
    var chunk = chunks[idx];
    syncMsgTarget.textContent = 'Syncing ' + (idx * SYNC_CHUNK_SIZE + chunk.length) + ' of ' + ops.length + ' change(s)…';
    syncMsgTarget.className = 'msg info';
    var payload = { ops: chunk.map(function (o) { return { clientOpId: o.id, type: o.type, payload: o.payload }; }) };
    return jsonp(url, { api: 'sync', payload: JSON.stringify(payload) }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Sync failed.');
      latestData = data;
      var byId = {};
      data.results.forEach(function (r) { byId[r.clientOpId] = r; });
      var writes = chunk.map(function (op) {
        var r = byId[op.id];
        if (r && r.ok) return idbDelete('ops', op.id);
        op.error = r ? r.error : 'No response from server.';
        allFailed.push(op.error);
        return idbPut('ops', op);
      });
      return Promise.all(writes).then(function () { return runChunk(idx + 1); });
    });
  }

  return runChunk(0).then(function () {
    if (!latestData) return;
    return replaceAllProducts(latestData.products)
      .then(function () { if (latestData.exchangeRate) return setMeta('exchangeRate', latestData.exchangeRate); })
      .then(function () { return setMeta('lastSync', new Date().toISOString()); })
      .then(function () {
        if (allFailed.length) {
          syncMsgTarget.textContent = allFailed.length + ' change(s) could not sync: ' + allFailed.join('; ');
          syncMsgTarget.className = 'msg error';
        } else {
          syncMsgTarget.textContent = 'Synced successfully.'; syncMsgTarget.className = 'msg success';
        }
      });
  });
}

function getAllProductsRemote(url) {
  return jsonp(url, { api: 'products' });
}

function replaceAllProducts(products) {
  productCache = {};
  return idbClear('products').then(function () {
    var puts = (products || []).map(function (p) {
      productCache[p.code.toUpperCase()] = p;
      return idbPut('products', p);
    });
    return Promise.all(puts);
  });
}

/* -------------------------------- Init ------------------------------------ */

function loadProductCacheFromDb() {
  return idbAll('products').then(function (products) {
    productCache = {};
    products.forEach(function (p) { productCache[p.code.toUpperCase()] = p; });
  });
}

openDb().then(function (database) {
  db = database;
  return Promise.all([loadProductCacheFromDb(), getMeta('webAppUrl'), getMeta('exchangeRate')]);
}).then(function (r) {
  if (r[1]) $('webapp-url').value = r[1];
  if (r[2]) $('report-rate').value = r[2];
  populateSearchOptions();
  populateScanOptions();
  updateStatusUI();
  if (navigator.onLine) syncNow();
});

window.addEventListener('online', function () { updateStatusUI(); syncNow(); });
window.addEventListener('offline', updateStatusUI);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
}

/* ------------------------------ Settings UI -------------------------------- */

$('settings-toggle').addEventListener('click', function () {
  var card = $('settings-card');
  var open = card.style.display !== 'none';
  card.style.display = open ? 'none' : 'block';
  $('settings-toggle').textContent = open ? 'Settings ▾' : 'Settings ▴';
});
$('save-url-btn').addEventListener('click', function () {
  var url = $('webapp-url').value.trim();
  setMeta('webAppUrl', url).then(function () {
    $('settings-msg').textContent = 'Saved.'; $('settings-msg').className = 'msg success';
  });
});
$('sync-btn').addEventListener('click', syncNow);

/* ------------------------------- Tabs -------------------------------------- */

document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    $('page-' + btn.dataset.page).classList.add('active');
  });
});

/* --------------------------- Inventory: search ------------------------------ */

function sortedCodes() {
  return Object.keys(productCache).sort(function (a, b) {
    return (productCache[a].name || '').localeCompare(productCache[b].name || '');
  });
}

function populateSearchOptions() {
  var sel = $('search-code');
  var keep = sel.value;
  sel.innerHTML = '<option value="">Select a product…</option>' + sortedCodes().map(function (code) {
    var p = productCache[code];
    return '<option value="' + escapeHtml(p.code) + '">' + escapeHtml(p.name) + ' — ' + escapeHtml(p.code) + ' (qty ' + p.quantity + ')</option>';
  }).join('');
  if (keep && productCache[keep]) sel.value = keep;
}

function populateScanOptions() {
  var sel = $('scan-code');
  var keep = sel.value;
  sel.innerHTML = '<option value="">Select a product…</option>' + sortedCodes().map(function (code) {
    var p = productCache[code];
    return '<option value="' + escapeHtml(p.code) + '">' + escapeHtml(p.name) + ' — ' + escapeHtml(p.code) + ' (qty ' + p.quantity + ')</option>';
  }).join('');
  if (keep && productCache[keep]) sel.value = keep;
}

function renderSearchResult(product) {
  var result = $('search-result');
  currentProductCode = product.code;
  var badgeClass = product.repurchaseStatus === 'Needed' ? 'low' : 'ok';
  result.innerHTML = '<div class="r-title">' + escapeHtml(product.name) + '</div>' +
    '<div class="result-grid">' +
    '<div><span>Code</span>' + escapeHtml(product.code) + '</div>' +
    '<div><span>Category</span>' + escapeHtml(product.category) + '</div>' +
    '<div><span>Color</span>' + escapeHtml(product.color) + '</div>' +
    '<div><span>Quantity</span>' + product.quantity + '</div>' +
    '<div><span>Price per unit</span>' + bs(product.pricePerUnit) + '</div>' +
    '<div><span>Price (after discount)</span>' + bs(product.price) + '</div>' +
    '<div><span>Cost (USD)</span>' + money(product.costUsd) + '</div>' +
    '<div><span>Charge (USD)</span>' + money(product.chargeUsd) + '</div>' +
    '<div><span>Purchase date</span>' + escapeHtml(product.purchaseDate) + '</div>' +
    '</div>' +
    '<span style="font-size:12.5px;font-weight:600;color:#6b6161;margin-right:6px;">Repurchase status</span>' +
    '<span class="badge ' + badgeClass + '">' + escapeHtml(product.repurchaseStatus) + '</span>' +
    '<div class="field" style="margin-top:14px"><label>Update quantity</label>' +
    '<div class="code-row"><input type="number" id="update-quantity-input" min="0" value="' + product.quantity + '">' +
    '<button class="icon-btn" style="width:auto;padding:0 14px;" id="update-quantity-btn">Save</button></div></div>' +
    '<div class="msg" id="update-quantity-msg"></div>';
  result.style.display = 'block';
  $('update-quantity-btn').addEventListener('click', doUpdateQuantity);
}

function doSearch() {
  var code = $('search-code').value;
  var msg = $('search-msg'); var result = $('search-result');
  msg.textContent = ''; result.style.display = 'none';
  if (!code) { return; }
  var product = productCache[code.toUpperCase()];
  if (!product) { msg.textContent = 'No product found with that code.'; msg.className = 'msg error'; return; }
  renderSearchResult(product);
}
$('search-code').addEventListener('change', doSearch);

function doUpdateQuantity() {
  var msg = $('update-quantity-msg');
  var qty = Number($('update-quantity-input').value);
  if (!currentProductCode) return;
  try {
    updateQuantityLocal(currentProductCode, qty).then(function (product) {
      populateSearchOptions(); populateScanOptions();
      $('search-code').value = product.code;
      renderSearchResult(product);
      $('update-quantity-msg').textContent = 'Quantity updated to ' + product.quantity + ' (saved offline).';
      $('update-quantity-msg').className = 'msg success';
      updateStatusUI();
      if (navigator.onLine) syncNow();
    });
  } catch (err) {
    msg.textContent = err.message; msg.className = 'msg error';
  }
}

/* ---------------------------- Inventory: add product ------------------------- */

$('regen-code').addEventListener('click', function () { $('add-code').value = generateProductCode(); });
$('add-code').value = '';

$('add-btn').addEventListener('click', function () {
  var msg = $('add-msg');
  var name = $('add-name').value.trim();
  if (!name) { msg.textContent = 'Product name is required.'; msg.className = 'msg error'; return; }
  var input = {
    code: $('add-code').value.trim(),
    name: name,
    color: $('add-color').value.trim(),
    category: $('add-category').value.trim(),
    quantity: Number($('add-quantity').value) || 0,
    purchaseDate: $('add-purchase-date').value,
    pricePerUnit: Number($('add-price-per-unit').value) || 0,
    price: $('add-price').value === '' ? '' : Number($('add-price').value),
    costUsd: Number($('add-cost-usd').value) || 0,
    chargeUsd: Number($('add-charge-usd').value) || 0
  };
  try {
    addProductLocal(input).then(function (product) {
      msg.textContent = 'Added "' + product.name + '" (saved offline).'; msg.className = 'msg success';
      ['add-name', 'add-color', 'add-category', 'add-purchase-date', 'add-price-per-unit', 'add-price', 'add-cost-usd', 'add-charge-usd'].forEach(function (id) { $(id).value = ''; });
      $('add-quantity').value = 0;
      $('add-code').value = '';
      populateSearchOptions(); populateScanOptions();
      updateStatusUI();
      if (navigator.onLine) syncNow();
    });
  } catch (err) {
    msg.textContent = err.message; msg.className = 'msg error';
  }
});

/* -------------------------------- Cashier: cart ------------------------------ */

function getUnitPrice(product) { return $('price-mode').value === 'pricePerUnit' ? product.pricePerUnit : product.price; }

$('cart-type').addEventListener('change', function () {
  $('ded-reason-field').style.display = this.value === 'deduction' ? 'block' : 'none';
});

function committedQtyForCode(codeUpper) {
  return Object.keys(cart).reduce(function (sum, k) {
    return cart[k].product.code.toUpperCase() === codeUpper ? sum + cart[k].quantity : sum;
  }, 0);
}

/**
* Adds one unit of a product to the cart, respecting the current
* Sale/Deduction + reason selection. Used by both the barcode scanner and
* the "pick from list" dropdown, so they always behave identically.
*/
function addProductToCart(product) {
  var msg = $('scan-msg');
  var type = $('cart-type').value;
  var reason = type === 'deduction' ? $('ded-reason').value : null;
  var codeUpper = product.code.toUpperCase();
  var key = codeUpper + '|' + (reason || 'SALE');
  var committed = committedQtyForCode(codeUpper);
  if (committed >= product.quantity) {
    msg.textContent = 'Only ' + product.quantity + ' in stock for "' + product.name + '".';
    msg.className = 'msg error';
    return;
  }
  if (!cart[key]) cart[key] = { product: product, quantity: 0, dedType: reason };
  cart[key].quantity += 1;
  msg.textContent = 'Added "' + product.name + '".';
  msg.className = 'msg success';
  renderCart();
}

function handleScan(code) {
  if (!code) return;
  var msg = $('scan-msg');
  var product = productCache[code.trim().toUpperCase()];
  if (!product) {
    msg.textContent = 'No product found for code "' + code + '".';
    msg.className = 'msg error';
    return;
  }
  addProductToCart(product);
}

$('scan-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleScan(e.target.value.trim());
    e.target.value = '';
  }
});

$('add-to-cart-btn').addEventListener('click', function () {
  var code = $('scan-code').value;
  var msg = $('scan-msg');
  msg.textContent = '';
  if (!code) { msg.textContent = 'Select a product.'; msg.className = 'msg error'; return; }
  var product = productCache[code.toUpperCase()];
  if (!product) { msg.textContent = 'Product not found.'; msg.className = 'msg error'; return; }
  addProductToCart(product);
  $('scan-code').value = '';
});

function setLinePrice(key, value) {
  var entry = cart[key];
  if (!entry) return;
  var v = value === '' ? null : Number(value);
  if (v != null && (isNaN(v) || v < 0)) v = null;
  entry.overridePrice = v;
  renderCart();
}

function renderCart() {
  var list = $('cart-list');
  var keys = Object.keys(cart);
  if (!keys.length) {
    list.innerHTML = '<div class="cart-empty">Cart is empty — select a product to add it.</div>';
    $('cart-total').textContent = bs(0);
    return;
  }
  var total = 0;
  list.innerHTML = keys.map(function (key) {
    var entry = cart[key];
    var unitPrice = entry.dedType ? 0 : (entry.overridePrice != null ? entry.overridePrice : getUnitPrice(entry.product));
    var lineTotal = entry.quantity * unitPrice;
    total += lineTotal;
    var tag = entry.dedType ? ('<span class="badge tag">' + escapeHtml(entry.dedType) + '</span>') : '';
    var priceControl = entry.dedType
      ? '<div class="price-edit"><span>Bs</span><span>0.00 (deduction)</span></div>'
      : '<div class="price-edit"><span>Bs</span><input type="number" min="0" step="0.01" value="' + unitPrice.toFixed(2) + '" onchange="setLinePrice(\'' + key + '\', this.value)"></div>';
    return '<div class="cart-item">' +
      '<div class="ci-top">' +
      '<div class="ci-info"><div class="ci-name">' + escapeHtml(entry.product.name) + tag + '</div>' +
      '<div class="ci-code">' + escapeHtml(entry.product.code) + '</div></div>' +
      '<button class="ci-remove" onclick="removeFromCart(\'' + key + '\')">&times;</button>' +
      '</div>' +
      '<div class="ci-bottom">' +
      '<div class="qty-stepper">' +
      '<button onclick="changeQty(\'' + key + '\',-1)">&minus;</button>' +
      '<span>' + entry.quantity + '</span>' +
      '<button onclick="changeQty(\'' + key + '\',1)">+</button>' +
      '</div>' +
      priceControl +
      '<div class="ci-total">' + bs(lineTotal) + '</div>' +
      '</div>' +
      '</div>';
  }).join('');
  $('cart-total').textContent = bs(total);
}
$('price-mode').addEventListener('change', renderCart);

function changeQty(key, delta) {
  var entry = cart[key];
  if (!entry) return;
  var next = entry.quantity + delta;
  if (next <= 0) { delete cart[key]; renderCart(); return; }
  if (delta > 0) {
    var codeUpper = entry.product.code.toUpperCase();
    var committedOthers = committedQtyForCode(codeUpper) - entry.quantity;
    if (committedOthers + next > entry.product.quantity) return;
  }
  entry.quantity = next;
  renderCart();
}
function removeFromCart(key) { delete cart[key]; renderCart(); }

$('clear-cart').addEventListener('click', function () {
  cart = {};
  renderCart();
  $('checkout-msg').textContent = '';
  $('receipt-card').style.display = 'none';
  lastSaleResult = null;
});

$('checkout-btn').addEventListener('click', function () {
  var keys = Object.keys(cart);
  var checkoutMsg = $('checkout-msg');
  if (!keys.length) { checkoutMsg.textContent = 'Cart is empty.'; checkoutMsg.className = 'msg error'; return; }
  var lines = keys.map(function (key) { return { code: cart[key].product.code, quantity: cart[key].quantity, dedType: cart[key].dedType || null, unitPrice: cart[key].dedType ? null : cart[key].overridePrice }; });
  var priceType = $('price-mode').value;
  var btn = $('checkout-btn'); btn.disabled = true;
  checkoutMsg.textContent = 'Processing…'; checkoutMsg.className = 'msg info';
  try {
    checkoutCartLocal(lines, priceType).then(function (result) {
      btn.disabled = false;
      checkoutMsg.textContent = 'Sale complete — stock updated locally' + (navigator.onLine ? '.' : ' (will sync when online).');
      checkoutMsg.className = 'msg success';
      cart = {};
      renderCart();
      lastSaleResult = result;
      renderReceipt(result);
      populateSearchOptions(); populateScanOptions();
      updateStatusUI();
      if (navigator.onLine) syncNow();
    }).catch(function (err) {
      btn.disabled = false;
      checkoutMsg.textContent = err.message; checkoutMsg.className = 'msg error';
    });
  } catch (err) {
    btn.disabled = false;
    checkoutMsg.textContent = err.message; checkoutMsg.className = 'msg error';
  }
});

/* ------------------------------- Receipt: PDF + WhatsApp ---------------------- */

function renderReceipt(result) {
  var card = $('receipt-card'); var list = $('receipt-list');
  var saleLines = result.lines.filter(function (l) { return l.type !== 'Deduction'; });
  var dedLines = result.lines.filter(function (l) { return l.type === 'Deduction'; });
  var lineHtml = function (l) {
    return '<div class="receipt-line"><span>' + l.quantity + '&times; ' + escapeHtml(l.code) + '</span>' +
      '<span>' + bs(l.lineTotal) + '</span></div>';
  };
  list.innerHTML = saleLines.map(lineHtml).join('') +
    (dedLines.length ? '<div style="margin-top:8px;font-weight:700;font-size:12px;color:#6b6161;">Deductions</div>' +
      dedLines.map(function (l) {
        return '<div class="receipt-line"><span>' + l.quantity + '&times; ' + escapeHtml(l.code) + ' (' + escapeHtml(l.reason) + ')</span>' +
          '<span>' + bs(0) + '</span></div>';
      }).join('') : '') +
    '<div class="receipt-line" style="border-bottom:none;font-weight:700;">' +
    '<span>Total (' + result.saleId + ')</span><span>' + bs(result.total) + '</span></div>' +
    (result.pendingSync ? '<span class="badge pending">Pending sync</span>' : '');
  card.style.display = 'block';
  $('download-receipt-msg').textContent = ''; $('download-receipt-msg').className = 'msg';
  $('whatsapp-msg').textContent = ''; $('whatsapp-msg').className = 'msg';
  $('whatsapp-phone').value = '';
}

$('download-receipt-btn').addEventListener('click', function () {
  if (!lastSaleResult || !window.jspdf) return;
  var sale = lastSaleResult;
  var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
  var left = 56, right = 539; // ~A4 content width with 56pt margins
  var y = 70;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
  doc.setTextColor(44, 38, 38);
  doc.text('Pink Bunny', left, y); y += 22;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(110, 100, 97);
  doc.text('Sale ' + sale.saleId + '  \u00b7  ' + sale.timestamp, left, y); y += 26;
  doc.setDrawColor(200, 190, 185); doc.line(left, y, right, y); y += 22;

  var colQty = 360, colUnit = 430, colTotal = 500;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(110, 100, 97);
  doc.text('ITEM', left, y); doc.text('QTY', colQty, y); doc.text('UNIT', colUnit, y); doc.text('TOTAL', colTotal, y); y += 8;
  doc.setDrawColor(230, 225, 220); doc.line(left, y, right, y); y += 20;

  function newPageIfNeeded() {
    if (y > 760) { doc.addPage(); y = 70; }
  }

  doc.setFont('helvetica', 'normal'); doc.setTextColor(44, 38, 38); doc.setFontSize(11);
  var saleLines = sale.lines.filter(function (l) { return l.type !== 'Deduction'; });
  var dedLines = sale.lines.filter(function (l) { return l.type === 'Deduction'; });
  saleLines.forEach(function (l) {
    newPageIfNeeded();
    doc.text(String(l.name || l.code).slice(0, 46), left, y);
    doc.text(String(l.quantity), colQty, y);
    doc.text(bs(l.pricePerUnit), colUnit, y);
    doc.text(bs(l.lineTotal), colTotal, y);
    y += 22;
  });
  if (dedLines.length) {
    newPageIfNeeded();
    y += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(110, 100, 97);
    doc.text('DEDUCTIONS', left, y); y += 20;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(44, 38, 38);
    dedLines.forEach(function (l) {
      newPageIfNeeded();
      doc.text((String(l.name || l.code).slice(0, 36)) + ' (' + l.reason + ')', left, y);
      doc.text(String(l.quantity), colQty, y);
      doc.text('\u2014', colUnit, y);
      doc.text(bs(0), colTotal, y);
      y += 22;
    });
  }

  newPageIfNeeded();
  y += 6;
  doc.setDrawColor(44, 38, 38); doc.line(left, y, right, y); y += 26;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('Total', left, y); doc.text(bs(sale.total), colTotal, y); y += 34;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(110, 100, 97);
  doc.text('Thank you for your purchase!', left, y);

  doc.save('Receipt-' + sale.saleId + '.pdf');
  $('download-receipt-msg').textContent = 'PDF downloaded.'; $('download-receipt-msg').className = 'msg success';
});

$('whatsapp-btn').addEventListener('click', function () {
  if (!lastSaleResult) return;
  if (!navigator.onLine) { $('whatsapp-msg').textContent = 'WhatsApp needs a connection to send.'; $('whatsapp-msg').className = 'msg error'; return; }
  var sale = lastSaleResult;
  var phone = $('whatsapp-phone').value.trim().replace(/[^0-9]/g, '');
  var text = 'Hi! Here is your receipt from Pink Bunny.\n' +
    'Sale ' + sale.saleId + ' \u2014 Total ' + bs(sale.total) + '\n' +
    'Items: ' + sale.lines.map(function (l) { return l.quantity + 'x ' + (l.name || l.code) + (l.type === 'Deduction' ? ' (' + l.reason + ')' : ''); }).join(', ') + '\n' +
    '(Download the PDF receipt and attach it here in WhatsApp.)';
  var url = 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text);
  window.open(url, '_blank');

  if (phone && sale.saleId.indexOf('OFFLINE-') !== 0) {
    getMeta('webAppUrl').then(function (webAppUrl) {
      if (!webAppUrl) return;
      return jsonp(webAppUrl.trim(), { api: 'recordWhatsapp', saleId: sale.saleId, phone: phone });
    }).catch(function () { /* best-effort — WhatsApp already opened either way */ });
  } else if (phone && sale.saleId.indexOf('OFFLINE-') === 0) {
    $('whatsapp-msg').textContent = 'Sent — number will be recorded in Sales once this sale finishes syncing.';
    $('whatsapp-msg').className = 'msg info';
  }
});

/* -------------------------------- Reports: profit ---------------------------- */

var lastReport = null;

$('generate-report-btn').addEventListener('click', function () {
  var start = $('report-start').value; var end = $('report-end').value;
  var rate = Number($('report-rate').value);
  var msg = $('report-msg');
  if (!start || !end) { msg.textContent = 'Pick a start and end date.'; msg.className = 'msg error'; return; }
  if (start > end) { msg.textContent = 'Start date must be before end date.'; msg.className = 'msg error'; return; }
  if (!rate || rate <= 0) { msg.textContent = 'Enter a valid exchange rate.'; msg.className = 'msg error'; return; }
  setMeta('exchangeRate', rate);
  msg.textContent = 'Calculating…'; msg.className = 'msg info';
  getProfitReport(start, end, rate).then(function (result) {
    msg.textContent = '';
    lastReport = result.report;
    renderReportSummary(result.report, result.source);
  }).catch(function (err) {
    msg.textContent = err.message || 'Could not build report.'; msg.className = 'msg error';
  });
});

/**
* Prefers the authoritative report from your Google Sheet (covers every
* device that's ever synced) whenever there's a connection and a Web App
* URL configured. Only falls back to this device's own local sales log —
* which won't include sales made on other devices — when offline.
*/
function getProfitReport(start, end, rate) {
  if (!navigator.onLine) {
    return buildLocalProfitReport(start, end, rate).then(function (report) {
      return { report: report, source: 'local' };
    });
  }
  return getMeta('webAppUrl').then(function (url) {
    if (!url) {
      return buildLocalProfitReport(start, end, rate).then(function (report) {
        return { report: report, source: 'local' };
      });
    }
    return jsonp(url.trim(), { api: 'report', start: start, end: end, rate: rate }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Could not load report from your Sheet.');
      return { report: data.report, source: 'server' };
    }).catch(function () {
      // Server unreachable for some reason — still give the person *something*.
      return buildLocalProfitReport(start, end, rate).then(function (report) {
        return { report: report, source: 'local' };
      });
    });
  });
}

/**
* Reads the local "sales" store (every checkout made on this device,
* synced or not) for the date range and computes Profit = Price Sold -
* (Cost + Charge) x rate, same formula as the backend's profit report.
* Only used offline, or as a fallback if the server can't be reached —
* it won't include sales made on other devices.
*/
function buildLocalProfitReport(startDate, endDate, rate) {
  var start = new Date(startDate + 'T00:00:00');
  var end = new Date(endDate + 'T23:59:59');
  return idbAll('sales').then(function (rows) {
    var lines = [];
    var totalRevenue = 0, totalCost = 0, totalCharge = 0;
    var salesCount = 0, deductionCount = 0;
    var byReason = {};
    rows.forEach(function (row) {
      var d = new Date(row.timestamp);
      if (isNaN(d.getTime()) || d < start || d > end) return;
      var lineCostBs = row.quantity * (row.costUsd || 0) * rate;
      var lineChargeBs = row.quantity * (row.chargeUsd || 0) * rate;
      var lineProfitBs = row.lineTotal - lineCostBs - lineChargeBs;
      totalRevenue += row.lineTotal;
      totalCost += lineCostBs;
      totalCharge += lineChargeBs;
      if (row.type === 'Deduction') {
        deductionCount++;
        byReason[row.reason] = (byReason[row.reason] || 0) + row.quantity;
      } else {
        salesCount++;
      }
      lines.push({
        timestamp: d.toLocaleString(), saleId: row.saleId, code: row.code, name: row.name,
        quantity: row.quantity, lineTotal: row.lineTotal, costBs: lineCostBs, chargeBs: lineChargeBs,
        profitBs: lineProfitBs, type: row.type, reason: row.reason
      });
    });
    return {
      startDate: startDate, endDate: endDate, rate: rate,
      totals: {
        revenue: totalRevenue, cost: totalCost, charge: totalCharge,
        profit: totalRevenue - totalCost - totalCharge,
        salesCount: salesCount, deductionCount: deductionCount, byReason: byReason
      },
      lines: lines
    };
  });
}

function renderReportSummary(report, source) {
  var t = report.totals;
  var reasonRows = Object.keys(t.byReason || {}).map(function (r) {
    return '<div><span>' + escapeHtml(r) + '</span>' + t.byReason[r] + ' item(s)</div>';
  }).join('');
  var sourceNote = source === 'server'
    ? '<div class="hint" style="margin-bottom:10px;color:#3f9e6f">&#10003; From your Google Sheet — includes every synced device.</div>'
    : '<div class="hint" style="margin-bottom:10px;color:#d68b2c">&#9888; This device only (offline) — sales from other devices aren\'t included until you sync and re-run this while online.</div>';
  $('report-summary').innerHTML = sourceNote +
    '<div class="result-grid">' +
    '<div><span>Revenue</span>' + bs(t.revenue) + '</div>' +
    '<div><span>Cost</span>' + bs(t.cost) + '</div>' +
    '<div><span>Charge</span>' + bs(t.charge) + '</div>' +
    '<div><span>Profit</span>' + bs(t.profit) + '</div>' +
    '<div><span>Sales</span>' + t.salesCount + '</div>' +
    '<div><span>Deductions</span>' + t.deductionCount + '</div>' +
    '</div>' +
    (reasonRows ? '<div class="field" style="margin-top:12px"><label>Deductions by reason</label><div class="result-grid">' + reasonRows + '</div></div>' : '');
  $('report-result-card').style.display = 'block';
  $('download-report-msg').textContent = ''; $('download-report-msg').className = 'msg';
}

$('download-report-btn').addEventListener('click', function () {
  if (!lastReport || !window.jspdf) return;
  var msg = $('download-report-msg');
  var report = lastReport;
  var t = report.totals;
  var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
  var left = 56, right = 539;
  var y = 70;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(44, 38, 38);
  doc.text('Pink Bunny \u2014 Profit Report', left, y); y += 20;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(110, 100, 97);
  doc.text(report.startDate + ' to ' + report.endDate + '  \u00b7  Rate: 1 USD = ' + report.rate + ' Bs', left, y); y += 30;

  var boxW = (right - left - 24) / 4;
  [['Revenue', t.revenue], ['Cost', t.cost], ['Charge', t.charge], ['Profit', t.profit]].forEach(function (pair, i) {
    var bx = left + i * (boxW + 8);
    doc.setDrawColor(230, 225, 220); doc.roundedRect(bx, y, boxW, 50, 6, 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(110, 100, 97);
    doc.text(pair[0].toUpperCase(), bx + 10, y + 18);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(44, 38, 38);
    doc.text(bs(pair[1]), bx + 10, y + 38);
  });
  y += 74;

  if (Object.keys(t.byReason || {}).length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(110, 100, 97);
    var reasonText = Object.keys(t.byReason).map(function (r) { return r + ': ' + t.byReason[r] + ' item(s)'; }).join('   \u00b7   ');
    doc.text(reasonText, left, y); y += 24;
  }

  doc.setDrawColor(200, 190, 185); doc.line(left, y, right, y); y += 20;

  var colQty = 300, colRev = 360, colCost = 430, colProfit = 500;
  function drawTableHeader() {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(110, 100, 97);
    doc.text('DATE / ITEM', left, y);
    doc.text('QTY', colQty, y); doc.text('REVENUE', colRev, y); doc.text('COST+CHG', colCost, y); doc.text('PROFIT', colProfit, y);
    y += 8;
    doc.setDrawColor(230, 225, 220); doc.line(left, y, right, y); y += 18;
  }
  drawTableHeader();

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(44, 38, 38);
  report.lines.forEach(function (l) {
    if (y > 760) { doc.addPage(); y = 70; drawTableHeader(); }
    var tag = l.type === 'Deduction' ? (' (' + l.reason + ')') : '';
    doc.setFontSize(8); doc.setTextColor(110, 100, 97);
    doc.text(String(l.timestamp).slice(0, 16), left, y);
    doc.setFontSize(9.5); doc.setTextColor(44, 38, 38);
    doc.text((String(l.name || l.code) + tag).slice(0, 30), left, y + 12);
    doc.text(String(l.quantity), colQty, y + 6);
    doc.text(bs(l.lineTotal), colRev, y + 6);
    doc.text(bs(l.costBs + l.chargeBs), colCost, y + 6);
    doc.text(bs(l.profitBs), colProfit, y + 6);
    y += 28;
  });

  doc.save('Profit-Report-' + report.startDate + '_to_' + report.endDate + '.pdf');
  msg.textContent = 'PDF downloaded.'; msg.className = 'msg success';
});

/* ---------------------------- Camera barcode scan ------------------------- */

var html5QrCode = null;
var cameraModal = $('camera-modal');

$('open-camera').addEventListener('click', function () {
  var scanMsg = $('scan-msg');
  if (typeof Html5Qrcode === 'undefined') {
    scanMsg.textContent = 'Camera scanner library isn\'t cached yet — connect once online, then it\'ll work offline too.';
    scanMsg.className = 'msg error';
    return;
  }
  cameraModal.classList.add('open');
  html5QrCode = new Html5Qrcode('qr-reader');
  Html5Qrcode.getCameras().then(function (cameras) {
    var cameraId = cameras.length ? cameras[cameras.length - 1].id : null;
    if (!cameraId) { scanMsg.textContent = 'No camera found.'; scanMsg.className = 'msg error'; closeCamera(); return; }
    html5QrCode.start(
      cameraId,
      { fps: 10, qrbox: { width: 250, height: 140 } },
      function (decodedText) { handleScan(decodedText); closeCamera(); }
    ).catch(function () {
      scanMsg.textContent = 'Could not start camera.'; scanMsg.className = 'msg error'; closeCamera();
    });
  }).catch(function () {
    scanMsg.textContent = 'Camera access denied.'; scanMsg.className = 'msg error'; closeCamera();
  });
});

function closeCamera() {
  cameraModal.classList.remove('open');
  if (html5QrCode) {
    html5QrCode.stop().then(function () { html5QrCode.clear(); }).catch(function () {});
    html5QrCode = null;
  }
}
$('close-camera').addEventListener('click', closeCamera);

