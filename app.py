"""
Dibbo Store — family shop web app (Flask + SQLite).

Run:  python app.py   ->  http://127.0.0.1:5000
Owner login (seeded): owner@dibbostore.com / dibbo1234
"""
import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, render_template, request, session

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dibbo.db")
LOW_STOCK = 5          # "running low" threshold
CANCEL_WINDOW_H = 12   # hours a customer may cancel an order
DELIVERY_FEE = 60      # ৳ delivery charge
FREE_OVER = 1500       # free delivery above this basket size

app = Flask(__name__)
app.secret_key = os.environ.get("DIBBO_SECRET", "dibbo-store-family-secret-key")


# ---------------------------------------------------------------- database

def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def query(sql, args=(), one=False):
    cur = db().execute(sql, args)
    rows = cur.fetchall()
    cur.close()
    return (rows[0] if rows else None) if one else rows


def execute(sql, args=()):
    cur = db().execute(sql, args)
    cur.close()
    db().commit()


# ---------------------------------------------------------------- passwords

def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return f"{salt}${digest}"


def check_password(password, stored):
    try:
        salt, digest = stored.split("$", 1)
    except ValueError:
        return False
    good = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return hmac.compare_digest(good, digest)


# ---------------------------------------------------------------- auth helpers

def current_user():
    uid = session.get("uid")
    if uid is None:
        return None
    return query("SELECT * FROM users WHERE id = ?", (uid,), one=True)


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        user = current_user()
        if not user:
            return jsonify(error="Please log in first."), 401
        return fn(user, *a, **kw)
    return wrapper


def owner_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        user = current_user()
        if not user:
            return jsonify(error="Please log in first."), 401
        if user["role"] != "owner":
            return jsonify(error="Owner access only."), 403
        return fn(user, *a, **kw)
    return wrapper


def public_user(row):
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"]}


def admin_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        user = current_user()
        if not user:
            return jsonify(error="Please log in first."), 401
        if user["role"] not in ("owner", "admin"):
            return jsonify(error="Admin access only."), 403
        return fn(user, *a, **kw)
    return wrapper


# ---------------------------------------------------------------- auth hardening

LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_MIN = 15
SESSION_TIMEOUT_MIN = 30
REMEMBER_DAYS = 30

def is_locked(user):
    if not user["locked_until"]:
        return False
    try:
        return datetime.fromisoformat(user["locked_until"]) > datetime.now()
    except ValueError:
        return False


def record_failed_login(user):
    attempts = user["failed_attempts"] + 1
    if attempts >= LOGIN_MAX_ATTEMPTS:
        locked = (datetime.now() + timedelta(minutes=LOGIN_LOCKOUT_MIN)).isoformat(timespec="seconds")
        execute("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?",
                (attempts, locked, user["id"]))
    else:
        execute("UPDATE users SET failed_attempts = ? WHERE id = ?", (attempts, user["id"]))


def clear_failed_login(user):
    execute("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?", (user["id"],))


def generate_csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_hex(16)
    return session["csrf_token"]


def validate_csrf(token):
    return token and hmac.compare_digest(token, session.get("csrf_token", ""))


# ---------------------------------------------------------------- notifications

def notify(kind, message, product_id=None):
    """Drop a notification for the shop owner (kind: stock_out|low_stock|order|complaint)."""
    execute(
        "INSERT INTO notifications (kind, message, product_id, created_at) VALUES (?, ?, ?, ?)",
        (kind, message, product_id, datetime.now().isoformat(timespec="seconds")),
    )


def check_stock_after_change(product_row, old_stock):
    """Raise stock_out / low_stock notifications when a stock change crosses a threshold."""
    new_stock = product_row["stock"]
    name = product_row["name"]
    if new_stock <= 0:
        if old_stock > 0:
            notify("stock_out", f"OUT OF STOCK: {name} sold out — restock soon!", product_row["id"])
    elif new_stock <= LOW_STOCK and old_stock > LOW_STOCK:
        notify("low_stock", f"Running low: {name} — only {new_stock} left.", product_row["id"])


