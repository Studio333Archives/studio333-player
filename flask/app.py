#!/usr/bin/env python3
# app.py — studio333.art (Flask + psycopg3 pool; Jinja templates in app/templates)





import os, sys, time, json, atexit, re
from functools import wraps


from flask import Flask, request, session, jsonify, redirect, url_for, render_template, render_template_string, abort, make_response, send_from_directory, flash
from werkzeug.utils import secure_filename
import uuid
from PIL import Image


from werkzeug.security import generate_password_hash, check_password_hash

import psycopg
from psycopg_pool import ConnectionPool
from psycopg.errors import UniqueViolation
from psycopg.types.json import Json

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

# Session policy (idle + absolute lifetime)
SESSION_TIMEOUT_DEFAULT_MIN   = int(os.getenv("SESSION_TIMEOUT_DEFAULT_MIN", 60))   # default idle timeout (minutes)
SESSION_TIMEOUT_MAX_MIN       = int(os.getenv("SESSION_TIMEOUT_MAX_MIN", 720))     # clamp user-supplied (minutes)
SESSION_ABSOLUTE_LIFETIME_HRS = int(os.getenv("SESSION_ABSOLUTE_LIFETIME_HRS", 24))# absolute max (hours)
SESSION_UPDATE_GRACE_SEC      = 30  # reduce churn: only refresh last_active if >30s since last refresh



# DB connection helper
# --------------------
def get_db_connection():
    """
    Return a fresh psycopg connection using env config.
    Kept simple so existing call sites using .cursor()/close() continue to work.
    """
    return psycopg.connect(
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
        host=DB_HOST,
        port=DB_PORT,
    )


# ----------------------------
# Flask
# ----------------------------
app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static"
)
app.secret_key = SECRET_KEY
app.config["PREFERRED_URL_SCHEME"] = "https"

# ----------------------------
# Static media
# ----------------------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))
MEDIA_ROOT = os.path.join(APP_DIR, 'media')

@app.route('/media/<path:filename>', methods=['GET'])
def media(filename):
    """
    Serve media assets from ./media via /media/<path>.
    No auth. No proxy rewriting. No fallback. Returns 404 if missing.
    """
    return send_from_directory(MEDIA_ROOT, filename, conditional=True, max_age=0)


# ----------------------------
# DB pool (psycopg3)
# ----------------------------
_pool: ConnectionPool | None = None

def init_pool():
    """
    Lazily initialize a global connection pool for PostgreSQL connections.
    The pool is created once per process and reused by helper functions.
    """
    global _pool
    if _pool is None:
        conninfo = (
            f"dbname={DB_NAME} user={DB_USER} password={DB_PASSWORD} "
            f"host={DB_HOST} port={DB_PORT}"
        )
        _pool = ConnectionPool(
            conninfo=conninfo,
            min_size=DB_MIN_CONN,
            max_size=DB_MAX_CONN,
            kwargs={"autocommit": False},
        )

def get_conn():
    """
    Acquire a pooled connection. Use as context manager:
      with get_conn() as conn: ...
    Closing the connection returns it to the pool.
    """
    init_pool()
    return _pool.connection()

def query_one(sql, params=()):
    """
    Run a single-row query and return the first row (or None).
    Commits are not required for reads; the connection is returned to the pool.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()

def execute(sql, params=()):
    """
    Execute a statement and commit. Intended for INSERT/UPDATE/DELETE, schema ops.
    Uses one short-lived pooled connection per call.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        conn.commit()

@atexit.register
def _close_pool_on_exit():
    """
    Close the global pool during interpreter shutdown to stop pool threads cleanly.
    Prevents 'cannot join thread at interpreter shutdown' noise on one-off CLI runs.
    """
    global _pool
    try:
        if _pool is not None:
            _pool.close()
    except Exception:
        pass


# ----------------------------
# Helpers
# ----------------------------
from functools import wraps
from flask import redirect, url_for, request, session
from psycopg.types.json import Json

def nocache(resp):
    """Add no-cache headers to a response to prevent browser/proxy caching."""
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp

def current_user_id():
    """Return authenticated user id from session or None."""
    return session.get("user_id")

def current_user_role():
    """Return current user role from DB or None."""
    uid = current_user_id()
    if not uid:
        return None
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT role FROM users WHERE id=%s AND is_deleted=false", (uid,))
        row = cur.fetchone()
        return row[0] if row else None

