# Reference evidence review

**Review date:** 2026-08-01
**Scope:** issue #15 — selected food composition, biological variation, kidney-function, medication, REDs, and micronutrient guardrails.

## Status and boundary

This was a source and provenance review, not a clinical review. It records the source release or live-record date where one exists, corrects claims that were stronger than their sources, and adds regression checks. It did **not** change the lab catalogue's critical values or high-consequence clinical floors.

The remaining external blocker is explicit: a qualified clinician must review the critical-value policy and clinical floors in `docs/kg/specs/lab-panels.json` before those thresholds can be treated as approved for release. No clinician participated in this review, and source validation must not be represented as clinician approval.

## USDA FoodData Central staple cohort

This local-only app has no aggregate usage telemetry, so the repository cannot honestly identify its empirically “highest-traffic” foods. The review therefore uses a documented common-staple cohort. Values were checked against the official FoodData Central **SR Legacy final release (2018-04)**, retrieved 2026-08-01.

| App food | FDC ID | Result |
|---|---:|---|
| White rice, long grain, cooked | 168878 | Values matched |
| Whole milk, 3.25% | 171265 | Values matched |
| Egg, whole, raw | 171287 | Values matched |
| Chicken breast, skinless, roasted | 171477 | Values matched |
| Apple, with skin | 171688 | Values matched |
| Banana | 173944 | Values matched |
| Salmon, Atlantic, farmed, cooked | 175168 | Saturated fat corrected from 2.5 to 2.4 g/100 g after rounding the official 2.397 value |

Each audited source row now carries its FDC ID, source release, and review date. Primary sources: [FoodData Central downloads](https://fdc.nal.usda.gov/download-datasets/), [data documentation](https://fdc.nal.usda.gov/data-documentation/), and [release log](https://fdc.nal.usda.gov/log/).

## EFLM biological variation

The EFLM Biological Variation Database live API was retrieved 2026-08-01. Its snapshot reported **191 meta-analyses, 3,366 biological-variation specifications, and 607 references**. The serum/plasma or whole-blood CVi records for creatinine, cystatin C, ferritin, iron, TSH, ALT, AST, alkaline phosphatase, albumin, bilirubin, sodium, potassium, chloride, calcium, magnesium, phosphate, haemoglobin, haematocrit, and creatine kinase were updated from their current per-analyte meta-analysis records.

The catalogue now distinguishes two inputs that had previously been blurred together:

- `cviPct` is source-verified from the dated EFLM record.
- `cvaPct` remains an app assumption unless the actual laboratory assay supplies an analytical coefficient of variation.

That distinction matters because an RCV calculation is not fully source-verified merely because its biological-variation component is. Primary sources: [EFLM database](https://biologicalvariation.eu/), [live meta-analysis API](https://biologicalvariation.eu/api/meta), and [API snapshot counts](https://biologicalvariation.eu/api/meta_calculations).

## Kidney-function and creatine claims

The previous copy overstated both causation and cystatin C. It now says that creatine can modestly raise serum creatinine without reducing measured filtration in healthy trial participants, but that this is a possible explanation—not proof that an abnormal result is harmless. Cystatin C is less muscle-dependent than creatinine but has other non-GFR determinants. A combined eGFRcr-cys estimate is generally more accurate than either marker alone; measured GFR may be appropriate when more certainty is needed.

Sources: [KDIGO 2024 CKD guideline](https://kdigo.org/wp-content/uploads/2024/03/KDIGO-2024-CKD-Guideline.pdf), [National Kidney Foundation implementation guidance](https://www.kidney.org/recommendations-implementing-ckd-epi-2021-race-free-egfr-calculation-guidelines-clinical), [NKF 2021 CKD-EPI creatinine equation](https://www.kidney.org/professionals/ckd-epi-creatinine-equation-2021), [Inker et al., 2021](https://www.nejm.org/doi/10.1056/NEJMoa2102953), [creatine randomized trial](https://pubmed.ncbi.nlm.nih.gov/18188581/), and [creatine renal-function trial](https://pmc.ncbi.nlm.nih.gov/articles/PMC7329184/).

## Medication, REDs, and nutrition guardrails

- Medication source metadata now dates the kidney/creatine review and the existing FDA label sources for sertraline and finasteride. It explicitly states that medication context never suppresses a critical-value escalation. Sources: [FDA sertraline label](https://www.accessdata.fda.gov/drugsatfda_docs/label/2023/215133s001lbl.pdf) and [FDA finasteride label](https://www.accessdata.fda.gov/drugsatfda_docs/label/2012/020788s020s021s023lbl.pdf).
- The energy-availability warning now uses 30 kcal/kg FFM/day as a conservative app caution line for adults, not a sex-specific clinical or diagnostic threshold. The copy states that energy availability is a continuum and that the app cannot diagnose REDs. Sources: [2023 IOC REDs consensus](https://bjsm.bmj.com/content/57/17/1073) and [IOC REDs CAT2 development and validation](https://bjsm.bmj.com/content/57/17/1109).
- The form-specific upper-limit rules were checked for preformed vitamin A, folic acid from supplements/fortified food, and supplemental magnesium. Sources: [NIH ODS Vitamin A](https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/), [Folate](https://ods.od.nih.gov/factsheets/Folate-HealthProfessional/), and [Magnesium](https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/).

## Review cadence

- Recheck FoodData Central release metadata when USDA publishes a new Foundation or SR release; retain stable FDC IDs and record the release used.
- Refresh the EFLM API snapshot at least annually and before changing any RCV-related behavior. Preserve each record's `updated_at` timestamp.
- Recheck clinical guidelines and regulator labels before changing user-facing health claims.
- Do not clear the clinical-review blocker through desk research alone.
