"""Recheck 30 WI27 event packages against the official public schedule."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen

DATA = Path(__file__).resolve().parents[1] / "public" / "data"
URL = "https://classplanner.apps.ucsd.edu/api/v1/public/catalog/courses/search"
SAMPLES = {
    "AAS 170R": 161526, "ANTH 110": 161699, "BENG 152": 161869, "BENG 207": 161912,
    "BICD 110": 162226, "BILD 1": 162158, "CAT 2": 161456, "CHEM 6A": 162734,
    "CHEM 7L": 162822, "COGS 1": 163880, "COMM 10": 168029, "CSE 6R": 164991,
    "CSE 11": 165032, "CSE 12": 165078, "CSE 30": 165068, "CSE 100": 165248,
    "DSC 10": 166086, "ECE 35": 166381, "ECON 1": 167139, "HUM 1": 167305,
    "LIGN 8": 164542, "MATH 18": 163247, "MATH 20C": 163118, "MGT 16": 164234,
    "MMW 12": 164796, "PHIL 10": 166527, "PHYS 2A": 167163, "PSYC 1": 163966,
    "TDGE 1": 163753, "WCWP 10A": 166397,
}
DAYS = dict(zip(("M", "T", "W", "R", "F", "S", "U"), range(1, 8)))


def official_keys(codes):
    for code in codes:
        subject, digits, suffix = re.fullmatch(r"(\w+) (\d+)(\w*)", code).groups()
        yield f"{subject} {int(digits):03}{suffix}"


def read_public():
    # The catalog search accepts an array of exact course keys.
    keys = list(official_keys(SAMPLES))
    pages = []
    for i in range(0, len(keys), 8):
        body = json.dumps({"term_code": "WI27", "offset": 0, "limit": 48, "course_key": keys[i:i+8]}).encode()
        with urlopen(Request(URL, data=body, headers={"Content-Type": "application/json",
                                                      "User-Agent": "QuarterPlan-data-audit/1.0"}), timeout=40) as res:
            page = json.load(res)
        if page["total"] != len(page["courses"]) or page["term_code"] != "WI27":
            raise ValueError("Incomplete official search response")
        pages.extend(page["courses"])
    return pages


def check(source, saved, seats, package):
    sections = [s for s in source if str(package) in s["event_package_ids"]]
    expected = {s["section_id"] for s in sections}
    assert expected and expected == set(saved["sectionIds"]), "source membership differs"
    kinds = set()
    live_deltas = []
    for s in sections:
        assert s["status"] in ("AC", "waitlist_only"), "source section is inactive"
        assert s["section_code"] in saved["label"].split(" + ")
        sid = s["section_id"]
        counts = {key: s[field] for key, field in (("available", "seats_available"), ("capacity", "capacity"),
                                                   ("waitlist", "waitlist_enrolled"))}
        if seats[sid] != counts:
            live_deltas.append(sid)
        actual = set()
        for m in saved["meetings"]:
            if m["sectionId"] == sid:
                for day in m["days"] or [None]:
                    actual.add((day, m["start"], m["end"], m.get("date"), bool(m.get("remote")), m["type"]))
        wanted = set()
        for m in s["meetings"]:
            kind = m["meeting_kind"]
            kind = {"final": "FI", "midterm": "MI"}.get(kind, s["section_code"].split("-")[-1])
            kinds.add(kind)
            day = DAYS.get(m["day_code"])
            wanted.add((day, m["start_minutes"], m["end_minutes"], m["specific_date"], bool(m["is_remote"]), kind))
        assert actual == wanted, f"source time/recurrence differs for {sid}"
    assert bool(saved.get("waitlistOnly")) == any(s["status"] == "waitlist_only" for s in sections)
    avail = [seats[s]["available"] for s in expected]
    assert saved["available"] == (None if None in avail else min(avail))
    assert all(saved[k] == seats[saved["sectionId"]][k] for k in ("capacity", "waitlist"))
    flags = set(kinds)
    if saved.get("waitlistOnly"):
        flags.add("waitlist only")
    if saved["available"] == 0:
        flags.add("full")
    if any(m.get("remote") for m in saved["meetings"]):
        flags.add("remote")
    if any(m["start"] is None or not m["days"] for m in saved["meetings"]):
        flags.add("TBA")
    return {"id": saved["id"], "sections": sorted(expected), "covers": sorted(flags),
            "seatCountsChangedSinceCapture": sorted(live_deltas)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Recheck the frozen public raw catalog from data-catalog.py --cache")
    parser.add_argument("--write", action="store_true", help="Write the validation summary into the static data folder")
    args = parser.parse_args()
    source = json.loads(args.source.read_bytes())["courses"] if args.source else read_public()
    catalog = json.loads((DATA / "catalog.json").read_bytes())
    seats = json.loads((DATA / "seats.json").read_bytes())["seats"]
    by_code = {c["code"]: c for c in catalog["courses"]}
    by_key = defaultdict(list)
    for raw in source:
        by_key[raw["module_code"].replace("-", " ")].extend(raw["sections"])
    cases = []
    for (code, pkg), key in zip(SAMPLES.items(), official_keys(SAMPLES)):
        saved = next(o for o in by_code[code]["options"] if o["id"] == f"WI27:{pkg}")
        cases.append({"course": code, **check(by_key[key], saved, seats, pkg)})
    report = {"term": "WI27", "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "catalogObservedAt": catalog["observedAt"], "source": URL,
              "reference": "public snapshot" if args.source else "fresh public search",
              "statusesSeenInSource": dict(Counter(s["status"] for c in source for s in c["sections"])),
              "cancelledCase": "No cancelled section in source" if all(
                  s["status"] in {"AC", "waitlist_only"} for c in source for s in c["sections"]) else "See source statuses",
              "cases": cases}
    print(f"{len(cases)} matching packages; {sum(len(c['sections']) for c in cases)} membership checks; "
          f"{sum(len(c['seatCountsChangedSinceCapture']) for c in cases)} later seat-count changes")
    if args.write:
        (DATA / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
