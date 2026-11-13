/* ============================================================
   Dibbo Store — frontend logic (dual portal + 3D)
   cart in localStorage · session auth · role-based portals
   ============================================================ */
"use strict";

const $ = (id) => document.getElementById(id);
const CURRENCY = "৳";
const state = {
  user: null,
  products: [],
  offers: [],
  coupon: null,
  cart: JSON.parse(localStorage.getItem("dibbo_cart") || "[]"),
  favs: JSON.parse(localStorage.getItem("dibbo_favs") || "[]"),
  cat: "All",
  search: "",
  sort: "featured",
  lowOnly: false,
  unread: 0,
  lastNotiId: 0,
  pollTimer: null,
  // admin state
  adminStats: null,
  adminOrders: [],
  adminProducts: [],
  adminOffers: [],
  adminComplaints: [],
  adminSettings: null,
  // user portal state
  userAddresses: [],
  userWishlist: [],
  // 3D
  threeInitialized: false,
  threeModels: {},
};

/* ---------------- helpers ---------------- */
const tk = (n) => `${CURRENCY}${Number(n).toLocaleString("en-IN")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isAdminUser = () => state.user && (state.user.role === "owner" || state.user.role === "admin");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, alert = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("toast-alert", alert);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3400);
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/* ---------------- portal routing ---------------- */
function setUIForUser() {
  const u = state.user;
  // hide all portal indicators
  $("accountBtn").hidden = !!u;
  $("logoutBtn").hidden = !u;
  $("myOrdersBtn").hidden = !u || isAdminUser();
  $("adminBtn").hidden = true;
  $("userPortalBtn").hidden = true;
  $("bellBtn").hidden = true;
  $("cartBtn").hidden = isAdminUser() || (!u && !state.cart.length);

  if (u) {
    $("accountBtn").textContent = "Log in"; // reset
    if (u.role === "owner" || u.role === "admin") {
      $("adminBtn").hidden = false;
      $("bellBtn").hidden = false;
      startPolling();
    } else {
      $("userPortalBtn").hidden = false;
      stopPolling();
    }
  } else {
    stopPolling();
  }
  // show cart if has items even for guests
  if (state.cart.length && !isAdminUser()) $("cartBtn").hidden = false;
}

/* ---------------- auth modal ---------------- */
function setupAuthModal() {
  let mode = "login";
  const modal = $("accountModal");
  function setMode(m) {
    mode = m;
    $("switchLogin").classList.toggle("is-active", m === "login");
    $("switchRegister").classList.toggle("is-active", m === "register");
    $("nameField").hidden = m === "login";
    $("forgotLink").hidden = m === "register";
    $("accountTitle").textContent = m === "login" ? "Log in" : "Create your account";
    $("accountSubmit").textContent = m === "login" ? "Log in →" : "Join the family →";
    $("accountError").hidden = true;
  }
  $("switchLogin").addEventListener("click", () => setMode("login"));
  $("switchRegister").addEventListener("click", () => setMode("register"));
  $("forgotLink").addEventListener("click", (e) => { e.preventDefault(); showForgotModal(); });
  $("accountBtn").addEventListener("click", () => { setMode("login"); modal.showModal(); });
  $("accountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const path = mode === "login" ? "/api/login" : "/api/register";
      const body = mode === "login"
        ? { email: f.email.value, password: f.password.value }
        : { name: f.name.value, email: f.email.value, password: f.password.value };
      const data = await api(path, { method: "POST", body });
      state.user = data.user;
      setUIForUser();
      modal.close();
      toast(`Welcome${data.user.role === "owner" ? ", boss" : ""}, ${data.user.name.split(" ")[0]}! 🧡`);
      f.reset();
      // redirect to appropriate portal
      if (data.user.role === "owner" || data.user.role === "admin") {
        setTimeout(() => openAdminPortal(), 200);
      } else {
        setTimeout(() => openUserPortal(), 200);
      }
    } catch (err) { $("accountError").textContent = err.message; $("accountError").hidden = false; }
  });
  $("logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    state.user = null; setUIForUser(); renderShop();
    closeAdminPortal();
    closeUserPortal();
    toast("Logged out — come back soon! 👋");
  });
}

function showForgotModal() {
  $("accountModal").close();
  $("forgotModal").showModal();
  $("forgotForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await api("/api/password/forgot", { method: "POST", body: { email: $("forgotEmail").value } });
      toast(data.message);
      if (data.reset_url) {
        // In demo, show the reset link
        const url = data.reset_url;
        setTimeout(() => {
          alert(`Reset link (demo): ${url}`);
        }, 300);
      }
      $("forgotModal").close();
      $("forgotForm").reset();
    } catch (err) {
      $("forgotError").textContent = err.message;
      $("forgotError").hidden = false;
    }
  };
}

function setupResetModal() {
  // Reset modal would be shown via URL token in production
  $("resetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/password/reset", { method: "POST", body: { token: $("resetToken").value, password: $("resetPassword").value } });
      toast("Password updated. You can now log in.");
      $("resetModal").close();
      $("accountModal").showModal();
    } catch (err) { $("resetError").textContent = err.message; $("resetError").hidden = false; }
  });
}

/* ---------------- offers strip ---------------- */
function renderOfferStrip() {
  const strip = $("offerStrip");
  if (!state.offers.length) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = `<span class="offer-strip-label">🎟 Offers</span>` + state.offers.map((o) => {
    const val = o.kind === "percent" ? `${parseFloat(o.value)}% off` : `${tk(o.value)} off`;
    const bits = [val, o.min_total ? `over ${tk(o.min_total)}` : "", o.applies !== "all" ? o.applies : ""].filter(Boolean);
    return `<span class="offer-pill"><b>${esc(o.code)}</b> · ${bits.map(esc).join(" · ")}</span>`;
  }).join("");
}

/* ---------------- products & grid ---------------- */
function productBySku(sku) { return state.products.find((p) => p.sku === sku); }
function productById(id) { return state.products.find((p) => p.id == id); }

function categories() {
  const set = [...new Set(state.products.map((p) => p.category))];
  return ["All", ...set];
}

function renderCats() {
  $("catRow").innerHTML = categories().map((c) =>
    `<button class="filter-chip ${c === state.cat ? "is-active" : ""}" data-cat="${esc(c)}" type="button">${c === "All" ? "🧺 Everything" : esc(c)}</button>`).join("");
  document.querySelectorAll("[data-cat]").forEach((el) =>
    el.addEventListener("click", () => { state.cat = el.dataset.cat; renderShop(); }));
}

function visibleProducts() {
  let list = state.products.filter((p) => p.active);
  if (state.cat !== "All") list = list.filter((p) => p.category === state.cat);
  if (state.lowOnly) list = list.filter((p) => p.stock <= (p.low_stock_threshold || 5));
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((p) => (p.name + " " + p.category + " " + (p.blurb || "")).toLowerCase().includes(q));
  if (state.sort === "price-low") list.sort((a, b) => a.price - b.price);
  else if (state.sort === "price-high") list.sort((a, b) => b.price - a.price);
  else if (state.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function artTint(cat) {
  return { Groceries: "#FDE8DC", Fresh: "#E4F0E9", Snacks: "#FDF3CE", Drinks: "#E8ECF7", Home: "#F7E9F2", Care: "#D9F0EE" }[cat] || "#F5E9D3";
}

/* --- 3D Model Types --- */
const MODEL_GEOMETRIES = {
  bag: { type: "box", params: [1, 1.2, 0.6], color: 0xD4A876 },
  box: { type: "box", params: [1, 1, 0.8], color: 0xE8D5B7 },
  bottle: { type: "cylinder", params: [0.4, 0.35, 1.5, 16], color: 0x8B6914 },
  jar: { type: "cylinder", params: [0.5, 0.5, 0.8, 16], color: 0xD4A876 },
  fruit: { type: "sphere", params: [0.6, 16, 16], color: 0xE86C56 },
  veg: { type: "sphere", params: [0.55, 16, 16], color: 0x8FBC8F },
  tube: { type: "cylinder", params: [0.3, 0.3, 1.2, 16], color: 0xF5F5F5 },
};

function create3DModel(modelType) {
  const geo = MODEL_GEOMETRIES[modelType] || MODEL_GEOMETRIES.box;
  let geometry;
  if (geo.type === "box") geometry = new THREE.BoxGeometry(...geo.params);
  else if (geo.type === "cylinder") geometry = new THREE.CylinderGeometry(...geo.params);
  else if (geo.type === "sphere") geometry = new THREE.SphereGeometry(...geo.params);
  
  const material = new THREE.MeshStandardMaterial({ 
    color: geo.color,
    roughness: 0.6,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  return mesh;
}

function initThreeJS() {
  if (state.threeInitialized || typeof THREE === "undefined") return;
  
  state.threeInitialized = true;
  
  // Create a shared scene for product previews
  const container = document.createElement("div");
  container.id = "three-container";
  container.style.display = "none";
  document.body.appendChild(container);
  
  // We'll create individual canvases per product card on hover
}

function show3DPreview(product, targetElement) {
  if (typeof THREE === "undefined") return;
  
  const modelType = product.model_type || "box";
  const key = `${product.sku}-${modelType}`;
  
  // Check if we already have a renderer for this product
  let canvas = targetElement.querySelector(".product-3d-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "product-3d-canvas";
    canvas.width = 120;
    canvas.height = 120;
    targetElement.querySelector(".card-art").appendChild(canvas);
    
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(120, 120);
    renderer.setPixelRatio(window.devicePixelRatio);
    
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 3;
    
    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(2, 3, 4);
    scene.add(dirLight);
    
    // Create model
    const mesh = create3DModel(modelType);
    scene.add(mesh);
    
    // Animation
    let frame = 0;
    function animate() {
      if (!targetElement.isConnected || targetElement.querySelector(".card-art")?.contains(canvas) === false) {
        renderer.dispose();
        return;
      }
      mesh.rotation.y += 0.01;
      mesh.rotation.x = Math.sin(frame * 0.02) * 0.1;
      renderer.render(scene, camera);
      frame++;
      requestAnimationFrame(animate);
    }
    animate();
  }
}

function hide3DPreview(targetElement) {
  const canvas = targetElement.querySelector(".product-3d-canvas");
  if (canvas) canvas.remove();
}

function renderShop() {
  renderCats();
  const list = visibleProducts();
  $("emptyMsg").hidden = list.length > 0;
  $("shopTotal").textContent = `${list.length} item${list.length === 1 ? "" : "s"} on the shelf`;
  $("grid").innerHTML = list.map((p) => {
    const fav = state.favs.includes(p.sku);
    const out = p.stock <= 0;
    const low = p.stock > 0 && p.stock <= (p.low_stock_threshold || 5);
    const modelType = p.model_type || "box";
    return `<article class="card" data-sku="${esc(p.sku)}">
      <div class="card-art" style="background:${artTint(p.category)}">
        ${esc(p.emoji || "🛍️")}
        ${out ? '<span class="badge badge-out">Out of stock</span>' : low ? `<span class="badge badge-low">Only ${p.stock} left</span>` : ""}
        ${p.stock >= 10 && (p.name.includes("25kg") || p.name.includes("5kg")) ? '<span class="badge badge-fam">Family pack</span>' : ""}
        <button class="card-fav ${fav ? "is-fav" : ""}" data-fav="${esc(p.sku)}" aria-label="Save to favourites">${fav ? "❤️" : "🤍"}</button>
      </div>
      <div class="card-body">
        <span class="card-cat">${esc(p.category)}</span>
        <h3 class="card-name">${esc(p.name)}</h3>
        <p class="card-blurb">${esc(p.blurb || "")}</p>
        <div class="card-foot">
          <div><span class="price">${tk(p.price)}</span><br>
            <span class="stock-note ${low ? "warn" : ""}">${out ? "Restocking soon" : low ? `Hurry — ${p.stock} left` : `${p.stock} in stock`}</span></div>
          <button class="addbtn" data-add="${esc(p.sku)}" ${out || isAdminUser() ? "disabled" : ""}>${out ? "Sold out" : isAdminUser() ? "Admin mode" : "＋ Add"}</button>
        </div>
      </div>
    </article>`;
  }).join("");

  // Add 3D hover handlers
  document.querySelectorAll(".card[data-sku]").forEach((card) => {
    const sku = card.dataset.sku;
    const product = productBySku(sku);
    if (!product) return;
    
    card.addEventListener("mouseenter", () => show3DPreview(product, card));
    card.addEventListener("mouseleave", () => hide3DPreview(card));
  });

  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => addToCart(b.dataset.add)));
  document.querySelectorAll("[data-fav]").forEach((b) => b.addEventListener("click", () => {
    const sku = b.dataset.fav;
    state.favs = state.favs.includes(sku) ? state.favs.filter((s) => s !== sku) : [...state.favs, sku];
    localStorage.setItem("dibbo_favs", JSON.stringify(state.favs));
    renderShop();
  }));
}

/* ---------------- cart ---------------- */
function cartCount() { return state.cart.reduce((n, i) => n + i.qty, 0); }
function cartTotal() { return state.cart.reduce((n, i) => n + i.qty * (productBySku(i.sku)?.price || 0), 0); }

function saveCart() { localStorage.setItem("dibbo_cart", JSON.stringify(state.cart)); state.coupon = null; renderCouponNote(); }

function addToCart(sku) {
  if (isAdminUser()) {
    toast("Admin accounts manage the shop and cannot place customer orders.", true);
    return;
  }
  const p = productBySku(sku);
  if (!p || p.stock <= 0) return;
  const line = state.cart.find((i) => i.sku === sku);
  const inCart = line ? line.qty : 0;
  if (inCart + 1 > p.stock) { toast(`Only ${p.stock} left of ${p.name} 🙈`, true); return; }
  if (line) line.qty += 1; else state.cart.push({ sku, qty: 1 });
  saveCart(); renderCart();
  const n = cartCount();
  toast(`${p.emoji} ${p.name} added — basket: ${n} item${n === 1 ? "" : "s"} · ${tk(cartTotal() + estFee(cartTotal()))}`);
  pulseCart();
}

function pulseCart() {
  const b = $("cartBtn");
  b.style.transform = "scale(1.12)";
  setTimeout(() => (b.style.transform = ""), 180);
}

function setQty(sku, qty) {
  const p = productBySku(sku);
  if (qty <= 0) state.cart = state.cart.filter((i) => i.sku !== sku);
  else if (p && qty > p.stock) { toast(`Only ${p.stock} left of ${p.name}`, true); return; }
  else state.cart.find((i) => i.sku === sku).qty = qty;
  saveCart(); renderCart();
}

const FREE_OVER = 1500, DELIVERY_FEE = 60;
const estFee = (net) => (net >= FREE_OVER ? 0 : DELIVERY_FEE);

function renderCart() {
  $("cartCount").textContent = cartCount();
  $("cartBtnText").textContent = cartCount() ? tk(cartTotal()) : "Cart";
  const body = $("cartBody");
  const subtotal = cartTotal();
  const fee = estFee(subtotal);
  if (!state.cart.length) {
    body.innerHTML = `<p class="cart-empty">Your basket is empty.<br>Fill it with something tasty! 🍪</p>`;
    $("checkoutBtn").disabled = true;
    $("checkoutBtn").style.opacity = 0.5;
  } else {
    $("checkoutBtn").disabled = false;
    $("checkoutBtn").style.opacity = 1;
    body.innerHTML = state.cart.map((i) => {
      const p = productBySku(i.sku);
      if (!p) return "";
      return `<div class="cart-line">
        <span class="cl-art">${esc(p.emoji || "🛍️")}</span>
        <div class="cl-info"><div class="cl-name">${esc(p.name)}</div>
          <div class="cl-price">${i.qty} × ${tk(p.price)} = <b>${tk(p.price * i.qty)}</b></div>
          <button class="cl-remove" data-remove="${esc(p.sku)}">remove</button></div>
        <div class="qty">
          <button data-less="${esc(p.sku)}" aria-label="Less">−</button><span class="q">${i.qty}</span>
          <button data-more="${esc(p.sku)}" aria-label="More">＋</button>
        </div></div>`;
    }).join("");
    document.querySelectorAll("[data-more]").forEach((b) => b.addEventListener("click", () => {
      const l = state.cart.find((i) => i.sku === b.dataset.more); setQty(b.dataset.more, l.qty + 1);
    }));
    document.querySelectorAll("[data-less]").forEach((b) => b.addEventListener("click", () => {
      const l = state.cart.find((i) => i.sku === b.dataset.less); setQty(b.dataset.less, l.qty - 1);
    }));
    document.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => setQty(b.dataset.remove, 0)));
  }
  $("billQty").textContent = cartCount();
  $("billSubtotal").textContent = tk(subtotal);
  $("billFee").textContent = fee === 0 ? "FREE 🎉" : tk(fee);
  $("cartTotal").textContent = tk(subtotal + fee);
  $("checkoutTotal").textContent = tk(subtotal + fee);
}

/* ---------------- coupon ---------------- */
function renderCouponNote() {
  const note = $("couponNote");
  if (!note) return;
  if (state.coupon) {
    note.textContent = `🎟 ${state.coupon.code} applied — you save ${tk(state.coupon.discount)}!`;
    note.className = "coupon-note ok";
    $("checkoutTotal").textContent = tk(state.coupon.total);
  } else {
    const sub = cartTotal();
    note.textContent = state.offers.length ? `Try: ${state.offers.map((o) => o.code).join(", ")}` : "";
    note.className = "coupon-note";
    $("checkoutTotal").textContent = tk(sub + estFee(sub));
  }
}

async function applyCoupon() {
  const code = $("couponInput").value.trim();
  if (!code) { state.coupon = null; renderCouponNote(); return; }
  try {
    const data = await api("/api/offers/validate", { method: "POST", body: { code, items: state.cart } });
    state.coupon = data;
    renderCouponNote();
    toast(`🎟 ${data.code} applied — you save ${tk(data.discount)}!`);
  } catch (err) {
    state.coupon = null;
    renderCouponNote();
    toast(err.message, true);
  }
}

/* ---------------- checkout ---------------- */
function setupCheckout() {
  $("cartBtn").addEventListener("click", () => { $("cartDrawer").hidden = false; renderCart(); });
  document.querySelectorAll("[data-close-drawer]").forEach((b) => b.addEventListener("click", () => { $("cartDrawer").hidden = true; }));
  $("checkoutBtn").addEventListener("click", () => {
    if (isAdminUser()) { toast("Admin accounts cannot place customer orders.", true); return; }
    if (!state.user) { toast("Please log in first — it takes 10 seconds 🙂"); $("accountModal").showModal(); return; }
    $("cartDrawer").hidden = true;
    renderCouponNote();
    $("checkoutModal").showModal();
  });
  $("couponApply").addEventListener("click", applyCoupon);
  $("couponInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyCoupon(); } });
  $("checkoutForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const snapshot = state.cart.map((i) => ({ ...i, p: productBySku(i.sku) }));
    try {
      const data = await api("/api/orders", {
        method: "POST",
        body: {
          items: state.cart, coupon: state.coupon ? state.coupon.code : "",
          name: f.name.value, phone: f.phone.value,
          address: f.address.value, payment: f.payment.value, note: f.note.value,
        },
      });
      state.cart = []; state.coupon = null; saveCart(); renderCart();
      $("couponInput").value = "";
      $("checkoutModal").close();
      $("confirmCode").textContent = data.code;
      renderReceipt(data, snapshot, f.payment.value);
      f.reset();
      $("confirmModal").showModal();
    } catch (err) {
      $("checkoutError").textContent = err.message; $("checkoutError").hidden = false;
    }
  });
  $("confirmTrackBtn").addEventListener("click", () => {
    $("confirmModal").close();
    $("trackCode").value = $("confirmCode").textContent;
    $("trackModal").showModal();
    $("trackForm").requestSubmit();
  });
}

function renderReceipt(data, snapshot, payment) {
  $("confirmBill").innerHTML = `
    <div class="receipt-head">🧾 your bill · ${esc(payment === "bkash" ? "bKash" : "Cash on delivery")}</div>
    <table>
      ${snapshot.map((l) => `<tr><td>${esc(l.p?.emoji || "")} ${esc(l.p?.name || l.sku)} × ${l.qty}</td><td>${tk((l.p?.price || 0) * l.qty)}</td></tr>`).join("")}
      <tr class="r-sub"><td>Subtotal</td><td>${tk(data.subtotal)}</td></tr>
      ${data.discount ? `<tr class="r-disc"><td>Discount 🎟 ${esc(data.coupon)}</td><td>−${tk(data.discount)}</td></tr>` : ""}
      <tr><td>Delivery</td><td>${data.delivery_fee === 0 ? "FREE 🎉" : tk(data.delivery_fee)}</td></tr>
      <tr class="r-total"><td>To pay</td><td>${tk(data.total)}</td></tr>
    </table>`;
}

/* ---------------- tracking ---------------- */
const STAGES = ["Placed", "Confirmed", "Out for delivery", "Delivered"];
function setupTrack() {
  $("heroTrackBtn").addEventListener("click", () => $("trackModal").showModal());
  $("deliveryTrackBtn").addEventListener("click", () => $("trackModal").showModal());
  $("trackForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("trackResult");
    box.innerHTML = "<p class='modal-sub'>Looking for your basket…</p>";
    try {
      const data = await api(`/api/track/${encodeURIComponent($("trackCode").value.trim())}`);
      const o = data.order;
      const stageIdx = STAGES.indexOf(o.status);
      const cancelled = o.status === "Cancelled";
      box.innerHTML = `
        <div class="order-card" style="margin-top:14px">
          <div class="order-top"><span class="order-code-sm">${esc(o.code)}</span>
            <span class="status st-${o.status.toLowerCase().replace(/\s/g, "")}">${esc(o.status)}</span></div>
          <p class="order-meta">Placed ${timeAgo(o.created_at)} · ${esc(o.payment === "bkash" ? "bKash" : "Cash on delivery")}${o.discount ? ` · 🎟 ${esc(o.coupon)} −${tk(o.discount)}` : ""} · delivery ${o.delivery_fee ? tk(o.delivery_fee) : "FREE"} · Total <b>${tk(o.total)}</b></p>
          ${cancelled ? "<p style='margin-top:8px'>This order was cancelled. 🙏</p>" : `
          <ol class="order-items" style="display:flex;gap:6px;list-style:none;margin:14px 0 6px;padding:0;flex-wrap:wrap">
            ${STAGES.map((s, i) => `<li style="flex:1;min-width:90px;text-align:center;font-weight:${i <= stageIdx ? 800 : 400};color:${i <= stageIdx ? "var(--leaf)" : "var(--ink-soft)"}">
              <div style="font-size:1.3rem">${i <= stageIdx ? "🟢" : "⚪"}</div>${s}</li>`).join("")}
          </ol>`}
          <ul class="order-items">${data.items.map((i) => `<li>${esc(i.emoji || "")} ${esc(i.name)} × ${i.qty} — ${tk(i.price * i.qty)}</li>`).join("")}</ul>
        </div>`;
    } catch (err) { box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  });
}

/* ============================================================
   USER PORTAL
   ============================================================ */
function openUserPortal() {
  if (!state.user) return;
  $("userPortalModal").showModal();
  loadUserPortal();
}

function closeUserPortal() {
  $("userPortalModal").close();
}

async function loadUserPortal() {
  try {
    const [profile, orders, addresses, wishlist] = await Promise.all([
      api("/api/user/profile"),
      api("/api/user/orders"),
      api("/api/addresses"),
      api("/api/wishlist"),
    ]);
    state.user = profile.user;
    state.userAddresses = profile.user.addresses || [];
    state.userWishlist = wishlist.wishlist || [];
    
    renderUserDashboard(orders.orders);
    renderUserAddresses();
    renderUserWishlist();
    renderUserProfile();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderUserDashboard(orders) {
  const activeOrders = orders.filter(o => !["Delivered", "Cancelled"].includes(o.status));
  const pastOrders = orders.filter(o => ["Delivered", "Cancelled"].includes(o.status));
  
  $("userActiveOrders").innerHTML = activeOrders.length
    ? activeOrders.map(renderUserOrderCard).join("")
    : "<p class='modal-sub'>No active orders. Your next basket awaits! 🧺</p>";
  
  $("userPastOrders").innerHTML = pastOrders.length
    ? pastOrders.map(renderUserOrderCard).join("")
    : "<p class='modal-sub'>No past orders yet.</p>";
  
  // Add cancel handlers
  document.querySelectorAll("[data-user-cancel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Cancel order ${b.dataset.userCancel}? Stock goes back on the shelf.`)) return;
    try { await api(`/api/orders/${b.dataset.userCancel}/cancel`, { method: "POST" }); toast("Order cancelled."); loadUserPortal(); }
    catch (err) { toast(err.message, true); }
  }));
  
  document.querySelectorAll("[data-user-report]").forEach((b) => b.addEventListener("click", () => {
    $("userComplaintForm").dataset.code = b.dataset.userReport;
    $("userComplaintOrder").textContent = `About order ${b.dataset.userReport}`;
    $("userComplaintError").hidden = true;
    $("userComplaintModal").showModal();
  }));
}

