#!/usr/bin/env python3
# app.py — studio333.art (Flask + psycopg3 pool; Jinja templates in app/templates)

import os, sys, time, json, atexit, re, inspect, logging
from datetime import datetime, timedelta
from functools import wraps
from urllib.parse import urlparse

from flask import (
    Flask, Blueprint, request, session, jsonify, redirect, url_for, render_template,
    render_template_string, abort, make_response, send_from_directory, flash
)
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import uuid
from PIL import Image

import psycopg
from psycopg_pool import ConnectionPool
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row
from psycopg.types.json import Json as PgJson
from psycopg import sql  # used by dev_db_tables

# ----------------------------
# Config (env vars)
# ----------------------------
SECRET_KEY   = os.getenv("SECRET_KEY", "CHANGE_ME")
DB_NAME      = os.getenv("DB_NAME", "studio333")
DB_USER      = os.getenv("DB_USER", "studio333")
DB_PASSWORD  = os.getenv("DB_PASSWORD", "studio333")
DB_HOST      = os.getenv("DB_HOST", "localhost")
DB_PORT      = int(os.getenv("DB_PORT", 5432))
DB_MIN_CONN  = int(os.getenv("DB_MIN_CONN", 1))
DB_MAX_CONN  = int(os.getenv("DB_MAX_CONN", 10))

SESSION_TIMEOUT_DEFAULT_MIN   = int(os.getenv("SESSION_TIMEOUT_DEFAULT_MIN", 60))
SESSION_TIMEOUT_MAX_MIN       = int(os.getenv("SESSION_TIMEOUT_MAX_MIN", 720))
SESSION_ABSOLUTE_LIFETIME_HRS = int(os.getenv("SESSION_ABSOLUTE_LIFETIME_HRS", 24))
SESSION_UPDATE_GRACE_SEC      = 30

# ----------------------------
# Flask
# ----------------------------
app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = SECRET_KEY
app.config["PREFERRED_URL_SCHEME"] = "https"

# ----------------------------
# Static media
# ----------------------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))
MEDIA_ROOT = os.path.join(APP_DIR, 'media')

@app.route('/media/<path:filename>', methods=['GET'])
def media(filename):
    return send_from_directory(MEDIA_ROOT, filename, conditional=True, max_age=0)

# ----------------------------
# DB pool (psycopg3)
# ----------------------------
_pool: ConnectionPool | None = None

def init_pool():
    global _pool
    if _pool is None:
        conninfo = f"dbname={DB_NAME} user={DB_USER} password={DB_PASSWORD} host={DB_HOST} port={DB_PORT}"
        _pool = ConnectionPool(conninfo=conninfo, min_size=DB_MIN_CONN, max_size=DB_MAX_CONN, kwargs={"autocommit": False})

def get_conn():
    init_pool()
    return _pool.connection()

def query_one(sql_txt, params=()):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql_txt, params)
        return cur.fetchone()

def execute(sql_txt, params=()):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql_txt, params)
        conn.commit()

@atexit.register
def _close_pool_on_exit():
    global _pool
    try:
        if _pool is not None:
            _pool.close()
    except Exception:
        pass

