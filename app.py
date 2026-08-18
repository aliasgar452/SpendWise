"""
SpendWise – app.py
Full-stack Flask + SQLite backend for the Smart Budget & Expense Tracker.
"""

import sqlite3
import os
from datetime import datetime, date
from flask import Flask, request, jsonify, render_template, g

# ─── App Setup ───────────────────────────────────────────────────────────────
app = Flask(__name__)
DB_PATH = os.path.join(os.path.dirname(__file__), "spendwise.db")


# ─── Database Helpers ─────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    """Return a per-request SQLite connection stored on Flask's `g` object."""
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
        g.db.row_factory = sqlite3.Row          # rows behave like dicts
        g.db.execute("PRAGMA journal_mode=WAL")  # safer concurrent writes
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Create tables if they do not already exist."""
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS transactions (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            title     TEXT    NOT NULL,
            amount    REAL    NOT NULL CHECK (amount > 0),
            type      TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
            category  TEXT    NOT NULL DEFAULT 'Others',
            date      TEXT    NOT NULL,
            created_at TEXT   NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS budget (
            id        INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
            monthly_limit REAL NOT NULL DEFAULT 0,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Seed the singleton budget row so we can always UPDATE it
        INSERT OR IGNORE INTO budget (id, monthly_limit) VALUES (1, 0);
    """)
    db.commit()
    db.close()


# ─── Utility ──────────────────────────────────────────────────────────────────

def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


def current_month_range() -> tuple[str, str]:
    """Return ISO date strings for the first and last day of the current month."""
    today = date.today()
    first = today.replace(day=1).isoformat()
    # last day: first day of next month minus 1 day (handled by DB comparison <=)
    # We simply filter by YYYY-MM prefix for simplicity
    month_prefix = today.strftime("%Y-%m")
    return first, month_prefix


