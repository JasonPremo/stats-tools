"""
app.py — Flask backend for the survey application.

Endpoints:
  GET  /                        Serve the survey frontend
  GET  /survey.json             Survey definition as JSON for the frontend
  POST /api/start               Create a new session, return session_id
  POST /api/page                Submit a page's answers (checkpoint)
  POST /api/submit              Submit final page and mark complete
  GET  /api/export              Download all responses as CSV
  GET  /api/status              Response counts (for monitoring)
"""

import io
import json
import os
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, request, send_from_directory, Response, abort

from parser import load_survey, Survey
from exporter import DB, Exporter

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR  = os.path.join(BASE_DIR, "static")
SURVEY_PATH = os.environ.get("SURVEY_PATH", os.path.join(BASE_DIR, "survey.yaml"))
DB_PATH     = os.environ.get("DB_PATH",     os.path.join(BASE_DIR, "responses.db"))
EXPORT_KEY  = os.environ.get("EXPORT_KEY",  "")   # optional secret for /api/export
DEBUG_KEY   = os.environ.get("DEBUG_KEY",   "")   # optional secret for debug mode

app = Flask(__name__, static_folder=STATIC_DIR)

# Load survey definition once at startup — crash immediately if invalid.
try:
    SURVEY: Survey = load_survey(SURVEY_PATH)
    print(f"✓ Survey '{SURVEY.title}' loaded — "
          f"{len(SURVEY.pages)} page(s), "
          f"{sum(len(p.questions) for p in SURVEY.pages)} question(s).")
except ValueError as e:
    print(f"✗ Failed to load survey:\n{e}")
    raise SystemExit(1)

# Database and exporter
DB_INSTANCE = DB(DB_PATH)
EXPORTER    = Exporter(SURVEY, DB_INSTANCE)

# Hot-reload: track file mtime so we can detect changes
_survey_mtime = os.path.getmtime(SURVEY_PATH)

def _maybe_reload_survey():
    """Re-parse the survey YAML if the file has been modified since last load."""
    global SURVEY, EXPORTER, _survey_mtime
    try:
        current_mtime = os.path.getmtime(SURVEY_PATH)
    except OSError:
        return  # file temporarily unavailable — skip
    if current_mtime == _survey_mtime:
        return
    _survey_mtime = current_mtime
    try:
        new_survey = load_survey(SURVEY_PATH)
        SURVEY   = new_survey
        EXPORTER = Exporter(SURVEY, DB_INSTANCE)
        print(f"⟳ Survey reloaded — '{SURVEY.title}', "
              f"{len(SURVEY.pages)} page(s), "
              f"{sum(len(p.questions) for p in SURVEY.pages)} question(s).")
    except ValueError as e:
        print(f"⟳ Survey reload failed (keeping previous version):\n{e}")


@app.before_request
def check_survey_reload():
    _maybe_reload_survey()

# ---------------------------------------------------------------------------
# Survey → JSON serialisation
# (Converts the parsed dataclass tree into a plain dict for the frontend)
# ---------------------------------------------------------------------------

def _build_survey_json(survey: Survey) -> dict:
    # Flatten groups into a flat page list for the frontend.
    # Each page inherits its group's display_if (ANDed with its own).
    flat_pages = []
    for group in survey.page_groups:
        for page in group.pages:
            flat_pages.append(_page_json(page, group.display_if))
    return {
        "title":       survey.title,
        "description": survey.description,
        "pages":       flat_pages,
    }


def _page_json(page, group_display_if=None) -> dict:
    # Combine group and page display_if conditions
    effective_display_if = _combine_conditions(group_display_if, page.display_if)

    d = {
        "id":          page.id,
        "title":       page.title,
        "description": page.description,
        "display_if":  _condition_json(effective_display_if),
        "page_type":   page.page_type,
        "questions":   [_question_json(q) for q in page.questions],
    }
    if page.page_type == "breakout":
        d["breakout_button_label"] = page.breakout_button_label
        d["continue_button_label"] = page.continue_button_label
        d["acknowledge_text"]      = page.acknowledge_text
    return d