function renderUserOrderCard(o) {
  return `
    <div class="order-card">
      <div class="order-top"><span class="order-code-sm">${esc(o.code)}</span>
        <span class="status st-${o.status.toLowerCase().replace(/\s/g, "")}">${esc(o.status)}</span></div>
      <p class="order-meta">Placed ${timeAgo(o.created_at)} · ${esc(o.payment === "bkash" ? "bKash" : "Cash on delivery")}${o.discount ? ` · 🎟 ${esc(o.coupon)} −${tk(o.discount)}` : ""} · delivery ${o.delivery_fee ? tk(o.delivery_fee) : "FREE"}</p>
      <ul class="order-items">${o.items.map((i) => `<li>${esc(i.emoji || "")} ${esc(i.name)} × ${i.qty} — ${tk(i.price * i.qty)}</li>`).join("")}</ul>
      <div class="order-top"><span class="order-total">${tk(o.total)}</span>
        <span class="order-actions">
          <button class="btn btn-mini btn-ghost" data-user-report="${esc(o.code)}">Report a problem</button>
          ${o.can_cancel ? `<button class="btn btn-mini addbtn" data-user-cancel="${esc(o.code)}">Cancel (12h window)</button>` : ""}
        </span></div>
    </div>`;
}

function renderUserAddresses() {
  const list = state.userAddresses;
  $("userAddressesList").innerHTML = list.length
    ? list.map(a => `
      <div class="address-card ${a.is_default ? "default" : ""}">
        <div class="addr-info">
          <b>${esc(a.label)}</b> ${a.is_default ? '<span class="pill pill-ok">Default</span>' : ''}
          <br>${esc(a.name)} · ${esc(a.phone)}<br>${esc(a.address)}
        </div>
        <div class="addr-actions">
          ${!a.is_default ? `<button class="btn btn-mini btn-ghost" data-set-default="${a.id}">Make default</button>` : ""}
          <button class="btn btn-mini btn-ghost" data-edit-addr="${a.id}">Edit</button>
          <button class="btn btn-mini addbtn" data-del-addr="${a.id}">Delete</button>
        </div>
      </div>`).join("")
    : "<p class='modal-sub'>No saved addresses. Add one for faster checkout!</p>";
  
  // Handlers
  document.querySelectorAll("[data-set-default]").forEach(b => b.addEventListener("click", async () => {
    await api(`/api/addresses/${b.dataset.setDefault}`, { method: "PUT", body: { is_default: true } });
    loadUserPortal();
  }));
  document.querySelectorAll("[data-edit-addr]").forEach(b => b.addEventListener("click", () => openAddressEditor(b.dataset.editAddr)));
  document.querySelectorAll("[data-del-addr]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this address?")) return;
    await api(`/api/addresses/${b.dataset.delAddr}`, { method: "DELETE" });
    loadUserPortal();
  }));
}