# ----------------------------
# Helpers
# ----------------------------
def nocache(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp

def current_user_id():
    return session.get("user_id")

def current_user_role():
    uid = current_user_id()
    if not uid:
        return None
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT role FROM users WHERE id=%s AND is_deleted=false", (uid,))
        row = cur.fetchone()
        return row[0] if row else None

def is_admin():
    role = current_user_role()
    return bool(role in ("admin", "super_admin"))

def login_required(fn):
    @wraps(fn)
    def _wrapped(*args, **kwargs):
        if not current_user_id():
            return redirect(url_for("bart", next=request.path))
        return fn(*args, **kwargs)
    return _wrapped

def require_admin(fn):
    @wraps(fn)
    def _wrapped(*args, **kwargs):
        if not is_admin():
            return jsonify({"error": "Forbidden"}), 403
        return fn(*args, **kwargs)
    return _wrapped

def require_login(fn):
    @wraps(fn)
    def _wrapped(*args, **kwargs):
        uid = session.get("user_id")
        if not uid:
            return jsonify({"ok": False, "error": "unauthorized"}), 401
        return fn(*args, **kwargs)
    return _wrapped

def log_user_activity(user_id, activity_type, context=None):
    try:
        ua = (request.user_agent.string or "")[:500]
        xff = request.headers.get("X-Forwarded-For", "")
        ip = xff.split(",")[0].strip() if xff else request.remote_addr
    except Exception:
        ua, ip = "", None
    execute(
        """
        INSERT INTO user_activity_log (user_id, activity_type, user_agent, ip_address, context)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (user_id, activity_type, ua, ip, PgJson(context) if context is not None else None),
    )

_slug_re = re.compile(r'[^a-z0-9]+')

def make_slug(title: str) -> str:
    s = (title or "").lower()
    s = _slug_re.sub("-", s).strip("-")
    return s or "album"

def unique_album_slug(cur, user_id: int, base: str) -> str:
    slug = base
    n = 2
    while True:
        cur.execute("SELECT 1 FROM albums WHERE user_id=%s AND slug=%s LIMIT 1", (user_id, slug))
        if not cur.fetchone():
            return slug
        slug = f"{base}-{n}"
        n += 1

def normalize_media_url(url_str: str | None) -> str | None:
    if not url_str:
        return None
    s = str(url_str).strip()
    parsed = urlparse(s)
    if not parsed.scheme and not parsed.netloc:
        return "/" + s.lstrip("/")
    req_host = (request.host or "").split(":")[0]
    host = (parsed.hostname or "").lower()
    is_local = host in {"localhost", "127.0.0.1"} or host.startswith("192.168.")
    same_origin = host == req_host.lower()
    if same_origin or is_local:
        return parsed.path or "/"
    return s

# ----------------------------
# Auth helpers (enhanced timeout)
# ----------------------------
def _now_ts() -> float:
    return time.time()

def _effective_idle_timeout_sec() -> int:
    chosen_min = int(session.get("session_timeout") or 0)
    if chosen_min <= 0:
        chosen_min = SESSION_TIMEOUT_DEFAULT_MIN
    chosen_min = max(1, min(chosen_min, SESSION_TIMEOUT_MAX_MIN))
    return chosen_min * 60

def _absolute_lifetime_sec() -> int:
    return max(1, SESSION_ABSOLUTE_LIFETIME_HRS) * 3600

def _expired_by_idle(now_ts: float) -> bool:
    last = float(session.get("last_active") or 0)
    if last <= 0:
        return False
    return (now_ts - last) > _effective_idle_timeout_sec()

def _expired_by_absolute(now_ts: float) -> bool:
    login_at = float(session.get("login_at") or 0)
    if login_at <= 0:
        return False
    return (now_ts - login_at) > _absolute_lifetime_sec()

def _refresh_last_active(now_ts: float) -> None:
    last = float(session.get("last_active") or 0)
    if now_ts - last >= SESSION_UPDATE_GRACE_SEC:
        session["last_active"] = now_ts

@app.before_request
def enforce_session_timeout():
    if not session.get("user_id"):
        return
    timeout = int(session.get("session_timeout", 0) or 0)
    last = session.get("last_active")
    now = time.time()
    if timeout and last and (now - last) > timeout:
        uid = session.get("user_id")
        session.clear()
        if uid: log_user_activity(uid, "session_expired")
        flash("Session expired.", "info")
        return redirect(url_for("bart"))
    session["last_active"] = now

# ----------------------------
# Routes
# ----------------------------
@app.route("/")
def index():
    resp = make_response(render_template("index.html", logged_in=bool(session.get("user_id"))))
    return nocache(resp)

@app.route("/bart", methods=["GET", "POST"])
def bart():
    if request.method == "GET" and session.get("user_id"):
        session.clear()

    if session.get("login_failures", 0) >= 3:
        return redirect(url_for("puzzle"))

    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = (request.form.get("password") or "").strip()

        row = query_one("""
            SELECT id, password_hash, role, nickname
            FROM users
            WHERE email = %s AND is_verified = TRUE AND is_deleted = FALSE
        """, (email,))

        if row and check_password_hash(row[1], password):
            user_id, _, role, nickname = row

            chosen_min = int(request.form.get("timeout", 0) or 0)
            if chosen_min <= 0:
                chosen_min = SESSION_TIMEOUT_DEFAULT_MIN
            chosen_min = max(1, min(chosen_min, SESSION_TIMEOUT_MAX_MIN))

            now_ts = _now_ts()
            session.clear()
            session["user_id"]        = user_id
            session["user_email"]     = email
            session["user_role"]      = role
            session["user_nickname"]  = nickname or email
            session["session_timeout"]= chosen_min
            session["login_at"]       = now_ts
            session["last_active"]    = now_ts

            try:
                log_user_activity(user_id, "login")
            except Exception:
                pass
            execute("UPDATE users SET last_login = NOW() WHERE id = %s", (user_id,))

            try:
                app.permanent_session_lifetime = timedelta(seconds=_absolute_lifetime_sec())
                session.permanent = True
            except Exception:
                pass

            return redirect(url_for("dashboard"))
        else:
            session["login_failures"] = session.get("login_failures", 0) + 1
            try:
                if row:
                    log_user_activity(row[0], "login_failed")
            except Exception:
                pass
            flash("Invalid email or password", "error")
            return redirect(url_for("bart"))

    resp = make_response(render_template("bart.html"))
    return nocache(resp)

@app.route("/puzzle")
def puzzle():
    return render_template("puzzle.html")

@app.route("/dashboard", methods=["GET"])
@login_required
def dashboard():
    return render_template("dashboard.html")

# Profile
# -------
@app.route('/profile', methods=['GET', 'POST'])
@login_required
def edit_user_profile():
    user_id = session.get('user_id')
    with get_conn() as conn, conn.cursor() as cur:
        if request.method == 'POST':
            nickname   = request.form.get('nickname', '').strip()
            avatar_url = request.form.get('avatar', '').strip()
            bio        = request.form.get('bio', '').strip()
            phone      = request.form.get('phone', '').strip()
            homepage   = request.form.get('homepage', '').strip()
            twitter    = request.form.get('twitter', '').strip()
            linkedin   = request.form.get('linkedin', '').strip()
            github     = request.form.get('github', '').strip()

            avatar_file = request.files.get('avatar_file')
            if avatar_file and avatar_file.filename:
                safe_nick = nickname or f"user{user_id}"
                filename = secure_filename(f"{safe_nick}_{uuid.uuid4().hex}.jpg")
                upload_path = os.path.join('static', 'avatars', filename)
                os.makedirs(os.path.dirname(upload_path), exist_ok=True)

                img = Image.open(avatar_file.stream).convert('RGB')
                img.thumbnail((512, 512), Image.LANCZOS)
                img.save(upload_path, format='JPEG', quality=85, optimize=True)

                avatar_url = f"/static/avatars/{filename}"

            if nickname:
                cur.execute("UPDATE users SET nickname = %s WHERE id = %s", (nickname, user_id))

            cur.execute("SELECT 1 FROM profiles WHERE user_id = %s", (user_id,))
            if cur.fetchone():
                cur.execute("""
                    UPDATE profiles
                       SET avatar=%s, bio=%s, phone=%s, homepage=%s,
                           twitter=%s, linkedin=%s, github=%s
                     WHERE user_id=%s
                """, (avatar_url, bio, phone, homepage, twitter, linkedin, github, user_id))
            else:
                cur.execute("""
                    INSERT INTO profiles (user_id, avatar, bio, phone, homepage, twitter, linkedin, github)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                """, (user_id, avatar_url, bio, phone, homepage, twitter, linkedin, github))

            conn.commit()
            flash("Profile updated successfully", "success")
            try:
                log_user_activity(user_id, 'profile_updated')
            except Exception:
                pass
            return redirect(url_for('dashboard'))

        cur.execute("SELECT nickname FROM users WHERE id = %s", (user_id,))
        nick_row = cur.fetchone()

        cur.execute("""
            SELECT avatar, bio, phone, homepage, twitter, linkedin, github
              FROM profiles
             WHERE user_id = %s
        """, (user_id,))
        prof_row = cur.fetchone()

    return render_template('edit_profile.html',
                           nickname=nick_row[0] if nick_row else "",
                           profile={
                               'avatar':   prof_row[0] if prof_row else "",
                               'bio':      prof_row[1] if prof_row else "",
                               'phone':    prof_row[2] if prof_row else "",
                               'homepage': prof_row[3] if prof_row else "",
                               'twitter':  prof_row[4] if prof_row else "",
                               'linkedin': prof_row[5] if prof_row else "",
                               'github':   prof_row[6] if prof_row else ""
                           })

@app.route('/logout', methods=['GET'])
@login_required
def logout():
    uid = session.get("user_id")
    try:
        if uid:
            log_user_activity(uid, "logout")
    except Exception:
        pass
    session.clear()
    return redirect(url_for('bart'))

# Dev Home
# --------
@app.route("/dev", methods=["GET"])
@login_required
def dev_home():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403
    return render_template("dev/index.html")

# ----------------------------
# CLI: initdb / seedadmin / run
# ----------------------------
SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  uuid UUID NOT NULL DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  nickname TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  twofa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  otp_secret TEXT,
  session_timeout INTEGER DEFAULT 0,
  last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar TEXT,
  bio TEXT,
  phone TEXT,
  homepage TEXT,
  twitter TEXT,
  linkedin TEXT,
  github TEXT
);

CREATE TABLE IF NOT EXISTS invitation_codes (
  id SERIAL PRIMARY KEY,
  invited_email TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  is_used BOOLEAN NOT NULL DEFAULT FALSE,
  used_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_activity_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  activity_type TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  context JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

def cmd_initdb():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(SCHEMA_SQL)
        conn.commit()
    if _pool is not None:
        _pool.close()
    print("DB schema ensured.")

def cmd_seedadmin():
    email = os.getenv("ADMIN_EMAIL", "admin@studio333.art")
    pwd   = os.getenv("ADMIN_PASSWORD", "change-me")
    nick  = os.getenv("ADMIN_NICK", "Admin")
    phash = generate_password_hash(pwd)

    row = query_one("SELECT 1 FROM users WHERE email=%s", (email,))
    if row:
        if _pool is not None:
            _pool.close()
        print(f"Admin exists: {email}")
        return

    execute(
        "INSERT INTO users(email, password_hash, role, nickname, is_verified) VALUES (%s,%s,%s,%s,%s)",
        (email, phash, "super_admin", nick, True),
    )
    if _pool is not None:
        _pool.close()
    print(f"Admin created: {email} / {pwd}")

# DEV - DB Tables (Markdown + copy-to-clipboard)
# ----------------------------------------------
from collections import defaultdict
import markdown

@app.route('/dev/db_tables', methods=['GET'])
@login_required
def dev_db_tables():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
              table_schema,
              table_name,
              column_name,
              data_type,
              is_nullable,
              column_default
            FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
            ORDER BY table_schema, table_name, ordinal_position;
        """)
        rows = cur.fetchall()

        tables = defaultdict(list)
        for schema, table, col, dtype, nullable, default in rows:
            tables[(schema, table)].append((
                col,
                dtype,
                'NO' if (nullable in ('NO', False)) else 'YES',
                default or "",
                ""
            ))

        counts = {}
        for (schema, table) in tables.keys():
            try:
                qry = sql.SQL("SELECT COUNT(*) FROM {}.{}").format(
                    sql.Identifier(schema), sql.Identifier(table)
                )
                cur.execute(qry)
                counts[(schema, table)] = cur.fetchone()[0]
            except Exception:
                counts[(schema, table)] = None

    md_lines = ["# `DB.md`"]
    last_schema = None
    for (schema, table) in sorted(tables.keys()):
        if schema != last_schema:
            md_lines.append("\n---\n")
            md_lines.append(f"## Schema: `{schema}`")
            last_schema = schema
        cols = tables[(schema, table)]
        count_val = counts.get((schema, table))
        count_str = f" (rows: {count_val})" if count_val is not None else ""
        md_lines.append(f"\n### Table: `{table}`{count_str}")
        md_lines.append("| Column | Data Type | Nullable | Default | Notes |")
        md_lines.append("|--------|-----------|----------|---------|-------|")
        for col_name, dtype, nullable, default, notes in cols:
            md_lines.append(f"| `{col_name}` | `{dtype}` | {nullable} | `{default}` | {notes} |")

    markdown_str = "\n".join(md_lines + ["\n---\n"])
    html = markdown.markdown(markdown_str, extensions=["tables"])
    return render_template('dev/db_tables.html', html=html, markdown_str=markdown_str)

# DEV - Routes registry & docs
# ----------------------------
logging.basicConfig(level=logging.DEBUG)

def _ensure_route_docs_table():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.route_docs (
                id SERIAL PRIMARY KEY,
                path TEXT NOT NULL,
                methods TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                doc TEXT DEFAULT NULL,
                UNIQUE (path, endpoint)
            );
        """)
        conn.commit()

def sync_routes_to_db(app):
    logging.debug("Syncing Flask routes to DB...")
    _ensure_route_docs_table()
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT path, endpoint FROM public.route_docs;")
        existing = {(row[0], row[1]) for row in cur.fetchall()}
        for rule in app.url_map.iter_rules():
            if rule.endpoint == "static":
                continue
            path = str(rule)
            methods = ",".join(sorted(m for m in rule.methods if m not in {"HEAD", "OPTIONS"}))
            endpoint = rule.endpoint
            if (path, endpoint) not in existing:
                view_func = app.view_functions.get(endpoint)
                func_doc = (view_func.__doc__.strip() if (view_func and view_func.__doc__) else "")
                cur.execute(
                    "INSERT INTO public.route_docs (path, methods, endpoint, doc) VALUES (%s, %s, %s, %s)",
                    (path, methods, endpoint, func_doc)
                )
        conn.commit()
    logging.debug("Route sync complete.")

@app.route("/dev/routes/<int:route_id>/details", methods=["GET"])
@login_required
def route_details(route_id: int):
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, path, methods, endpoint, COALESCE(doc, '') AS doc
            FROM public.route_docs
            WHERE id = %s
            """, (route_id,))
        row = cur.fetchone()
    if not row:
        abort(404)

    rid, path, methods_csv, endpoint, doc = row
    source_code = ""
    source_docstring = ""
    view_func = app.view_functions.get(endpoint)
    if view_func:
        try:
            source_code = inspect.getsource(view_func)
            source_docstring = (view_func.__doc__ or "").strip()
        except OSError:
            source_code = "# Source not available"

    return jsonify({
        "id": rid,
        "path": path,
        "methods": methods_csv.split(","),
        "endpoint": endpoint,
        "doc": doc or "",
        "source_code": source_code,
        "source_docstring": source_docstring
    })