def _question_json(q) -> dict:
    base = {
        "id":         q.id,
        "type":       q.type,
        "text":       q.text,
        "label":      q.label,
        "required":   q.required,
        "notes":      q.notes,
        "note_title":  q.note_title,
        "note_position": q.note_position,
        "warn_if_empty": q.warn_if_empty,
        "layout":     q.layout,
        "display_if": _condition_json(q.display_if),
        "defines_variable": _variable_json(q.defines_variable),
    }

    if q.type in ("radio", "checkbox", "dropdown"):
        base["options"] = [
            {"value": o.value, "text": o.text,
             "display_if": _condition_json(o.display_if)}
            for o in q.options
        ]

    elif q.type == "number":
        base.update({"min": q.min, "max": q.max, "integer_only": q.integer_only,
                     "default_value": q.default_value})

    elif q.type == "rating":
        base.update({"min": q.min, "max": q.max,
                     "min_label": q.min_label, "max_label": q.max_label})

    elif q.type in ("radio_grid", "checkbox_grid"):
        base["columns"] = [{"value": c.value, "text": c.text} for c in q.columns]
        base["rows"]    = [_row_json(r) for r in q.rows]

    elif q.type == "rating_grid":
        base.update({"min": q.min, "max": q.max,
                     "min_label": q.min_label, "max_label": q.max_label})
        base["rows"] = [_row_json(r) for r in q.rows]

    elif q.type == "number_grid":
        base.update({"min": q.min, "max": q.max, "integer_only": q.integer_only,
                     "default_value": q.default_value})
        base["columns"] = [{"value": c.value, "text": c.text} for c in q.columns]
        base["rows"]    = [_row_json(r) for r in q.rows]

    return base


def _row_json(row) -> dict:
    return {
        "id":           row.id,
        "text":         row.text,
        "label":        row.label,
        "label_prefix": row.label_prefix,
        "display_if":   _condition_json(row.display_if),
    }


def _condition_json(cond) -> dict | None:
    if cond is None:
        return None
    # Import here to avoid circular reference issues with type checking
    from parser import Condition, ConditionGroup
    if isinstance(cond, Condition):
        return {
            "question": cond.question,
            "operator": cond.operator,
            "value":    cond.value,
        }
    else:  # ConditionGroup
        return {
            "operator":   cond.operator,
            "conditions": [_condition_json(c) for c in cond.conditions],
        }


def _variable_json(var) -> dict | None:
    if var is None:
        return None
    return {
        "name":    var.name,
        "mapping": var.mapping,
    }


def _combine_conditions(cond_a, cond_b):
    """Combine two display_if conditions with AND. Returns None if both are None."""
    from parser import ConditionGroup
    if cond_a is None:
        return cond_b
    if cond_b is None:
        return cond_a
    return ConditionGroup(operator="and", conditions=[cond_a, cond_b])


# Pre-build the survey JSON once — it never changes at runtime.
SURVEY_JSON = _build_survey_json(SURVEY)


# ---------------------------------------------------------------------------
# Request validation helpers
# ---------------------------------------------------------------------------