def is_admin():
    """Return True when user role is admin or super_admin."""
    role = current_user_role()
    return bool(role in ("admin", "super_admin"))

def login_required(fn):
    """Decorator that redirects to /bart when not authenticated."""
    @wraps(fn)
    def _wrapped(*args, **kwargs):
        if not current_user_id():
            return redirect(url_for("bart", next=request.path))
        return fn(*args, **kwargs)
    return _wrapped

def require_admin(fn):
    """Decorator that returns 403 when user is not admin or super_admin."""
    @wraps(fn)
    def _wrapped(*args, **kwargs):
        if not is_admin():
            return jsonify({"error": "Forbidden"}), 403
        return fn(*args, **kwargs)
    return _wrapped

def log_user_activity(user_id, activity_type, context=None):
    """Insert audit record with user agent, IP, and optional JSON context."""
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
        (user_id, activity_type, ua, ip, Json(context) if context is not None else None),
    )


_slug_re = re.compile(r'[^a-z0-9]+')

def make_slug(title: str) -> str:
    """Lowercase, trim, collapse non-alnum to hyphens; strip hyphens."""
    s = (title or "").lower()
    s = _slug_re.sub("-", s)
    s = s.strip("-")
    return s or "album"

def unique_album_slug(cur, user_id: int, base: str) -> str:
    """Return a slug unique per user by appending -2, -3, … if needed."""
    slug = base
    n = 2
    while True:
        cur.execute(
            "SELECT 1 FROM albums WHERE user_id=%s AND slug=%s LIMIT 1",
            (user_id, slug)
        )
        if not cur.fetchone():
            return slug
        slug = f"{base}-{n}"
        n += 1






# ----------------------------
# Auth helpers (enhanced timeout)
# ----------------------------
from functools import wraps
from datetime import timedelta

def _now_ts() -> float:
    return time.time()

def _effective_idle_timeout_sec() -> int:
    # user-chosen timeout (minutes) comes from session["session_timeout"]; 0 means use default
    chosen_min = int(session.get("session_timeout") or 0)
    if chosen_min <= 0:
        chosen_min = SESSION_TIMEOUT_DEFAULT_MIN
    # clamp to sane bounds
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

def login_required(view):
    """
    Decorator: requires session['user_id'] and enforces idle + absolute expirations.
    On expiry, clears session and redirects to /bart with a flash message.
    """
    @wraps(view)
    def inner(*args, **kwargs):
        uid = session.get("user_id")
        if not uid:
            return redirect(url_for("bart"))

        now_ts = _now_ts()
        if _expired_by_idle(now_ts) or _expired_by_absolute(now_ts):
            session.clear()
            try:
                flash("Session expired. Please sign in again.", "error")
            except Exception:
                pass
            return redirect(url_for("bart"))

        _refresh_last_active(now_ts)
        # also set flask's permanent lifetime to match absolute limit
        try:
            app.permanent_session_lifetime = timedelta(seconds=_absolute_lifetime_sec())
            session.permanent = True
        except Exception:
            pass
        return view(*args, **kwargs)
    return inner




@app.before_request
def enforce_session_timeout():
    """
    If a session timeout is configured, expire idle sessions and redirect to /bart.
    Updates last_active on each request from authenticated users.
    """
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
    """
    Landing route: render WebGL canvas page. A minimal HUD is shown when logged-in.
    """
    resp = make_response(render_template("index.html", logged_in=bool(session.get("user_id"))))
    return nocache(resp)




@app.route("/bart", methods=["GET", "POST"])
def bart():
    """
    Authentication route with idle/absolute session policy.
    GET: show login; if already logged in, clear session first (explicit re-auth).
    POST: verify credentials; on success set session + timeouts; on 3 failures redirect /puzzle.
    """
    # ensure /bart always shows login form (explicit re-auth entry point)
    if request.method == "GET" and session.get("user_id"):
        session.clear()

    # soft rate-limit
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

            # compute effective idle timeout from form or default (minutes)
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
            session["session_timeout"]= chosen_min                 # minutes (idle)
            session["login_at"]       = now_ts                     # absolute lifetime anchor
            session["last_active"]    = now_ts

            try:
                log_user_activity(user_id, "login")
            except Exception:
                pass
            execute("UPDATE users SET last_login = NOW() WHERE id = %s", (user_id,))

            # align Flask permanent session with absolute lifetime
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



