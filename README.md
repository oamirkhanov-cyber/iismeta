# Digital Office — AI assistants for construction companies

**Live module:** [www.iismeta.com](https://www.iismeta.com) — IISMETA, the cost-estimating module
(a working build in pilot operation; interface title: "SmetaAI")
*Русская версия — [README.ru.md](README.ru.md)*

---

## The idea

**Digital Office (DO)** is a platform of AI assistants that mirrors the org structure of a
construction company. Every department gets its own assistant that takes over the paperwork,
and all of them work off **one shared project database**: quantities are measured once, and from
them follow the estimate, the material requisition, the completion certificates and the budget.
Nothing is re-typed from one spreadsheet into another, so the figures agree everywhere.

**The governing principle: the software calculates — the specialist decides and signs.**
Approvals, signatures and payments always belong to a human.

| Module | Department | Status |
|---|---|---|
| **IISMETA — cost estimating** | estimating | **working today** — see below |
| Site & technical department | production/technical | planned, stage 1 |
| Procurement | supply | planned, stage 1 |
| Design office | design | planned, stage 2 |
| Project office, schedule & reporting | PMO | planned, stage 2 |
| Finance: budget and cost price | finance | planned, stage 2 |
| HR, records, safety & quality | support functions | planned, stage 3 |

Reference model: a typical contractor of **484 positions**, of which about **170** are
office-based engineering staff working with documents (our estimate, to be measured on site) — those are the ones the assistants unload.
Rollout is staged; each stage states openly what is required from the company.

---

## IISMETA — the first working module

Turns a **Bill of Quantities (BoQ)** into **cost estimate documentation compliant with ShNK**
(the construction norms and standards of the Republic of Uzbekistan).

> Upload the BoQ → get an estimate draft in minutes → the estimator checks and approves it.

**The module has two parts.** *Manual estimating* — a complete estimator workstation: the full
ShNK rate tree, hand assembly of estimates, Ministry-format export — is feature-complete (≈99%),
and we are preparing to apply for the official licence for its use in Uzbekistan's construction
industry. *The automatic BoQ → estimate part* — the AI-assisted matching with the accuracy figures
below — is in refinement.


| Estimator's step | Today | With IISMETA |
|---|---|---|
| Read the BoQ (PDF, scan, Excel) | manual re-typing | recognition, including scans |
| Break lines down into norms | manual search in reference books | the engine proposes, the estimator verifies |
| Match the ShNK unit rate | tens of minutes per item | automatic matching with justification |
| Assemble the estimate | manual assembly | export in the working format |

### Measured results

- Verified on **10 real construction projects**: **360 items matched exactly**;
  about **71% of labour content** closed automatically.
- Matching accuracy: **~70%** correct on the first try; **~79%** correct within the five suggested
  options — the estimator picks the right one with a single click.
- Ambiguous lines are **flagged for the operator**, never passed off as certain.
- **Scope of the measurement:** the figures above were obtained on **earthworks and architectural works (AR)** — the sections the engine has been calibrated and validated on so far. The full ShNK base is loaded, but matching quality on the remaining sections is still being brought up.

---

## From bill of quantities to estimate — six steps

The engine makes the first pass; the estimator checks and approves.

**Project criteria** are set once and govern norm selection throughout: building type ·
structural system · work conditions · region.

| # | Step | What happens | Who runs it |
|---|---|---|---|
| 1 | **Project** | site → sub-site; description of construction conditions | operator |
| 2 | **Bill of quantities** | upload as-is: PDF · scan · Excel · Word, no reformatting | operator |
| 3 | **Recognition** | document → table: sections, quantities, units of measure (scans included) | AI |
| 4 | **Normalization** | lines are mapped to work items; uncertain items are flagged | engine + human |
| 5 | **ShNK matching** | line → ShNK table; norm variant + justification for every item | strict rules |
| 6 | **Estimate** | resources and adjustments per the ShNK norms, Ministry format, export to Excel | engine |

Steps 5 and 6 — the ones that produce the figures — run on strict rules over the normative base,
with no AI involved. AI is confined to reading documents (step 3) and to proposing options inside
a rule-generated shortlist (step 4).

**Current scope of the module:** today it produces the *resource part* of the estimate — the volumes of labour, machinery and materials per the ShNK norms, in the Ministry format. The current-prices layer (market prices for materials) is the next milestone.


**Learning from corrections.** Every estimator correction is stored as a *before → after* pair with
its context (`code/engine/edit_journal.py`). Those pairs stay inside the customer's own
installation and make subsequent matching more accurate there; the shared engine that ships to
everyone is improved on our own reference corpus, never on another customer's project data.

---

## Engineering principles

- **Deterministic core.** The main path — BoQ line → applicable ShNK rate → estimate — runs on
  explicit rules over the normative base. No LLM call, no internet needed. The same input yields
  the same output: an estimate is a calculation document, and "different every time" is unacceptable.
- **Justification for every item.** For any matched norm the system shows the grounds for the choice.
- **Human in the loop.** Everything the engine did by itself is flagged and subject to confirmation.
- **AI only where rules fall short.** Reading scans, disambiguating wording, drafting. The AI layer
  is behind feature flags with a rule-based fallback, and it *selects from a shortlist produced by
  the deterministic core* rather than inventing rate codes.
- **Deployable inside the customer's perimeter.** The same container runs on-premise — up to a fully
  air-gapped installation, because the core needs no outside connection.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Published source code

[`code/`](code/) holds a **selected working part** of the product — about **19,000 lines**:

| Area | Path |
|---|---|
| Web service & API | [`code/web_server.py`](code/web_server.py) |
| BoQ → estimate pipeline | [`code/pipeline/`](code/pipeline/) |
| Engine: norms, rate selection, estimate assembly | [`code/engine/`](code/engine/) |
| Browser client | [`code/frontend/`](code/frontend/) |
| Deployment | [`code/Dockerfile`](code/Dockerfile) |

Development is carried out in a private repository — **950+ commits** since the start of the
project; this repository is a curated review copy of the working part.

**This is a review copy, not a runnable distribution.** Deliberately excluded:

- the digitised **ShNK normative database** (tens of thousands of rates with correction factors);
- the engine's **full catalogues, dictionaries and calibration data** (the published code shows the
  framework and representative rules, not the complete rule set);
- the **validation corpus** of real bills and estimates — it contains **third-party client project
  data** we are not entitled to disclose;
- several internal modules that the published files import.

Because of this, `import web_server` will not resolve and the code cannot produce estimates on its
own. The engine is the machine tool; the normative data is the die. The working product is at
[www.iismeta.com](https://www.iismeta.com).

---

## Team

- **Otabek Amirkhanov** — Founder & CEO. 15+ years in EPC/EPCM design and construction.
- **Zulfiya Karimova** — practising cost estimator; validation of engineering decisions.
- **Shakhnoza Akhmedova** — design and communications.

Contact: bkhan.uz@gmail.com

## License

Proprietary — source-available for review only. See [LICENSE](LICENSE).
