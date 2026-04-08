"""
exporter.py — SQLite session storage and CSV export.

Responsibilities:
  - Initialize and manage the SQLite database
  - Create / update response sessions as pages are submitted
  - Assemble final CSV rows from session data
  - Export all sessions (complete and incomplete) to CSV

Missing value sentinels:
  SKIPPED     — question was shown but hidden by skip logic
  NO_ANSWER   — question was shown and active, but left blank
  NOT_REACHED — respondent abandoned before this page was displayed
"""

import csv
import json
import sqlite3
import os
from datetime import datetime, timezone
from typing import Optional

from parser import Survey, Question, GridRow, load_survey

# ---------------------------------------------------------------------------
# Sentinel values
# ---------------------------------------------------------------------------

SKIPPED     = "SKIPPED"
NO_ANSWER   = "NO_ANSWER"
NOT_REACHED = "NOT_REACHED"

# ---------------------------------------------------------------------------
# CSV column derivation
# Mirrors exactly what the frontend will send as answer keys.
# ---------------------------------------------------------------------------

def get_csv_columns(survey: Survey) -> list[str]:
    """
    Return the ordered list of CSV column names for a survey.
    Order: session_id, started_at, completed, then one or more columns per
    question in document order.
    """
    cols = ["session_id", "started_at", "completed"]
    for page in survey.pages:
        for q in page.questions:
            cols.extend(_question_columns(q))
    return cols


def _question_columns(q: Question) -> list[str]:
    """Return the CSV column name(s) for a single question."""
    if q.type == "checkbox":
        return [f"{q.label}__{opt.value}" for opt in q.options]

    elif q.type == "radio_grid":
        return [row.label for row in q.rows]

    elif q.type == "rating_grid":
        return [row.label for row in q.rows]

    elif q.type == "number_grid":
        cols = []
        for row in q.rows:
            for col in q.columns:
                cols.append(f"{row.label}__{col.value}")
        return cols

    elif q.type == "checkbox_grid":
        cols = []
        for row in q.rows:
            for col in q.columns:
                cols.append(f"{row.label_prefix}__{col.value}")
        return cols

    else:
        # radio, dropdown, number, rating, text, textarea
        return [q.label]


# ---------------------------------------------------------------------------
# Answer flattening
# Converts the answers dict (keyed by question id) into a flat dict
# keyed by CSV column name.
# ---------------------------------------------------------------------------

def flatten_answers(survey: Survey, answers: dict, visibility: dict) -> dict:
    """
    Given:
      answers    — {question_id: value} where value is whatever the frontend sent
      visibility — {question_id: "visible" | "hidden" | "not_reached"}
                   also includes row ids for grid questions

    Returns a flat dict {csv_column: value} with sentinels filled in.
    """
    flat = {}
    for page in survey.pages:
        page_vis = visibility.get(page.id, "not_reached")

        for q in page.questions:
            q_vis = visibility.get(q.id, "not_reached")

            # Parent-beats-child rule: if page not reached, question not reached
            if page_vis == "not_reached":
                q_vis = "not_reached"
            # If page was reached but question hidden by skip logic
            elif q_vis == "hidden":
                q_vis = "hidden"

            flat.update(_flatten_question(q, answers, visibility, q_vis))

    return flat


