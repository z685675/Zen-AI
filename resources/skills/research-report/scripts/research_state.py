#!/usr/bin/env python3
"""Offline research checkpoint and bounded work reservations; never runs tools/network.

OpenCode owns execution. This helper records evidence and returns which proposed
reads are new, reused or blocked. SQLite transactions prevent parallel reservations
of the same work. No external packages, secrets, browser IDs or page bodies needed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

OUTCOMES = {"success", "timeout", "blocked", "certificate", "not_found", "error", "interrupted"}
METHODS = {"search", "browser", "metadata", "repository", "fetch"}
LEVELS = {"metadata", "abstract", "full_text_excerpt", "full_text"}
TRACKING = {"fbclid", "gclid", "mc_cid", "mc_eid"}


def canonical_url(value):
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Use a public HTTP(S) source URL without credentials")
    query = sorted((k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
                   if not k.lower().startswith("utm_") and k.lower() not in TRACKING)
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/") or "/", urlencode(query), ""))


def normalize_doi(value):
    value = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip(), flags=re.I).lower()
    if value and not re.fullmatch(r"10\.\d{4,9}/\S+", value):
        raise ValueError("Invalid DOI; leave unknown identifiers empty")
    return value


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be nonempty text")
    return value.strip()


def connect(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS questions (
            id TEXT PRIMARY KEY, question TEXT NOT NULL, minimum INTEGER NOT NULL, required_level TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, title TEXT NOT NULL, doi TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS urls (url TEXT PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id));
        CREATE TABLE IF NOT EXISTS work (
            id INTEGER PRIMARY KEY, work_key TEXT NOT NULL, method TEXT NOT NULL, target TEXT NOT NULL,
            source_id INTEGER REFERENCES sources(id), outcome TEXT NOT NULL DEFAULT 'pending',
            detail TEXT NOT NULL DEFAULT '', level TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS work_keys ON work(work_key);
        CREATE TABLE IF NOT EXISTS evidence (
            work_id INTEGER NOT NULL REFERENCES work(id), question_id TEXT NOT NULL REFERENCES questions(id),
            claim TEXT NOT NULL, confidence TEXT NOT NULL,
            PRIMARY KEY(work_id, question_id, claim));
    """)
    return db


def meta(db, key):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    if row is None:
        raise ValueError("Initialize this task before recording work")
    return row[0]


def initialize(db, task_id, plan):
    text(task_id, "task_id")
    questions = plan.get("questions", [])
    if not questions or len(questions) > 20:
        raise ValueError("Provide 1-20 explicit research questions")
    parsed = []
    for item in questions:
        minimum = item.get("min_sources", 2)
        if type(minimum) is not int or not 1 <= minimum <= 20:
            raise ValueError("min_sources must be 1-20")
        required_level = item.get("required_level", "abstract")
        if required_level not in {"abstract", "full_text"}:
            raise ValueError("required_level must be abstract or full_text")
        parsed.append((text(item.get("id"), "question id"), text(item.get("question"), "question"), minimum, required_level))
    if len({q[0] for q in parsed}) != len(parsed):
        raise ValueError("Question IDs must be unique")
    pages = plan.get("max_pages", 25)
    if type(pages) is not int or not 1 <= pages <= 200:
        raise ValueError("max_pages must be 1-200; broader studies require user authorization")
    existing = db.execute("SELECT value FROM meta WHERE key='task_id'").fetchone()
    if existing:
        if existing[0] != task_id:
            raise ValueError("Checkpoint belongs to another task; use a new task directory")
        previous = [tuple(row) for row in db.execute("SELECT id,question,minimum,required_level FROM questions ORDER BY id")]
        if previous != sorted(parsed) or int(meta(db, "max_pages")) != pages:
            raise ValueError("Existing plan differs; preserve this checkpoint and explicitly revise the plan")
        return {"task_id": task_id, "reused": True}
    db.executemany("INSERT INTO meta VALUES (?,?)", [("task_id", task_id), ("max_pages", str(pages)), ("gap_passes", "0")])
    db.executemany("INSERT INTO questions VALUES (?,?,?,?)", parsed)
    return {"task_id": task_id, "reused": False}