@app.route("/dev/routes/update_doc", methods=["POST"])
@login_required
def update_doc():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403
    data = request.get_json(silent=True) or {}
    rid = data.get("id")
    doc = data.get("doc", "")
    if not isinstance(rid, int):
        return jsonify({"error": "Invalid id"}), 400
    _ensure_route_docs_table()
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE public.route_docs SET doc=%s WHERE id=%s", (doc, rid))
        conn.commit()
    return "", 204

@app.route("/dev/routes", methods=["GET"])
@login_required
def admin_routes():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403
    sync_routes_to_db(app)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, path, methods, endpoint, COALESCE(doc, '') AS doc
            FROM public.route_docs
            ORDER BY path, endpoint
        """)
        rows = cur.fetchall()
    routes = []
    for db_id, path, methods_csv, endpoint, db_doc in rows:
        view_func = app.view_functions.get(endpoint)
        source_doc = ""
        if view_func and getattr(view_func, "__doc__", None):
            source_doc = (view_func.__doc__ or "").strip()
        routes.append({
            "id": db_id,
            "rule": path,
            "methods": methods_csv.split(","),
            "endpoint": endpoint,
            "doc": (db_doc or "").strip(),
            "source_doc": (source_doc or "").strip()
        })
    return render_template("admin/admin_routes.html", routes=routes)

# DEV: DB health
# --------------
@app.route("/dev/db_health", methods=["GET"])
def dev_db_health():
    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT version()")
            server_version = cur.fetchone()[0]
            cur.execute("SELECT current_schema()")
            current_schema = cur.fetchone()[0]
            missing = []
            try:
                cur.execute("SELECT 1 FROM pg_extension WHERE extname='uuid-ossp'")
                if cur.fetchone() is None:
                    missing.append("uuid-ossp")
            except Exception:
                pass
        return jsonify({
            "ok": True,
            "server_version": server_version,
            "current_schema": current_schema,
            "missing_extensions": missing
        }), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 503

# ── HTTPS & cache headers
def generate_temp_ssl_cert():
    import subprocess
    ssl_dir = "/tmp/ssl"
    os.makedirs(ssl_dir, exist_ok=True)
    cert_file = os.path.join(ssl_dir, "server.crt")
    key_file = os.path.join(ssl_dir, "server.key")
    if not (os.path.exists(cert_file) and os.path.exists(key_file)):
        subprocess.run([
            "openssl", "req", "-new", "-newkey", "rsa:2048", "-days", "1", "-nodes", "-x509",
            "-keyout", key_file,
            "-out", cert_file,
            "-subj", "/C=US/ST=Denial/L=Springfield/O=Dis/CN=localhost"
        ], check=True)
    return cert_file, key_file

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# ----------------------------
# Auth/API Blueprint
# ----------------------------
api_auth = Blueprint("api_auth", __name__)

def _row_to_user(cur, user_id):
    cur.execute(
        "SELECT id, email, role, nickname, last_login FROM users WHERE id=%s AND is_deleted=false",
        (user_id,)
    )
    u = cur.fetchone()
    if not u:
        return None
    cur.execute("SELECT avatar FROM profiles WHERE user_id=%s", (user_id,))
    p = cur.fetchone()
    avatar_url = p[0] if p and p[0] else "media/icons/user.svg"
    return {
        "id": u[0],
        "email": u[1],
        "role": u[2],
        "name": u[3] or (u[1].split("@")[0] if u[1] else "User"),
        "last_login": (u[4].isoformat() if isinstance(u[4], datetime) else u[4]),
        "avatar_url": avatar_url
    }

@api_auth.post("/login")
def api_login():
    payload = request.get_json(silent=True) or request.form or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    if not email or not password:
        return jsonify({"error": "missing_credentials"}), 400

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, password_hash FROM users WHERE email=%s AND is_deleted=false", (email,))
        row = cur.fetchone()
        if not row:
            cur.execute(
                "INSERT INTO user_activity_log(user_id, activity_type, user_agent, ip_address, context) "
                "VALUES (%s,%s,%s,%s,%s)",
                (None, "login_failed_no_user", request.headers.get("User-Agent"), request.remote_addr, PgJson({"email": email}))
            )
            conn.commit()
            return jsonify({"error": "invalid_credentials", "reason": "email"}), 401

        user_id, pw_hash = row[0], row[1]
        if not check_password_hash(pw_hash, password):
            cur.execute(
                "INSERT INTO user_activity_log(user_id, activity_type, user_agent, ip_address, context) "
                "VALUES (%s,%s,%s,%s,%s)",
                (user_id, "login_failed_bad_password", request.headers.get("User-Agent"), request.remote_addr, PgJson({"email": email}))
            )
            conn.commit()
            return jsonify({"error": "invalid_credentials", "reason": "password"}), 401

        session["user_id"] = user_id
        session.modified = True

        cur.execute("UPDATE users SET last_login=now() WHERE id=%s", (user_id,))
        cur.execute(
            "INSERT INTO user_activity_log(user_id, activity_type, user_agent, ip_address) "
            "VALUES (%s,%s,%s,%s)",
            (user_id, "login", request.headers.get("User-Agent"), request.remote_addr)
        )
        conn.commit()

        user = _row_to_user(cur, user_id)
        return jsonify({"user": user}), 200

@api_auth.get("/me")
def api_me():
    uid = session.get("user_id")
    if not uid:
        return jsonify({"user": None}), 401
    with get_conn() as conn, conn.cursor() as cur:
        user = _row_to_user(cur, uid)
        if not user:
            session.pop("user_id", None)
            return jsonify({"user": None}), 401
        return jsonify({"user": user}), 200

# Albums: list/create/get/update/tracks/cover/delete/clone
@api_auth.get("/me/albums")
def api_me_albums():
    uid = session.get("user_id")
    if not uid:
        return jsonify({"albums": []}), 401
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, title, COALESCE(subtitle, '') AS subtitle,
                   COALESCE(cover_path, '') AS cover_url, created_at
            FROM albums
            WHERE user_id = %s
            ORDER BY created_at DESC, id DESC
            """,
            (uid,),
        )
        rows = cur.fetchall() or []
        albums = [{
            "id": r[0],
            "title": r[1],
            "subtitle": r[2],
            "cover_url": r[3],
            "created_at": (r[4].isoformat() if r[4] else None),
        } for r in rows]
        return jsonify({"albums": albums}), 200

