import csv
import json
import re
import subprocess
from pathlib import Path

import pymupdf


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = Path(__file__).resolve().parent
CHECKLIST_SCRIPT = """
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { APPLICATION_TYPES, CHECKLIST_SLOTS } = await import(
  pathToFileURL(resolve("backend", "src", "engine", "checklist.js"))
);
console.log(JSON.stringify({ APPLICATION_TYPES, CHECKLIST_SLOTS }));
"""
APPLICATION_NAMES = {
    "new_institution": "New Institution",
    "new_course": "New Course",
    "increase_in_intake": "Increase in Intake",
    "extension_of_approval": "Extension of Approval",
    "conversion_diploma_to_degree": "Conversion of Diploma to Degree",
    "collaboration_twinning": "Collaboration or Twinning Programme",
    "restoration_of_intake": "Restoration of Intake",
}
MODEL_SAMPLE_IDS = {
    "lease": "M1-000083",
    "fire": "M1-000071",
    "structural": "M1-000170",
    "occupancy_or_building": "M1-000030",
    "nba_letter": "M1-000011",
    "audited_accounts": "M1-000009",
    "aicte_approval_letter": "M1-000063",
}
MODEL_SAMPLE_TEXTS: dict[str, str] = {}
DOCUMENT_CONTENT = {
    "lease": [
        "LEASE DEED",
        "This synthetic lease deed records a sample institutional premises lease between Example Property Owner and Fictional Technical Institute.",
        "Lease start: 01 September 2026",
        "Lease end: 31 August 2036",
        "Lease term: 10 years",
        "Issuer: Example Property Registry",
    ],
    "fire": [
        "FIRE SAFETY CERTIFICATE",
        "The fictional premises listed in this sample are presented as inspected for fire-safety equipment and emergency exits.",
        "Certificate number: TEST-FIRE-2026-001",
        "Issue date: 01 September 2026",
        "Valid until: 31 August 2027",
        "Issuer: Example Fire Safety Authority",
    ],
    "structural": [
        "STRUCTURAL STABILITY CERTIFICATE",
        "This fictional certificate states that the sample academic building was inspected for structural stability.",
        "Certificate number: TEST-STRUCT-2026-001",
        "Issue date: 01 September 2026",
        "Valid until: 31 August 2027",
        "Issuer: Example Structural Engineering Office",
    ],
    "occupancy_or_building": [
        "OCCUPANCY AND BUILDING CERTIFICATE",
        "This fictional record describes an academic building and its sample occupancy approval.",
        "Certificate number: TEST-BUILDING-2026-001",
        "Issue date: 01 September 2026",
        "Issuer: Example Municipal Building Office",
    ],
    "nba_letter": [
        "NBA ACCREDITATION LETTER",
        "This synthetic letter records a sample accreditation status for the fictional Example Institute programme.",
        "Reference number: TEST-NBA-2026-001",
        "Issue date: 01 September 2026",
        "Valid until: 31 August 2029",
        "Issuer: Example Accreditation Board",
    ],
    "audited_accounts": [
        "AUDITED ACCOUNTS",
        "This fictional financial statement is supplied only to exercise document upload and text extraction.",
        "Financial year: 2025-2026",
        "Audit reference: TEST-AUDIT-2026-001",
        "Issue date: 01 September 2026",
        "Issuer: Example Audit Partners",
    ],
    "aicte_approval_letter": [
        "AICTE APPROVAL LETTER",
        "This synthetic sample approval letter is not issued by AICTE and grants no approval.",
        "Reference number: TEST-APPROVAL-2026-001",
        "Academic year: 2026-2027",
        "Issue date: 01 September 2026",
        "Issuer: FICTIONAL SAMPLE - NOT AICTE",
    ],
    "society_or_trust_registration": [
        "SOCIETY OR TRUST REGISTRATION RECORD",
        "This sample record describes a fictional educational trust registration for testing only.",
        "Registration number: TEST-TRUST-2026-001",
        "Registration date: 01 September 2026",
        "Issuer: Example Registrar of Societies",
    ],
    "affidavit": [
        "AFFIDAVIT",
        "This is a fictional affidavit-style sample for interface testing only; it is not sworn, notarized, or legally valid.",
        "Deponent: Sample Authorized Representative",
        "Execution date: 01 September 2026",
        "Reference number: TEST-AFFIDAVIT-001",
        "Issuer: FICTIONAL SAMPLE - NO NOTARIAL EFFECT",
    ],
    "collaboration_agreement": [
        "COLLABORATION AGREEMENT",
        "This fictional agreement summarizes a sample academic collaboration between Example Technical Institute and Example Partner College.",
        "Agreement reference: TEST-COLLAB-2026-001",
        "Effective date: 01 September 2026",
        "Issuer: Fictional parties - sample only",
    ],
    "land_ownership_documents": [
        "LAND OWNERSHIP RECORD",
        "This synthetic record describes fictional institutional land at Example Campus, Plot TEST-12.",
        "Record number: TEST-LAND-2026-001",
        "Record date: 01 September 2026",
        "Issuer: Example Land Records Office",
    ],
    "land_use_certificate": [
        "LAND USE CERTIFICATE",
        "This synthetic certificate describes fictional educational use of Example Campus land.",
        "Certificate number: TEST-LANDUSE-2026-001",
        "Issue date: 01 September 2026",
        "Issuer: Example Planning Office",
    ],
    "land_conversion_certificate": [
        "LAND CONVERSION CERTIFICATE",
        "This synthetic certificate describes a fictional land-use conversion for educational purposes.",
        "Certificate number: TEST-CONVERSION-2026-001",
        "Issue date: 01 September 2026",
        "Issuer: Example Planning Office",
    ],
    "khasra_plan_master_plan": [
        "KHASRA AND MASTER PLAN EXTRACT",
        "This synthetic planning extract describes fictional Plot TEST-12 at Example Campus.",
        "Map reference: TEST-MAP-2026-001",
        "Plan date: 01 September 2026",
        "Issuer: Example Planning Office",
    ],
    "encumbrance_certificate": [
        "ENCUMBRANCE CERTIFICATE",
        "This synthetic certificate describes fictional Example Campus land and sample encumbrance search details.",
        "Certificate number: TEST-ENC-2026-001",
        "Search period: 01 September 2016 to 31 August 2026",
        "Issue date: 01 September 2026",
        "Issuer: Example Land Records Office",
    ],
    "approved_building_plan_with_architect_certificate": [
        "APPROVED BUILDING PLAN AND ARCHITECT CERTIFICATE",
        "This fictional planning record describes a sample academic building plan and architect certification.",
        "Plan reference: TEST-PLAN-2026-001",
        "Issue date: 01 September 2026",
        "Architect: Sample Registered Architect",
        "Issuer: Example Municipal Planning Office",
    ],
    "noc_affiliating_university_or_state": [
        "NO OBJECTION CERTIFICATE",
        "This fictional no-objection certificate refers to a sample affiliating body and Example Technical Institute.",
        "Reference number: TEST-NOC-2026-001",
        "Issue date: 01 September 2026",
        "Issuer: Example Affiliating University",
    ],
}


