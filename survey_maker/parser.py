"""
parser.py — Loads, validates, and normalizes the survey YAML definition.

Call load_survey(path) to get back a fully validated Survey object.
All validation errors are collected and raised together so you can fix
them all at once rather than playing whack-a-mole.
"""

import yaml
from dataclasses import dataclass, field
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Data classes — these are the normalized in-memory representation
# ---------------------------------------------------------------------------

@dataclass
class Condition:
    """A single leaf condition: question <operator> value"""
    question: str
    operator: str   # equals | not_equals | includes | not_includes | is_answered | is_not_answered
    value: Optional[str] = None   # not required for is_answered / is_not_answered


@dataclass
class ConditionGroup:
    """A compound condition: operator (and|or) over a list of Condition or ConditionGroup"""
    operator: str   # and | or
    conditions: list   # list of Condition or ConditionGroup


@dataclass
class Option:
    value: str
    text: str
    display_if: Optional[Any] = None   # Condition | ConditionGroup | None


@dataclass
class GridColumn:
    value: str
    text: str


@dataclass
class GridRow:
    id: str
    text: str
    label: Optional[str] = None          # radio_grid, rating_grid
    label_prefix: Optional[str] = None   # checkbox_grid
    display_if: Optional[Any] = None


@dataclass
class Variable:
    """A display variable defined by a question's answer."""
    name: str
    mapping: Optional[dict] = None  # {answer_value: display_string}, or None to use raw answer


@dataclass
class Question:
    id: str
    type: str   # radio|checkbox|dropdown|number|rating|text|textarea|
                # radio_grid|checkbox_grid|rating_grid
    text: str
    label: Optional[str] = None          # all non-grid types
    required: bool = False
    display_if: Optional[Any] = None

    # radio | checkbox | dropdown
    options: list = field(default_factory=list)   # list of Option

    # number
    min: Optional[float] = None
    max: Optional[float] = None
    integer_only: bool = False
    default_value: Optional[float] = None

    # optional notes shown to respondent as a side panel
    notes: Optional[str] = None
    note_title: Optional[str] = "Note"  # None = no title, omit field = default "Note"
    note_position: str = "side"  # "side" | "below_text" | "below_answers"

    # soft warning when optional questions are left blank
    warn_if_empty: Optional[bool] = None  # None = use type default

    # rating / rating_grid
    min_label: Optional[str] = None
    max_label: Optional[str] = None

    # layout variant for radio / checkbox (None | "horizontal" | "two_col")
    layout: Optional[str] = None

    # grids
    columns: list = field(default_factory=list)   # list of GridColumn
    rows: list = field(default_factory=list)       # list of GridRow

    # variables defined by this question's answer
    defines_variable: Optional[Variable] = None


@dataclass
class Page:
    id: str
    title: str
    questions: list   # list of Question
    description: Optional[str] = None
    display_if: Optional[Any] = None
    page_type: str = "standard"  # standard | section_title | breakout
    # breakout-specific fields
    breakout_button_label: Optional[str] = None    # end survey button text
    continue_button_label: Optional[str] = None    # continue button text
    acknowledge_text: Optional[str] = None         # acknowledgment checkbox text


@dataclass
class PageGroup:
    id: str
    title: str
    pages: list   # list of Page
    display_if: Optional[Any] = None


@dataclass
class Survey:
    title: str
    page_groups: list   # list of PageGroup
    description: Optional[str] = None

    @property
    def pages(self) -> list:
        """Flat list of all pages across all groups (convenience accessor)."""
        return [p for g in self.page_groups for p in g.pages]


# ---------------------------------------------------------------------------
# Operator constants
# ---------------------------------------------------------------------------

LEAF_OPERATORS = {"equals", "not_equals", "includes", "not_includes",
                  "is_answered", "is_not_answered",
                  "count_equals", "count_not_equals",
                  "count_gt", "count_gte", "count_lt", "count_lte"}
VALUE_NOT_REQUIRED = {"is_answered", "is_not_answered"}
INCLUDES_OPERATORS = {"includes", "not_includes"}
COUNT_OPERATORS = {"count_equals", "count_not_equals",
                   "count_gt", "count_gte", "count_lt", "count_lte"}
