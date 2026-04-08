# Survey App — Deployment & Usage Guide

## What you have

```
project/
  survey.yaml        ← Your survey definition (edit this)
  app.py             ← Flask backend
  parser.py          ← YAML loader and validator
  exporter.py        ← SQLite → CSV logic
  requirements.txt   ← Python dependencies
  Procfile           ← Gunicorn start command
  render.yaml        ← Render deployment config
  static/
    index.html       ← Frontend shell
    style.css        ← Stylesheet
    survey.js        ← All frontend logic
```

---

## Step 1 — Write your survey

Edit `survey.yaml`. Run this to validate it before deploying:

```bash
python parser.py survey.yaml
```

Any errors are printed with exact locations. Fix them all before proceeding.
The `survey.yaml` included in this project is a worked example covering every
question type — use it as a reference.

### Question types quick reference

| Type | What it renders |
|---|---|
| `radio` | Single-choice buttons |
| `checkbox` | Multi-select checkboxes |
| `dropdown` | Select box |
| `text` | Single-line text input |
| `textarea` | Multi-line text input |
| `number` | Numeric input (with optional min/max) |
| `rating` | Row of numbered buttons |
| `radio_grid` | Matrix — one radio per row (e.g. Likert scale) |
| `checkbox_grid` | Matrix — multiple checkboxes per row |
| `rating_grid` | Matrix — one numeric rating per row |

### display_if syntax

Attach `display_if` to any page, question, option, or grid row.
It can only reference questions that appear **before** it in the survey.

Single condition:
```yaml
display_if:
  question: q_employment
  operator: equals
  value: employed
```

Compound condition:
```yaml
display_if:
  operator: and          # or: or
  conditions:
    - question: q_employment
      operator: equals
      value: employed
    - question: q_region
      operator: not_equals
      value: other
```

Available operators:
- `equals` / `not_equals` — exact string match
- `includes` / `not_includes` — checkbox question contains a value
- `is_answered` / `is_not_answered` — any non-empty answer exists

Compound conditions can be nested arbitrarily:
```yaml
display_if:
  operator: or
  conditions:
    - question: q_transport
      operator: includes
      value: car
    - operator: and
      conditions:
        - question: q_age
          operator: is_answered
        - question: q_region
          operator: equals
          value: rural
```

---

## Step 2 — Deploy to Render

Render is the recommended host. Their free tier works, but note that free
instances spin down after 15 minutes of inactivity and take ~30 seconds to
wake up on the next request. For an active survey this is fine; if you want
instant response at all times, the $7/month "Starter" plan keeps it always on.

The persistent disk ($1/month for 1 GB) is **required** — without it the
SQLite database resets every time the service restarts and you lose all data.
This brings the minimum cost to $1/month (disk only, if using the free web tier)
or $8/month (Starter web + disk).

### One-time setup

1. **Create a GitHub repository** and push all project files to it.
   The repository should look like this at its root:
   ```
   survey.yaml
   app.py
   parser.py
   exporter.py
   requirements.txt
   Procfile
   render.yaml
   static/
     index.html
     style.css
     survey.js
   ```

2. **Sign up at render.com** (free account, no credit card needed for the
   web service itself — card required to add the disk).

3. **Create a new Web Service:**
   - Click "New → Web Service"
   - Connect your GitHub account and select your repository
   - Render will detect `render.yaml` automatically and pre-fill most settings

4. **Add a persistent disk:**
   - In your service settings, go to "Disks"
   - Add a disk: name it `survey-data`, mount path `/data`, size 1 GB
   - This is where `responses.db` will live

5. **Set environment variables** (Settings → Environment):

   | Variable | Value |
   |---|---|
   | `DB_PATH` | `/data/responses.db` |
   | `SURVEY_PATH` | `/opt/render/project/src/survey.yaml` |
   | `EXPORT_KEY` | A random secret string of your choosing |

   The `EXPORT_KEY` protects the `/api/export` endpoint. Choose something
   unguessable — a random 20-character string is fine. You'll need it to
   download your data.

6. **Deploy.** Render will install dependencies, start gunicorn, and give
   you a public URL like `https://survey.onrender.com`.

### Updating the survey