def _flatten_question(q: Question, answers: dict, visibility: dict, q_vis: str) -> dict:
    flat = {}

    if q.type == "checkbox":
        raw = answers.get(q.id)  # expected: list of selected values, or None
        for opt in q.options:
            col = f"{q.label}__{opt.value}"
            if q_vis == "not_reached":
                flat[col] = NOT_REACHED
            elif q_vis == "hidden":
                flat[col] = SKIPPED
            else:
                # Option itself may be hidden
                opt_vis = visibility.get(f"{q.id}__opt__{opt.value}", "visible")
                if opt_vis == "hidden":
                    flat[col] = SKIPPED
                elif raw is None:
                    flat[col] = NO_ANSWER
                else:
                    flat[col] = 1 if opt.value in raw else 0

    elif q.type == "radio_grid":
        for row in q.rows:
            col = row.label
            row_vis = visibility.get(row.id, "visible")
            if q_vis == "not_reached":
                flat[col] = NOT_REACHED
            elif q_vis == "hidden":
                flat[col] = SKIPPED
            elif row_vis == "hidden":
                flat[col] = SKIPPED
            else:
                val = answers.get(row.id)
                flat[col] = val if val is not None else NO_ANSWER

    elif q.type == "rating_grid":
        for row in q.rows:
            col = row.label
            row_vis = visibility.get(row.id, "visible")
            if q_vis == "not_reached":
                flat[col] = NOT_REACHED
            elif q_vis == "hidden":
                flat[col] = SKIPPED
            elif row_vis == "hidden":
                flat[col] = SKIPPED
            else:
                val = answers.get(row.id)
                flat[col] = val if val is not None else NO_ANSWER

    elif q.type == "number_grid":
        for row in q.rows:
            row_vis = visibility.get(row.id, "visible")
            for col in q.columns:
                csv_col = f"{row.label}__{col.value}"
                answer_key = f"{row.id}__{col.value}"
                if q_vis == "not_reached":
                    flat[csv_col] = NOT_REACHED
                elif q_vis == "hidden":
                    flat[csv_col] = SKIPPED
                elif row_vis == "hidden":
                    flat[csv_col] = SKIPPED
                else:
                    val = answers.get(answer_key)
                    flat[csv_col] = val if val is not None else NO_ANSWER

    elif q.type == "checkbox_grid":
        for row in q.rows:
            row_vis = visibility.get(row.id, "visible")
            raw = answers.get(row.id)  # expected: list of selected column values
            for col_def in q.columns:
                col = f"{row.label_prefix}__{col_def.value}"
                if q_vis == "not_reached":
                    flat[col] = NOT_REACHED
                elif q_vis == "hidden":
                    flat[col] = SKIPPED
                elif row_vis == "hidden":
                    flat[col] = SKIPPED
                else:
                    if raw is None:
                        flat[col] = NO_ANSWER
                    else:
                        flat[col] = 1 if col_def.value in raw else 0

    else:
        # radio, dropdown, number, rating, text, textarea
        col = q.label
        if q_vis == "not_reached":
            flat[col] = NOT_REACHED
        elif q_vis == "hidden":
            flat[col] = SKIPPED
        else:
            val = answers.get(q.id)
            flat[col] = val if val is not None else NO_ANSWER

    return flat


# ---------------------------------------------------------------------------
# Database manager
# ---------------------------------------------------------------------------