# @app.route("/logout")
# def logout():
#     """
#     Clear session and log a logout event; then send user to the landing page.
#     """
#     uid = session.get("user_id")
#     if uid: log_user_activity(uid, "logout")
#     session.clear()
#     return redirect(url_for("index"))

@app.route("/puzzle")
def puzzle():
    """
    Render a lightweight puzzle page used after repeated failed logins.
    """
    return render_template("puzzle.html")

# Dashboard
# ---------
@app.route("/dashboard", methods=["GET"])
@login_required
def dashboard():
    """
    Main dashboard view; uses shared dev/user header include.
    """
    return render_template("dashboard.html")





# Profile
# -------
@app.route('/profile', methods=['GET', 'POST'])
@login_required
def edit_user_profile():
    """
    Edit profile and avatar; persists to users.nickname and profiles table.
    """
    user_id = session.get('user_id')
    conn = get_db_connection()
    cur = conn.cursor()

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
        cur.close(); conn.close()
        return redirect(url_for('dashboard'))

    # GET
    cur.execute("SELECT nickname FROM users WHERE id = %s", (user_id,))
    nick_row = cur.fetchone()

    cur.execute("""
        SELECT avatar, bio, phone, homepage, twitter, linkedin, github
          FROM profiles
         WHERE user_id = %s
    """, (user_id,))
    prof_row = cur.fetchone()

    cur.close(); conn.close()
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