def source(db, item, url):
    doi = normalize_doi(item.get("doi", ""))
    # A DOI resolver URL itself is a stable source identifier.
    if urlsplit(url).hostname in {"doi.org", "dx.doi.org"}:
        resolver_doi = normalize_doi(url)
        if doi and doi != resolver_doi:
            raise ValueError("DOI conflicts with its resolver URL; verify metadata first")
        doi = resolver_doi
    found = db.execute("SELECT source_id FROM urls WHERE url=?", (url,)).fetchone()
    if found and doi:
        old_doi = db.execute("SELECT doi FROM sources WHERE id=?", (found[0],)).fetchone()[0]
        if old_doi and old_doi != doi:
            raise ValueError("Conflicting DOI for an existing URL; verify metadata first")
    known = db.execute("SELECT id FROM sources WHERE doi=?", (doi,)).fetchone() if doi else None
    if found and known and found[0] != known[0]:
        # Newly learned DOI joins earlier URL-only records without losing evidence.
        db.execute("UPDATE urls SET source_id=? WHERE source_id=?", (known[0], found[0]))
        db.execute("UPDATE work SET source_id=? WHERE source_id=?", (known[0], found[0]))
        db.execute("DELETE FROM sources WHERE id=?", (found[0],))
        found = known
    row = known or found
    if row:
        source_id = row[0]
        old = db.execute("SELECT doi FROM sources WHERE id=?", (source_id,)).fetchone()[0]
        if old and doi and old != doi:
            raise ValueError("Conflicting DOI for an existing URL; verify metadata first")
        if doi and not old:
            db.execute("UPDATE sources SET doi=? WHERE id=?", (doi, source_id))
    else:
        source_id = db.execute("INSERT INTO sources(title,doi) VALUES (?,?)", (item.get("title") or url, doi or None)).lastrowid
    db.execute("INSERT OR IGNORE INTO urls VALUES (?,?)", (url, source_id))
    return source_id


def reserve(db, items):
    meta(db, "task_id")
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise ValueError("Reserve a batch of 1-50 reads")
    output = []
    for item in items:
        method = item.get("method")
        if method not in METHODS:
            raise ValueError("Unknown read method")
        target = (" ".join(text(item.get("query"), "query").split()) if method == "search"
                  else canonical_url(text(item.get("url"), "url")))
        key = hashlib.sha256(f"{method}:{target.casefold() if method == 'search' else target}".encode()).hexdigest()
        # Learn/validate new DOI metadata even when this URL was already read.
        # Identity updates must not require another content fetch.
        source_id = None if method == "search" else source(db, item, target)
        previous = db.execute("SELECT * FROM work WHERE work_key=? ORDER BY id", (key,)).fetchall()
        decision = {"method": method, "target": target}
        # Explicit one-time retry for a transient failure only. Never replay a
        # pending read, CAPTCHA, certificate failure or successful operation.
        retry = (item.get("retry_transient") is True and len(previous) == 1
                 and previous[0]["outcome"] in {"timeout", "error", "interrupted"})
        if previous and not retry:
            last = previous[-1]
            output.append({**decision, "decision": "reuse" if last["outcome"] == "success" else "skip",
                           "attempt_id": last["id"], "source_id": source_id,
                           "outcome": last["outcome"], "reason": "already_recorded"})
            continue
        if source_id:
            prior = db.execute("SELECT method,target,outcome FROM work WHERE source_id=?", (source_id,)).fetchall()
            # Once the paper's full text is read, reuse it across DOI/repository URLs.
            full_text = db.execute("SELECT id FROM work WHERE source_id=? AND outcome='success' AND level='full_text'", (source_id,)).fetchone()
            if full_text:
                output.append({**decision, "decision": "reuse", "source_id": source_id, "attempt_id": full_text[0], "reason": "full_text_available"})
                continue
            # A source may use metadata plus two content routes. This bounds
            # chasing mirrors while permitting abstract -> full-text upgrades.
            routes = {(r["method"], r["target"]) for r in prior if r["method"] != "metadata"}
            if method != "metadata" and (method, target) not in routes and len(routes) >= 2:
                output.append({**decision, "decision": "skip", "source_id": source_id, "reason": "source_route_budget"})
                continue
        if method == "browser" and db.execute("SELECT COUNT(*) FROM work WHERE method='browser'").fetchone()[0] >= int(meta(db, "max_pages")):
            output.append({**decision, "decision": "skip", "reason": "page_budget"})
            continue
        attempt = db.execute("INSERT INTO work(work_key,method,target,source_id) VALUES (?,?,?,?)", (key, method, target, source_id)).lastrowid
        output.append({**decision, "decision": "execute", "attempt_id": attempt, "source_id": source_id})
    return output