COMPOUND_OPERATORS = {"and", "or", "not"}

QUESTION_TYPES = {
    "radio", "checkbox", "dropdown",
    "number", "rating",
    "text", "textarea",
    "radio_grid", "checkbox_grid", "rating_grid", "number_grid",
}

OPTION_TYPES = {"radio", "checkbox", "dropdown"}
GRID_TYPES = {"radio_grid", "checkbox_grid", "rating_grid", "number_grid"}
NUMBER_TYPES = {"number", "rating", "rating_grid"}


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class SurveyParser:
    def __init__(self):
        self.errors = []
        # Tracks every id and label seen, and the order questions appear
        self.all_ids = {}          # id -> position index (for forward-ref check)
        self.question_order = []   # list of question ids in document order
        self.question_types = {}   # id -> type (for operator validation)
        self.position = 0          # monotonic counter for ordering
        self.variable_names = set()  # variable names defined by defines_variable

    def err(self, msg):
        self.errors.append(msg)

    # --- Top level ---

    def parse(self, path: str) -> Survey:
        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        if not isinstance(raw, dict) or "survey" not in raw:
            raise ValueError("YAML must have a top-level 'survey' key.")

        s = raw["survey"]
        title = self._req_str(s, "title", "survey")
        description = s.get("description")

        # Accept either page_groups: (new) or pages: (legacy shorthand)
        raw_groups = s.get("page_groups")
        raw_pages = s.get("pages")

        if raw_groups and raw_pages:
            self.err("survey: use either 'page_groups' or 'pages', not both.")
        
        if raw_groups:
            if not isinstance(raw_groups, list) or len(raw_groups) == 0:
                self.err("survey: 'page_groups' must be a non-empty list.")
                raw_groups = []
            page_groups = [self._parse_page_group(g, i) for i, g in enumerate(raw_groups)]
        elif raw_pages:
            if not isinstance(raw_pages, list) or len(raw_pages) == 0:
                self.err("survey: 'pages' must be a non-empty list.")
                raw_pages = []
            # Legacy format: wrap all pages in a single default group
            pages = [self._parse_page(p, i, "pages") for i, p in enumerate(raw_pages)]
            page_groups = [PageGroup(id="_default_group", title="All Pages", pages=pages)]
        else:
            self.err("survey: must have either 'page_groups' or 'pages'.")
            page_groups = []

        survey = Survey(title=title, description=description, page_groups=page_groups)

        # Second pass: validate all display_if references now that we know
        # the full question order and types.
        for group in page_groups:
            if group.display_if:
                self._validate_condition(group.display_if, f"page_group '{group.id}'", None)
            for page in group.pages:
                if page.display_if:
                    self._validate_condition(page.display_if, f"page '{page.id}'", None)
                for q in page.questions:
                    self._validate_question_conditions(q)

        # Validate CSV column uniqueness (replaces old label uniqueness check)
        self._validate_csv_columns(survey)

        if self.errors:
            joined = "\n".join(f"  • {e}" for e in self.errors)
            raise ValueError(f"Survey definition has {len(self.errors)} error(s):\n{joined}")

        return survey

    # --- Page Group ---

    def _parse_page_group(self, raw, index) -> PageGroup:
        ctx = f"page_groups[{index}]"
        gid = self._req_str(raw, "id", ctx)
        self._register_id(gid, ctx)

        title = raw.get("title", f"Group {index + 1}")
        display_if = self._parse_condition(raw.get("display_if"), ctx)

        raw_pages = raw.get("pages")
        if not raw_pages or not isinstance(raw_pages, list):
            self.err(f"{ctx}: 'pages' must be a non-empty list.")
            raw_pages = []

        pages = [self._parse_page(p, i, f"{ctx} > pages") for i, p in enumerate(raw_pages)]

        return PageGroup(id=gid, title=title, pages=pages, display_if=display_if)

    # --- Page ---

    def _parse_page(self, raw, index, ctx_prefix="pages") -> Page:
        ctx = f"{ctx_prefix}[{index}]"
        pid = self._req_str(raw, "id", ctx)
        self._register_id(pid, ctx)

        title = self._req_str(raw, "title", ctx)
        description = raw.get("description")
        display_if = self._parse_condition(raw.get("display_if"), ctx)

        page_type = raw.get("page_type", "standard")
        VALID_PAGE_TYPES = {"standard", "section_title", "breakout"}
        if page_type not in VALID_PAGE_TYPES:
            self.err(f"{ctx}: unknown page_type '{page_type}'. "
                     f"Must be one of: {sorted(VALID_PAGE_TYPES)}")
            page_type = "standard"

        raw_qs = raw.get("questions")
        if page_type == "standard":
            if not raw_qs or not isinstance(raw_qs, list):
                self.err(f"{ctx}: 'questions' must be a non-empty list.")
                raw_qs = []
        else:
            # section_title and breakout pages don't require questions
            raw_qs = raw_qs or []

        questions = [self._parse_question(q, i, ctx) for i, q in enumerate(raw_qs)
                     if not q.get("disabled")]

        page = Page(id=pid, title=title, description=description,
                    display_if=display_if, questions=questions,
                    page_type=page_type)

        if page_type == "breakout":
            page.breakout_button_label = raw.get("breakout_button_label", "End survey")
            page.continue_button_label = raw.get("continue_button_label", "Continue")
            page.acknowledge_text = raw.get("acknowledge_text")
            if not page.acknowledge_text:
                self.err(f"{ctx}: breakout page requires 'acknowledge_text'.")

        return page

    # --- Question ---

    def _parse_question(self, raw, index, page_ctx) -> Question:
        ctx = f"{page_ctx} > questions[{index}]"
        qid = self._req_str(raw, "id", ctx)
        self._register_id(qid, ctx)
        self.question_order.append(qid)
        q_position = self.position - 1   # position was just incremented

        qtype = self._req_str(raw, "type", ctx)
        if qtype not in QUESTION_TYPES:
            self.err(f"{ctx} (id='{qid}'): unknown type '{qtype}'. "
                     f"Must be one of: {sorted(QUESTION_TYPES)}")
            qtype = "text"   # fallback to avoid cascading errors

        text = self._req_str(raw, "text", ctx)
        required = bool(raw.get("required", False))
        display_if = self._parse_condition(raw.get("display_if"), ctx)
        # display_if references validated in second pass

        q = Question(id=qid, type=qtype, text=text, required=required,
                     display_if=display_if, notes=raw.get("notes") or None,
                     note_title=raw.get("note_title", "Note"))

        # note_position
        note_pos = raw.get("note_position", "side")
        if note_pos not in ("side", "below_text", "below_answers"):
            self.err(f"{ctx} (id='{qid}'): note_position must be 'side', 'below_text', or 'below_answers'.")
            note_pos = "side"
        q.note_position = note_pos

        # warn_if_empty — None means use type default
        raw_warn = raw.get("warn_if_empty")
        if raw_warn is not None:
            q.warn_if_empty = bool(raw_warn)
        else:
            q.warn_if_empty = None

        # layout: optional display variant for radio / checkbox
        raw_layout = raw.get("layout")
        if raw_layout is not None:
            valid_layouts = ("horizontal", "two_col")
            if raw_layout not in valid_layouts:
                self.err(f"{ctx} (id='{qid}'): invalid layout '{raw_layout}'. "
                         f"Must be one of: {valid_layouts}")
            elif qtype not in ("radio", "checkbox"):
                self.err(f"{ctx} (id='{qid}'): 'layout' is only valid for "
                         f"radio and checkbox question types.")
            else:
                q.layout = raw_layout

        self.question_types[qid] = qtype

        if qtype in OPTION_TYPES:
            label = self._req_str(raw, "label", ctx)
            q.label = label
            q.options = self._parse_options(raw.get("options"), ctx, qid)

        elif qtype == "number":
            label = self._req_str(raw, "label", ctx)
            q.label = label
            q.min, q.max = self._parse_min_max(raw, ctx)
            q.integer_only = bool(raw.get("integer_only", False))
            if raw.get("default_value") is not None:
                q.default_value = float(raw["default_value"])

        elif qtype == "rating":
            label = self._req_str(raw, "label", ctx)
            q.label = label
            q.min, q.max = self._parse_min_max(raw, ctx, required=True)
            q.min_label = raw.get("min_label")
            q.max_label = raw.get("max_label")

        elif qtype in ("text", "textarea"):
            label = self._req_str(raw, "label", ctx)
            q.label = label

        elif qtype in GRID_TYPES:
            if qtype in ("radio_grid", "checkbox_grid", "number_grid"):
                q.columns = self._parse_grid_columns(raw.get("columns"), ctx)
            q.rows = self._parse_grid_rows(raw.get("rows"), ctx, qtype)
            # For number_grid, register compound cell IDs (row__col) for condition targeting
            if qtype == "number_grid" and q.columns:
                for row in q.rows:
                    for col in q.columns:
                        cell_id = f"{row.id}__{col.value}"
                        self.question_order.append(cell_id)
                        self.question_types[cell_id] = "number_grid_cell"
            if qtype == "rating_grid":
                q.min, q.max = self._parse_min_max(raw, ctx, required=True)
                q.min_label = raw.get("min_label")
                q.max_label = raw.get("max_label")
            if qtype == "number_grid":
                q.min, q.max = self._parse_min_max(raw, ctx)
                q.integer_only = bool(raw.get("integer_only", False))
                if raw.get("default_value") is not None:
                    q.default_value = float(raw["default_value"])

        # --- defines_variable (optional, any question type) ---
        raw_var = raw.get("defines_variable")
        if raw_var is not None:
            q.defines_variable = self._parse_variable(raw_var, ctx, qid)

        return q

    # --- Options ---

    def _parse_options(self, raw, ctx, qid) -> list:
        if not raw or not isinstance(raw, list):
            self.err(f"{ctx}: 'options' must be a non-empty list.")
            return []
        seen_values = set()
        options = []
        for i, o in enumerate(raw):
            octx = f"{ctx} > options[{i}]"
            val = self._req_str(o, "value", octx)
            if val in seen_values:
                self.err(f"{octx}: duplicate option value '{val}' in question '{qid}'.")
            seen_values.add(val)
            text = self._req_str(o, "text", octx)
            display_if = self._parse_condition(o.get("display_if"), octx)
            options.append(Option(value=val, text=text, display_if=display_if))
        return options

    # --- Grid columns and rows ---

    def _parse_grid_columns(self, raw, ctx) -> list:
        if not raw or not isinstance(raw, list):
            self.err(f"{ctx}: 'columns' must be a non-empty list.")
            return []
        seen = set()
        cols = []
        for i, c in enumerate(raw):
            cctx = f"{ctx} > columns[{i}]"
            val = self._req_str(c, "value", cctx)
            if val in seen:
                self.err(f"{cctx}: duplicate column value '{val}'.")
            seen.add(val)
            text = self._req_str(c, "text", cctx)
            cols.append(GridColumn(value=val, text=text))
        return cols

    def _parse_grid_rows(self, raw, ctx, qtype) -> list:
        if not raw or not isinstance(raw, list):
            self.err(f"{ctx}: 'rows' must be a non-empty list.")
            return []
        rows = []
        for i, r in enumerate(raw):
            rctx = f"{ctx} > rows[{i}]"
            rid = self._req_str(r, "id", rctx)
            self._register_id(rid, rctx)
            # Grid rows are also question-like for ordering purposes
            self.question_order.append(rid)
            self.question_types[rid] = qtype + "_row"

            text = self._req_str(r, "text", rctx)
            display_if = self._parse_condition(r.get("display_if"), rctx)

            if qtype == "checkbox_grid":
                lp = self._req_str(r, "label_prefix", rctx)
                rows.append(GridRow(id=rid, text=text, label_prefix=lp,
                                    display_if=display_if))
            else:
                lbl = self._req_str(r, "label", rctx)
                rows.append(GridRow(id=rid, text=text, label=lbl,
                                    display_if=display_if))
        return rows

    # --- Variable parsing ---

    def _parse_variable(self, raw, ctx, qid):
        """Parse a defines_variable block into a Variable instance."""
        if not isinstance(raw, dict):
            self.err(f"{ctx} > defines_variable: must be a mapping.")
            return None
        name = raw.get("name")
        if not name or not isinstance(name, str):
            self.err(f"{ctx} > defines_variable: 'name' is required.")
            return None
        # Check for valid identifier-like name (letters, digits, underscores)
        import re
        if not re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', name):
            self.err(f"{ctx} > defines_variable: name '{name}' must be a valid "
                     f"identifier (letters, digits, underscores; cannot start with a digit).")
            return None
        # Track variable name (later definitions overwrite earlier ones at runtime)
        self.variable_names.add(name)

        mapping = raw.get("mapping")
        if mapping is not None:
            if not isinstance(mapping, dict):
                self.err(f"{ctx} > defines_variable > mapping: must be a mapping.")
                mapping = None
            else:
                # Coerce keys and values to strings
                mapping = {str(k): str(v) for k, v in mapping.items()}

        return Variable(name=name, mapping=mapping)

    # --- Condition parsing (structural only, not reference validation) ---

    def _parse_condition(self, raw, ctx):
        """Parse a display_if block into Condition or ConditionGroup. No reference
        validation here — that happens in the second pass once all IDs are known."""
        if raw is None:
            return None
        if not isinstance(raw, dict):
            self.err(f"{ctx} > display_if: must be a mapping.")
            return None

        op = raw.get("operator")
        if op in COMPOUND_OPERATORS:
            raw_conds = raw.get("conditions")
            if not raw_conds or not isinstance(raw_conds, list):
                self.err(f"{ctx} > display_if: compound condition needs a 'conditions' list.")
                return None
            if op == "not" and len(raw_conds) != 1:
                self.err(f"{ctx} > display_if: 'not' operator must have exactly one condition.")
                return None
            children = [self._parse_condition(c, ctx + " > conditions") for c in raw_conds]
            children = [c for c in children if c is not None]
            return ConditionGroup(operator=op, conditions=children)

        elif op in LEAF_OPERATORS:
            question_ref = raw.get("question")
            if not question_ref:
                self.err(f"{ctx} > display_if: leaf condition needs a 'question' field.")
                return None
            value = raw.get("value")
            if op not in VALUE_NOT_REQUIRED and value is None:
                self.err(f"{ctx} > display_if: operator '{op}' requires a 'value' field.")
            return Condition(question=question_ref, operator=op, value=str(value) if value is not None else None)

        else:
            self.err(f"{ctx} > display_if: unknown operator '{op}'. "
                     f"Must be one of: {sorted(LEAF_OPERATORS | COMPOUND_OPERATORS)}")
            return None

    # --- Second-pass condition validation ---

    def _validate_question_conditions(self, q: Question):
        ctx = f"question '{q.id}'"
        q_pos = self.question_order.index(q.id)

        if q.display_if:
            self._validate_condition(q.display_if, ctx, q_pos)

        for opt in q.options:
            if opt.display_if:
                self._validate_condition(opt.display_if, f"{ctx} > option '{opt.value}'", q_pos)

        for row in q.rows:
            if row.display_if:
                row_pos = self.question_order.index(row.id)
                self._validate_condition(row.display_if, f"{ctx} > row '{row.id}'", row_pos)

    def _validate_condition(self, cond, ctx, self_pos):
        """Recursively validate that all question references exist, are not
        forward references, and use operators appropriate for their type."""
        if cond is None:
            return
        if isinstance(cond, ConditionGroup):
            for c in cond.conditions:
                self._validate_condition(c, ctx, self_pos)
            return

        # Leaf condition
        ref = cond.question

        # $-prefixed references target variables, not questions
        if ref.startswith("$"):
            var_name = ref[1:]
            if var_name not in self.variable_names:
                self.err(f"{ctx} > display_if: references unknown variable '${var_name}'. "
                         f"Available variables: {sorted(self.variable_names) or '(none)'}.")
            # Variable refs only support equals/not_equals/is_answered/is_not_answered
            if cond.operator in INCLUDES_OPERATORS or cond.operator in COUNT_OPERATORS:
                self.err(f"{ctx} > display_if: operator '{cond.operator}' cannot be used "
                         f"with variable references (only equals, not_equals, is_answered, "
                         f"is_not_answered are supported).")
            return

        if ref not in self.question_types:
            self.err(f"{ctx} > display_if: references unknown question id '{ref}'.")
            return

        ref_pos = self.question_order.index(ref)
        if self_pos is not None and ref_pos >= self_pos:
            self.err(f"{ctx} > display_if: references '{ref}' which appears at the same "
                     f"position or later in the survey (forward references not allowed).")

        ref_type = self.question_types[ref]
        if cond.operator in INCLUDES_OPERATORS:
            if ref_type not in ("checkbox", "checkbox_grid", "checkbox_grid_row"):
                self.err(f"{ctx} > display_if: operator '{cond.operator}' can only be used "
                         f"with checkbox/checkbox_grid questions, but '{ref}' is type '{ref_type}'.")

        if cond.operator in COUNT_OPERATORS:
            if ref_type not in ("checkbox", "checkbox_grid", "checkbox_grid_row"):
                self.err(f"{ctx} > display_if: operator '{cond.operator}' can only be used "
                         f"with checkbox/checkbox_grid questions, but '{ref}' is type '{ref_type}'.")
            if cond.value is not None:
                try:
                    int(cond.value)
                except (ValueError, TypeError):
                    self.err(f"{ctx} > display_if: count operator '{cond.operator}' requires "
                             f"an integer value, got '{cond.value}'.")

    # --- Helpers ---

    def _req_str(self, raw, key, ctx) -> str:
        val = raw.get(key) if isinstance(raw, dict) else None
        if val is None:
            self.err(f"{ctx}: missing required field '{key}'.")
            return ""
        return str(val)

    def _register_id(self, id_val, ctx):
        if not id_val:
            return
        if id_val in self.all_ids:
            self.err(f"{ctx}: duplicate id '{id_val}' (first seen at position {self.all_ids[id_val]}).")
        else:
            self.all_ids[id_val] = self.position
        self.position += 1

    def _validate_csv_columns(self, survey):
        """Check that all CSV column names that would be generated are unique."""
        seen = {}  # col_name -> description of source
        for page in survey.pages:
            for q in page.questions:
                cols = self._csv_columns_for(q)
                src = f"question '{q.id}'"
                for col in cols:
                    if col in seen:
                        self.err(f"CSV column collision: '{col}' produced by "
                                 f"{seen[col]} and {src}.")
                    else:
                        seen[col] = src

    def _csv_columns_for(self, q):
        """Return the list of CSV column names a question would produce."""
        if q.type == "checkbox":
            return [f"{q.label}__{o.value}" for o in q.options]
        elif q.type == "checkbox_grid":
            return [f"{r.label_prefix}__{c.value}"
                    for r in q.rows for c in q.columns]
        elif q.type == "number_grid":
            return [f"{r.label}__{c.value}"
                    for r in q.rows for c in q.columns]
        elif q.type in ("radio_grid", "rating_grid"):
            return [r.label for r in q.rows]
        elif q.label:
            return [q.label]
        return []

    def _parse_min_max(self, raw, ctx, required=False):
        mn = raw.get("min")
        mx = raw.get("max")
        if required:
            if mn is None:
                self.err(f"{ctx}: 'min' is required for this type.")
            if mx is None:
                self.err(f"{ctx}: 'max' is required for this type.")
        if mn is not None and mx is not None:
            try:
                mn, mx = float(mn), float(mx)
                if mn >= mx:
                    self.err(f"{ctx}: 'min' ({mn}) must be less than 'max' ({mx}).")
            except (TypeError, ValueError):
                self.err(f"{ctx}: 'min' and 'max' must be numbers.")
                return None, None
        return mn, mx


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def load_survey(path: str) -> Survey:
    """Load and validate a survey YAML file. Raises ValueError on any errors."""
    parser = SurveyParser()
    return parser.parse(path)


# ---------------------------------------------------------------------------
# CLI — run directly to validate a survey file
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python parser.py <survey.yaml>")
        sys.exit(1)
    try:
        survey = load_survey(sys.argv[1])
        page_count = len(survey.pages)
        q_count = sum(len(p.questions) for p in survey.pages)
        print(f"✓ Survey '{survey.title}' loaded successfully.")
        print(f"  {page_count} page(s), {q_count} question(s).")
    except ValueError as e:
        print(str(e))
        sys.exit(1)