# Logout
# ------
@app.route('/logout', methods=['GET'])
@login_required
def logout():
    """
    Clear session and return to login.
    """
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
    """
    Dev tools landing; links to DB tables and Routes admin.
    """
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
    """
    Ensure the database schema exists by executing SCHEMA_SQL once.
    Closes the pool explicitly to avoid background-thread warnings on exit.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(SCHEMA_SQL)
        conn.commit()
    if _pool is not None:
        _pool.close()
    print("DB schema ensured.")

def cmd_seedadmin():
    """
    Create a default super admin user if not present, with credentials
    from environment variables. Closes the pool explicitly on completion.
    """
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
    """Admin-only schema browser (Markdown): lists all non-system schemas and tables with columns + row counts."""
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    conn = get_db_connection()
    cur = conn.cursor()

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

    from collections import defaultdict
    tables = defaultdict(list)  # key: (schema, table) -> [columns]
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

    cur.close()
    conn.close()

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




# DEV - Routes registry & docs (template-based)
# ---------------------------------------------
import inspect
import logging
from flask import abort, jsonify, render_template, request

logging.basicConfig(level=logging.DEBUG)

def _ensure_route_docs_table():
    """
    Ensure the route_docs table exists for persisting per-route documentation.
    """
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
    """
    Ensure all Flask routes exist in route_docs, prefilling with function docstring.
    """
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
                logging.info("Inserted route: %s [%s]", path, endpoint)

        conn.commit()
    logging.debug("Route sync complete.")

@app.route("/dev/routes/<int:route_id>/details", methods=["GET"])
@login_required
def route_details(route_id: int):
    """
    Return JSON with route metadata, Python source code, and docstring.
    """
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
    """
    Update documentation text for a given route ID.
    """
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
    """
    List registered routes with DB docs and source docstrings (template).
    """
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
    """
    Lightweight DB readiness probe. Returns JSON with 'ok', 'server_version',
    'current_schema', and missing extensions (uuid-ossp).
    """
    try:
        conn = get_db_connection()
        cur  = conn.cursor()
        cur.execute("SELECT version()")
        server_version = cur.fetchone()[0]

        # current schema (PostgreSQL)
        cur.execute("SELECT current_schema()")
        current_schema = cur.fetchone()[0]

        # extension check (optional)
        missing = []
        try:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname='uuid-ossp'")
            if cur.fetchone() is None:
                missing.append("uuid-ossp")
        except Exception:
            # not PostgreSQL or no perms
            pass

        cur.close(); conn.close()
        return jsonify({
            "ok": True,
            "server_version": server_version,
            "current_schema": current_schema,
            "missing_extensions": missing
        }), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 503









# # --- albums: DB helper, page route, and audioteka-backed media search ---
# import os, re, hashlib, threading, time
# from pathlib import Path
# from flask import render_template, request, jsonify, abort
# import psycopg2, psycopg2.extras

# # DB helper (uses DATABASE_URL, or DB_* pieces)
# def pg():
#     dsn = os.getenv("DATABASE_URL")
#     if dsn:
#         conn = psycopg2.connect(dsn); conn.autocommit = True; return conn
#     conn = psycopg2.connect(
#         dbname=os.getenv("DB_NAME", "studio333"),
#         user=os.getenv("DB_USER", "studio333"),
#         password=os.getenv("DB_PASSWORD", ""),
#         host=os.getenv("DB_HOST", "localhost"),
#         port=int(os.getenv("DB_PORT", "5432")),
#     )
#     conn.autocommit = True
#     return conn

# # Page: SPA shell
# @app.route("/albums")
# def albums_page():
#     return render_template("albums.html")

# # --- media index from media/archives/audioteka.txt (deterministic path under this Flask app) ---
# _APP_ROOT = Path(app.root_path).resolve()
# _AUDIOTEKA_TXT = os.getenv("AUDIOTEKA_TXT", str(_APP_ROOT / "media" / "archives" / "audioteka.txt"))

# _MEDIA_EXTS = {
#     ".mp3": "audio", ".wav": "audio", ".flac": "audio", ".m4a": "audio",
#     ".mp4": "video", ".mkv": "video", ".webm": "video", ".mov": "video"
# }
# _media_cache = {"items": [], "by_rel": {}, "mtime": 0.0, "src": None, "loaded_at": 0.0}
# _media_lock = threading.Lock()

# def _strip_tree_glyphs(s: str) -> str:
#     s = re.sub(r"^[\s│]+", "", s)
#     s = re.sub(r"^(├──|└──)\s*", "", s)
#     return s.strip()

# def _kind_for(name: str) -> str | None:
#     _, ext = os.path.splitext(name.lower())
#     return _MEDIA_EXTS.get(ext)

# def _nice_title(fname: str) -> str:
#     base = os.path.splitext(os.path.basename(fname))[0]
#     base = re.sub(r"[_#]+", " ", base)
#     base = re.sub(r"\s*--\s*", " — ", base)
#     return re.sub(r"\s{2,}", " ", base).strip()

# def _scan_audioteka_locked() -> None:
#     src_path = Path(_AUDIOTEKA_TXT)
#     if not src_path.exists():
#         app.logger.warning("ALBUMS: audioteka.txt not found at %s", src_path)
#         _media_cache.update({"items": [], "by_rel": {}, "mtime": 0.0, "src": None, "loaded_at": time.time()})
#         return

#     try:
#         mtime = src_path.stat().st_mtime
#     except OSError:
#         mtime = time.time()

#     if _media_cache["src"] == str(src_path) and _media_cache["mtime"] == mtime and _media_cache["items"]:
#         return

#     items, by_rel = [], {}
#     current_folder = ""
#     with src_path.open("r", encoding="utf-8", errors="ignore") as f:
#         for raw in f:
#             line = _strip_tree_glyphs(raw)
#             if not line or line == ".":
#                 continue
#             kind = _kind_for(line)
#             if kind is None:
#                 current_folder = line
#                 continue
#             folder = current_folder
#             filename = line
#             rel_path = f"{folder}/{filename}" if folder else filename
#             mid = hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:16]  # index id only (NOT DB id)
#             item = {"id": mid, "folder": folder, "filename": filename, "rel_path": rel_path,
#                     "title": _nice_title(filename), "kind": kind}
#             items.append(item)
#             by_rel[rel_path] = item

#     _media_cache.update({
#         "items": items, "by_rel": by_rel, "mtime": mtime, "src": str(src_path), "loaded_at": time.time()
#     })
#     app.logger.info("ALBUMS: loaded %d entries from %s", len(items), src_path)

# def _ensure_media_index() -> None:
#     with _media_lock:
#         _scan_audioteka_locked()

# @app.get("/api/albums/media_search")
# def api_albums_media_search():
#     _ensure_media_index()
#     q = (request.args.get("q") or "").strip().lower()
#     folder = (request.args.get("folder") or "").strip()
#     try:
#         limit = min(max(int(request.args.get("limit", "100")), 1), 1000)
#     except ValueError:
#         limit = 100

#     items = _media_cache["items"]
#     if not q and not folder:
#         out = []
#     else:
#         out = []
#         for it in items:
#             if folder and it["folder"] != folder:
#                 continue
#             if q:
#                 hay = f"{it['title']} {it['filename']} {it['rel_path']}".lower()
#                 if q not in hay:
#                     continue
#             out.append(it)
#             if len(out) >= limit:
#                 break

#     app.logger.debug("ALBUMS: media_search q=%r folder=%r -> %d/%d", q, folder, len(out), len(items))
#     return jsonify({"items": out, "total": len(items), "source": _media_cache["src"]})

# @app.post("/api/albums/media_resolve")
# def api_albums_media_resolve():
#     _ensure_media_index()
#     data = request.get_json(silent=True) or {}
#     paths = data.get("paths") or []
#     items = []
#     for p in paths:
#         it = _media_cache["by_rel"].get(p)
#         if it: items.append(it)
#     return jsonify({"items": items})

# @app.post("/api/albums/media_refresh")
# def api_albums_media_refresh():
#     with _media_lock:
#         _media_cache.update({"items": [], "by_rel": {}, "mtime": 0.0, "src": None, "loaded_at": 0.0})
#         _scan_audioteka_locked()
#     return jsonify({"count": len(_media_cache["items"]), "mtime": _media_cache["mtime"],
#                     "loaded_at": _media_cache["loaded_at"], "source": _media_cache["src"]})

# # --- albums CRUD/APIs (DB uses UUIDs) ---
# @app.get("/api/albums")
# def api_albums_list():
#     with pg().cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
#         cur.execute("""
#           SELECT id::text, slug, title, subtitle, visibility, release_date, created_at
#           FROM albums
#           ORDER BY created_at DESC
#         """)
#         rows = cur.fetchall()
#     return jsonify({"items": rows})