def slug(value):
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def wrap_lines(text, max_chars=82):
    words = text.split()
    lines = []
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if len(candidate) > max_chars and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def make_pdf(path, application_name, slot, requirement):
    title, *details = DOCUMENT_CONTENT.get(
        slot["kind"],
        [
            slot["label"].upper(),
            f"Synthetic sample document for {slot['label']}.",
            "Reference number: TEST-DOC-2026-001",
            "Issue date: 01 September 2026",
            "Issuer: Example Test Records Office",
        ],
    )
    sample_text = MODEL_SAMPLE_TEXTS.get(slot["kind"])
    if sample_text:
        sample_lines = [
            line.encode("ascii", "replace").decode("ascii")
            for line in sample_text.splitlines()
            if line.strip()
        ]
        title, *details = sample_lines
    pdf = pymupdf.open()
    page = pdf.new_page(width=595, height=842)
    page.insert_text((38, 91), title, fontsize=18, fontname="hebo", color=(0.08, 0.16, 0.29))
    page.insert_text(
        (38, 118),
        f"Test application: {application_name}",
        fontsize=10,
        fontname="helv",
        color=(0.25, 0.31, 0.40),
    )
    page.insert_text(
        (38, 137),
        f"Checklist slot: {slot['slotId']} | Matrix: {'Required' if requirement == 'R' else 'Conditional'}",
        fontsize=9,
        fontname="helv",
        color=(0.25, 0.31, 0.40),
    )
    y = 185
    for paragraph in details:
        for line in wrap_lines(paragraph):
            page.insert_text((42, y), line, fontsize=11, fontname="helv", color=(0.12, 0.16, 0.22))
            y += 18
        y += 12
    page.draw_rect(pymupdf.Rect(36, 565, 559, 671), color=(0.75, 0.12, 0.12), width=1.5)
    page.insert_text(
        (52, 594),
        "SYNTHETIC TEST DOCUMENT - NOT OFFICIAL",
        fontsize=15,
        fontname="hebo",
        color=(0.68, 0.08, 0.08),
    )
    notice = (
        "TEST DATA ONLY. Fictional values for software testing. Not a real certificate, "
        "approval, legal record, or evidence."
    )
    for index, line in enumerate(wrap_lines(notice, 76)):
        page.insert_text(
            (52, 620 + index * 16),
            line,
            fontsize=9,
            fontname="helv",
            color=(0.45, 0.12, 0.12),
        )
    page.draw_line((38, 780), (557, 780), color=(0.80, 0.83, 0.87), width=0.8)
    page.insert_text(
        (38, 801),
        "ApprovalTrack local test fixture | Do not submit to any authority",
        fontsize=9,
        fontname="helv",
        color=(0.40, 0.45, 0.52),
    )
    pdf.set_metadata(
        {
            "title": f"TEST ONLY - {title}",
            "author": "ApprovalTrack synthetic fixture generator",
            "subject": "Fictional software test data - not official",
        }
    )
    pdf.save(path, garbage=4, deflate=True)
    pdf.close()