def record(db, items):
    meta(db, "task_id")
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise ValueError("Record a batch of 1-50 results")
    for item in items:
        attempt = db.execute("SELECT * FROM work WHERE id=?", (item.get("attempt_id"),)).fetchone()
        if not attempt:
            raise ValueError("Unknown attempt_id; reserve work before executing it")
        outcome = item.get("outcome")
        if outcome not in OUTCOMES:
            raise ValueError("Unknown outcome")
        level = item.get("level") if outcome == "success" else None
        if outcome == "success" and attempt["source_id"] and level not in LEVELS:
            raise ValueError("Successful source reads require metadata/abstract/full_text evidence level")
        findings = [{"question_id": text(f.get("question_id"), "question_id"),
                     "claim": text(f.get("claim"), "claim"), "confidence": f.get("confidence", "medium")}
                    for f in item.get("findings", [])]
        if findings and (outcome != "success" or not attempt["source_id"] or level not in {"abstract", "full_text_excerpt", "full_text"}):
            raise ValueError("Search snippets/metadata/failures cannot count as verified content evidence")
        detail = item.get("detail", "")
        if not isinstance(detail, str) or len(detail) > 2000:
            raise ValueError("Use a short failure/reading note, not a full page body")
        if attempt["outcome"] != "pending":
            # Exact result replay is safe; conflicting histories are not silently rewritten.
            old = [dict(row) for row in db.execute("SELECT question_id,claim,confidence FROM evidence WHERE work_id=? ORDER BY question_id,claim", (attempt["id"],))]
            new = sorted(findings, key=lambda x: (x["question_id"], x["claim"]))
            if ((attempt["outcome"], attempt["level"], attempt["detail"]) != (outcome, level, detail)
                    or any(f not in old for f in new)):
                raise ValueError("Attempt already recorded with a different result")
            continue
        for finding in findings:
            if finding.get("confidence", "medium") not in {"high", "medium", "low"}:
                raise ValueError("Unknown confidence")
            db.execute("INSERT INTO evidence VALUES (?,?,?,?)", (attempt["id"], text(finding.get("question_id"), "question_id"),
                       text(finding.get("claim"), "claim"), finding.get("confidence", "medium")))
        db.execute("UPDATE work SET outcome=?,detail=?,level=? WHERE id=?", (outcome, detail, level, attempt["id"]))
    return {"recorded": len(items)}


def annotate(db, items):
    """Associate previously read evidence with another question without fetching again."""
    meta(db, "task_id")
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise ValueError("Annotate a batch of 1-50 findings")
    for item in items:
        work = db.execute("SELECT * FROM work WHERE id=?", (item.get("attempt_id"),)).fetchone()
        if not work or work["outcome"] != "success" or not work["source_id"] or work["level"] not in {"abstract", "full_text_excerpt", "full_text"}:
            raise ValueError("Annotate only a successful abstract/full-text read")
        confidence = item.get("confidence", "medium")
        if confidence not in {"high", "medium", "low"}:
            raise ValueError("Unknown confidence")
        db.execute("INSERT OR IGNORE INTO evidence VALUES (?,?,?,?)", (work["id"], text(item.get("question_id"), "question_id"),
                   text(item.get("claim"), "claim"), confidence))
    return {"annotated": len(items)}


def status(db, detailed=True):
    task_id = meta(db, "task_id")
    questions = []
    for q in db.execute("SELECT * FROM questions ORDER BY id"):
        findings = [dict(row) for row in db.execute("""SELECT w.source_id,e.claim,e.confidence,w.level,w.target
            FROM evidence e JOIN work w ON w.id=e.work_id WHERE e.question_id=? AND w.outcome='success'""", (q["id"],))]
        sources = {f["source_id"] for f in findings if f["confidence"] != "low"
                   and (q["required_level"] == "abstract" or f["level"] in {"full_text_excerpt", "full_text"})}
        questions.append({"id": q["id"], "question": q["question"], "min_sources": q["minimum"],
                          "required_level": q["required_level"],
                          "source_count": len(sources), "coverage_met": len(sources) >= q["minimum"], "findings": findings})
    pending = [dict(row) for row in db.execute("SELECT id,method,target,created_at FROM work WHERE outcome='pending'")]
    failures = [dict(row) for row in db.execute("SELECT id,method,target,outcome,detail FROM work WHERE outcome NOT IN ('pending','success')")]
    completed = [dict(row) for row in db.execute("SELECT id,method,target,source_id,level,detail FROM work WHERE outcome='success'")]
    registry = []
    for row in db.execute("SELECT id,title,doi FROM sources ORDER BY id"):
        registry.append({**dict(row), "urls": [u[0] for u in db.execute("SELECT url FROM urls WHERE source_id=? ORDER BY url", (row["id"],))]})
    gap_passes = int(meta(db, "gap_passes"))
    enough = all(q["coverage_met"] for q in questions)
    pages = db.execute("SELECT COUNT(*) FROM work WHERE method='browser'").fetchone()[0]
    next_step = ("settle_pending_reads" if pending else "synthesize" if enough else
                 "synthesize_with_limitations" if gap_passes >= 2 or pages >= int(meta(db, "max_pages")) else "research_gaps")
    result = {"task_id": task_id, "questions": questions, "pending": pending, "failures": failures,
            "completed_reads": completed, "source_registry": registry,
            "gap_passes": gap_passes, "browser_pages": pages, "next_step": next_step,
            "note": "Coverage counts are a guide, not proof of independent agreement or report quality. Reuse evidence; explain unresolved gaps."}
    if not detailed:
        # Normal passes already have the new tool outputs in context. Return
        # coverage, not every old finding again. Full evidence stays on disk
        # and is available with status on resumption.
        for question in questions:
            question.pop("findings")
        result["completed_read_count"] = len(result.pop("completed_reads"))
        result["source_count"] = len(result.pop("source_registry"))
    return result