function openAddressEditor(id) {
  const addr = state.userAddresses.find(a => a.id == id);
  if (!addr) return;
  const f = $("addressForm");
  f.dataset.id = id;
  f.label.value = addr.label;
  f.name.value = addr.name;
  f.phone.value = addr.phone;
  f.address.value = addr.address;
  f.is_default.checked = addr.is_default;
  $("addressModalTitle").textContent = "Edit Address";
  $("addressModal").showModal();
}

function setupAddressForm() {
  $("addAddressBtn").addEventListener("click", () => {
    const f = $("addressForm");
    f.reset();
    delete f.dataset.id;
    $("addressModalTitle").textContent = "Add Address";
    $("addressModal").showModal();
  });
  
  $("addressForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.dataset.id) {
        await api(`/api/addresses/${f.dataset.id}`, { 
          method: "PUT", 
          body: { label: f.label.value, name: f.name.value, phone: f.phone.value, address: f.address.value, is_default: f.is_default.checked }
        });
      } else {
        await api("/api/addresses", { 
          method: "POST", 
          body: { label: f.label.value, name: f.name.value, phone: f.phone.value, address: f.address.value }
        });
      }
      $("addressModal").close();
      loadUserPortal();
    } catch (err) { toast(err.message, true); }
  });
}