def generate():
    result = subprocess.run(
        ["node", "--input-type=module", "-e", CHECKLIST_SCRIPT],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    policy = json.loads(result.stdout)
    sample_path = PROJECT_ROOT / "mlmodels" / "Model1" / "m1_dataset" / "m1_test.csv"
    with sample_path.open(encoding="utf-8-sig", newline="") as sample_file:
        sample_rows = {row["doc_id"]: row["text"] for row in csv.DictReader(sample_file)}
    missing_samples = set(MODEL_SAMPLE_IDS.values()) - sample_rows.keys()
    if missing_samples:
        raise RuntimeError(f"Required synthetic M1 examples are missing: {sorted(missing_samples)}")
    global MODEL_SAMPLE_TEXTS
    MODEL_SAMPLE_TEXTS = {
        kind: sample_rows[doc_id]
        for kind, doc_id in MODEL_SAMPLE_IDS.items()
    }
    manifest = []

    for application_type in policy["APPLICATION_TYPES"]:
        application_name = APPLICATION_NAMES[application_type]
        folder = OUTPUT_ROOT / application_type
        folder.mkdir(exist_ok=True)
        folder_files = []
        for slot in policy["CHECKLIST_SLOTS"]:
            requirement = slot["requirements"].get(application_type, "-")
            if requirement not in {"R", "C"}:
                continue
            prefix = "REQUIRED" if requirement == "R" else "CONDITIONAL"
            filename = f"{prefix}_{slug(slot['slotId'])}_SYNTHETIC.pdf"
            make_pdf(folder / filename, application_name, slot, requirement)
            requirement_name = "Required" if requirement == "R" else "Conditional"
            folder_files.append((filename, slot["slotId"], requirement_name))
            manifest.append(
                {
                    "application_type": application_type,
                    "application_name": application_name,
                    "file_name": filename,
                    "slot_id": slot["slotId"],
                    "checklist_matrix": requirement,
                }
            )

        with (folder / "README.txt").open("w", encoding="utf-8", newline="\n") as readme:
            readme.write(f"{application_name} - SYNTHETIC TEST DOCUMENTS\n")
            readme.write("=" * (len(application_name) + 35) + "\n\n")
            readme.write(
                "Every PDF in this folder is fictional test data. These are not official "
                "AICTE forms, certificates, approvals, or valid evidence. Never submit "
                "them to an authority.\n\n"
            )
            readme.write(
                "How to test: choose this application type in ApprovalTrack; answer "
                "applicability questions to enable the matching conditional slots; "
                "upload the matching PDF by filename; wait for AI analysis; then inspect "
                "the extracted suggestions and validation findings.\n\n"
            )
            readme.write(
                "REQUIRED_* files correspond to unconditional Required (R) entries in "
                "the current development checklist. CONDITIONAL_* files correspond to "
                "Conditional (C) entries and are only required when the application's "
                "answers make that slot applicable. Review-required checklist entries "
                "remain subject to the application's answers.\n\n"
            )
            readme.write("Files in this folder:\n")
            for filename, slot_id, requirement_name in folder_files:
                readme.write(f"- {filename} -> {slot_id} ({requirement_name})\n")
            readme.write(
                "\nAll names, dates, organizations, references, and identifiers are "
                "invented. The current development checklist is an assumption and is "
                "not an official policy checklist.\n"
            )

    with (OUTPUT_ROOT / "manifest.csv").open("w", encoding="utf-8-sig", newline="") as manifest_file:
        writer = csv.DictWriter(
            manifest_file,
            fieldnames=[
                "application_type",
                "application_name",
                "file_name",
                "slot_id",
                "checklist_matrix",
            ],
        )
        writer.writeheader()
        writer.writerows(manifest)

    with (OUTPUT_ROOT / "README.txt").open("w", encoding="utf-8", newline="\n") as readme:
        readme.write("APPROVALTRACK SYNTHETIC TEST DOCUMENTS\n")
        readme.write("=======================================\n\n")
        readme.write(
            "This folder contains fictional, searchable PDF fixtures for testing "
            "document upload and AI analysis for all seven application types. Every "
            "PDF is prominently marked SYNTHETIC TEST DOCUMENT - NOT OFFICIAL. Do not "
            "file or rely on any of these documents.\n\n"
        )
        readme.write(
            "Open the matching application-type folder and use the PDF whose REQUIRED_ "
            "or CONDITIONAL_ filename matches the checklist slot. Each folder includes "
            "its own file-to-slot list. Conditional files are provided so you can test "
            "different applicability answers; a conditional slot is not automatically "
            "required.\n\n"
        )
        readme.write(
            "These documents test the upload/OCR/extraction path only. AI results may "
            "vary, and no document fixture guarantees a pass/fail result. AI findings "
            "do not themselves issue an official rejection. Where available, sample "
            "text follows the project's synthetic M1 test examples.\n\n"
        )
        readme.write(
            f"Generated {len(manifest)} PDFs across {len(policy['APPLICATION_TYPES'])} "
            "application types from the current backend checklist matrix. See "
            "manifest.csv for the full mapping.\n"
        )
    return len(manifest), len(policy["APPLICATION_TYPES"])


if __name__ == "__main__":
    pdf_count, application_count = generate()
    print(f"Generated {pdf_count} synthetic PDFs across {application_count} application folders in {OUTPUT_ROOT}")
