"""
SpendWise  —  api/index.py
Google OAuth2 + Google Drive-backed expense tracker backend.

Run:  python api/index.py          (starts on http://localhost:5001)
Env:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FLASK_SECRET_KEY, REDIRECT_URI
"""
from __future__ import annotations

import io
import os
import json
import uuid
import pathlib
from datetime import datetime, timedelta

# Allow plain HTTP during local development
os.environ.setdefault('OAUTHLIB_INSECURE_TRANSPORT', '1')

from flask import (
    Flask, request, jsonify, session,
    redirect, send_from_directory,
)
from flask_cors import CORS
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GRequest
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaIoBaseDownload
from googleapiclient.errors import HttpError

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT_DIR = pathlib.Path(__file__).parent.parent   # d:/Projects/SpendWise

# ── App ───────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, supports_credentials=True)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'spendwise-dev-' + uuid.uuid4().hex)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_NAME='spendwise_sess',
)

# ── Config (populated at startup from env / .env file) ────────────────────────
CLIENT_ID     = os.environ.get('GOOGLE_CLIENT_ID') or ''
CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET') or ''
REDIRECT_URI  = os.environ.get('REDIRECT_URI', 'http://localhost:5001/auth/callback')


def _load_google_env() -> tuple[str, str, str]:
    global CLIENT_ID, CLIENT_SECRET, REDIRECT_URI
    CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID') or CLIENT_ID or ''
    CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET') or CLIENT_SECRET or ''
    REDIRECT_URI = os.environ.get('REDIRECT_URI') or REDIRECT_URI
    return CLIENT_ID, CLIENT_SECRET, REDIRECT_URI


def _missing_google_env_error() -> tuple[dict, int]:
    return jsonify({
        "error": "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in Vercel environment variables"
    }), 500

SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/drive.file',
]

DRIVE_FOLDER = os.environ.get('DRIVE_FOLDER_NAME', 'Husaini Ledger')
LEDGER_FILE  = 'ledger_data.json'
MAX_UPLOAD   = 20 * 1024 * 1024   # 20 MB


# ═══════════════════════════════════════════════════════════════════════════════
#  CREDENTIAL HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _creds_to_dict(creds: Credentials) -> dict:
    return {
        'token':         creds.token,
        'refresh_token': creds.refresh_token,
        'token_uri':     creds.token_uri,
        'client_id':     creds.client_id,
        'client_secret': creds.client_secret,
        'scopes':        list(creds.scopes or SCOPES),
    }


def _creds_from_session() -> Credentials | None:
    """Restore Credentials from session; auto-refresh if expired."""
    raw = session.get('credentials')
    if not raw:
        return None
    try:
        creds = Credentials(**raw)
        if creds.expired and creds.refresh_token:
            creds.refresh(GRequest())
            session['credentials'] = _creds_to_dict(creds)
        return creds if creds.valid else None
    except Exception:
        return None


def _build_flow() -> Flow:
    client_id, client_secret, redirect_uri = _load_google_env()
    if not client_id or not client_secret:
        raise RuntimeError('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables')
    return Flow.from_client_config(
        {
            'web': {
                'client_id':     client_id,
                'client_secret': client_secret,
                'auth_uri':      'https://accounts.google.com/o/oauth2/auth',
                'token_uri':     'https://oauth2.googleapis.com/token',
                'redirect_uris': [redirect_uri],
            }
        },
        scopes=SCOPES,
        redirect_uri=redirect_uri,
    )


# ═══════════════════════════════════════════════════════════════════════════════
#  DRIVE HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _drive(creds: Credentials):
    return build('drive', 'v3', credentials=creds, cache_discovery=False)


def _get_or_create_folder(svc, name: str) -> str:
    q   = (f"name='{name}' and mimeType='application/vnd.google-apps.folder'"
           f" and trashed=false")
    res = svc.files().list(q=q, fields='files(id)', pageSize=1).execute()
    if res.get('files'):
        return res['files'][0]['id']
    folder = svc.files().create(
        body={'name': name, 'mimeType': 'application/vnd.google-apps.folder'},
        fields='id',
    ).execute()
    return folder['id']


def _find_file(svc, folder_id: str, filename: str) -> str | None:
    q   = f"name='{filename}' and '{folder_id}' in parents and trashed=false"
    res = svc.files().list(q=q, fields='files(id)', pageSize=1).execute()
    files = res.get('files', [])
    return files[0]['id'] if files else None