def compute_summary(db: sqlite3.Connection) -> dict:
    """Aggregate totals from the transactions table."""
    totals = db.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN type='income'  THEN amount ELSE 0 END), 0) AS total_income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS total_expenses
        FROM transactions
    """).fetchone()

    budget_row = db.execute("SELECT monthly_limit FROM budget WHERE id=1").fetchone()
    budget_limit = budget_row["monthly_limit"] if budget_row else 0.0

    _, month_prefix = current_month_range()
    month_expenses_row = db.execute("""
        SELECT COALESCE(SUM(amount), 0) AS month_expenses
        FROM transactions
        WHERE type='expense' AND strftime('%Y-%m', date) = ?
    """, (month_prefix,)).fetchone()

    month_expenses = month_expenses_row["month_expenses"] if month_expenses_row else 0.0
    total_income   = totals["total_income"]
    total_expenses = totals["total_expenses"]
    balance        = total_income - total_expenses
    budget_remaining = budget_limit - month_expenses if budget_limit > 0 else None
    budget_percent = min((month_expenses / budget_limit) * 100, 200) if budget_limit > 0 else 0

    return {
        "total_income":      round(total_income, 2),
        "total_expenses":    round(total_expenses, 2),
        "balance":           round(balance, 2),
        "budget_limit":      round(budget_limit, 2),
        "month_expenses":    round(month_expenses, 2),
        "budget_remaining":  round(budget_remaining, 2) if budget_remaining is not None else None,
        "budget_percent":    round(budget_percent, 2),
    }


def category_breakdown(db: sqlite3.Connection) -> list[dict]:
    """Return per-category expense totals for chart rendering."""
    rows = db.execute("""
        SELECT category, ROUND(SUM(amount), 2) AS total
        FROM transactions
        WHERE type = 'expense'
        GROUP BY category
        ORDER BY total DESC
    """).fetchall()
    return [row_to_dict(r) for r in rows]


def income_breakdown(db: sqlite3.Connection) -> list[dict]:
    """Return per-category income totals for the income breakdown chart."""
    rows = db.execute("""
        SELECT category, ROUND(SUM(amount), 2) AS total
        FROM transactions
        WHERE type = 'income'
        GROUP BY category
        ORDER BY total DESC
    """).fetchall()
    return [row_to_dict(r) for r in rows]


# ─── Routes – Pages ───────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ─── REST API ─────────────────────────────────────────────────────────────────

@app.route("/api/transactions", methods=["GET"])
def get_transactions():
    """
    GET /api/transactions
    Query params:
        filter   = all | income | expense  (default: all)
        search   = text search in title/category
        sort     = date_desc | date_asc | amount_desc | amount_asc (default: date_desc)
        page     = integer (default: 1)
        per_page = integer (default: 50)
    Returns: { transactions, summary, breakdown, pagination }
    """
    db = get_db()

    filter_type = request.args.get("filter", "all").lower()
    search      = request.args.get("search", "").strip()
    sort        = request.args.get("sort", "date_desc").lower()
    try:
        page     = max(int(request.args.get("page", 1)), 1)
        per_page = min(max(int(request.args.get("per_page", 50)), 1), 200)
    except ValueError:
        page, per_page = 1, 50

    # Build WHERE clauses
    conditions = []
    params: list = []

    if filter_type in ("income", "expense"):
        conditions.append("type = ?")
        params.append(filter_type)

    if search:
        conditions.append("(title LIKE ? OR category LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])

    where_sql = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    # Sort
    sort_map = {
        "date_desc":   "date DESC, id DESC",
        "date_asc":    "date ASC,  id ASC",
        "amount_desc": "amount DESC, date DESC",
        "amount_asc":  "amount ASC,  date DESC",
    }
    order_sql = sort_map.get(sort, "date DESC, id DESC")

    # Total count for pagination
    count_row = db.execute(
        f"SELECT COUNT(*) AS cnt FROM transactions {where_sql}", params
    ).fetchone()
    total = count_row["cnt"]

    offset = (page - 1) * per_page
    rows = db.execute(
        f"SELECT * FROM transactions {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?",
        params + [per_page, offset],
    ).fetchall()

    return jsonify({
        "transactions": [row_to_dict(r) for r in rows],
        "summary":      compute_summary(db),
        "breakdown":       category_breakdown(db),
        "income_breakdown": income_breakdown(db),
        "pagination": {
            "page":       page,
            "per_page":   per_page,
            "total":      total,
            "total_pages": max(1, -(-total // per_page)),  # ceil division
        },
    }), 200


@app.route("/api/transactions", methods=["POST"])
def add_transaction():
    """
    POST /api/transactions
    Body (JSON): { title, amount, type, category, date? }
    Returns: { transaction, summary, breakdown, message }
    """
    db   = get_db()
    data = request.get_json(silent=True) or {}

    # --- Validation ---
    errors = {}

    title = str(data.get("title", "")).strip()
    if not title:
        errors["title"] = "Title is required."
    elif len(title) > 120:
        errors["title"] = "Title must be ≤ 120 characters."

    try:
        amount = float(data.get("amount", 0))
        if amount <= 0:
            raise ValueError
    except (TypeError, ValueError):
        errors["amount"] = "Amount must be a positive number."

    tx_type = str(data.get("type", "")).strip().lower()
    if tx_type not in ("income", "expense"):
        errors["type"] = "Type must be 'income' or 'expense'."

    category = str(data.get("category", "Others")).strip()
    if not category:
        category = "Others"

    tx_date = str(data.get("date", "")).strip()
    if not tx_date:
        tx_date = date.today().isoformat()
    else:
        try:
            datetime.fromisoformat(tx_date)  # validate ISO date
        except ValueError:
            errors["date"] = "Date must be a valid ISO date (YYYY-MM-DD)."

    if errors:
        return jsonify({"errors": errors}), 422

    # --- Insert ---
    cursor = db.execute(
        "INSERT INTO transactions (title, amount, type, category, date) VALUES (?,?,?,?,?)",
        (title, round(amount, 2), tx_type, category, tx_date),
    )
    db.commit()

    new_tx = row_to_dict(db.execute(
        "SELECT * FROM transactions WHERE id = ?", (cursor.lastrowid,)
    ).fetchone())

    return jsonify({
        "message":     "Transaction added successfully.",
        "transaction": new_tx,
        "summary":     compute_summary(db),
        "breakdown":       category_breakdown(db),
        "income_breakdown": income_breakdown(db),
    }), 201


@app.route("/api/transactions/<int:tx_id>", methods=["DELETE"])
def delete_transaction(tx_id: int):
    """
    DELETE /api/transactions/<id>
    Returns: { message, summary, breakdown }
    """
    db = get_db()
    row = db.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"Transaction {tx_id} not found."}), 404

    db.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
    db.commit()

    return jsonify({
        "message":   f"Transaction '{row['title']}' deleted.",
        "summary":   compute_summary(db),
        "breakdown":       category_breakdown(db),
        "income_breakdown": income_breakdown(db),
    }), 200


@app.route("/api/budget", methods=["POST"])
def set_budget():
    """
    POST /api/budget
    Body (JSON): { monthly_limit }
    Returns: { monthly_limit, message, summary }
    """
    db   = get_db()
    data = request.get_json(silent=True) or {}

    try:
        limit = float(data.get("monthly_limit", 0))
        if limit < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"error": "monthly_limit must be a non-negative number."}), 422

    db.execute(
        "UPDATE budget SET monthly_limit = ?, updated_at = datetime('now') WHERE id = 1",
        (round(limit, 2),),
    )
    db.commit()

    return jsonify({
        "message":       "Budget updated successfully.",
        "monthly_limit": round(limit, 2),
        "summary":       compute_summary(db),
    }), 200


@app.route("/api/budget", methods=["GET"])
def get_budget():
    """GET /api/budget – Retrieve current budget settings."""
    db  = get_db()
    row = db.execute("SELECT * FROM budget WHERE id=1").fetchone()
    return jsonify(row_to_dict(row) if row else {"monthly_limit": 0}), 200


@app.route("/api/transactions/export", methods=["GET"])
def export_transactions():
    """GET /api/transactions/export – Download all transactions as CSV."""
    import csv, io
    db   = get_db()
    rows = db.execute(
        "SELECT id, title, amount, type, category, date, created_at FROM transactions ORDER BY date DESC"
    ).fetchall()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "Title", "Amount", "Type", "Category", "Date", "Created At"])
    for r in rows:
        writer.writerow([r["id"], r["title"], r["amount"], r["type"], r["category"], r["date"], r["created_at"]])

    csv_bytes = output.getvalue().encode("utf-8")
    from flask import Response
    filename = f"spendwise_{date.today().isoformat()}.csv"
    return Response(
        csv_bytes,
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    print("[OK] SpendWise database initialised.")
    print("[>>] Starting Flask server on http://127.0.0.1:5000")
    app.run(debug=True, port=5000)