function renderUserWishlist() {
  const list = state.userWishlist;
  $("userWishlistGrid").innerHTML = list.length
    ? list.map(p => `
      <div class="wish-item">
        <span class="wish-emoji">${esc(p.emoji || "🛍️")}</span>
        <div class="wish-info">
          <div class="wish-name">${esc(p.name)}</div>
          <div class="wish-price">${tk(p.price)} · ${p.stock <= 0 ? "Out of stock" : p.stock <= 5 ? `Only ${p.stock} left` : `${p.stock} in stock`}</div>
        </div>
        <div class="wish-actions">
          <button class="addbtn" data-wish-add="${esc(p.sku)}">${p.stock > 0 ? "＋ Add" : "Out of stock"}</button>
          <button class="btn btn-mini btn-ghost" data-wish-remove="${p.id}">🗑️</button>
        </div>
      </div>`).join("")
    : "<p class='modal-sub'>Your wishlist is empty. Click 🤍 on products to save them!</p>";
  
  document.querySelectorAll("[data-wish-add]").forEach(b => b.addEventListener("click", () => addToCart(b.dataset.wishAdd)));
  document.querySelectorAll("[data-wish-remove]").forEach(b => b.addEventListener("click", async () => {
    await api(`/api/wishlist/${b.dataset.wishRemove}`, { method: "DELETE" });
    loadUserPortal();
  }));
}