def require_json(f):
    """Decorator: reject requests without a JSON body."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not request.is_json:
            return jsonify({"error": "Request must be JSON."}), 415
        return f(*args, **kwargs)
    return wrapper


def get_session_or_404(session_id: str):
    """Return session dict or abort with 404."""
    session = DB_INSTANCE.get_session(session_id)
    if session is None:
        abort(404, description=f"Session '{session_id}' not found.")
    return session


def validate_page_payload(data: dict):
    """
    Validate the common payload structure for /api/page and /api/submit.

    Expected shape:
    {
        "session_id":  str,
        "page_id":     str,
        "answers":     {question_id: value, ...},
        "visibility":  {element_id: "visible"|"hidden"|"not_reached", ...}
    }

    Returns (session_id, page_id, answers, visibility) or raises ValueError.
    """
    errors = []

    session_id = data.get("session_id")
    if not session_id or not isinstance(session_id, str):
        errors.append("'session_id' must be a non-empty string.")

    page_id = data.get("page_id")
    if not page_id or not isinstance(page_id, str):
        errors.append("'page_id' must be a non-empty string.")

    answers = data.get("answers")
    if answers is None or not isinstance(answers, dict):
        errors.append("'answers' must be an object.")

    visibility = data.get("visibility")
    if visibility is None or not isinstance(visibility, dict):
        errors.append("'visibility' must be an object.")

    if errors:
        raise ValueError("; ".join(errors))

    # Sanitise: only allow string/number/list/null answer values
    clean_answers = {}
    for k, v in answers.items():
        if v is None or isinstance(v, (str, int, float, bool, list)):
            clean_answers[str(k)] = v
        else:
            clean_answers[str(k)] = str(v)

    # Sanitise visibility values
    allowed_vis = {"visible", "hidden", "not_reached"}
    clean_vis = {}
    for k, v in visibility.items():
        if v in allowed_vis:
            clean_vis[str(k)] = v

    return session_id, page_id, clean_answers, clean_vis


# ---------------------------------------------------------------------------
# Routes — static files
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/survey.json")
def survey_json():
    """Return the full survey definition as JSON."""
    return jsonify(SURVEY_JSON)


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------

@app.route("/api/start", methods=["POST"])
def api_start():
    """
    Create a new survey session.

    Request body: {} (empty, or omitted entirely)
    Response: {"session_id": "<uuid>"}
    """
    session_id = str(uuid.uuid4())
    DB_INSTANCE.start_session(session_id)
    return jsonify({"session_id": session_id}), 201


@app.route("/api/page", methods=["POST"])
@require_json
def api_page():
    """
    Checkpoint: record answers for a completed page.
    The session remains open (completed=0).

    Request body:
    {
        "session_id":  "...",
        "page_id":     "page_background",
        "answers":     {"q_employment": "employed", ...},
        "visibility":  {"page_background": "visible", "q_employment": "visible", ...}
    }

    Response: {"ok": true}
    """
    try:
        session_id, page_id, answers, visibility = validate_page_payload(request.get_json())
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    session = get_session_or_404(session_id)

    if session["completed"]:
        return jsonify({"error": "Session is already completed."}), 409

    try:
        DB_INSTANCE.update_session(session_id, answers, visibility)
    except KeyError:
        abort(404)

    return jsonify({"ok": True})


@app.route("/api/submit", methods=["POST"])
@require_json
def api_submit():
    """
    Final submission: record last page's answers and mark session complete.

    Request body: same shape as /api/page.
    Response: {"ok": true}
    """
    try:
        session_id, page_id, answers, visibility = validate_page_payload(request.get_json())
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    session = get_session_or_404(session_id)

    if session["completed"]:
        return jsonify({"error": "Session is already completed."}), 409

    try:
        DB_INSTANCE.complete_session(session_id, answers, visibility)
    except KeyError:
        abort(404)

    return jsonify({"ok": True})


@app.route("/api/resume/<session_id>", methods=["GET"])
def api_resume(session_id):
    """
    Retrieve a session's saved state for resuming.

    Response:
    {
        "session_id":  "...",
        "answers":     {...},
        "visibility":  {...},
        "completed":   false
    }
    """
    session = DB_INSTANCE.get_session(session_id)
    if session is None:
        return jsonify({"error": "Session not found."}), 404

    return jsonify({
        "session_id":  session["session_id"],
        "answers":     json.loads(session["answers"]),
        "visibility":  json.loads(session["visibility"]),
        "completed":   bool(session["completed"]),
    })


@app.route("/api/debug-verify")
def api_debug_verify():
    """
    Verify a debug key and return debug metadata (CSV column mappings).
    Query param: ?key=<DEBUG_KEY>
    """
    if not DEBUG_KEY:
        return jsonify({"error": "Debug mode is not enabled on this server."}), 403
    provided = request.args.get("key", "")
    if provided != DEBUG_KEY:
        return jsonify({"error": "Invalid debug key."}), 403

    # Build CSV column mapping: question_id -> [csv_column_names]
    from exporter import _question_columns
    csv_map = {}
    for page in SURVEY.pages:
        for q in page.questions:
            csv_map[q.id] = _question_columns(q)

    return jsonify({"ok": True, "csv_columns": csv_map})


@app.route("/api/export")
def api_export():
    """
    Download all responses as a CSV file.

    Optional query parameter: ?key=<EXPORT_KEY>
    If EXPORT_KEY env var is set, the key must match to proceed.
    """
    if EXPORT_KEY:
        provided = request.args.get("key", "")
        if provided != EXPORT_KEY:
            abort(403, description="Invalid or missing export key.")

    # Write CSV to an in-memory buffer so we never touch the filesystem for
    # the export itself (the DB file is the source of truth).
    buf = io.StringIO()

    from exporter import get_csv_columns, flatten_answers, NOT_REACHED
    import csv

    columns  = get_csv_columns(SURVEY)
    sessions = DB_INSTANCE.get_all_sessions()

    writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()

    for session in sessions:
        answers    = json.loads(session["answers"])
        visibility = json.loads(session["visibility"])
        flat = flatten_answers(SURVEY, answers, visibility)
        flat["session_id"] = session["session_id"]
        flat["started_at"] = session["started_at"]
        flat["completed"]  = session["completed"]
        for col in columns:
            if col not in flat:
                flat[col] = NOT_REACHED
        writer.writerow(flat)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename  = f"responses_{timestamp}.csv"

    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@app.route("/api/status")
def api_status():
    """
    Return basic response counts. Useful for monitoring.
    Response: {"total": N, "completed": N, "incomplete": N}
    """
    return jsonify(DB_INSTANCE.count_sessions())


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": str(e)}), 404


@app.errorhandler(403)
def forbidden(e):
    return jsonify({"error": str(e)}), 403


@app.errorhandler(409)
def conflict(e):
    return jsonify({"error": str(e)}), 409


@app.errorhandler(415)
def unsupported_media(e):
    return jsonify({"error": str(e)}), 415


# ---------------------------------------------------------------------------
# Dev server entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    print(f"Starting dev server on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