class DB:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")   # safe for concurrent reads
        return conn

    def _init_db(self):
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS responses (
                    session_id      TEXT PRIMARY KEY,
                    started_at      TEXT NOT NULL,
                    last_updated_at TEXT NOT NULL,
                    completed       INTEGER NOT NULL DEFAULT 0,
                    answers         TEXT NOT NULL DEFAULT '{}',
                    visibility      TEXT NOT NULL DEFAULT '{}'
                )
            """)
            conn.commit()

    # --- Session lifecycle ---

    def start_session(self, session_id: str) -> bool:
        """
        Create a new session row. Returns True if created, False if the
        session_id already exists (idempotent — safe to call twice).
        """
        now = _now()
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO responses (session_id, started_at, last_updated_at) "
                    "VALUES (?, ?, ?)",
                    (session_id, now, now)
                )
                conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False   # already exists

    def update_session(self, session_id: str, new_answers: dict, new_visibility: dict):
        """
        Merge new_answers and new_visibility into the existing session.
        Both are shallow-merged (new keys overwrite old keys).
        Raises KeyError if session_id not found.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT answers, visibility FROM responses WHERE session_id = ?",
                (session_id,)
            ).fetchone()

            if row is None:
                raise KeyError(f"Session not found: {session_id}")

            answers    = json.loads(row["answers"])
            visibility = json.loads(row["visibility"])

            answers.update(new_answers)
            visibility.update(new_visibility)

            conn.execute(
                "UPDATE responses SET answers = ?, visibility = ?, last_updated_at = ? "
                "WHERE session_id = ?",
                (json.dumps(answers), json.dumps(visibility), _now(), session_id)
            )
            conn.commit()

    def complete_session(self, session_id: str, new_answers: dict, new_visibility: dict):
        """
        Merge final answers/visibility and mark the session as completed.
        Raises KeyError if session_id not found.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT answers, visibility FROM responses WHERE session_id = ?",
                (session_id,)
            ).fetchone()

            if row is None:
                raise KeyError(f"Session not found: {session_id}")

            answers    = json.loads(row["answers"])
            visibility = json.loads(row["visibility"])

            answers.update(new_answers)
            visibility.update(new_visibility)

            conn.execute(
                "UPDATE responses SET answers = ?, visibility = ?, "
                "last_updated_at = ?, completed = 1 "
                "WHERE session_id = ?",
                (json.dumps(answers), json.dumps(visibility), _now(), session_id)
            )
            conn.commit()

    def get_session(self, session_id: str) -> Optional[dict]:
        """Return a session row as a dict, or None if not found."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM responses WHERE session_id = ?",
                (session_id,)
            ).fetchone()
        if row is None:
            return None
        return dict(row)

    def get_all_sessions(self) -> list[dict]:
        """Return all session rows ordered by start time."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM responses ORDER BY started_at ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def count_sessions(self) -> dict:
        """Return counts of total, completed, and incomplete sessions."""
        with self._connect() as conn:
            total     = conn.execute("SELECT COUNT(*) FROM responses").fetchone()[0]
            completed = conn.execute("SELECT COUNT(*) FROM responses WHERE completed = 1").fetchone()[0]
        return {"total": total, "completed": completed, "incomplete": total - completed}


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------

class Exporter:
    def __init__(self, survey: Survey, db: DB):
        self.survey  = survey
        self.db      = db
        self.columns = get_csv_columns(survey)

    def export(self, output_path: str) -> int:
        """
        Write all sessions to a CSV file at output_path.
        Returns the number of rows written.
        """
        sessions = self.db.get_all_sessions()
        rows_written = 0

        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=self.columns, extrasaction="ignore")
            writer.writeheader()

            for session in sessions:
                row = self._session_to_row(session)
                writer.writerow(row)
                rows_written += 1

        return rows_written

    def _session_to_row(self, session: dict) -> dict:
        answers    = json.loads(session["answers"])
        visibility = json.loads(session["visibility"])

        flat = flatten_answers(self.survey, answers, visibility)

        flat["session_id"] = session["session_id"]
        flat["started_at"] = session["started_at"]
        flat["completed"]  = session["completed"]

        # Any column not yet in flat gets NOT_REACHED (session started but
        # never sent any visibility info for those questions)
        for col in self.columns:
            if col not in flat:
                flat[col] = NOT_REACHED

        return flat


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# CLI — export on demand
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 4:
        print("Usage: python exporter.py <survey.yaml> <responses.db> <output.csv>")
        sys.exit(1)

    survey_path, db_path, csv_path = sys.argv[1], sys.argv[2], sys.argv[3]

    try:
        survey = load_survey(survey_path)
    except ValueError as e:
        print(f"Survey load error:\n{e}")
        sys.exit(1)

    db       = DB(db_path)
    exporter = Exporter(survey, db)
    counts   = db.count_sessions()
    n        = exporter.export(csv_path)

    print(f"✓ Exported {n} rows to '{csv_path}'.")
    print(f"  {counts['completed']} complete, {counts['incomplete']} incomplete.")