function renderUserProfile() {
  const u = state.user;
  $("profileName").value = u.name || "";
  $("profileEmail").value = u.email || "";
  $("profilePhone").value = u.phone || "";
  $("profileRole").textContent = u.role === "customer" ? "Customer" : u.role.charAt(0).toUpperCase() + u.role.slice(1);
  $("profileSince").textContent = u.created_at ? new Date(u.created_at).toLocaleDateString() : "—";
}

function setupProfileForm() {
  $("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/user/profile", { method: "PUT", body: { name: $("profileName").value } });
      state.user.name = $("profileName").value;
      setUIForUser();
      toast("Profile updated!");
    } catch (err) { toast(err.message, true); }
  });
  
  $("passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/user/password", { method: "PUT", body: { current: $("currentPassword").value, new: $("newPassword").value } });
      toast("Password changed!");
      $("passwordForm").reset();
    } catch (err) { toast(err.message, true); }
  });
}

/* ============================================================
   ADMIN PORTAL
   ============================================================ */
function openAdminPortal() {
  if (!state.user || (state.user.role !== "owner" && state.user.role !== "admin")) return;
  $("adminPortalModal").showModal();
  loadAdminPortal();
}

function closeAdminPortal() {
  $("adminPortalModal").close();
}

async function loadAdminPortal() {
  try {
    const [dashboard, products, orders, offers, complaints, settings] = await Promise.all([
      api("/api/admin/dashboard"),
      api("/api/admin/products"),
      api("/api/admin/orders"),
      api("/api/admin/offers"),
      api("/api/admin/complaints"),
      api("/api/admin/settings"),
    ]);
    state.adminStats = dashboard;
    state.adminProducts = products.products;
    state.adminOrders = orders.orders;
    state.adminOffers = offers.offers;
    state.adminComplaints = complaints.complaints;
    state.adminSettings = settings.settings;
    
    // Update main state products for shop
    state.products = state.adminProducts.filter(p => p.active);
    
    renderAdminDashboard();
    renderAdminProducts();
    renderAdminOrders();
    renderAdminOffers();
    renderAdminComplaints();
    renderAdminSettings();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderAdminDashboard() {
  const s = state.adminStats;
  $("adminStatsGrid").innerHTML = `
    <div class="stat-card revenue"><span class="stat-icon">💰</span><div class="stat-value">${tk(s.monthly_revenue)}</div><div class="stat-label">Monthly Revenue</div><small class="stat-help">Delivered orders this month</small></div>
    <div class="stat-card"><span class="stat-icon">📉</span><div class="stat-value">${tk(s.monthly_cost)}</div><div class="stat-label">Monthly Cost</div><small class="stat-help">Cost of goods sold</small></div>
    <div class="stat-card ${s.monthly_profit >= 0 ? "profit" : "danger"}"><span class="stat-icon">${s.monthly_profit >= 0 ? "📈" : "⚠️"}</span><div class="stat-value">${tk(Math.abs(s.monthly_profit))}</div><div class="stat-label">${s.monthly_profit >= 0 ? "Monthly Profit" : "Monthly Loss"}</div><small class="stat-help">${s.monthly_missing_cost_qty ? "Some costs are not set" : "Based on delivered orders"}</small></div>
    <div class="stat-card"><span class="stat-icon">🗓️</span><div class="stat-value">${tk(s.revenue_30d)}</div><div class="stat-label">Revenue (30d)</div></div>
    <div class="stat-card"><span class="stat-icon">🧾</span><div class="stat-value">${s.orders_placed}</div><div class="stat-label">Total Orders</div></div>
    <div class="stat-card warning"><span class="stat-icon">📦</span><div class="stat-value">${s.orders_open}</div><div class="stat-label">Open Orders</div></div>
    <div class="stat-card"><span class="stat-icon">📋</span><div class="stat-value">${s.products_total}</div><div class="stat-label">Products</div></div>
    <div class="stat-card danger"><span class="stat-icon">🚨</span><div class="stat-value">${s.out_of_stock}</div><div class="stat-label">Out of Stock</div></div>
    <div class="stat-card warning"><span class="stat-icon">🟠</span><div class="stat-value">${s.low_stock}</div><div class="stat-label">Low Stock</div></div>
    <div class="stat-card"><span class="stat-icon">👥</span><div class="stat-value">${s.customers}</div><div class="stat-label">Customers</div></div>
  `;
  
  // Low stock alert
  if (s.low_stock_items && s.low_stock_items.length) {
    $("adminLowStockAlert").hidden = false;
    $("adminLowStockList").innerHTML = s.low_stock_items.map(p => `
      <div class="low-stock-item">
        <span>${esc(p.emoji || "")} ${esc(p.name)}</span>
        <span class="stock-badge low">${p.stock} left (threshold: ${p.low_stock_threshold})</span>
        <button class="btn btn-mini btn-primary" data-restock-alert="${p.sku}">Quick Restock</button>
      </div>`).join("");
    document.querySelectorAll("[data-restock-alert]").forEach(b => b.addEventListener("click", () => {
      const p = state.adminProducts.find(x => x.sku === b.dataset.restockAlert);
      if (p) {
        $("adminRestockSku").value = p.sku;
        $("adminRestockName").value = p.name;
        $("adminRestockQty").value = 25;
        $("adminRestockModal").showModal();
      }
    }));
  } else {
    $("adminLowStockAlert").hidden = true;
  }
  
  // Recent orders
  if (s.recent_orders && s.recent_orders.length) {
    $("adminRecentOrders").innerHTML = s.recent_orders.map(o => `
      <div class="recent-order">
        <span class="order-code">${esc(o.code)}</span>
        <span class="status st-${o.status.toLowerCase().replace(/\s/g, "")}">${esc(o.status)}</span>
        <span>${esc(o.customer_name)}</span>
        <span>${tk(o.total)}</span>
      </div>`).join("");
  }
}

function renderAdminProducts() {
  const tbody = $("adminProductsTable");
  tbody.innerHTML = state.adminProducts.map(p => `
    <tr data-sku="${esc(p.sku)}">
      <td>${esc(p.emoji || "")}</td>
      <td>${esc(p.name)}<br><small>${esc(p.sku)}</small></td>
      <td>${esc(p.category)}</td>
      <td>${tk(p.price)}</td>
      <td>${p.cost_price ? tk(p.cost_price) : "<span class=\"pill pill-off\">Not set</span>"}</td>
      <td class="${p.stock <= 0 ? "danger" : p.stock <= (p.low_stock_threshold || 5) ? "warning" : ""}">${p.stock}</td>
      <td>${p.low_stock_threshold || 5}</td>
      <td><span class="pill ${p.active ? "pill-ok" : "pill-off"}">${p.active ? "Active" : "Hidden"}</span></td>
      <td>
        <div class="admin-actions">
          <button class="btn btn-mini btn-ghost" data-edit-prod="${p.sku}">Edit</button>
          <button class="btn btn-mini ${p.active ? "btn-ghost" : "btn-primary"}" data-toggle-prod="${p.sku}">${p.active ? "Hide" : "Show"}</button>
          <button class="btn btn-mini btn-danger" data-delete-prod="${p.sku}">Delete</button>
        </div>
      </td>
    </tr>`).join("");
  
  document.querySelectorAll("[data-edit-prod]").forEach(b => b.addEventListener("click", () => openProductEditor(b.dataset.editProd)));
  document.querySelectorAll("[data-toggle-prod]").forEach(b => b.addEventListener("click", async () => {
    const p = state.adminProducts.find(x => x.sku === b.dataset.toggleProd);
    if (!p) return;
    try {
      await api(`/api/admin/products/${encodeURIComponent(p.sku)}`, { method: "PUT", body: { active: !p.active } });
      loadAdminPortal();
    } catch (err) { toast(err.message, true); }
  }));
  document.querySelectorAll("[data-delete-prod]").forEach(b => b.addEventListener("click", async () => {
    const p = state.adminProducts.find(x => x.sku === b.dataset.deleteProd);
    if (!p || !confirm(`Delete ${p.name}? Products used in order history can only be hidden.`)) return;
    try {
      await api(`/api/admin/products/${encodeURIComponent(p.sku)}`, { method: "DELETE" });
      loadAdminPortal();
      toast("Product deleted.");
    } catch (err) { toast(err.message, true); }
  }));
}

function openProductEditor(sku) {
  const p = state.adminProducts.find(x => x.sku === sku);
  if (!p) return;
  const f = $("adminProductForm");
  f.dataset.sku = sku;
  f.sku.value = p.sku;
  f.name.value = p.name;
  f.category.value = p.category;
  f.price.value = p.price;
  f.cost_price.value = p.cost_price || 0;
  f.stock.value = p.stock;
  f.low_stock_threshold.value = p.low_stock_threshold || 5;
  f.emoji.value = p.emoji || "";
  f.blurb.value = p.blurb || "";
  f.model_type.value = p.model_type || "";
  f.active.checked = p.active;
  $("adminProductModalTitle").textContent = "Edit Product";
  $("adminProductModal").showModal();
}

function setupAdminProductForm() {
  $("addProductBtn").addEventListener("click", () => {
    const f = $("adminProductForm");
    f.reset();
    delete f.dataset.sku;
    f.active.checked = true;
    $("adminProductModalTitle").textContent = "Add Product";
    $("adminProductModal").showModal();
  });
  
  $("adminProductForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const body = {
        sku: f.sku.value,
        name: f.name.value,
        category: f.category.value,
        price: parseFloat(f.price.value),
        cost_price: parseFloat(f.cost_price.value || 0),
        stock: parseInt(f.stock.value || 0),
        low_stock_threshold: parseInt(f.low_stock_threshold.value || 5),
        emoji: f.emoji.value,
        blurb: f.blurb.value,
        model_type: f.model_type.value,
        active: f.active.checked
      };
      if (f.dataset.sku) {
        await api(`/api/admin/products/${encodeURIComponent(f.dataset.sku)}`, { method: "PUT", body });
      } else {
        await api("/api/admin/products", { method: "POST", body });
      }
      $("adminProductModal").close();
      loadAdminPortal();
      toast("Product saved! 🧺");
    } catch (err) { toast(err.message, true); }
  });
}