def export_sources(db):
    """Reuse saved evidence; metadata candidates are not content verification."""
    snapshot = status(db)
    sources, candidates = [], []
    ranks = {"metadata": 0, "abstract": 1, "full_text_excerpt": 2, "full_text": 3}
    for source in snapshot["source_registry"]:
        reads = [r for r in snapshot["completed_reads"] if r["source_id"] == source["id"]]
        findings = [f for q in snapshot["questions"] for f in q["findings"] if f["source_id"] == source["id"]]
        level = max((r["level"] or "metadata" for r in (findings or reads)), key=lambda x: ranks.get(x, 0), default="metadata")
        content_url = next((r["target"] for r in (findings or reads) if r["level"] == level and r["target"].startswith(("https://", "http://"))), None)
        entry = {"title": source["title"], "doi": source["doi"],
                 "url": content_url or (source["urls"] or [f"https://doi.org/{source['doi']}" if source["doi"] else None])[0],
                 "evidence_level": level, "supports": list(dict.fromkeys(f["claim"] for f in findings)),
                 "confidence": "low" if findings and all(f["confidence"] == "low" for f in findings) else "medium",
                 "limitations": [] if level == "full_text" else ["Only relevant full-text excerpts were read; not the whole paper." if level == "full_text_excerpt" else "Full text has not been verified."]}
        (sources if findings and level in {"abstract", "full_text_excerpt", "full_text"} else candidates).append(entry)
    return {"sources": sources, "candidates": candidates,
            "note": "Evidence levels record actual tool reads, not scientific quality. Candidates do not count as verified content."}


def gap_pass(db):
    count = int(meta(db, "gap_passes"))
    if count < 2:
        db.execute("UPDATE meta SET value=? WHERE key='gap_passes'", (str(count + 1),))
    return {"allowed": count < 2, "gap_pass": min(count + 1, 2)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("action", choices=["init", "reserve", "record", "annotate", "status", "gap-pass", "export-sources"])
    parser.add_argument("--out", help="New UTF-8 JSON file for export-sources; existing files are never overwritten")
    parser.add_argument("--task-id")
    parser.add_argument("--gap-pass", action="store_true", help="Reserve a focused follow-up batch atomically, at most twice")
    data_arg = parser.add_mutually_exclusive_group()
    data_arg.add_argument("--input", help="UTF-8 JSON file: plan object or batch array")
    data_arg.add_argument("--json", help="Inline JSON through the managed tool's argument array (no shell)")
    args = parser.parse_args(argv)
    try:
        data = json.loads(Path(args.input).read_text(encoding="utf-8-sig")) if args.input else json.loads(args.json) if args.json else None
        if args.gap_pass and args.action != "reserve":
            raise ValueError("--gap-pass is only valid with reserve")
        if args.out and args.action != "export-sources":
            raise ValueError("--out is only valid with export-sources")
        with closing(connect(args.db)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if args.action == "init":
                result = initialize(db, args.task_id, data)
                if data.get("reads"):
                    result["reservations"] = reserve(db, data["reads"])
                result["state"] = status(db, detailed=False)
            elif args.action == "reserve":
                permit = gap_pass(db) if args.gap_pass else {"allowed": True}
                result = {**permit, "reservations": reserve(db, data) if permit["allowed"] else [], "state": status(db, detailed=False)}
            elif args.action == "record":
                result = record(db, data)
                result["state"] = status(db, detailed=False)
            elif args.action == "annotate":
                result = annotate(db, data)
                result["state"] = status(db, detailed=False)
            elif args.action == "gap-pass":
                result = gap_pass(db)
            elif args.action == "export-sources":
                result = export_sources(db)
                if args.out:
                    with Path(args.out).open("x", encoding="utf-8") as output:
                        json.dump(result, output, ensure_ascii=False, indent=2)
                    result = {"output": args.out, "verified_source_count": len(result["sources"]),
                              "candidate_count": len(result["candidates"])}
            else:
                result = status(db)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, TypeError, AttributeError, OSError, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
