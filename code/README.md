# IISMETA — published source code

This directory contains a **selected working part** of the product's source code (~19,000 lines).
These are not demo stubs: every module here runs in the product at [www.iismeta.com](https://www.iismeta.com).

**What was changed for publication:** internal identifiers were renamed and internal working
notes (names, dated decisions, internal run figures) were removed or generalised. Comments
explaining the engineering are kept in place, in Russian — that is the working language of the
team and of the industry documentation this software processes.

## Layout

| Path | Contents |
|---|---|
| `web_server.py` | FastAPI application: API endpoints, sessions, project handling, estimate export |
| `pipeline/` | BoQ → estimate pipeline |
| `engine/` | norms knowledge base, rate selection, estimate assembly |
| `frontend/` | browser client (plain JS, no external dependencies) |
| `Dockerfile`, `requirements.txt` | deployment: a single container |

### `pipeline/` — from a bill of quantities to structured work items

| File | Role |
|---|---|
| `parsing.py` | reads the BoQ from Excel/PDF/scans into structured lines |
| `columns.py` | detects which column is quantity, unit, description |
| `doctype.py` | recognises the document type and its layout |
| `router.py`, `vor_router.py` | routes each line towards the applicable norm |
| `crosscheck.py`, `reconcile.py` | cross-checks quantities and reconciles discrepancies |
| `*_decompose.py` | decomposes structures (roofs, floors, walls, steelwork) into the works a norm expects |
| `llm_fallback.py` | optional AI assist — behind a feature flag, selecting from a rule-generated shortlist, with a rule-based fallback |

### `engine/` — norms and assembly

| File | Role |
|---|---|
| `kb_engine.py` | access to the ShNK knowledge base: norms, technical parts, correction factors |
| `cluster_c.py` | resolves variant axes where one work maps to several candidate norms |
| `lrv_build.py` | assembles the estimate in the Ministry of Construction format |
| `unit_convert.py` | unit normalisation and cross-dimension conversion (area → mass via unit weight, m² ↔ m³ via thickness) |
| `edit_journal.py` | append-only journal of estimator corrections "before → after" |

## What these modules demonstrate

- **Determinism first.** The main path contains no LLM call at all. Rate selection is explicit rules
  over the normative base, so the same BoQ always yields the same estimate — a requirement for a
  document that goes to state expertise.
- **Honest uncertainty.** Where data is missing, the code returns "unknown" and asks the operator
  instead of substituting a plausible number — see `unit_convert.py`.
- **Provenance.** Every produced line carries its rate, the version of the norms base and the source
  of the decision (rule / operator / AI suggestion).
- **The system gets better from expert work.** `edit_journal.py` accumulates estimator corrections
  as *before → after* pairs. They stay inside the customer's own installation and improve matching
  there; the shipped engine is improved on our own reference corpus, not on another customer's data.

## Note

This is a **review copy, not a runnable distribution**. Without the normative database, the full
catalogues and matching rules, and several internal modules that these files import — none of which
are published — `import web_server` will not resolve and no estimate can be produced.

What *is* visible here is the framework and representative rules (section heuristics, unit handling,
decomposition logic); the complete rule set and catalogues stay unpublished.

See the repository [LICENSE](../LICENSE).