# @app.post("/api/albums")
# def api_albums_create():
#     data = request.get_json(force=True, silent=True) or {}
#     title = (data.get("title") or "").strip()
#     slug  = (data.get("slug") or "").strip()
#     if not title or not slug:
#         abort(400, "title and slug required")
#     with pg() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
#         cur.execute("""
#           INSERT INTO albums(id, slug, title, description_md, metadata)
#           VALUES (uuid_generate_v4(), %s, %s, %s, '{}'::jsonb)
#           RETURNING id::text, slug, title
#         """, (slug, title, data.get("description_md") or ""))
#         row = cur.fetchone()
#     return jsonify(row), 201

# @app.get("/api/albums/<aid>")
# def api_album_get(aid):
#     with pg().cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
#         cur.execute("SELECT id::text, slug, title, subtitle, description_md FROM albums WHERE id=%s::uuid", (aid,))
#         album = cur.fetchone()
#         if not album:
#             abort(404)
#         cur.execute("""
#           SELECT t.id::text, t.position, t.variant, t.notes,
#                  m.id::text AS media_id, m.title, m.rel_path, m.kind, m.duration_sec
#           FROM album_tracks t
#           JOIN media_items m ON m.id = t.media_id
#           WHERE t.album_id = %s::uuid
#           ORDER BY t.position ASC
#         """, (aid,))
#         tracks = cur.fetchall()
#     return jsonify({"album": album, "tracks": tracks})

# # Helper: ensure media_items row exists for rel_path, return UUID
# def _ensure_media_uuid(cur, rel_path: str) -> str:
#     cur.execute("SELECT id::text FROM media_items WHERE rel_path=%s LIMIT 1", (rel_path,))
#     row = cur.fetchone()
#     if row:
#         return row[0]
#     title = _nice_title(os.path.basename(rel_path))
#     kind = _kind_for(rel_path) or "audio"
#     cur.execute("""
#       INSERT INTO media_items(id, kind, slug, title, rel_path, description_md, metadata)
#       VALUES (uuid_generate_v4(), %s, NULL, %s, %s, ''::text, '{}'::jsonb)
#       RETURNING id::text
#     """, (kind, title, rel_path))
#     return cur.fetchone()[0]