@api_auth.post("/me/albums")
def api_me_albums_create():
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or request.form or {}
    title = (payload.get("title") or "").strip()
    subtitle = (payload.get("subtitle") or payload.get("band") or "").strip() or None
    cover_url = (payload.get("cover_url") or "").strip() or None
    if not title:
        return jsonify({"error":"title_required"}), 400

    with get_conn() as conn, conn.cursor() as cur:
        base = make_slug(title)
        slug = unique_album_slug(cur, uid, base)
        cur.execute(
            """
            INSERT INTO albums (id, user_id, slug, title, subtitle, cover_path, visibility, metadata)
            VALUES (uuid_generate_v4(), %s, %s, %s, %s, %s, 'private', '{}'::jsonb)
            RETURNING id::text, title, COALESCE(subtitle,''), COALESCE(cover_path,''), created_at
            """,
            (uid, slug, title, subtitle, cover_url),
        )
        row = cur.fetchone()
        conn.commit()

    album = {
        "id": row[0],
        "title": row[1],
        "subtitle": row[2],
        "cover_url": row[3],
        "created_at": (row[4].isoformat() if row[4] else None),
    }
    return jsonify({"album": album}), 201

@api_auth.get("/me/albums/<string:album_id>")
def api_album_get(album_id):
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "unauthorized"}), 401
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, user_id, slug, title, subtitle, description_md, cover_path,
                   visibility::text, metadata, created_at, updated_at
            FROM albums
            WHERE id = %s AND user_id = %s
            """,
            (album_id, uid),
        )
        row = cur.fetchone()
        if not row:
            return jsonify({"error": "not_found"}), 404
        album = {
            "id": row[0],
            "slug": row[2],
            "title": row[3],
            "subtitle": row[4] or "",
            "description_md": row[5] or "",
            "cover_url": row[6] or "",
            "visibility": row[7] or "private",
            "metadata": row[8] or {},
            "created_at": (row[9].isoformat() if row[9] else None),
            "updated_at": (row[10].isoformat() if row[10] else None),
        }
        return jsonify({"album": album}), 200

@api_auth.post("/me/albums/<string:album_id>")
def api_album_update(album_id):
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or request.form or {}
    title = (payload.get("title") or "").strip()
    subtitle = (payload.get("subtitle") or payload.get("band") or "").strip()
    description_md = (payload.get("description_md") or "").strip()
    visibility = (payload.get("visibility") or "private").strip()
    cover_url = (payload.get("cover_url") or "").strip()
    metadata = payload.get("metadata") or {}

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE albums
            SET title = COALESCE(NULLIF(%s,''), title),
                subtitle = COALESCE(NULLIF(%s,''), subtitle),
                description_md = %s,
                visibility = %s::visibility_enum,
                cover_path = %s,
                metadata = %s,
                updated_at = now()
            WHERE id = %s AND user_id = %s
            RETURNING id::text, title, COALESCE(subtitle,''), COALESCE(cover_path,''), visibility::text, metadata, updated_at
            """,
            (title, subtitle, description_md, visibility, cover_url or None, PgJson(metadata), album_id, uid),
        )
        row = cur.fetchone()
        if not row:
            return jsonify({"error": "not_found"}), 404
        conn.commit()
        out = {
            "id": row[0],
            "title": row[1],
            "subtitle": row[2],
            "cover_url": row[3],
            "visibility": row[4],
            "metadata": row[5] or {},
            "updated_at": (row[6].isoformat() if row[6] else None),
        }
        return jsonify({"album": out}), 200