def _load_ledger(svc, folder_id: str) -> dict:
    fid = _find_file(svc, folder_id, LEDGER_FILE)
    if not fid:
        return {'transactions': [], 'budget': 0}
    buf = io.BytesIO()
    dl  = MediaIoBaseDownload(buf, svc.files().get_media(fileId=fid))
    done = False
    while not done:
        _, done = dl.next_chunk()
    try:
        return json.loads(buf.getvalue().decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {'transactions': [], 'budget': 0}


def _save_ledger(svc, folder_id: str, data: dict) -> None:
    body    = json.dumps(data, indent=2, ensure_ascii=False).encode('utf-8')
    media   = MediaIoBaseUpload(io.BytesIO(body), mimetype='application/json')
    fid     = _find_file(svc, folder_id, LEDGER_FILE)
    if fid:
        svc.files().update(fileId=fid, media_body=media).execute()
    else:
        svc.files().create(
            body={'name': LEDGER_FILE, 'parents': [folder_id]},
            media_body=media, fields='id',
        ).execute()


def _require_drive() -> tuple:
    """Return (creds, folder_id, svc) — or (None, None, None) if not authed."""
    creds = _creds_from_session()
    if not creds:
        return None, None, None
    svc = _drive(creds)
    folder_id = session.get('folder_id')
    if not folder_id:
        folder_id = _get_or_create_folder(svc, DRIVE_FOLDER)
        session['folder_id'] = folder_id
    return creds, folder_id, svc


# ═══════════════════════════════════════════════════════════════════════════════
#  ANALYTICS HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _compute_summary(transactions: list, budget: float) -> dict:
    income    = sum(t['amount'] for t in transactions if t.get('type') == 'income')
    expenses  = sum(t['amount'] for t in transactions if t.get('type') == 'expense')
    now       = datetime.utcnow()
    month_exp = sum(
        t['amount'] for t in transactions
        if t.get('type') == 'expense'
        and t.get('date', '') >= now.strftime('%Y-%m-01')
    )
    bpct = round(month_exp / budget * 100, 2) if budget else 0
    return {
        'total_income':    round(income, 2),
        'total_expenses':  round(expenses, 2),
        'balance':         round(income - expenses, 2),
        'budget_limit':    budget,
        'month_expenses':  round(month_exp, 2),
        'budget_remaining': round(budget - month_exp, 2) if budget else None,
        'budget_percent':  bpct,
    }


def _breakdown(transactions: list, tx_type: str) -> list:
    totals: dict[str, float] = {}
    for t in transactions:
        if t.get('type') != tx_type:
            continue
        cat = t.get('category', 'Others')
        totals[cat] = round(totals.get(cat, 0.0) + t['amount'], 2)
    return [{'category': k, 'total': v}
            for k, v in sorted(totals.items(), key=lambda x: -x[1])]


def _filter_by_period(txs: list, period: str) -> list:
    now = datetime.utcnow()
    if period == 'week':
        cutoff = (now - timedelta(days=7)).strftime('%Y-%m-%d')
    elif period == 'month':
        cutoff = now.strftime('%Y-%m-01')
    elif period == 'year':
        cutoff = now.strftime('%Y-01-01')
    else:
        return txs
    return [t for t in txs if t.get('date', '') >= cutoff]


# ═══════════════════════════════════════════════════════════════════════════════
#  AUTH ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/auth/login', methods=['GET', 'POST'])
@app.route('/api/auth/login', methods=['GET', 'POST'])
def auth_login():
    try:
        _load_google_env()
        if not CLIENT_ID or not CLIENT_SECRET:
            return _missing_google_env_error()
        flow = _build_flow()
        auth_url, state = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='select_account',
        )
        session['oauth_state'] = state
        return redirect(auth_url)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/auth/callback', methods=['GET'])
@app.route('/api/auth/callback', methods=['GET'])
def auth_callback():
    state = session.pop('oauth_state', None)
    try:
        _load_google_env()
        if not CLIENT_ID or not CLIENT_SECRET:
            return _missing_google_env_error()
        flow = _build_flow()
        flow.fetch_token(authorization_response=request.url, state=state)
        creds = flow.credentials
        session['credentials'] = _creds_to_dict(creds)

        svc = build('oauth2', 'v2', credentials=creds, cache_discovery=False)
        info = svc.userinfo().get().execute()
        session['user'] = {
            'id':      info.get('id', ''),
            'name':    info.get('name', 'User'),
            'email':   info.get('email', ''),
            'picture': info.get('picture', ''),
        }

        dsvc = _drive(creds)
        fid = _get_or_create_folder(dsvc, DRIVE_FOLDER)
        session['folder_id'] = fid
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500

    return redirect('/')


@app.route('/auth/logout', methods=['POST'])
@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    try:
        session.clear()
        return jsonify({'ok': True})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/auth/me', methods=['GET'])
@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    try:
        if 'user' not in session:
            return jsonify({'authenticated': False}), 401
        if not _creds_from_session():
            return jsonify({'authenticated': False}), 401
        return jsonify({'authenticated': True, 'user': session['user']})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