# # Add tracks using rel_paths from the audioteka index (fixes non-UUID problem)
# @app.post("/api/albums/<aid>/tracks_from_index")
# def api_album_add_tracks_from_index(aid):
#     data = request.get_json(force=True, silent=True) or {}
#     paths = data.get("paths") or []
#     variant = (data.get("variant") or "").strip()
#     if not isinstance(paths, list) or not paths:
#         abort(400, "paths list required")
#     with pg() as conn, conn.cursor() as cur:
#         # ensure album exists
#         cur.execute("SELECT 1 FROM albums WHERE id=%s::uuid", (aid,))
#         if not cur.fetchone():
#             abort(404, "album not found")
#         # current max position
#         cur.execute("SELECT COALESCE(MAX(position),0) FROM album_tracks WHERE album_id=%s::uuid", (aid,))
#         pos = cur.fetchone()[0]
#         added = 0
#         for rel_path in paths:
#             media_uuid = _ensure_media_uuid(cur, rel_path)
#             pos += 1
#             cur.execute("""
#               INSERT INTO album_tracks(id, album_id, media_id, position, variant, notes)
#               VALUES (uuid_generate_v4(), %s::uuid, %s::uuid, %s, %s, NULL)
#               ON CONFLICT (album_id, media_id, variant) DO NOTHING
#             """, (aid, media_uuid, pos, variant))
#             added += 1
#     return jsonify({"status": "ok", "added": added})

# @app.post("/api/albums/<aid>/tracks")
# def api_album_add_tracks(aid):
#     # legacy endpoint kept for compatibility if media_ids are real UUIDs
#     data = request.get_json(force=True, silent=True) or {}
#     media_ids = data.get("media_ids") or []
#     if not isinstance(media_ids, list) or not media_ids:
#         abort(400, "media_ids list required")
#     variant = (data.get("variant") or "").strip()
#     notes   = (data.get("notes") or None)
#     with pg() as conn, conn.cursor() as cur:
#         cur.execute("SELECT COALESCE(MAX(position),0) FROM album_tracks WHERE album_id=%s::uuid", (aid,))
#         pos = cur.fetchone()[0]
#         for mid in media_ids:
#             pos += 1
#             cur.execute("""
#               INSERT INTO album_tracks(id, album_id, media_id, position, variant, notes)
#               VALUES (uuid_generate_v4(), %s::uuid, %s::uuid, %s, %s, %s)
#               ON CONFLICT (album_id, media_id, variant) DO NOTHING
#             """, (aid, mid, pos, variant, notes))
#     return jsonify({"status": "ok", "added": len(media_ids)})

# @app.put("/api/albums/<aid>/tracks/reorder")
# def api_album_reorder(aid):
#     data = request.get_json(force=True, silent=True) or {}
#     order = data.get("order") or []
#     if not isinstance(order, list) or not order:
#         abort(400, "order list required")
#     with pg() as conn, conn.cursor() as cur:
#         for idx, tid in enumerate(order, start=1):
#             cur.execute("""
#               UPDATE album_tracks SET position=%s, updated_at=now()
#               WHERE id=%s::uuid AND album_id=%s::uuid
#             """, (idx, tid, aid))
#     return jsonify({"status": "ok"})

# @app.delete("/api/albums/<aid>/tracks/<tid>")
# def api_album_del_track(aid, tid):
#     with pg() as conn, conn.cursor() as cur:
#         cur.execute("DELETE FROM album_tracks WHERE id=%s::uuid AND album_id=%s::uuid", (tid, aid))
#     return jsonify({"status": "ok"})
# # --- end albums block ---











# ── HTTPS & cache headers (kept local to entrypoint section) ────────────────
def generate_temp_ssl_cert():
    """
    Create/ensure a short-lived self-signed cert and return (cert_path, key_path).
    Uses /tmp/ssl and regenerates only when missing.
    """
    import os, subprocess
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
    """
    Force no-cache headers for all responses to avoid stale dev assets.
    """
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response














# app.py — Auth API as a Blueprint kept in the same file (monolith-friendly)
from flask import Blueprint, request, session, jsonify
from werkzeug.security import check_password_hash
from datetime import datetime

api_auth = Blueprint("api_auth", __name__)