# ---------------------------------------------------------------- seed data

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    last_login TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    reset_token TEXT,
    reset_expires TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    cost_price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 5,
    emoji TEXT DEFAULT '',
    blurb TEXT DEFAULT '',
    model_type TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    payment TEXT NOT NULL DEFAULT 'cash',
    note TEXT DEFAULT '',
    total REAL NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    coupon TEXT NOT NULL DEFAULT '',
    delivery_fee REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Placed',
    status_history TEXT DEFAULT '',
    admin_note TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT DEFAULT '',
    price REAL NOT NULL,
    cost_price REAL NOT NULL DEFAULT 0,
    qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    product_id INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    category TEXT NOT NULL DEFAULT 'product',
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'percent',
    value REAL NOT NULL,
    min_total REAL NOT NULL DEFAULT 0,
    applies TEXT NOT NULL DEFAULT 'all',
    description TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    usage_limit INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    label TEXT NOT NULL DEFAULT 'Home',
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    created_at TEXT NOT NULL,
    UNIQUE(user_id, product_id)
);
"""


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    
    # ---- Migrations for existing tables ----
    # users
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    for col, decl in (("last_login", "TEXT"), ("failed_attempts", "INTEGER NOT NULL DEFAULT 0"),
                      ("locked_until", "TEXT"), ("reset_token", "TEXT"),
                      ("reset_expires", "TEXT")):
        if col not in cols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
    
    # products
    cols = [r[1] for r in conn.execute("PRAGMA table_info(products)").fetchall()]
    for col, decl in (("cost_price", "REAL NOT NULL DEFAULT 0"),
                      ("low_stock_threshold", "INTEGER NOT NULL DEFAULT 5"),
                      ("model_type", "TEXT DEFAULT ''")):
        if col not in cols:
            conn.execute(f"ALTER TABLE products ADD COLUMN {col} {decl}")

    # order item cost snapshots keep historical profit calculations stable
    cols = [r[1] for r in conn.execute("PRAGMA table_info(order_items)").fetchall()]
    if "cost_price" not in cols:
        conn.execute("ALTER TABLE order_items ADD COLUMN cost_price REAL NOT NULL DEFAULT 0")
    
    # orders
    cols = [r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    for col, decl in (("discount", "REAL DEFAULT 0"), ("coupon", "TEXT DEFAULT ''"),
                      ("delivery_fee", "REAL DEFAULT 0"), ("status_history", "TEXT DEFAULT ''"),
                      ("admin_note", "TEXT DEFAULT ''")):
        if col not in cols:
            conn.execute(f"ALTER TABLE orders ADD COLUMN {col} {decl}")
    
    # offers
    cols = [r[1] for r in conn.execute("PRAGMA table_info(offers)").fetchall()]
    for col, decl in (("expires_at", "TEXT"), ("usage_limit", "INTEGER"),
                      ("used_count", "INTEGER NOT NULL DEFAULT 0")):
        if col not in cols:
            conn.execute(f"ALTER TABLE offers ADD COLUMN {col} {decl}")
    
    conn.commit()
    conn.close()


SEED_PRODUCTS = [
    # sku, name, category, price, stock, emoji, blurb, model_type
    ("GRV-001", "Chinigura Rice 5kg", "Groceries", 720, 24, "🍚", "Fragrant polao rice from our trusted mill.", "bag"),
    ("GRV-002", "Mustard Oil 1L", "Groceries", 320, 18, "🛢️", "Cold-pressed, strong aroma, family favourite.", "bottle"),
    ("GRV-003", "Farm Eggs (dozen)", "Groceries", 145, 30, "🥚", "Collected fresh every morning.", "box"),
    ("GRV-004", "Milk Powder 1kg", "Groceries", 850, 4, "🥛", "Full cream, makes 10 litres.", "bag"),
    ("GRV-005", "Miniket Rice 25kg", "Groceries", 1850, 8, "🌾", "Monthly family pack at wholesale rate.", "bag"),
    ("GRV-006", "Pure Honey 500g", "Groceries", 550, 2, "🍯", "Sundarbans raw honey, unprocessed.", "jar"),
    ("FRS-001", "Seasonal Apples (kg)", "Fresh", 260, 20, "🍎", "Crisp and sweet, hand-picked crates.", "fruit"),
    ("FRS-002", "Bananas (dozen)", "Fresh", 130, 15, "🍌", "Sagor variety, ripened naturally.", "fruit"),
    ("FRS-003", "Baby Potatoes 5kg", "Fresh", 210, 0, "🥔", "New harvest, perfect for curry.", "veg"),
    ("SNK-001", "Spicy Chanachur 500g", "Snacks", 165, 25, "🥜", "Extra hot mix for evening adda.", "box"),
    ("SNK-002", "Butter Cookies Box", "Snacks", 240, 12, "🍪", "Melts in the mouth, kids love it.", "box"),
    ("DRK-001", "Tea Leaves 400g", "Drinks", 385, 3, "🍵", "Strong Sylleti blend for the whole family.", "box"),
    ("DRK-002", "Instant Coffee 250g", "Drinks", 620, 9, "☕", "Smooth roast, wake-up guaranteed.", "jar"),
    ("HOM-001", "Detergent Powder 1kg", "Home", 265, 22, "🧼", "Tough on stains, gentle on hands.", "box"),
    ("HOM-002", "Dish Wash 500ml", "Home", 120, 16, "🧽", "Lemon fresh, cuts grease fast.", "bottle"),
    ("CAR-001", "Family Toothpaste 200g", "Care", 145, 14, "🪥", "Salt + herbal, dentist approved.", "tube"),
    ("CAR-002", "Herbal Shampoo 500ml", "Care", 360, 5, "🧴", "Amla & neem for everyday hair.", "bottle"),
]

SEED_OWNER = ("Dibbo Store Owner", "owner@dibbostore.com", "dibbo1234")


SEED_OFFERS = [
    # code, kind, value, min_total, applies, description
    ("FAMILY10", "percent", 10, 500, "all", "10% off your whole basket over ৳500"),
    ("FRESH50", "flat", 50, 400, "Fresh", "৳50 off fresh fruits & veggies over ৳400"),
]


def seed_if_empty():
    init_db()
    if query("SELECT id FROM offers LIMIT 1", one=True) is None:
        for code, kind, value, min_total, applies, desc in SEED_OFFERS:
            execute(
                "INSERT INTO offers (code, kind, value, min_total, applies, description, active, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
                (code, kind, value, min_total, applies, desc, datetime.now().isoformat(timespec="seconds")),
            )
    if query("SELECT id FROM products LIMIT 1", one=True) is not None:
        return
    for sku, name, cat, price, stock, emoji, blurb, model_type in SEED_PRODUCTS:
        execute(
            "INSERT INTO products (sku, name, category, price, stock, emoji, blurb, model_type, low_stock_threshold, active, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, 1, ?)",
            (sku, name, cat, price, stock, emoji, blurb, model_type, datetime.now().isoformat(timespec="seconds")),
        )
    if query("SELECT id FROM users LIMIT 1", one=True) is None:
        execute(
            "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
            (SEED_OWNER[0], SEED_OWNER[1], hash_password(SEED_OWNER[2]),
             datetime.now().isoformat(timespec="seconds")),
        )
    # Demo notifications so the owner bell has something to show on first login.
    for p in query("SELECT * FROM products WHERE stock <= ?", (LOW_STOCK,)):
        if p["stock"] == 0:
            notify("stock_out", f"OUT OF STOCK: {p['name']} sold out — restock soon!", p["id"])
        else:
            notify("low_stock", f"Running low: {p['name']} — only {p['stock']} left.", p["id"])


# ---------------------------------------------------------------- offers / bill

def offer_for_code(code):
    offer = query("SELECT * FROM offers WHERE code = ? AND active = 1",
                  ((code or "").strip().upper(),), one=True)
    if not offer:
        return None
    # Check expiry
    if offer["expires_at"]:
        try:
            if datetime.fromisoformat(offer["expires_at"]) < datetime.now():
                return None
        except ValueError:
            pass
    # Check usage limit
    if offer["usage_limit"] and offer["used_count"] >= offer["usage_limit"]:
        return None
    return offer


def bill_math(items):
    """Validate cart items and compute the subtotal. Returns (lines, subtotal)
    or raises ValueError with a user-facing message."""
    lines = []
    subtotal = 0.0
    for it in items:
        sku = (it.get("sku") or "").strip().upper()
        try:
            qty = int(it.get("qty") or 0)
        except (TypeError, ValueError):
            raise ValueError("Quantity must be a number.")
        prod = query("SELECT * FROM products WHERE sku = ? AND active = 1", (sku,), one=True)
        if not prod:
            raise ValueError(f"We no longer sell '{sku}'. Remove it from your basket.")
        if qty < 1:
            continue
        if prod["stock"] < qty:
            raise ValueError(f"Only {prod['stock']} left of {prod['name']} — please adjust your basket.")
        lines.append((prod, qty, round(prod["price"] * qty, 2)))
        subtotal += prod["price"] * qty
    if not lines:
        raise ValueError("Your basket is empty.")
    return lines, round(subtotal, 2)


def apply_offer(lines, subtotal, code):
    """Return (discount, coupon_code, error)."""
    if not code:
        return 0.0, "", None
    offer = offer_for_code(code)
    if not offer:
        return 0.0, "", "That coupon code is expired or invalid. 🙈"
    base = sum(amt for p, q, amt in lines if offer["applies"] == "all" or p["category"] == offer["applies"])
    if base <= 0:
        return 0.0, "", f"'{offer['code']}' doesn't apply to anything in your basket."
    if subtotal < offer["min_total"]:
        return 0.0, "", f"'{offer['code']}' needs a basket of at least ৳{offer['min_total']:,.0f}."
    if offer["kind"] == "percent":
        return round(base * offer["value"] / 100.0, 2), offer["code"], None
    return round(min(offer["value"], base), 2), offer["code"], None


def delivery_fee_for(net):
    return 0.0 if net >= FREE_OVER else float(DELIVERY_FEE)


def money(x):
    s = f"৳{float(x):,.2f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


@app.post("/api/offers/validate")
def offers_validate():
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip()
    if not code:
        return jsonify(error="Enter a coupon code first."), 400
    try:
        lines, subtotal = bill_math(data.get("items") or [])
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    discount, used, err = apply_offer(lines, subtotal, code)
    if err:
        return jsonify(error=err), 400
    fee = delivery_fee_for(subtotal - discount)
    return jsonify(ok=True, code=used, discount=discount, delivery_fee=fee,
                   subtotal=subtotal, total=round(subtotal - discount + fee, 2))


# ---------------------------------------------------------------- shop APIs

@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/bootstrap")
def bootstrap():
    """Public init payload: products + current user + active offers in one request."""
    user = current_user()
    products = query(
        "SELECT * FROM products WHERE active = 1 ORDER BY category, name"
    )
    offers = query(
        "SELECT code, kind, value, min_total, applies, description FROM offers WHERE active = 1"
    )
    return jsonify(
        user=public_user(user) if user else None,
        products=[dict(p) for p in products],
        offers=[dict(o) for o in offers],
    )


@app.post("/api/register")
def register():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not name or len(name) > 100:
        return jsonify(error="Please tell us your name."), 400
    if "@" not in email or len(email) > 100:
        return jsonify(error="That email doesn't look right."), 400
    if len(password) < 8:
        return jsonify(error="Password needs at least 8 characters."), 400
    if query("SELECT id FROM users WHERE email = ?", (email,), one=True):
        return jsonify(error="An account with this email already exists — try logging in."), 409
    execute(
        "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'customer', ?)",
        (name, email, hash_password(password), datetime.now().isoformat(timespec="seconds")),
    )
    row = query("SELECT * FROM users WHERE email = ?", (email,), one=True)
    session["uid"] = row["id"]
    return jsonify(user=public_user(row))


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    row = query("SELECT * FROM users WHERE email = ?", (email,), one=True)
    if not row:
        return jsonify(error="Wrong email or password."), 401
    
    if is_locked(row):
        return jsonify(error=f"Account locked. Try again in {LOGIN_LOCKOUT_MIN} minutes."), 429
    
    if not check_password(password, row["password_hash"]):
        record_failed_login(row)
        return jsonify(error="Wrong email or password."), 401
    
    clear_failed_login(row)
    execute("UPDATE users SET last_login = ? WHERE id = ?", (datetime.now().isoformat(timespec="seconds"), row["id"]))
    session["uid"] = row["id"]
    session.permanent = True
    app.permanent_session_lifetime = timedelta(days=REMEMBER_DAYS)
    return jsonify(user=public_user(row), csrf_token=generate_csrf_token())


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.post("/api/orders")
def place_order():
    """Place an order (guest or logged-in). Body: {items:[{sku,qty}], coupon, name, phone, address, payment, note}"""
    user = current_user()
    if user and user["role"] in ("owner", "admin"):
        return jsonify(error="Admin accounts can manage orders but cannot place customer orders."), 403
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    phone = (data.get("phone") or "").strip()
    address = (data.get("address") or "").strip()
    payment = data.get("payment") if data.get("payment") in ("cash", "bkash") else "cash"
    note = (data.get("note") or "").strip()[:300]
    coupon_code = (data.get("coupon") or "").strip()
    if not name or not phone or not address:
        return jsonify(error="Name, phone and address are needed for delivery."), 400

    try:
        lines, subtotal = bill_math(data.get("items") or [])
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    discount, coupon, err = apply_offer(lines, subtotal, coupon_code)
    if err:
        return jsonify(error=err), 400
    fee = delivery_fee_for(subtotal - discount)
    total = round(subtotal - discount + fee, 2)

    conn = db()
    placed = datetime.now().isoformat(timespec="seconds")
    try:
        conn.execute("BEGIN")
        for prod, qty, _amt in lines:  # re-check stock inside the transaction
            fresh = conn.execute("SELECT stock FROM products WHERE id = ?", (prod["id"],)).fetchone()
            if fresh["stock"] < qty:
                conn.rollback()
                return jsonify(error=f"Only {fresh['stock']} left of {prod['name']} — please adjust your basket."), 409

        cur = conn.execute(
            "INSERT INTO orders (code, user_id, customer_name, phone, address, payment, note, total,"
            " discount, coupon, delivery_fee, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Placed', ?)",
            ("", session.get("uid"), name, phone, address, payment, note, total,
             discount, coupon, fee, placed),
        )
        order_id = cur.lastrowid
        code = f"DB-{1000 + order_id}"
        conn.execute("UPDATE orders SET code = ? WHERE id = ?", (code, order_id))
        for prod, qty, _amt in lines:
            conn.execute(
                "INSERT INTO order_items (order_id, sku, name, emoji, price, cost_price, qty) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (order_id, prod["sku"], prod["name"], prod["emoji"], prod["price"], prod["cost_price"], qty),
            )
            old_stock = conn.execute("SELECT stock FROM products WHERE id = ?", (prod["id"],)).fetchone()["stock"]
            conn.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (qty, prod["id"]))
            fresh = conn.execute("SELECT * FROM products WHERE id = ?", (prod["id"],)).fetchone()
            check_stock_after_change(fresh, old_stock)
        # Increment offer used_count if coupon applied
        if coupon:
            conn.execute("UPDATE offers SET used_count = used_count + 1 WHERE code = ?", (coupon,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    qty_total = sum(q for _, q, _ in lines)
    bill_note = f" — {money(total)}"
    if discount:
        bill_note += f" (coupon {coupon}: −{money(discount)})"
    notify("order", f"New order {code}: {name}{bill_note} ({qty_total} items).")
    return jsonify(ok=True, code=code, total=total, subtotal=subtotal,
                   discount=discount, coupon=coupon, delivery_fee=fee, eta="2–5 working days")


@app.get("/api/track/<code>")
def track(code):
    order = query("SELECT * FROM orders WHERE code = ?", (code.strip().upper(),), one=True)
    if not order:
        return jsonify(error="No order found with that code."), 404
    items = query("SELECT * FROM order_items WHERE order_id = ?", (order["id"],))
    return jsonify(order={k: order[k] for k in ("code", "customer_name", "status", "total", "discount", "coupon", "delivery_fee", "payment", "created_at")},
                   items=[dict(i) for i in items])


@app.get("/api/orders/mine")
@login_required
def my_orders(user):
    orders = query("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", (user["id"],))
    result = []
    now = datetime.now()
    for o in orders:
        items = query("SELECT * FROM order_items WHERE order_id = ?", (o["id"],))
        placed_at = datetime.fromisoformat(o["created_at"])
        result.append({
            **{k: o[k] for k in ("code", "status", "total", "discount", "coupon", "delivery_fee", "payment", "created_at")},
            "items": [dict(i) for i in items],
            "can_cancel": o["status"] in ("Placed", "Confirmed") and now - placed_at <= timedelta(hours=CANCEL_WINDOW_H),
        })
    return jsonify(orders=result)


@app.post("/api/orders/<code>/cancel")
@login_required
def cancel_order(user, code):
    order = query("SELECT * FROM orders WHERE code = ?", (code.upper(),), one=True)
    if not order or order["user_id"] != user["id"]:
        return jsonify(error="Order not found."), 404
    placed_at = datetime.fromisoformat(order["created_at"])
    if not (order["status"] in ("Placed", "Confirmed") and datetime.now() - placed_at <= timedelta(hours=CANCEL_WINDOW_H)):
        return jsonify(error="This order can no longer be cancelled (12-hour window passed or already out for delivery)."), 409
    items = query("SELECT * FROM order_items WHERE order_id = ?", (order["id"],))
    for it in items:
        p = query("SELECT * FROM products WHERE sku = ?", (it["sku"],), one=True)
        if p:
            old = p["stock"]
            execute("UPDATE products SET stock = stock + ? WHERE id = ?", (it["qty"], p["id"]))
            check_stock_after_change(query("SELECT * FROM products WHERE id = ?", (p["id"],), one=True), old)
    execute("UPDATE orders SET status = 'Cancelled' WHERE id = ?", (order["id"],))
    notify("order", f"Order {order['code']} cancelled by {order['customer_name']} — stock restored.")
    return jsonify(ok=True)


@app.post("/api/complaints")
def complaint():
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip().upper()
    category = data.get("category") or "product"
    message = (data.get("message") or "").strip()
    order = query("SELECT * FROM orders WHERE code = ?", (code,), one=True)
    if not order:
        return jsonify(error="Order code not found — check your confirmation message."), 404
    if len(message) < 10:
        return jsonify(error="Please describe the problem in at least 10 characters."), 400
    execute(
        "INSERT INTO complaints (order_id, category, message, status, created_at) VALUES (?, ?, ?, 'Open', ?)",
        (order["id"], category if category in ("product", "delivery") else "product", message,
         datetime.now().isoformat(timespec="seconds")),
    )
    notify("complaint", f"Problem reported on order {code} ({category}): {message[:80]}")
    return jsonify(ok=True, thanks="Thank you! The owner will look into it and reach out to you.")


# ---------------------------------------------------------------- owner APIs

@app.get("/api/admin/overview")
@admin_required
def admin_overview(user):
    revenue = query("SELECT COALESCE(SUM(total),0) t FROM orders WHERE status = 'Delivered'", one=True)["t"]
    stats = {
        "revenue": revenue,
        "orders_placed": query("SELECT COUNT(*) c FROM orders", one=True)["c"],
        "orders_open": query("SELECT COUNT(*) c FROM orders WHERE status IN ('Placed','Confirmed','Out for delivery')", one=True)["c"],
        "products": query("SELECT COUNT(*) c FROM products", one=True)["c"],
        "out_of_stock": query("SELECT COUNT(*) c FROM products WHERE stock <= 0 AND active = 1", one=True)["c"],
        "low_stock": query("SELECT COUNT(*) c FROM products WHERE stock > 0 AND stock <= ?", (LOW_STOCK,), one=True)["c"],
        "customers": query("SELECT COUNT(*) c FROM users WHERE role = 'customer'", one=True)["c"],
    }
    return jsonify(stats=stats)


@app.get("/api/admin/products")
@admin_required
def admin_products(user):
    return jsonify(products=[dict(p) for p in query("SELECT * FROM products ORDER BY category, name")])


@app.post("/api/admin/products")
@admin_required
def admin_add_product(user):
    data = request.get_json(silent=True) or {}
    sku = (data.get("sku") or "").strip().upper()
    name = (data.get("name") or "").strip()
    category = (data.get("category") or "Groceries").strip()
    emoji = (data.get("emoji") or "🛍️").strip()[:8]
    blurb = (data.get("blurb") or "").strip()[:200]
    try:
        price = round(float(data.get("price")), 2)
        cost_price = round(float(data.get("cost_price", 0)), 2)
        stock = int(data.get("stock") or 0)
    except (TypeError, ValueError):
        return jsonify(error="Price and stock must be numbers."), 400
    if not sku or not name:
        return jsonify(error="SKU and product name are required."), 400
    if price <= 0 or cost_price < 0 or stock < 0:
        return jsonify(error="Selling price must be above 0; cost price and stock can't be negative."), 400
    if query("SELECT id FROM products WHERE sku = ?", (sku,), one=True):
        return jsonify(error=f"SKU {sku} already exists."), 409
    model_type = (data.get("model_type") or "").strip()[:20]
    low_stock_threshold = int(data.get("low_stock_threshold", 5))
    execute(
        "INSERT INTO products (sku, name, category, price, cost_price, stock, emoji, blurb, model_type, low_stock_threshold, active, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (sku, name, category, price, cost_price, stock, emoji, blurb, model_type, low_stock_threshold, datetime.now().isoformat(timespec="seconds")),
    )
    check_stock_after_change(query("SELECT * FROM products WHERE sku = ?", (sku,), one=True), 99)
    return jsonify(ok=True)


@app.put("/api/admin/products/<sku>")
@admin_required
def admin_update_product(user, sku):
    p = query("SELECT * FROM products WHERE sku = ?", (sku.upper(),), one=True)
    if not p:
        return jsonify(error="Product not found."), 404
    data = request.get_json(silent=True) or {}
    try:
        price = round(float(data.get("price", p["price"])), 2)
        cost_price = round(float(data.get("cost_price", p["cost_price"])), 2)
        stock = int(data.get("stock", p["stock"]))
    except (TypeError, ValueError):
        return jsonify(error="Price and stock must be numbers."), 400
    name = (data.get("name") or p["name"]).strip()
    category = (data.get("category") or p["category"]).strip()
    blurb = (data.get("blurb") if data.get("blurb") is not None else p["blurb"]).strip()[:200]
    emoji = (data.get("emoji") or p["emoji"]).strip()[:8]
    model_type = (data.get("model_type") if data.get("model_type") is not None else p["model_type"]).strip()[:20]
    low_stock_threshold = int(data.get("low_stock_threshold", p["low_stock_threshold"]))
    active = 1 if str(data.get("active", p["active"])).lower() in ("1", "true", "on") else 0
    if price <= 0 or cost_price < 0 or stock < 0 or low_stock_threshold < 0:
        return jsonify(error="Selling price must be above 0; cost price, stock and threshold can't be negative."), 400
    execute(
        "UPDATE products SET name=?, category=?, price=?, cost_price=?, stock=?, emoji=?, blurb=?, model_type=?, low_stock_threshold=?, active=? WHERE id=?",
        (name, category, price, cost_price, max(stock, 0), emoji, blurb, model_type, low_stock_threshold, active, p["id"]),
    )
    check_stock_after_change(query("SELECT * FROM products WHERE id = ?", (p["id"],), one=True), p["stock"])
    return jsonify(ok=True, product=dict(query("SELECT * FROM products WHERE id = ?", (p["id"],), one=True)))


@app.delete("/api/admin/products/<sku>")
@admin_required
def admin_delete_product(user, sku):
    p = query("SELECT * FROM products WHERE sku = ?", (sku.upper(),), one=True)
    if not p:
        return jsonify(error="Product not found."), 404
    if query("SELECT id FROM order_items WHERE sku = ? LIMIT 1", (p["sku"],), one=True):
        return jsonify(error="This product is used in order history. Hide it instead of deleting it."), 409
    execute("DELETE FROM wishlist WHERE product_id = ?", (p["id"],))
    execute("DELETE FROM products WHERE id = ?", (p["id"],))
    return jsonify(ok=True)


@app.get("/api/admin/orders")
@admin_required
def admin_orders(user):
    orders = query("SELECT * FROM orders ORDER BY id DESC LIMIT 200")
    result = []
    for o in orders:
        items = query("SELECT * FROM order_items WHERE order_id = ?", (o["id"],))
        result.append({**{k: o[k] for k in ("code", "customer_name", "phone", "address", "payment", "note", "status", "total", "discount", "coupon", "delivery_fee", "created_at")},
                       "items": [dict(i) for i in items]})
    return jsonify(orders=result)


@app.put("/api/admin/orders/<code>")
@admin_required
def admin_order_status(user, code):
    order = query("SELECT * FROM orders WHERE code = ?", (code.upper(),), one=True)
    if not order:
        return jsonify(error="Order not found."), 404
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    admin_note = (data.get("admin_note") or "").strip()[:300]
    allowed = ("Placed", "Confirmed", "Out for delivery", "Delivered", "Cancelled")
    if status not in allowed:
        return jsonify(error="Invalid status."), 400
    if order["status"] == "Cancelled" and status != "Cancelled":
        return jsonify(error="Cancelled orders can't be changed."), 409
    
    # Build status history entry
    hist_entry = f"{datetime.now().isoformat(timespec='seconds')}|{order['status']}→{status}|{user['name']}"
    old_history = order["status_history"] or ""
    new_history = (old_history + "\n" + hist_entry).strip() if old_history else hist_entry
    
    execute("UPDATE orders SET status = ?, status_history = ?, admin_note = ? WHERE id = ?",
            (status, new_history, admin_note, order["id"]))
    
    # If cancelling, restore stock
    if status == "Cancelled" and order["status"] != "Cancelled":
        items = query("SELECT * FROM order_items WHERE order_id = ?", (order["id"],))
        for it in items:
            p = query("SELECT * FROM products WHERE sku = ?", (it["sku"],), one=True)
            if p:
                old = p["stock"]
                execute("UPDATE products SET stock = stock + ? WHERE id = ?", (it["qty"], p["id"]))
                check_stock_after_change(query("SELECT * FROM products WHERE id = ?", (p["id"],), one=True), old)
        notify("order", f"Order {order['code']} cancelled by admin — stock restored.")
    
    return jsonify(ok=True)


@app.get("/api/admin/complaints")
@admin_required
def admin_complaints(user):
    rows = query(
        "SELECT c.*, o.code AS order_code, o.customer_name FROM complaints c"
        " JOIN orders o ON o.id = c.order_id ORDER BY c.id DESC LIMIT 100"
    )
    return jsonify(complaints=[dict(r) for r in rows])


@app.put("/api/admin/complaints/<int:cid>")
@admin_required
def admin_resolve_complaint(user, cid):
    c = query("SELECT * FROM complaints WHERE id = ?", (cid,), one=True)
    if not c:
        return jsonify(error="Complaint not found."), 404
    execute("UPDATE complaints SET status = 'Resolved' WHERE id = ?", (cid,))
    return jsonify(ok=True)


@app.get("/api/admin/offers")
@admin_required
def admin_offers(user):
    return jsonify(offers=[dict(o) for o in query("SELECT * FROM offers ORDER BY id DESC")])


@app.post("/api/admin/offers")
@admin_required
def admin_add_offer(user):
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip().upper()
    kind = data.get("kind") if data.get("kind") in ("percent", "flat") else "percent"
    try:
        value = round(float(data.get("value")), 2)
        min_total = round(float(data.get("min_total") or 0), 2)
    except (TypeError, ValueError):
        return jsonify(error="Value and minimum must be numbers."), 400
    applies = (data.get("applies") or "all").strip() or "all"
    description = (data.get("description") or "").strip()[:160]
    expires_at = (data.get("expires_at") or "").strip()
    usage_limit = data.get("usage_limit")
    if usage_limit is not None:
        try:
            usage_limit = int(usage_limit)
            if usage_limit < 1:
                usage_limit = None
        except (TypeError, ValueError):
            usage_limit = None
    if not code or len(code) > 20 or not code.replace("_", "").isalnum():
        return jsonify(error="Code: letters/numbers, up to 20 characters."), 400
    if value <= 0:
        return jsonify(error="Offer value must be above 0."), 400
    if kind == "percent" and value > 90:
        return jsonify(error="Percent can't be more than 90."), 400
    if query("SELECT id FROM offers WHERE code = ?", (code,), one=True):
        return jsonify(error=f"Code {code} already exists."), 409
    execute(
        "INSERT INTO offers (code, kind, value, min_total, applies, description, expires_at, usage_limit, active, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (code, kind, value, min_total, applies, description, expires_at or None, usage_limit, datetime.now().isoformat(timespec="seconds")),
    )
    return jsonify(ok=True)


@app.put("/api/admin/offers/<int:oid>")
@admin_required
def admin_update_offer(user, oid):
    o = query("SELECT * FROM offers WHERE id = ?", (oid,), one=True)
    if not o:
        return jsonify(error="Offer not found."), 404
    data = request.get_json(silent=True) or {}
    active = 1 if str(data.get("active", o["active"])).lower() in ("1", "true", "on") else 0
    kind = data.get("kind") if data.get("kind") in ("percent", "flat") else o["kind"]
    try:
        value = round(float(data.get("value", o["value"])), 2)
        min_total = round(float(data.get("min_total", o["min_total"])), 2)
    except (TypeError, ValueError):
        return jsonify(error="Value and minimum must be numbers."), 400
    applies = (data.get("applies") or o["applies"]).strip() or "all"
    description = (data.get("description") if data.get("description") is not None else o["description"]).strip()[:160]
    expires_at = (data.get("expires_at") if data.get("expires_at") is not None else o["expires_at"])
    usage_limit = data.get("usage_limit") if data.get("usage_limit") is not None else o["usage_limit"]
    if value <= 0:
        return jsonify(error="Offer value must be above 0."), 400
    if kind == "percent" and value > 90:
        return jsonify(error="Percent can't be more than 90."), 400
    execute(
        "UPDATE offers SET active=?, kind=?, value=?, min_total=?, applies=?, description=?, expires_at=?, usage_limit=? WHERE id=?",
        (active, kind, value, min_total, applies, description, expires_at, usage_limit, oid),
    )
    return jsonify(ok=True, active=active)


@app.delete("/api/admin/offers/<int:oid>")
@admin_required
def admin_delete_offer(user, oid):
    execute("DELETE FROM offers WHERE id = ?", (oid,))
    return jsonify(ok=True)


@app.get("/api/notifications")
@admin_required
def notifications(user):
    rows = query("SELECT * FROM notifications ORDER BY id DESC LIMIT 50")
    unread = query("SELECT COUNT(*) c FROM notifications WHERE is_read = 0", one=True)["c"]
    return jsonify(notifications=[dict(r) for r in rows], unread=unread)


@app.post("/api/notifications/read")
@admin_required
def notifications_read(user):
    data = request.get_json(silent=True) or {}
    if data.get("id"):
        execute("UPDATE notifications SET is_read = 1 WHERE id = ?", (data["id"],))
    else:
        execute("UPDATE notifications SET is_read = 1")
    unread = query("SELECT COUNT(*) c FROM notifications WHERE is_read = 0", one=True)["c"]
    return jsonify(ok=True, unread=unread)


# ---------------------------------------------------------------- password reset

@app.post("/api/password/forgot")
def password_forgot():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    user = query("SELECT * FROM users WHERE email = ?", (email,), one=True)
    if not user:
        return jsonify(ok=True, message="If that email exists, a reset link has been sent.")
    token = secrets.token_urlsafe(24)
    expires = (datetime.now() + timedelta(hours=1)).isoformat(timespec="seconds")
    execute("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?",
            (token, expires, user["id"]))
    # In production, email this link. For demo, return it.
    reset_url = f"{request.host_url}reset/{token}"
    return jsonify(ok=True, message="Reset link generated.", reset_url=reset_url)


@app.post("/api/password/reset")
def password_reset():
    data = request.get_json(silent=True) or {}
    token = (data.get("token") or "").strip()
    password = data.get("password") or ""
    if len(password) < 8:
        return jsonify(error="Password needs at least 8 characters."), 400
    user = query("SELECT * FROM users WHERE reset_token = ?", (token,), one=True)
    if not user:
        return jsonify(error="Invalid or expired reset token."), 400
    try:
        if datetime.fromisoformat(user["reset_expires"]) < datetime.now():
            return jsonify(error="Reset token has expired."), 400
    except (ValueError, TypeError):
        return jsonify(error="Invalid reset token."), 400
    execute("UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?",
            (hash_password(password), user["id"]))
    return jsonify(ok=True, message="Password updated. You can now log in.")


# ---------------------------------------------------------------- addresses (user)

@app.get("/api/addresses")
@login_required
def list_addresses(user):
    rows = query("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id", (user["id"],))
    return jsonify(addresses=[dict(r) for r in rows])


@app.post("/api/addresses")
@login_required
def add_address(user):
    data = request.get_json(silent=True) or {}
    label = (data.get("label") or "Home").strip()[:20]
    name = (data.get("name") or "").strip()
    phone = (data.get("phone") or "").strip()
    address = (data.get("address") or "").strip()
    if not name or not phone or not address:
        return jsonify(error="Name, phone, and address are required."), 400
    is_default = 1 if not query("SELECT id FROM addresses WHERE user_id = ?", (user["id"],), one=True) else 0
    execute(
        "INSERT INTO addresses (user_id, label, name, phone, address, is_default, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user["id"], label, name, phone, address, is_default, datetime.now().isoformat(timespec="seconds")),
    )
    return jsonify(ok=True)


@app.put("/api/addresses/<int:aid>")
@login_required
def update_address(user, aid):
    addr = query("SELECT * FROM addresses WHERE id = ? AND user_id = ?", (aid, user["id"]), one=True)
    if not addr:
        return jsonify(error="Address not found."), 404
    data = request.get_json(silent=True) or {}
    label = (data.get("label") or addr["label"]).strip()[:20]
    name = (data.get("name") or addr["name"]).strip()
    phone = (data.get("phone") or addr["phone"]).strip()
    address = (data.get("address") or addr["address"]).strip()
    is_default = 1 if data.get("is_default") else addr["is_default"]
    if is_default:
        execute("UPDATE addresses SET is_default = 0 WHERE user_id = ?", (user["id"],))
    execute(
        "UPDATE addresses SET label=?, name=?, phone=?, address=?, is_default=? WHERE id=?",
        (label, name, phone, address, is_default, aid),
    )
    return jsonify(ok=True)


@app.delete("/api/addresses/<int:aid>")
@login_required
def delete_address(user, aid):
    execute("DELETE FROM addresses WHERE id = ? AND user_id = ?", (aid, user["id"]))
    return jsonify(ok=True)


# ---------------------------------------------------------------- wishlist (user)

@app.get("/api/wishlist")
@login_required
def get_wishlist(user):
    rows = query(
        "SELECT p.*, w.created_at FROM wishlist w"
        " JOIN products p ON p.id = w.product_id"
        " WHERE w.user_id = ? AND p.active = 1 ORDER BY w.created_at DESC",
        (user["id"],),
    )
    return jsonify(wishlist=[dict(r) for r in rows])


@app.post("/api/wishlist")
@login_required
def add_wishlist(user):
    data = request.get_json(silent=True) or {}
    pid = data.get("product_id")
    if not pid:
        return jsonify(error="Product ID required."), 400
    p = query("SELECT * FROM products WHERE id = ? AND active = 1", (pid,), one=True)
    if not p:
        return jsonify(error="Product not found."), 404
    try:
        execute("INSERT INTO wishlist (user_id, product_id, created_at) VALUES (?, ?, ?)",
                (user["id"], pid, datetime.now().isoformat(timespec="seconds")))
    except sqlite3.IntegrityError:
        return jsonify(error="Already in wishlist."), 409
    return jsonify(ok=True)


@app.delete("/api/wishlist/<int:pid>")
@login_required
def remove_wishlist(user, pid):
    execute("DELETE FROM wishlist WHERE user_id = ? AND product_id = ?", (user["id"], pid))
    return jsonify(ok=True)


# ---------------------------------------------------------------- admin dashboard / extra

@app.get("/api/admin/dashboard")
@admin_required
def admin_dashboard(user):
    now = datetime.now()
    month_ago = (now - timedelta(days=30)).isoformat(timespec="seconds")
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
    monthly_financials = query(
        "SELECT "
        "(SELECT COALESCE(SUM(total), 0) FROM orders WHERE status = 'Delivered' AND created_at >= ?) revenue, "
        "(SELECT COALESCE(SUM(oi.cost_price * oi.qty), 0) FROM order_items oi "
        " JOIN orders o ON o.id = oi.order_id WHERE o.status = 'Delivered' AND o.created_at >= ?) cost, "
        "(SELECT COALESCE(SUM(CASE WHEN oi.cost_price = 0 THEN oi.qty ELSE 0 END), 0) FROM order_items oi "
        " JOIN orders o ON o.id = oi.order_id WHERE o.status = 'Delivered' AND o.created_at >= ?) missing_cost_qty",
        (month_start, month_start, month_start),
        one=True,
    )
    monthly_revenue = round(monthly_financials["revenue"], 2)
    monthly_cost = round(monthly_financials["cost"], 2)
    monthly_profit = round(monthly_revenue - monthly_cost, 2)
    stats = {
        "revenue_30d": query("SELECT COALESCE(SUM(total),0) t FROM orders WHERE status = 'Delivered' AND created_at >= ?", (month_ago,), one=True)["t"],
        "monthly_revenue": monthly_revenue,
        "monthly_cost": monthly_cost,
        "monthly_profit": monthly_profit,
        "monthly_loss": max(0, -monthly_profit),
        "monthly_missing_cost_qty": monthly_financials["missing_cost_qty"],
        "orders_placed": query("SELECT COUNT(*) c FROM orders", one=True)["c"],
        "orders_open": query("SELECT COUNT(*) c FROM orders WHERE status IN ('Placed','Confirmed','Out for delivery')", one=True)["c"],
        "products_total": query("SELECT COUNT(*) c FROM products", one=True)["c"],
        "out_of_stock": query("SELECT COUNT(*) c FROM products WHERE stock <= 0 AND active = 1", one=True)["c"],
        "low_stock": query("SELECT COUNT(*) c FROM products WHERE stock > 0 AND stock <= low_stock_threshold AND active = 1", one=True)["c"],
        "customers": query("SELECT COUNT(*) c FROM users WHERE role = 'customer'", one=True)["c"],
    }
    # low stock list
    low = query("SELECT * FROM products WHERE stock > 0 AND stock <= low_stock_threshold AND active = 1 ORDER BY stock")
    stats["low_stock_items"] = [dict(r) for r in low]
    # recent orders
    recent = query("SELECT * FROM orders ORDER BY id DESC LIMIT 10")
    stats["recent_orders"] = [dict(r) for r in recent]
    return jsonify(stats)


@app.get("/api/admin/settings")
@admin_required
def admin_get_settings(user):
    return jsonify(settings={
        "shop_name": "Dibbo Store",
        "delivery_fee": DELIVERY_FEE,
        "free_over": FREE_OVER,
        "low_stock_default": LOW_STOCK,
        "contact_phone": "01700-000000",
        "contact_email": "hello@dibbostore.com",
    })


@app.put("/api/admin/settings")
@admin_required
def admin_update_settings(user):
    data = request.get_json(silent=True) or {}
    global DELIVERY_FEE, FREE_OVER, LOW_STOCK
    if "delivery_fee" in data:
        DELIVERY_FEE = max(0, int(data["delivery_fee"]))
    if "free_over" in data:
        FREE_OVER = max(0, int(data["free_over"]))
    if "low_stock_default" in data:
        LOW_STOCK = max(0, int(data["low_stock_default"]))
    return jsonify(ok=True, settings={
        "delivery_fee": DELIVERY_FEE,
        "free_over": FREE_OVER,
        "low_stock_default": LOW_STOCK,
    })


@app.put("/api/admin/products/<sku>/threshold")
@admin_required
def admin_update_threshold(user, sku):
    p = query("SELECT * FROM products WHERE sku = ?", (sku.upper(),), one=True)
    if not p:
        return jsonify(error="Product not found."), 404
    data = request.get_json(silent=True) or {}
    try:
        threshold = max(0, int(data.get("low_stock_threshold", p["low_stock_threshold"])))
    except (TypeError, ValueError):
        return jsonify(error="Threshold must be a number."), 400
    execute("UPDATE products SET low_stock_threshold = ? WHERE id = ?", (threshold, p["id"]))
    return jsonify(ok=True)


# ---------------------------------------------------------------- user portal

@app.get("/api/user/profile")
@login_required
def user_profile(user):
    return jsonify(user=public_user(user))


@app.put("/api/user/profile")
@login_required
def user_update_profile(user):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    phone = (data.get("phone") or "").strip()
    if name and len(name) <= 100:
        execute("UPDATE users SET name = ? WHERE id = ?", (name, user["id"]))
    return jsonify(ok=True)


@app.put("/api/user/password")
@login_required
def user_change_password(user):
    data = request.get_json(silent=True) or {}
    current = data.get("current") or ""
    new = data.get("new") or ""
    if len(new) < 8:
        return jsonify(error="New password needs at least 8 characters."), 400
    if not check_password(current, user["password_hash"]):
        return jsonify(error="Current password is incorrect."), 400
    execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new), user["id"]))
    return jsonify(ok=True)


@app.get("/api/user/orders")
@login_required
def user_orders(user):
    orders = query("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", (user["id"],))
    result = []
    now = datetime.now()
    for o in orders:
        items = query("SELECT * FROM order_items WHERE order_id = ?", (o["id"],))
        placed_at = datetime.fromisoformat(o["created_at"])
        result.append({
            **{k: o[k] for k in ("code", "status", "total", "discount", "coupon", "delivery_fee", "payment", "created_at")},
            "items": [dict(i) for i in items],
            "can_cancel": o["status"] in ("Placed", "Confirmed") and now - placed_at <= timedelta(hours=CANCEL_WINDOW_H),
        })
    return jsonify(orders=result)


# ---------------------------------------------------------------- secure headers

@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # CSP allows inline scripts/styles for our app + Three.js CDN
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https:; "
        "connect-src 'self'; "
        "frame-ancestors 'self';"
    )
    return response


# ---------------------------------------------------------------- init

if __name__ == "__main__":
    with app.app_context():
        seed_if_empty()
    print("\n  Dibbo Store is open!  ->  http://127.0.0.1:5000\n")
    app.run(host="127.0.0.1", port=5000, debug=False)