@api_auth.get("/me/albums/<string:album_id>/tracks")
def api_album_tracks(album_id):
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "unauthorized"}), 401
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT metadata FROM albums WHERE id=%s AND user_id=%s", (album_id, uid))
        row = cur.fetchone()
        if not row:
            return jsonify({"error": "not_found"}), 404
        meta = row[0] or {}
        tracks = meta.get("tracks") or []
        return jsonify({"tracks": tracks}), 200

@api_auth.post("/me/albums/<string:album_id>/cover")
def api_album_upload_cover(album_id):
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "unauthorized"}), 401

    file = request.files.get("file")
    if not file or file.filename == "":
        return jsonify({"error": "file_required"}), 400

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM albums WHERE id=%s AND user_id=%s", (album_id, uid))
        if not cur.fetchone():
            return jsonify({"error": "not_found"}), 404

        name = secure_filename(file.filename)
        root = os.path.join(app.root_path, "static", "album_covers")
        os.makedirs(root, exist_ok=True)
        base, ext = os.path.splitext(name or "cover")
        fname = f"{album_id}{ext.lower() or '.jpg'}"
        path_fs = os.path.join(root, fname)
        file.save(path_fs)

        url_rel = f"/static/album_covers/{fname}"
        cur.execute("UPDATE albums SET cover_path=%s, updated_at=now() WHERE id=%s AND user_id=%s", (url_rel, album_id, uid))
        conn.commit()

    return jsonify({"cover_url": url_rel}), 200