def _row_to_user(cur, user_id):
    """Return minimal user payload used by the UI (id, email, role, name, last_login, avatar_url)."""
    cur.execute(
        "SELECT id, email, role, nickname, last_login "
        "FROM users WHERE id=%s AND is_deleted=false",
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




# app.py — REPLACE the entire login function with this version
from psycopg.types.json import Json

@api_auth.post("/login")
def api_login():
    """Authenticate using email/password; start session; log outcome; return {"user":{...}} or 401."""
    payload = request.get_json(silent=True) or request.form or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    if not email or not password:
        return jsonify({"error": "missing_credentials"}), 400

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, password_hash FROM users WHERE email=%s AND is_deleted=false",
            (email,)
        )
        row = cur.fetchone()
        if not row:
            cur.execute(
                "INSERT INTO user_activity_log(user_id, activity_type, user_agent, ip_address, context) "
                "VALUES (%s,%s,%s,%s,%s)",
                (None, "login_failed_no_user", request.headers.get("User-Agent"), request.remote_addr, Json({"email": email}))
            )
            conn.commit()
            return jsonify({"error": "invalid_credentials", "reason": "email"}), 401

        user_id, pw_hash = row[0], row[1]
        if not check_password_hash(pw_hash, password):
            cur.execute(
                "INSERT INTO user_activity_log(user_id, activity_type, user_agent, ip_address, context) "
                "VALUES (%s,%s,%s,%s,%s)",
                (user_id, "login_failed_bad_password", request.headers.get("User-Agent"), request.remote_addr, Json({"email": email}))
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
    """Return current session user JSON or 401 when unauthenticated; clears stale sessions safely."""
    uid = session.get("user_id")
    if not uid:
        return jsonify({"user": None}), 401
    with get_conn() as conn, conn.cursor() as cur:
        user = _row_to_user(cur, uid)
        if not user:
            session.pop("user_id", None)
            return jsonify({"user": None}), 401
        return jsonify({"user": user}), 200



@api_auth.get("/me/albums")
def api_me_albums():
    """Return the authenticated user's albums as [{id,title,cover_url,created_at}]; 401 when not logged in."""
    uid = session.get("user_id")
    if not uid:
        return jsonify({"albums": []}), 401
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, title, COALESCE(cover_path, '') AS cover_url, created_at
            FROM albums
            WHERE user_id = %s
            ORDER BY created_at DESC, id DESC
            """,
            (uid,),
        )
        rows = cur.fetchall() or []
        albums = [
            {
                "id": r[0],
                "title": r[1],
                "cover_url": r[2],
                "created_at": (r[3].isoformat() if r[3] else None),
            }
            for r in rows
        ]
        return jsonify({"albums": albums}), 200


@api_auth.post("/me/albums")
def api_me_albums_create():
    """Create a new album for the authenticated user; accepts {title, cover_url?}; returns created album."""
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or request.form or {}
    title = (payload.get("title") or "").strip()
    cover_url = (payload.get("cover_url") or "").strip() or None
    if not title:
        return jsonify({"error": "title_required"}), 400

    with get_conn() as conn, conn.cursor() as cur:
        base = make_slug(title)
        slug = unique_album_slug(cur, uid, base)
        cur.execute(
            """
            INSERT INTO albums (id, user_id, slug, title, cover_path, visibility, metadata)
            VALUES (uuid_generate_v4(), %s, %s, %s, %s, 'private', '{}'::jsonb)
            RETURNING id::text, title, COALESCE(cover_path, '') AS cover_url, created_at
            """,
            (uid, slug, title, cover_url),
        )
        row = cur.fetchone()
        conn.commit()

    album = {
        "id": row[0],
        "title": row[1],
        "cover_url": row[2],
        "created_at": (row[3].isoformat() if row[3] else None),
    }
    return jsonify({"album": album}), 201



# app.py — album editor endpoints (fetch/update one album; JSON in/out)
from psycopg.types.json import Json



@api_auth.get("/me/albums/<string:album_id>/tracks")
def api_album_tracks(album_id):
    """Return the track list stored in albums.metadata.tracks for the owner."""
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


@api_auth.get("/me/albums/<string:album_id>")
def api_album_get(album_id):
    """Return one album owned by current user with editable fields and metadata."""
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
    """Update title, description_md, visibility, cover_path, and metadata (incl. tracks array)."""
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or request.form or {}
    title = (payload.get("title") or "").strip()
    description_md = (payload.get("description_md") or "").strip()
    visibility = (payload.get("visibility") or "private").strip()
    cover_url = (payload.get("cover_url") or "").strip()
    metadata = payload.get("metadata") or {}

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE albums
            SET title = COALESCE(NULLIF(%s,''), title),
                description_md = %s,
                visibility = %s::visibility_enum,
                cover_path = %s,
                metadata = %s,
                updated_at = now()
            WHERE id = %s AND user_id = %s
            RETURNING id::text, title, COALESCE(cover_path,''), visibility::text, metadata, updated_at
            """,
            (title, description_md, visibility, cover_url or None, Json(metadata), album_id, uid),
        )
        row = cur.fetchone()
        if not row:
            return jsonify({"error": "not_found"}), 404
        conn.commit()
        out = {
            "id": row[0],
            "title": row[1],
            "cover_url": row[2],
            "visibility": row[3],
            "metadata": row[4] or {},
            "updated_at": (row[5].isoformat() if row[5] else None),
        }
        return jsonify({"album": out}), 200


