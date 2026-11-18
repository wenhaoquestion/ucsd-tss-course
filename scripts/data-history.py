"""Generate per-subject grade and seat history from pinned, public MIT archives."""
import argparse
import csv
import io
import json
import re
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

OUT = Path(__file__).resolve().parents[1] / "public" / "data"
ORG = "UCSD-Historical-Enrollment-Data"
RAW = f"https://raw.githubusercontent.com/{ORG}"
CAPE = "d9348e4ba62350254dd6bea7e81aee3baf8f69cd"
TERMS = [
    ("WI25", "2025Winter", "f69f79a44fc4728e69af848acf88aed4371abac9", "2024-11-12"),
    ("WI24", "2024Winter", "cdcbac11eb59bbbb71a71cae20f04a067e842501", "2023-11-14"),
]
OFFSETS = (-1, 0, 1, 2, 3, 5, 7, 8, 10, 12, 16, 23)
FEATURED = ("CSE 11", "CSE 12", "CSE 100", "MATH 18", "MATH 20C", "COGS 1",
            "BILD 1", "CHEM 6A", "PSYC 1", "PHYS 2A", "DSC 10", "ECON 1")


def download(url, byte_range=False):
    headers = {"User-Agent": "UCSD-offline-planner/1.0"}
    if byte_range:
        headers["Range"] = "bytes=0-1048575"
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=35) as response:
                if byte_range:
                    # A school's first sampling sweep fits in 1 MiB. Discard a cut
                    # final CSV row; use exact Unix observation times on every row.
                    return response.read(1048576).rsplit(b"\n", 1)[0]
                return response.read()
        except (TimeoutError, URLError) as error:
            if (isinstance(error, HTTPError) and error.code < 500 and error.code != 429) or attempt == 2:
                raise
            time.sleep(2 ** attempt)


def lines(content):
    return io.StringIO(content.decode("utf-8-sig"))


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_suffix(path.suffix + ".tmp")
    staging.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    staging.replace(path)


def number(field):
    try:
        value = float(field)
        if value >= 0:
            return int(value) if value.is_integer() else value
    except (ValueError, TypeError):
        pass
    return None


def shards(kind, records):
    subjects = defaultdict(dict)
    for code, rows in sorted(records.items()):
        subject = code.split()[0]
        if not re.fullmatch(r"[A-Z][A-Z0-9]*", subject):
            raise ValueError(f"Unexpected subject: {subject}")
        subjects[subject][code] = rows
    for subject, data in subjects.items():
        dump(OUT / kind / f"{subject}.json", data)
    dump(OUT / kind / "index.json", sorted(subjects))
    return len(subjects)


def grades():
    rows = defaultdict(list)
    by_instructor = defaultdict(set)
    for item in csv.DictReader(lines(download(f"{RAW}/UCSDHistEnrollData/{CAPE}/data/CAPEs.tsv")), delimiter="\t"):
        course = " ".join(item["sub_course"].upper().split())
        if not course:
            continue
        if item["instructor"].strip():
            by_instructor[item["instructor"].strip()].add(course)
        rows[course].append({
            "instructor": item["instructor"].strip(), "term": item["term"],
            "actual": number(item["avg_grade_rec"]), "expected": number(item["avg_grade_exp"]),
            "hours": number(item["study_hr_wk"]), "responses": number(item["evals_made"]),
            "recommend": number(item["rcmd_instr"]), "recommendCourse": number(item["rcmd_class"]),
            "enrolled": number(item["enroll"]),
        })
    count = sum(len(records) for records in rows.values())
    if count != 61791:
        raise ValueError(f"Unexpected CAPE row count {count}")
    print(f"CAPE: {count} records; {len(rows)} course labels; {shards('grades', rows)} subjects", flush=True)
    dump(OUT / "grades" / "instructors.json", {name: sorted(codes) for name, codes in sorted(by_instructor.items())})
    (OUT / "historical-data-LICENSE.txt").write_bytes(download(f"{RAW}/UCSDHistEnrollData/{CAPE}/LICENSE"))


def sample_raw(url):
    rows, encountered = {}, set()
    for item in csv.DictReader(lines(download(url, True))):
        sid = (item["subj_course_id"].strip(), item["sec_code"].strip(), item["sec_id"].strip())
        if sid in encountered:
            break
        encountered.add(sid)
        course, section, _ = sid
        if not course or not section:
            continue
        point = {"at": datetime.fromtimestamp(int(item["time"])/1000, timezone.utc).isoformat(timespec="seconds"),
                 "available": number(item["available"]), "capacity": number(item["total"]),
                 "waitlist": number(item["waitlist"])}
        rows[course, section] = point
    return rows


def sample_course(url):
    sampled = {}
    try:
        file = download(url)
    except HTTPError as error:
        if error.code == 404:
            return []
        raise
    # The included winter enrollment and drop periods both lie entirely in PST.
    for row in csv.DictReader(lines(file)):
        stamp = datetime.fromisoformat(row["time"])
        if stamp.month not in (11, 12, 1, 2):
            continue
        key = (stamp.date(), stamp.hour // 12)
        if key not in sampled:
            sampled[key] = {"at": stamp.replace(tzinfo=timezone(-timedelta(hours=8))).isoformat(timespec="seconds"),
                            "available": number(row["available"]), "capacity": number(row["total"]),
                            "waitlist": number(row["waitlisted"])}
    return list(sampled.values())


def history():
    courses = defaultdict(list)
    for term, repo, commit, first_pass in TERMS:
        manifest = json.loads(download(f"https://api.github.com/repos/{ORG}/{repo}/contents/raw?ref={commit}"))
        select = {(date.fromisoformat(first_pass) + timedelta(days=offset)).isoformat() for offset in OFFSETS}
        files = sorted(obj["name"] for obj in manifest if obj["name"][11:21] in select and obj["name"].endswith(".csv"))
        if len(files) < 5:
            raise ValueError(f"Archive {term} lacks enough dates")
        base = f"{RAW}/{repo}/{commit}"
        with ThreadPoolExecutor(max_workers=3) as pool:
            samples = pool.map(sample_raw, (f"{base}/raw/{quote(name)}" for name in files))
            collected = defaultdict(list)
            for results in samples:
                for key, point in results.items():
                    collected[key].append(point)
            totals = list(pool.map(sample_course, (f"{base}/overall/{quote(code)}.csv" for code in FEATURED)))
        first = f"{first_pass}T08:00:00-08:00"
        for code, aggregate in zip(FEATURED, totals):
            if aggregate:
                courses[code].append({"term": term, "section": None, "firstPass": first, "points": aggregate})
        for (code, section), points in sorted(collected.items()):
            courses[code].append({"term": term, "section": section, "firstPass": first,
                                  "points": sorted(points, key=lambda p: p["at"])})
        print(f"{term}: {len(files)} raw sample dates; {len(collected)} course sections", flush=True)
    print(f"History: {len(courses)} courses; {shards('history', courses)} subjects", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", choices=("all", "grades", "history"), nargs="?", default="all")
    selected = parser.parse_args().dataset
    if selected in {"all", "grades"}:
        grades()
    if selected in {"all", "history"}:
        history()