@api_auth.delete("/me/albums/<string:album_id>")
def api_album_delete(album_id):
    uid = session.get("user_id")
    if not uid:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM albums WHERE id=%s AND user_id=%s", (album_id, uid))
        if cur.fetchone() is None:
            return jsonify({"ok": False, "error": "not_found_or_forbidden"}), 404
        cur.execute("DELETE FROM album_tracks WHERE album_id = %s", (album_id,))
        cur.execute("DELETE FROM albums WHERE id = %s AND user_id = %s", (album_id, uid))
        conn.commit()
    return jsonify({"ok": True})

@api_auth.post("/me/albums/<string:album_id>/clone")
def api_album_clone(album_id):
    uid = session.get("user_id")
    if not uid:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    with get_conn() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT id, title, subtitle, description_md, cover_path, visibility, metadata
            FROM albums
            WHERE id = %s AND user_id = %s
            """,
            (album_id, uid)
        )
        src = cur.fetchone()
        if not src:
            return jsonify({"ok": False, "error": "not_found_or_forbidden"}), 404

        new_title = (src["title"] or "Untitled") + " (Copy)"
        new_subtitle = src.get("subtitle")
        new_desc = src.get("description_md") or ""
        new_cover_path = src.get("cover_path")
        new_visibility = src.get("visibility") or "private"
        new_metadata = src.get("metadata") or {}

        cur.execute(
            """
            INSERT INTO albums (slug, title, subtitle, description_md, cover_path, visibility, metadata, user_id)
            VALUES (uuid_generate_v4()::text, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, slug, title, subtitle, description_md, cover_path, visibility, metadata, created_at, updated_at
            """,
            (new_title, new_subtitle, new_desc, new_cover_path, new_visibility, PgJson(new_metadata), uid),
        )
        new_album = cur.fetchone()

        cur.execute(
            "SELECT media_id, position, variant, notes FROM album_tracks WHERE album_id = %s ORDER BY position ASC",
            (album_id,)
        )
        for t in cur.fetchall() or []:
            cur.execute(
                """
                INSERT INTO album_tracks (album_id, media_id, position, variant, notes)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (str(new_album["id"]), str(t["media_id"]), int(t["position"]), t.get("variant") or "", t.get("notes"))
            )
        conn.commit()

    resp = dict(new_album)
    resp["cover_url"] = resp.pop("cover_path", None)
    return jsonify({"ok": True, "album": resp}), 201