# app.py — album cover upload + serve URL update
import os
from werkzeug.utils import secure_filename


@api_auth.post("/me/albums/<string:album_id>/cover")
def api_album_upload_cover(album_id):
    """Accept multipart 'file' image, save under /static/album_covers, update albums.cover_path, return {'cover_url': url}."""
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










@api_auth.post("/logout")
def api_logout():
    """Terminate session; log event; return {"ok": true}."""
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






# Register once; keeps endpoints exactly at /login, /me, /me/albums, /logout
app.register_blueprint(api_auth)


















# ── RUN / CLI dispatcher (preserves initdb / seedadmin / run) ───────────────
if __name__ == '__main__':
    import argparse
    import os
    import sys

    def _call_first_available(names):
        """
        Call the first callable found in globals() by any of the given names.
        Returns True if a callable was invoked, else False.
        """
        g = globals()
        for n in names:
            fn = g.get(n)
            if callable(fn):
                fn()
                return True
        return False

    parser = argparse.ArgumentParser(prog='app.py', add_help=True)
    sub = parser.add_subparsers(dest='cmd')

    # run (default)
    p_run = sub.add_parser('run', help='Start HTTPS dev server with auto-reload')
    p_run.add_argument('--host', default=os.environ.get('FLASK_HOST', '0.0.0.0'))
    p_run.add_argument('--port', type=int, default=int(os.environ.get('FLASK_PORT', '5000')))
    p_run.add_argument('--no-ssl', action='store_true', help='Disable HTTPS (use HTTP)')
    p_run.add_argument('--no-reload', action='store_true', help='Disable code auto-reload')

    # initdb
    sub.add_parser('initdb', help='Initialize database (calls initdb/init_db)')

    # seedadmin
    sub.add_parser('seedadmin', help='Seed admin user (calls seedadmin/seed_admin)')

    # allow bare call to behave like "run"
    args = parser.parse_args(None if len(sys.argv) > 1 else ['run'])

    if args.cmd == 'initdb':
        if not _call_first_available(['initdb', 'init_db']):
            print('No initdb/init_db() found.', file=sys.stderr)
            sys.exit(2)
        sys.exit(0)

    if args.cmd == 'seedadmin':
        if not _call_first_available(['seedadmin', 'seed_admin']):
            print('No seedadmin/seed_admin() found.', file=sys.stderr)
            sys.exit(2)
        sys.exit(0)

    # run (default)
    host = getattr(args, 'host', os.environ.get('FLASK_HOST', '0.0.0.0'))
    port = int(getattr(args, 'port', os.environ.get('FLASK_PORT', '5000')))
    use_ssl = not getattr(args, 'no_ssl', False)
    use_reload = not getattr(args, 'no_reload', False)

    if use_ssl:
        cert, key = generate_temp_ssl_cert()
        app.run(
            host=host,
            port=port,
            ssl_context=(cert, key),
            debug=True,
            use_reloader=use_reload,
            threaded=True
        )
    else:
        app.run(
            host=host,
            port=port,
            debug=True,
            use_reloader=use_reload,
            threaded=True
        )





# def cmd_run():
#     """
#     Launch the Flask development server with debug reloader via 'flask run'.
#     """
#     os.environ.setdefault("FLASK_APP", "app.py")
#     os.execvp(sys.executable, [sys.executable, "-m", "flask", "run", "--debug"])

# if __name__ == "__main__":
#     if len(sys.argv) == 2 and sys.argv[1] == "initdb":
#         cmd_initdb()
#     elif len(sys.argv) == 2 and sys.argv[1] == "seedadmin":
#         cmd_seedadmin()
#     elif len(sys.argv) == 2 and sys.argv[1] == "run":
#         cmd_run()
#     else:
#         print("Usage: python app.py [initdb|seedadmin|run]")