function renderAdminOrders() {
  const tbody = $("adminOrdersTable");
  tbody.innerHTML = state.adminOrders.map(o => `
    <tr data-code="${esc(o.code)}">
      <td>${esc(o.code)}</td>
      <td>${esc(o.customer_name)}<br><small>${esc(o.phone)}</small></td>
      <td>${esc(o.address)}</td>
      <td>${esc(o.payment === "bkash" ? "📱 bKash" : "💵 Cash")}</td>
      <td><span class="status st-${o.status.toLowerCase().replace(/\s/g, "")}">${esc(o.status)}</span></td>
      <td>${tk(o.total)}</td>
      <td>${timeAgo(o.created_at)}</td>
      <td>
        <div class="admin-actions">
          <select data-order-status="${esc(o.code)}" class="status-select">
            ${["Placed", "Confirmed", "Out for delivery", "Delivered", "Cancelled"].map(s => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <button class="btn btn-mini btn-ghost" data-order-note="${esc(o.code)}">Note</button>
          <button class="btn btn-mini addbtn" data-order-detail="${esc(o.code)}">View</button>
        </div>
      </td>
    </tr>`).join("");
  
  document.querySelectorAll("[data-order-status]").forEach(sel => sel.addEventListener("change", async () => {
    try {
      await api(`/api/admin/orders/${encodeURIComponent(sel.dataset.orderStatus)}`, { method: "PUT", body: { status: sel.value } });
      toast(`${sel.dataset.orderStatus} → ${sel.value} ✔`);
      loadAdminPortal();
    } catch (err) { toast(err.message, true); }
  }));
  
  document.querySelectorAll("[data-order-note]").forEach(b => b.addEventListener("click", async () => {
    const o = state.adminOrders.find(x => x.code === b.dataset.orderNote);
    if (!o) return;
    const note = prompt("Admin note:", o.admin_note || "");
    if (note !== null) {
      await api(`/api/admin/orders/${encodeURIComponent(o.code)}`, { method: "PUT", body: { status: o.status, admin_note: note } });
      loadAdminPortal();
    }
  }));
  
  document.querySelectorAll("[data-order-detail]").forEach(b => b.addEventListener("click", () => {
    const o = state.adminOrders.find(x => x.code === b.dataset.orderDetail);
    if (!o) return;
    showOrderDetail(o);
  }));
}