@api_auth.post("/logout")
def api_logout():
    uid = session.get("user_id")
    session.pop("user_id", None)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO user_activity_log(user_id, activity_type, user_agent, ip_address) "
            "VALUES (%s,%s,%s,%s)",
            (uid, "logout", request.headers.get("User-Agent"), request.remote_addr)
        )
        conn.commit()
    return jsonify({"ok": True}), 200

# Register blueprint
app.register_blueprint(api_auth)




# ── RUN / CLI dispatcher
if __name__ == '__main__':
    import argparse

    def _call_first_available(names):
        g = globals()
        for n in names:
            fn = g.get(n)
            if callable(fn):
                fn()
                return True
        return False

    parser = argparse.ArgumentParser(prog='app.py', add_help=True)
    sub = parser.add_subparsers(dest='cmd')

    p_run = sub.add_parser('run', help='Start HTTPS dev server with auto-reload')
    p_run.add_argument('--host', default=os.environ.get('FLASK_HOST', '0.0.0.0'))
    p_run.add_argument('--port', type=int, default=int(os.environ.get('FLASK_PORT', '5000')))
    p_run.add_argument('--no-ssl', action='store_true', help='Disable HTTPS (use HTTP)')
    p_run.add_argument('--no-reload', action='store_true', help='Disable code auto-reload')

    sub.add_parser('initdb', help='Initialize database (calls initdb/init_db)')
    sub.add_parser('seedadmin', help='Seed admin user (calls seedadmin/seed_admin)')

    args = parser.parse_args(None if len(sys.argv) > 1 else ['run'])

    if args.cmd == 'initdb':
        if not _call_first_available(['initdb', 'init_db', 'cmd_initdb']):
            print('No initdb/init_db()/cmd_initdb() found.', file=sys.stderr)
            sys.exit(2)
        else:
            cmd_initdb()
        sys.exit(0)

    if args.cmd == 'seedadmin':
        if not _call_first_available(['seedadmin', 'seed_admin', 'cmd_seedadmin']):
            print('No seedadmin/seed_admin()/cmd_seedadmin() found.', file=sys.stderr)
            sys.exit(2)
        else:
            cmd_seedadmin()
        sys.exit(0)

    host = getattr(args, 'host', os.environ.get('FLASK_HOST', '0.0.0.0'))
    port = int(getattr(args, 'port', os.environ.get('FLASK_PORT', '5000')))
    use_ssl = not getattr(args, 'no_ssl', False)
    use_reload = not getattr(args, 'no_reload', False)

    if use_ssl:
        cert, key = generate_temp_ssl_cert()
        app.run(host=host, port=port, ssl_context=(cert, key), debug=True, use_reloader=use_reload, threaded=True)
    else:
        app.run(host=host, port=port, debug=True, use_reloader=use_reload, threaded=True)