To update `survey.yaml` after deployment:
1. Edit the file locally and run `python parser.py survey.yaml` to validate
2. Commit and push to GitHub
3. Render redeploys automatically (usually takes under 2 minutes)

> ⚠️ Changing question `label` or `label_prefix` values after you have
> collected responses will rename CSV columns, making old and new data
> inconsistent. Avoid renaming labels once the survey is live.

---

## Step 3 — Collect responses

Share the Render URL. That's it. No login, no setup for respondents.

Responses are checkpointed to SQLite after every page. If a respondent
closes the browser mid-survey, their partial answers are retained.

---

## Step 4 — Export your data

Hit this URL in your browser to download a CSV of all responses:

```
https://your-survey-url.onrender.com/api/export?key=YOUR_EXPORT_KEY
```

The CSV contains one row per session (complete and incomplete alike) with
these columns:

- `session_id` — unique respondent identifier
- `started_at` — UTC timestamp when the survey was started
- `completed` — `1` if finished, `0` if abandoned
- One column per question (using the `label` you defined in the YAML)

### Missing value codes

| Code | Meaning |
|---|---|
| `SKIPPED` | Question was shown but hidden by skip logic |
| `NO_ANSWER` | Question was shown and active, but left blank |
| `NOT_REACHED` | Respondent abandoned before this page was displayed |

For checkbox questions: each option is a separate binary column (`0` or `1`),
plus the three sentinel values above.

### Check response counts

```
https://your-survey-url.onrender.com/api/status
```

Returns JSON: `{"total": 42, "completed": 38, "incomplete": 4}`

---

## Running locally (for testing)

First, install dependencies (only needed once):

```
pip install -r requirements.txt
```

Then validate your survey:

```
python parser.py survey.yaml
```

### Starting the dev server

**Windows Command Prompt:**
```bat
set SURVEY_PATH=survey.yaml
set DB_PATH=responses.db
set FLASK_DEBUG=1
python app.py
```

**Windows PowerShell:**
```powershell
$env:SURVEY_PATH="survey.yaml"
$env:DB_PATH="responses.db"
$env:FLASK_DEBUG="1"
python app.py
```

**Mac / Linux:**
```bash
SURVEY_PATH=survey.yaml DB_PATH=responses.db FLASK_DEBUG=1 python app.py
```

Once running, open your browser to: **http://localhost:5000**

You should see the survey welcome screen. The terminal will show a request
log as you navigate through the survey. To stop the server, press `Ctrl+C`.

The dev server reloads automatically when you edit Python files.
Changes to `survey.yaml` require a manual restart (Ctrl+C, then run again).

> ⚠️ A very common mistake: if your conditional pages aren't appearing, check
> that you restarted the server after editing `survey.yaml`. The survey
> definition is loaded once at startup and cached — the server will keep
> serving the old version until restarted.

### Exporting data locally

**Windows Command Prompt:**
```bat
python exporter.py survey.yaml responses.db responses.csv
```

**Mac / Linux:**
```bash
python exporter.py survey.yaml responses.db responses.csv
```

This writes all responses (complete and incomplete) to `responses.csv`
in the project folder.

---

## Troubleshooting

**Survey fails to load on startup**
Check the Render logs. The parser prints all validation errors at boot.
The most common causes are duplicate IDs, forward references in `display_if`,
or a `min`/`max` issue on a rating question.

**"Could not save your responses" in the browser**
Open the browser console (F12) and check for the specific error. Usually
a network error (service woke up slowly) — the respondent can retry.

**The export endpoint returns 403**
Your `EXPORT_KEY` environment variable on Render doesn't match what you're
passing in the `?key=` parameter. Check for accidental whitespace.

**Free tier is slow on first load**
Render free instances sleep after 15 minutes. The first request after sleep
takes 20–30 seconds. If this bothers you, upgrade to the $7/month Starter plan
or set up a free uptime monitor (e.g. UptimeRobot) to ping the `/api/status`
endpoint every 10 minutes.

**I need to reset all responses**
SSH into your Render instance (available on paid plans) and delete
`/data/responses.db`. It will be recreated empty on the next request.
On the free plan, you can temporarily remove and re-add the disk.