function showOrderDetail(order) {
  $("orderDetailCode").textContent = order.code;
  $("orderDetailContent").innerHTML = `
    <div class="order-detail-hero">
      <div>
        <span class="order-detail-label">Order placed ${timeAgo(order.created_at)}</span>
        <strong>${esc(order.code)}</strong>
      </div>
      <span class="status st-${order.status.toLowerCase().replace(/\s/g, "")}">${esc(order.status)}</span>
    </div>
    <div class="order-detail-actions">
      <label class="order-detail-status">Update status
        <select data-detail-order-status="${esc(order.code)}" class="status-select">
          ${["Placed", "Confirmed", "Out for delivery", "Delivered", "Cancelled"].map(s => `<option ${s === order.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </label>
      <button class="btn btn-mini btn-ghost" data-detail-order-note="${esc(order.code)}">Note</button>
    </div>
    <div class="order-detail-cards">
      <section class="order-detail-card">
        <h4>Customer & delivery</h4>
        <dl>
          <div><dt>Customer</dt><dd>${esc(order.customer_name)}</dd></div>
          <div><dt>Phone</dt><dd>${esc(order.phone)}</dd></div>
          <div><dt>Address</dt><dd>${esc(order.address)}</dd></div>
          <div><dt>Payment</dt><dd>${esc(order.payment === "bkash" ? "📱 bKash" : "💵 Cash on delivery")}</dd></div>
        </dl>
      </section>
      <section class="order-detail-card">
        <h4>Payment summary</h4>
        <dl>
          <div><dt>Subtotal</dt><dd>${tk(order.subtotal || order.total)}</dd></div>
          ${order.discount ? `<div><dt>Discount · ${esc(order.coupon)}</dt><dd class="order-detail-discount">−${tk(order.discount)}</dd></div>` : ""}
          <div><dt>Delivery</dt><dd>${order.delivery_fee ? tk(order.delivery_fee) : "FREE 🎉"}</dd></div>
          <div class="order-detail-total"><dt>Total</dt><dd>${tk(order.total)}</dd></div>
        </dl>
      </section>
    </div>
    <section class="order-detail-card order-detail-items">
      <h4>Items <span>${order.items.length} product${order.items.length === 1 ? "" : "s"}</span></h4>
      <ul class="order-detail-item-list">
        ${order.items.map(i => `<li><span><b>${esc(i.emoji || "")} ${esc(i.name)}</b><small>Quantity: ${i.qty}</small></span><strong>${tk(i.price * i.qty)}</strong></li>`).join("")}
      </ul>
    </section>
    ${(order.note || order.admin_note) ? `<section class="order-detail-card order-detail-notes">
      <h4>Notes</h4>
      ${order.note ? `<p><b>Customer note:</b> ${esc(order.note)}</p>` : ""}
      ${order.admin_note ? `<p><b>Admin note:</b> ${esc(order.admin_note)}</p>` : ""}
    </section>` : ""}
    ${order.status_history ? `<section class="order-detail-card order-detail-history">
      <h4>Status history</h4>
      <pre>${esc(order.status_history)}</pre>
    </section>` : ""}
    `;
  const statusSelect = document.querySelector("[data-detail-order-status]");
  statusSelect.addEventListener("change", async () => {
    try {
      await api(`/api/admin/orders/${encodeURIComponent(order.code)}`, { method: "PUT", body: { status: statusSelect.value } });
      toast(`${order.code} → ${statusSelect.value} ✔`);
      $("orderDetailModal").close();
      loadAdminPortal();
    } catch (err) {
      toast(err.message, true);
      statusSelect.value = order.status;
    }
  });
  document.querySelector("[data-detail-order-note]").addEventListener("click", async () => {
    const note = prompt("Admin note:", order.admin_note || "");
    if (note === null) return;
    try {
      await api(`/api/admin/orders/${encodeURIComponent(order.code)}`, {
        method: "PUT",
        body: { status: order.status, admin_note: note }
      });
      toast("Admin note saved.");
      $("orderDetailModal").close();
      loadAdminPortal();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("orderDetailModal").showModal();
}

function renderAdminOffers() {
  const tbody = $("adminOffersTable");
  tbody.innerHTML = state.adminOffers.map(o => `
    <tr>
      <td>🎟 ${esc(o.code)}</td>
      <td>${o.kind === "percent" ? `${parseFloat(o.value)}%` : tk(o.value)}</td>
      <td>${tk(o.min_total || 0)}</td>
      <td>${esc(o.applies)}</td>
      <td>${esc(o.description || "")}</td>
      <td>${o.usage_limit ? `${o.used_count}/${o.usage_limit}` : `${o.used_count}/∞`}</td>
      <td>${o.expires_at ? new Date(o.expires_at).toLocaleDateString() : "Never"}</td>
      <td><span class="pill ${o.active ? "pill-ok" : "pill-off"}">${o.active ? "Active" : "Paused"}</span></td>
      <td>
        <div class="admin-actions">
          <button class="btn btn-mini btn-ghost" data-edit-offer="${o.id}">Edit</button>
          <button class="btn btn-mini ${o.active ? "btn-ghost" : "btn-primary"}" data-toggle-offer="${o.id}">${o.active ? "Pause" : "Activate"}</button>
          <button class="btn btn-mini btn-danger" data-del-offer="${o.id}">Delete</button>
        </div>
      </td>
    </tr>`).join("");
  
  document.querySelectorAll("[data-toggle-offer]").forEach(b => b.addEventListener("click", async () => {
    const o = state.adminOffers.find(x => x.id == b.dataset.toggleOffer);
    if (!o) return;
    try {
      await api(`/api/admin/offers/${b.dataset.toggleOffer}`, { method: "PUT", body: { active: !o.active } });
      loadAdminPortal();
    } catch (err) { toast(err.message, true); }
  }));
  
  document.querySelectorAll("[data-del-offer]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this offer?")) return;
    try {
      await api(`/api/admin/offers/${b.dataset.delOffer}`, { method: "DELETE" });
      loadAdminPortal();
      toast("Offer deleted.");
    } catch (err) { toast(err.message, true); }
  }));

  document.querySelectorAll("[data-edit-offer]").forEach(b => b.addEventListener("click", () => openOfferEditor(b.dataset.editOffer)));
}

function setupAdminOfferForm() {
  $("addOfferBtn").addEventListener("click", () => {
    const f = $("adminOfferForm");
    f.reset();
    delete f.dataset.id;
    f.active.checked = true;
    populateAdminOfferApplies();
    $("adminOfferModalTitle").textContent = "Add Offer";
    $("adminOfferModal").showModal();
  });
  $("adminOfferForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const body = {
        code: f.code.value.toUpperCase(),
        kind: f.kind.value,
        value: parseFloat(f.value.value),
        min_total: parseFloat(f.min_total.value || 0),
        applies: f.applies.value,
        description: f.description.value,
        expires_at: f.expires_at.value || null,
        usage_limit: f.usage_limit.value ? parseInt(f.usage_limit.value) : null,
        active: f.active.checked
      };
      if (f.dataset.id) {
        await api(`/api/admin/offers/${f.dataset.id}`, { method: "PUT", body });
      } else {
        await api("/api/admin/offers", { method: "POST", body });
      }
      $("adminOfferModal").close();
      loadAdminPortal();
      toast("Offer saved! 🎟");
    } catch (err) { toast(err.message, true); }
  });
}

function populateAdminOfferApplies() {
  const cats = [...new Set(state.adminProducts.map(p => p.category))];
  $("adminOfferApplies").innerHTML = `<option value="all">Everything</option>`
    + cats.map(c => `<option value="${esc(c)}">${esc(c)} only</option>`).join("");
}

function openOfferEditor(id) {
  const o = state.adminOffers.find(x => x.id == id);
  if (!o) return;
  const f = $("adminOfferForm");
  f.dataset.id = id;
  f.code.value = o.code;
  f.kind.value = o.kind;
  f.value.value = o.value;
  f.min_total.value = o.min_total || 0;
  f.applies.value = o.applies;
  f.description.value = o.description || "";
  f.expires_at.value = o.expires_at ? o.expires_at.split("T")[0] : "";
  f.usage_limit.value = o.usage_limit || "";
  f.active.checked = o.active;
  populateAdminOfferApplies();
  $("adminOfferModalTitle").textContent = "Edit Offer";
  $("adminOfferModal").showModal();
}

function renderAdminComplaints() {
  const tbody = $("adminComplaintsTable");
  tbody.innerHTML = state.adminComplaints.map(c => `
    <tr>
      <td>${esc(c.order_code)}</td>
      <td>${esc(c.customer_name)}</td>
      <td>${c.category === "delivery" ? "🛵 Delivery" : "📦 Product"}</td>
      <td>${esc(c.message).slice(0, 60)}...</td>
      <td>${timeAgo(c.created_at)}</td>
      <td><span class="pill ${c.status === "Resolved" ? "pill-ok" : "pill-out"}">${esc(c.status)}</span></td>
      <td>
        ${c.status === "Open" ? `<button class="btn btn-mini btn-primary" data-resolve="${c.id}">Resolve</button>` : ""}
        <button class="btn btn-mini btn-ghost" data-view-complaint="${c.id}">View</button>
      </td>
    </tr>`).join("");
  
  document.querySelectorAll("[data-resolve]").forEach(b => b.addEventListener("click", async () => {
    await api(`/api/admin/complaints/${b.dataset.resolve}`, { method: "PUT", body: {} });
    loadAdminPortal();
  }));
  
  document.querySelectorAll("[data-view-complaint]").forEach(b => b.addEventListener("click", () => {
    const c = state.adminComplaints.find(x => x.id == b.dataset.viewComplaint);
    if (!c) return;
    alert(`Order: ${c.order_code}\nCustomer: ${c.customer_name}\nCategory: ${c.category}\n\nMessage:\n${c.message}\n\nStatus: ${c.status}`);
  }));
}

function renderAdminSettings() {
  const settings = state.adminSettings;
  if (!settings) return;
  $("settingDeliveryFee").value = settings.delivery_fee;
  $("settingFreeOver").value = settings.free_over;
  $("settingLowStock").value = settings.low_stock_default;
}

function setupAdminSettings() {
  $("adminSettingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data = await api("/api/admin/settings", {
        method: "PUT", 
        body: { 
          delivery_fee: parseInt($("settingDeliveryFee").value),
          free_over: parseInt($("settingFreeOver").value),
          low_stock_default: parseInt($("settingLowStock").value)
        }
      });
      state.adminSettings = { ...state.adminSettings, ...data.settings };
      toast("Settings saved!");
    } catch (err) { toast(err.message, true); }
  });
}

/* ============================================================
   NOTIFICATIONS (owner)
   ============================================================ */
function stopPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

function startPolling() {
  stopPolling();
  pollNotifications();
  state.pollTimer = setInterval(pollNotifications, 8000);
}

const NOTI_ICON = { stock_out: "🚨", low_stock: "🟠", order: "🧾", complaint: "💬" };

function notiHTML(n) {
  return `<div class="noti ${n.kind} ${n.is_read ? "read" : "unread"}" data-noti="${n.id}">
    <span class="n-icon">${NOTI_ICON[n.kind] || "🔔"}</span>
    <span class="n-msg">${esc(n.message)}<br><span class="n-time">${timeAgo(n.created_at)}</span></span>
    <span class="n-dot" title="${n.is_read ? "read" : "unread"}"></span></div>`;
}

async function pollNotifications() {
  if (!state.user || (state.user.role !== "owner" && state.user.role !== "admin")) return;
  try {
    const data = await api("/api/notifications");
    const fresh = data.notifications.filter((n) => n.id > state.lastNotiId && !n.is_read);
    state.lastNotiId = Math.max(state.lastNotiId, ...data.notifications.map((n) => n.id), 0);
    state.unread = data.unread;
    $("bellCount").textContent = data.unread > 99 ? "99+" : data.unread;
    $("bellCount").hidden = data.unread === 0;
    $("bellList").innerHTML = data.notifications.length
      ? data.notifications.map(notiHTML).join("")
      : "<p style='padding:18px;color:var(--ink-soft)'>All quiet on the shop floor. 🌿</p>";
    if (fresh.length) {
      fresh.forEach((n) => toast(`${NOTI_ICON[n.kind] || "🔔"} ${n.message}`, n.kind === "stock_out"));
      if (document.hidden && window.Notification && Notification.permission === "granted") {
        fresh.forEach((n) => new Notification("Dibbo Store", { body: n.message }));
      }
    }
  } catch { /* silently retry next tick */ }
}

function setupBell() {
  $("bellBtn").addEventListener("click", () => {
    const p = $("bellPanel");
    p.hidden = !p.hidden;
    if (!p.hidden) { pollNotifications(); askDesktopPermission(); }
  });
  document.addEventListener("click", (e) => {
    const p = $("bellPanel");
    if (!p.hidden && !p.contains(e.target) && e.target !== $("bellBtn") && !$("bellBtn").contains(e.target)) p.hidden = true;
  });
  $("bellMarkAll").addEventListener("click", markAllRead);
}

async function markAllRead() {
  await api("/api/notifications/read", { method: "POST", body: {} });
  pollNotifications();
}

function askDesktopPermission() {
  try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch { /* ignore */ }
}

/* ============================================================
   3D ADMIN STOCK VISUALIZATION
   ============================================================ */
function initAdmin3DViz() {
  if (typeof THREE === "undefined") return;
  
  const container = $("admin3dViz");
  if (!container) return;
  
  // Clear existing
  container.innerHTML = "";
  
  const width = container.clientWidth || 400;
  const height = 300;
  
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);
  
  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);
  
  // Create bars for each category
  const categories = [...new Set(state.adminProducts.map(p => p.category))];
  const barGroup = new THREE.Group();
  scene.add(barGroup);
  
  const maxStock = Math.max(...state.adminProducts.filter(p => p.active).map(p => p.stock), 1);
  
  categories.forEach((cat, i) => {
    const catProducts = state.adminProducts.filter(p => p.category === cat && p.active);
    const totalStock = catProducts.reduce((sum, p) => sum + p.stock, 0);
    const lowStock = catProducts.filter(p => p.stock > 0 && p.stock <= (p.low_stock_threshold || 5)).length;
    const outStock = catProducts.filter(p => p.stock <= 0).length;
    
    const height = Math.max(0.5, (totalStock / maxStock) * 4);
    const geometry = new THREE.BoxGeometry(1.2, height, 1.2);
    
    let color = 0x4CAF50; // green
    if (outStock > 0) color = 0xF44336; // red
    else if (lowStock > 0) color = 0xFF9800; // orange
    
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((i - (categories.length - 1) / 2) * 1.8, height / 2, 0);
    mesh.userData = { category: cat, totalStock, lowStock, outStock };
    barGroup.add(mesh);
    
    // Label
    const labelDiv = document.createElement("div");
    labelDiv.className = "viz-label";
    labelDiv.style.left = `${50 + (i / (categories.length - 1)) * (width - 100)}px`;
    labelDiv.style.bottom = "10px";
    labelDiv.textContent = cat;
    container.appendChild(labelDiv);
  });
  
  // Animation
  let angle = 0;
  function animate() {
    if (!container.isConnected) { renderer.dispose(); return; }
    angle += 0.003;
    barGroup.rotation.y = angle;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
}

/* ============================================================
   BOOT
   ============================================================ */
async function refreshProducts() {
  const data = await api("/api/bootstrap");
  state.user = data.user;
  state.products = data.products;
  state.offers = data.offers || [];
  setUIForUser();
  renderShop();
  renderOfferStrip();
}

async function boot() {
  // Load Three.js
  if (typeof THREE === "undefined") {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js";
    script.onload = () => { initThreeJS(); };
    document.head.appendChild(script);
  } else {
    initThreeJS();
  }
  
  // Setup all modals
  setupAuthModal();
  setupResetModal();
  setupCheckout();
  setupTrack();
  setupBell();
  setupAddressForm();
  setupProfileForm();
  setupAdminProductForm();
  setupAdminOfferForm();
  setupAdminSettings();
  
  // Portal tabs
  $("adminBtn").addEventListener("click", openAdminPortal);
  $("userPortalBtn").addEventListener("click", openUserPortal);
  document.querySelectorAll("[data-admin-tab]").forEach((tab) => tab.addEventListener("click", () => {
    const activeTab = tab.dataset.adminTab;
    document.querySelectorAll("[data-admin-tab]").forEach((button) => {
      button.classList.toggle("is-active", button === tab);
    });
    document.querySelectorAll(".admin-tabpanel").forEach((panel) => {
      panel.hidden = panel.id !== `adminTab-${activeTab}`;
    });
  }));
  document.querySelectorAll("[data-close-portal]").forEach(b => b.addEventListener("click", () => {
    $(b.dataset.closePortal).close();
  }));
  
  // Admin restock modal
  $("adminRestockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const p = state.adminProducts.find(x => x.sku === $("adminRestockSku").value);
      await api(`/api/admin/products/${$("adminRestockSku").value}`, { 
        method: "PUT", 
        body: { stock: p.stock + parseInt($("adminRestockQty").value) }
      });
      $("adminRestockModal").close();
      loadAdminPortal();
      toast("Restocked! 📦");
    } catch (err) { toast(err.message, true); }
  });
  
  // User complaint
  $("userComplaintForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/complaints", { method: "POST", body: { code: $("userComplaintForm").dataset.code, category: $("userComplaintCat").value, message: $("userComplaintMsg").value } });
      $("userComplaintModal").close();
      toast("Problem reported — the owner will look into it!");
      $("userComplaintMsg").value = "";
    } catch (err) { $("userComplaintError").textContent = err.message; $("userComplaintError").hidden = false; }
  });
  
  // Search/sort/filter
  $("searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderShop(); });
  $("sortSelect").addEventListener("change", (e) => { state.sort = e.target.value; renderShop(); });
  $("lowStockChip").addEventListener("click", () => {
    state.lowOnly = !state.lowOnly;
    $("lowStockChip").setAttribute("aria-pressed", state.lowOnly);
    renderShop();
  });
  
  try { await refreshProducts(); } catch (err) { toast(err.message, true); }
  renderCart();
}

boot();