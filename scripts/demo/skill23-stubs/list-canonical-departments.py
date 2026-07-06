#!/usr/bin/env python3
"""
DEMO STUB — list-canonical-departments.py

A pinned, self-contained copy of the Skill-23 canonical department floor printer.
The real script reads ~/.openclaw/skills/23-ai-workforce-blueprint/department-naming-map.json
and prints the mandatory + universal-primary floor. The Command Center's interview
seam (src/lib/interview/seam.ts -> listCanonicalDepartments) shells this with `--json`
to render the department board and compute the decision-coverage gate.

WHY A PINNED STUB (not the real script):
  • The demo instance must never depend on the operator box's live skill tree.
  • Pinning the JSON here freezes the floor at demo-pin time, so the seeded
    department decisions and the board can never disagree about which 28
    departments exist. `qc-demo.sh` re-verifies this floor at pin time.

CONTRACT: on `--json` print the EXACT shape the real script prints
(source, naming_map_version, mandatory[], universal_primary_vertical[], floor).
Captured from naming-map version 2.6.1 (floor 28 = 22 mandatory + 6 universal-primary).

This stub performs NO writes and has NO side effects. Fictional/neutral data only.
"""
import json
import sys

CANONICAL = {
    "source": "demo:pinned-canonical-department-map",
    "naming_map_version": "2.6.1",
    "mandatory_count": 22,
    "mandatory": [
        {"id": "marketing", "display_name": "Marketing", "one_liner": "Getting the word out about your business"},
        {"id": "sales", "display_name": "Sales", "one_liner": "Turning interested people into paying customers"},
        {"id": "billing-finance", "display_name": "Billing & Finance", "one_liner": "Invoices, payments, tracking your money"},
        {"id": "customer-support", "display_name": "Customer Support", "one_liner": "Helping your existing customers when they need it"},
        {"id": "web-development", "display_name": "Web Development", "one_liner": "Your website, funnels, landing pages, SEO"},
        {"id": "app-development", "display_name": "App Development", "one_liner": "Desktop apps, mobile apps, PWAs"},
        {"id": "graphics", "display_name": "Graphics", "one_liner": "Visual content — logos, images, ads, slides"},
        {"id": "video", "display_name": "Video", "one_liner": "Video production, editing, AI video, YouTube optimization"},
        {"id": "audio", "display_name": "Audio", "one_liner": "Podcasts, voiceovers, AI voice, music, sound design"},
        {"id": "research", "display_name": "Research", "one_liner": "Market research, competitor analysis, data insights"},
        {"id": "communications", "display_name": "Communications", "one_liner": "PR, announcements, internal and external messaging"},
        {"id": "crm", "display_name": "CRM", "one_liner": "Manages your contact management, email, automations"},
        {"id": "openclaw-maintenance", "display_name": "OpenClaw Maintenance", "one_liner": "Keeps your AI system healthy and up to date"},
        {"id": "legal", "display_name": "Legal", "one_liner": "Contracts, regulations, keeping you protected"},
        {"id": "social-media", "display_name": "Social Media", "one_liner": "Organic posting and community across all platforms"},
        {"id": "paid-advertisement", "display_name": "Paid Advertisement", "one_liner": "Paid ads across every platform — search, social, audio"},
        {"id": "personal-assistant", "display_name": "Personal Assistant", "one_liner": "Inbox, scheduling, travel, personal life — the owner's right hand"},
        {"id": "general-task", "display_name": "General Task", "one_liner": "Catches any task that doesn't fit a dedicated department, so nothing is ever dropped"},
        {"id": "project-architecture-office", "display_name": "Project Architecture Office", "one_liner": "Governs every project from trigger to verifiable completion — creates PRDs, runs loops, hands off to building departments"},
        {"id": "bugs", "display_name": "Bugs", "one_liner": "The front desk and medical records for every defect: logs, triages, dedupes, and tracks every bug to verified closure"},
        {"id": "healer", "display_name": "Healer", "one_liner": "The company doctors: root-cause diagnosis, fix-forward, SOP surgery, and teachings so the same bug never happens twice"},
        {"id": "quality-control", "display_name": "Quality Control", "one_liner": "Owns and operates the system analyzer: holds every other department's roles and procedures to the standard on two axes (is it real, is it specific enough to follow) and routes the failures it finds to the Healer"},
    ],
    "universal_primary_count": 6,
    "universal_primary_vertical": [
        {"id": "presentations", "display_name": "Presentations", "one_liner": "End-to-end branded webinar/slide decks: copy, price ladder, images, QC, delivery", "pack": "personal-pro-dev"},
        {"id": "scheduling-dispatch", "display_name": "Scheduling & Dispatch", "one_liner": "Booking, routing, technician/staff scheduling", "pack": "service-industry"},
        {"id": "logistics-fulfillment", "display_name": "Logistics & Fulfillment", "one_liner": "Inventory, shipping, returns", "pack": "ecommerce"},
        {"id": "engineering", "display_name": "Software Development / Engineering", "one_liner": "Builds your software, apps & web products", "pack": "saas"},
        {"id": "account-management", "display_name": "Account Management", "one_liner": "Client relationships, deliverables, retention", "pack": "agency"},
        {"id": "podcast", "display_name": "Podcast", "one_liner": "Production, distribution, sponsor management", "pack": "content-creator"},
    ],
    "floor": 28,
    "floor_label": "22 mandatory + 6 universal-primary vertical = 28",
}


def main() -> int:
    # The seam only ever calls this with --json; support a bare call too.
    if "--json" in sys.argv or len(sys.argv) == 1:
        json.dump(CANONICAL, sys.stdout, ensure_ascii=True)
        sys.stdout.write("\n")
        return 0
    # Unknown mode — mirror the real script's non-json human summary minimally.
    sys.stdout.write(CANONICAL["floor_label"] + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