#  TRANSACTIONS API
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/transactions', methods=['GET', 'POST'])
@app.route('/api/transactions', methods=['GET', 'POST'])
def transactions_route():
    if request.method == 'GET':
        try:
            _, folder_id, svc = _require_drive()
            if svc is None:
                return jsonify({'error': 'Unauthorized'}), 401

            ledger  = _load_ledger(svc, folder_id)
            all_txs = ledger.get('transactions', [])
            budget  = float(ledger.get('budget', 0))
            period  = request.args.get('period', 'all')
            visible = _filter_by_period(all_txs, period)
            sorted_txs = sorted(visible, key=lambda t: t.get('date', ''), reverse=True)

            return jsonify({
                'transactions':     sorted_txs,
                'summary':          _compute_summary(all_txs, budget),
                'breakdown':        _breakdown(visible, 'expense'),
                'income_breakdown': _breakdown(visible, 'income'),
            })
        except Exception as exc:
            return jsonify({'error': str(exc)}), 500

    try:
        _, folder_id, svc = _require_drive()
        if svc is None:
            return jsonify({'error': 'Unauthorized'}), 401

        body     = request.get_json(force=True) or {}
        title    = (body.get('title') or '').strip()
        amount   = body.get('amount')
        category = (body.get('category') or '').strip()
        errors   = {}

        if not title:
            errors['title'] = 'Description is required.'
        if not amount or float(amount or 0) <= 0:
            errors['amount'] = 'Enter a valid positive amount.'
        if not category:
            errors['category'] = 'Please select a category.'
        if errors:
            return jsonify({'errors': errors}), 422

        tx = {
            'id': str(uuid.uuid4()),
            'title': title,
            'amount': round(float(amount), 2),
            'type': body.get('type', 'expense'),
            'category': category,
            'date': body.get('date') or datetime.utcnow().strftime('%Y-%m-%d'),
            'receipt_url': body.get('receipt_url') or None,
            'created_at': datetime.utcnow().isoformat(),
        }

        ledger = _load_ledger(svc, folder_id)
        ledger.setdefault('transactions', []).append(tx)
        _save_ledger(svc, folder_id, ledger)
        budget = float(ledger.get('budget', 0))
        all_txs = ledger['transactions']

        return jsonify({
            'transaction': tx,
            'summary': _compute_summary(all_txs, budget),
            'breakdown': _breakdown(all_txs, 'expense'),
            'income_breakdown': _breakdown(all_txs, 'income'),
        }), 201
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/transactions/<tx_id>', methods=['DELETE'])
@app.route('/api/transactions/<tx_id>', methods=['DELETE'])
def delete_transaction(tx_id: str):
    try:
        _, folder_id, svc = _require_drive()
        if svc is None:
            return jsonify({'error': 'Unauthorized'}), 401

        ledger = _load_ledger(svc, folder_id)
        before = len(ledger.get('transactions', []))
        ledger['transactions'] = [t for t in ledger.get('transactions', []) if t['id'] != tx_id]
        if len(ledger['transactions']) == before:
            return jsonify({'error': 'Transaction not found.'}), 404

        _save_ledger(svc, folder_id, ledger)
        budget = float(ledger.get('budget', 0))
        all_txs = ledger['transactions']

        return jsonify({
            'message': 'Transaction deleted.',
            'summary': _compute_summary(all_txs, budget),
            'breakdown': _breakdown(all_txs, 'expense'),
            'income_breakdown': _breakdown(all_txs, 'income'),
        })
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/budget', methods=['POST'])
@app.route('/api/budget', methods=['POST'])
def set_budget():
    try:
        _, folder_id, svc = _require_drive()
        if svc is None:
            return jsonify({'error': 'Unauthorized'}), 401

        body = request.get_json(force=True) or {}
        budget = max(0.0, float(body.get('monthly_limit', 0) or 0))

        ledger = _load_ledger(svc, folder_id)
        ledger['budget'] = round(budget, 2)
        _save_ledger(svc, folder_id, ledger)

        return jsonify({'summary': _compute_summary(ledger.get('transactions', []), budget)})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500
    try:
        _, folder_id, svc = _require_drive()
        if svc is None:
            return jsonify({'error': 'Unauthorized'}), 401

        body     = request.get_json(force=True) or {}
        title    = (body.get('title') or '').strip()
        amount   = body.get('amount')
        category = (body.get('category') or '').strip()
        errors   = {}

        if not title:
            errors['title']    = 'Description is required.'
        if not amount or float(amount or 0) <= 0:
            errors['amount']   = 'Enter a valid positive amount.'
        if not category:
            errors['category'] = 'Please select a category.'
        if errors:
            return jsonify({'errors': errors}), 422

        tx = {
            'id':          str(uuid.uuid4()),
            'title':       title,
            'amount':      round(float(amount), 2),
            'type':        body.get('type', 'expense'),
            'category':    category,
            'date':        body.get('date') or datetime.utcnow().strftime('%Y-%m-%d'),
            'receipt_url': body.get('receipt_url') or None,
            'created_at':  datetime.utcnow().isoformat(),
        }

        ledger = _load_ledger(svc, folder_id)
        ledger.setdefault('transactions', []).append(tx)
        _save_ledger(svc, folder_id, ledger)
        budget = float(ledger.get('budget', 0))
        all_txs = ledger['transactions']

        return jsonify({
            'transaction':      tx,
            'summary':          _compute_summary(all_txs, budget),
            'breakdown':        _breakdown(all_txs, 'expense'),
            'income_breakdown': _breakdown(all_txs, 'income'),
        }), 201
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/api/transactions/<tx_id>', methods=['DELETE'])
def delete_transaction(tx_id: str):
    try:
        _, folder_id, svc = _require_drive()
        if svc is None:
            return jsonify({'error': 'Unauthorized'}), 401

        ledger  = _load_ledger(svc, folder_id)
        before  = len(ledger.get('transactions', []))
        ledger['transactions'] = [t for t in ledger.get('transactions', [])
                                   if t['id'] != tx_id]
        if len(ledger['transactions']) == before:
            return jsonify({'error': 'Transaction not found.'}), 404

        _save_ledger(svc, folder_id, ledger)
        budget  = float(ledger.get('budget', 0))
        all_txs = ledger['transactions']

        return jsonify({
            'message':          'Transaction deleted.',
            'summary':          _compute_summary(all_txs, budget),
            'breakdown':        _breakdown(all_txs, 'expense'),
            'income_breakdown': _breakdown(all_txs, 'income'),
        })
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/api/budget', methods=['POST'])
def set_budget():
    try:
        _, folder_id, svc = _require_drive()
        if svc is None:
            return jsonify({'error': 'Unauthorized'}), 401

        body   = request.get_json(force=True) or {}
        budget = max(0.0, float(body.get('monthly_limit', 0) or 0))

        ledger = _load_ledger(svc, folder_id)
        ledger['budget'] = round(budget, 2)
        _save_ledger(svc, folder_id, ledger)

        return jsonify({
            'summary': _compute_summary(ledger.get('transactions', []), budget)
        })
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
#  RECEIPT UPLOAD
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/upload', methods=['POST'])
@app.route('/api/upload', methods=['POST'])
@app.route('/upload-receipt', methods=['POST'])
@app.route('/api/upload-receipt', methods=['POST'])
def upload_receipt():
    try:
        _, folder_id, svc = _require_drive()
        if svc is None:
            return jsonify({'error': 'Unauthorized'}), 401

        f = request.files.get('file')
        if not f or not f.filename:
            return jsonify({'error': 'No file provided.'}), 400

        data = f.read()
        if len(data) > MAX_UPLOAD:
            return jsonify({'error': 'File exceeds 20 MB limit.'}), 413

        safe_name = f'receipt_{uuid.uuid4().hex[:8]}_{f.filename}'
        mime      = f.content_type or 'application/octet-stream'
        media     = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime, resumable=False)

        created = svc.files().create(
            body={'name': safe_name, 'parents': [folder_id]},
            media_body=media,
            fields='id,webViewLink',
        ).execute()

        try:
            svc.permissions().create(
                fileId=created['id'],
                body={'role': 'reader', 'type': 'anyone'},
            ).execute()
        except HttpError:
            pass

        return jsonify({
            'file_id': created['id'],
            'view_url': created.get('webViewLink', ''),
        })
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/health', methods=['GET'])
@app.route('/api/health', methods=['GET'])
def api_health():
    return jsonify({'status': 'ok'}), 200


@app.errorhandler(404)
def not_found(_error):
    return jsonify({
        'error': 'Route not found',
        'available_routes': [str(rule) for rule in app.url_map.iter_rules()]
    }), 404


# ═══════════════════════════════════════════════════════════════════════════════
#  SERVE FRONTEND (index.html + script.js + style.css from project root)
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static(path: str):
    if path:
        target = ROOT_DIR / path
        if target.is_file():
            return send_from_directory(ROOT_DIR, path)
    return send_from_directory(ROOT_DIR, 'index.html')


# ═══════════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    # Auto-load .env if present
    env_path = ROOT_DIR / '.env'
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, _, val = line.partition('=')
                os.environ.setdefault(key.strip(), val.strip())
        _load_google_env()
