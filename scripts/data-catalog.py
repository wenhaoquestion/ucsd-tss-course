"""Build a static WI27 catalog from UCSD's public Schedule of Classes."""
import argparse
import csv
import io
import json
import re
import time
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

DATA = Path(__file__).resolve().parents[1] / "public" / "data"
TERM = "WI27"
PUBLIC_SEARCH = "https://classplanner.apps.ucsd.edu/api/v1/public/catalog/courses/search"
SOURCE = "https://classplanner.apps.ucsd.edu/search"
TSSPLUS = "https://tssplusplus-api.onrender.com/api/courses/"
TSSPLUS_REV = "69f67dfaac8f89615266d67c891ceef02098fb01"
TSSPLUS_RAW = f"https://raw.githubusercontent.com/alchin2/tssplusplus/{TSSPLUS_REV}/"
ROOM_ARCHIVE = "68de978591a6d80814fc9592f8ec9c9edf150d20"
CLASSROOMS_REV = "30608ac0030af314692193400a89f4247726ad89"
CLASSROOMS_RAW = f"https://raw.githubusercontent.com/wenhaoquestion/ucsd-classrooms/{CLASSROOMS_REV}/"
STARTER = ("CSE 11", "CSE 12", "CSE 100", "MATH 18", "MATH 20C", "COGS 1",
           "BILD 1", "CHEM 6A", "PSYC 1", "PHYS 2A", "DSC 10", "ECON 1")
DAYS = {"monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4,
        "friday": 5, "saturday": 6, "sunday": 7}
DAY_TOKENS = {"M": 1, "TU": 2, "T": 2, "W": 3, "TH": 4, "R": 4,
              "F": 5, "SA": 6, "S": 6, "SU": 7, "SUN": 7, "SAT": 6}


def get(url, payload=None, timeout=40):
    body = json.dumps(payload).encode() if payload is not None else None
    req = Request(url, data=body, headers={"User-Agent": "UCSD-offline-planner/1.0",
                                            "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=timeout) as response:
                return response.read()
        except (TimeoutError, HTTPError, URLError) as error:
            if (isinstance(error, HTTPError) and error.code < 500 and error.code != 429) or attempt == 2:
                raise
            time.sleep(2 ** attempt)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    temp.replace(path)


def clean_code(value):
    value = re.sub(r"(?<=[A-Z])-(?=\d)", " ", value.strip().upper())
    return re.sub(r"\b0+(?=\d)", "", value)


def read_catalog():
    courses = []
    total = None
    while total is None or len(courses) < total:
        page = json.loads(get(PUBLIC_SEARCH, {"term_code": TERM, "offset": len(courses), "limit": 48}))
        if page.get("term_code") != TERM or not page.get("courses"):
            raise ValueError("Incomplete official catalog page")
        total = page["total"] if total is None else total
        if page["total"] != total:
            raise ValueError("Catalog changed while paging; rerun")
        courses.extend(page["courses"])
        time.sleep(0.15)
    if len(courses) != total:
        raise ValueError(f"Catalog pagination returned {len(courses)} of {total} offerings")
    return courses


def clock_minutes(clock):
    moment = datetime.strptime(clock.upper(), "%I:%M %p")
    return moment.hour * 60 + moment.minute


def campus_codes(by_name, campus):
    aliases = {k.casefold(): v["abbr"] for k, v in by_name.items() if v.get("abbr")}
    for college in campus["colleges"].values():
        for code, data in college.items():
            if data.get("name"):
                name = data["name"].casefold()
                aliases[name] = code
                aliases.setdefault(name + " building", code)
    return aliases


def archived_courses():
    url = f"https://codeload.github.com/SahirSSharma/WebReg/zip/{ROOM_ARCHIVE}"
    courses = []
    with zipfile.ZipFile(io.BytesIO(get(url, timeout=90))) as archive:
        for filename in sorted(archive.namelist()):
            if re.fullmatch(r"[^/]+/data/parsed/WI27/[A-Z0-9]+\.json", filename):
                courses.extend(json.loads(archive.read(filename)))
        license_data = archive.read(f"WebReg-{ROOM_ARCHIVE}/LICENSE")
        (DATA / "webreg-course-data-LICENSE.txt").write_bytes(license_data)
    if not courses:
        raise ValueError("WI27 room archive was empty")
    return courses


def archived_rooms(course, aliases):
    groups = defaultdict(list)
    for row in course["sections"]:
        if not row.get("cancelled"):
            groups[row["group"]].append(row)
    candidates = defaultdict(set)
    for rows in groups.values():
        packages = {str(row["section_id"]) for row in rows if row["section_id"] and row.get("enrollable")}
        for row in rows:
            building = row.get("building", "").strip()
            if not building or building in {"RCLAS", "TBA"} or not row.get("room"):
                continue
            if not row["time_start"] or not row["time_end"]:
                continue
            start, end = (clock_minutes(v[:-1] + " " + v[-1] + "m") for v in (row["time_start"], row["time_end"]))
            date = ""
            if re.fullmatch(r"\d{2}/\d{2}/\d{4}", row["code"]):
                stamp = datetime.strptime(row["code"], "%m/%d/%Y")
                date, days = stamp.date().isoformat(), [stamp.isoweekday()]
            else:
                tokens = re.findall("Tu|Th|Sa|Su|M|T|W|R|F|S", row["days"])
                days = [DAY_TOKENS[t.upper()] for t in tokens] if "".join(tokens) == row["days"] else []
            members = {str(row["section_id"])} if row["section_id"] else packages
            for pkg in members:
                for day in days:
                    key = pkg, row["type"], date, day, start, end
                    candidates[key].add((aliases.get(building.casefold(), building), row["room"].strip()))
    return {key: next(iter(matches)) for key, matches in candidates.items() if len(matches) == 1}


def rooms_for(detail, building_codes):
    rooms, links, labels = {}, {}, {}
    pattern = re.compile(r"(?P<days>.*?)\s+(?P<start>\d{1,2}:\d{2}\s+[AP]M)\s*-\s*"
                         r"(?P<end>\d{1,2}:\d{2}\s+[AP]M).*?\s@\s*(?P<location>.+)", re.I)
    for package in detail.get("sections", []):
        pkg = str(package["event_pkg_objid"])
        if re.fullmatch(r"[A-Z]-\d{3}-\d{3}", package.get("section_code") or ""):
            labels[pkg] = package["section_code"]
        url = package.get("book_url") or ""
        parsed = urlparse(url)
        if parsed.scheme == "https" and parsed.netloc == "tss.ucsd.edu" and parsed.path == "/fiori":
            links[pkg] = url
        for event in package.get("meetings", []):
            event_id = str(event.get("event_objid", "")).lstrip("0")
            for line in (event.get("sched") or "").splitlines():
                match = pattern.fullmatch(line.strip())
                if not match:
                    continue
                value = match.group("location").strip()
                building, sep, room = value.rpartition(" Room ")
                if not sep or not room.strip():
                    continue
                code = building_codes.get(building.strip().casefold(), building.strip())
                date_match = re.search(r"\b(\d{1,2}/\d{1,2}/\d{4})\b", match["days"])
                date, days = "", []
                if date_match:
                    date_obj = datetime.strptime(date_match[1], "%m/%d/%Y")
                    date, days = date_obj.date().isoformat(), [date_obj.isoweekday()]
                else:
                    tokens = [d.strip().upper() for d in match["days"].split(",")]
                    if all(token in DAY_TOKENS for token in tokens):
                        days = [DAY_TOKENS[token] for token in tokens]
                for day in days:
                    key = (pkg, event_id, date, day, clock_minutes(match["start"]), clock_minutes(match["end"]))
                    rooms[key] = code, room.strip()
    return rooms, links, labels


def meeting_rows(section, pkg, rooms, archive):
    grouped = {}
    for m in section.get("meetings") or []:
        day = DAYS.get((m.get("day_name") or "").lower())
        sem = m.get("meeting_kind") or "class"
        typ = {"final": "FI", "midterm": "MI"}.get(sem, section["section_code"].rsplit("-", 1)[-1])
        start, end = m.get("start_minutes"), m.get("end_minutes")
        date = m.get("specific_date")
        event = section["section_id"].split()[-1].lstrip("0")
        remote = bool(m.get("is_remote"))
        location = archive.get((pkg, typ, date or "", day, start, end), ("", ""))
        building, room = ("RCLAS", "") if remote else rooms.get((pkg, event, date or "", day, start, end), location)
        key = (typ, start, end, building, room, date, remote)
        if key not in grouped:
            grouped[key] = {"type": typ, "days": [], "start": start, "end": end,
                            "building": building, "room": room, "sectionId": section["section_id"]}
            if date:
                grouped[key]["date"] = date
            if remote:
                grouped[key]["remote"] = True
        if day and day not in grouped[key]["days"]:
            grouped[key]["days"].append(day)
    for entry in grouped.values():
        entry["days"].sort()
    return list(grouped.values())


def convert(course, rooms, links, labels, archive):
    packages = defaultdict(list)
    for sec in course.get("sections") or []:
        if sec.get("status") not in ("AC", "waitlist_only"):
            continue
        for pkg in sec.get("event_package_ids") or []:
            packages[str(pkg)].append(sec)
    options = []
    # Some common lectures list packages whose discussion has disappeared.
    # Resolve these only when the complete membership count confirms the result.
    if len(packages) > course["complete_package_count"]:
        members = {p: {s["section_id"] for s in ss} for p, ss in packages.items()}
        complete = {p: ss for p, ss in packages.items() if not any(members[p] < other for other in members.values())}
        if len(complete) != course["complete_package_count"]:
            raise ValueError(f"Cannot reconcile package membership for {course['module_code']}")
        packages = complete
    for pkg, sections in sorted(packages.items()):
        preferred = min(sections, key=lambda s: (len(s.get("event_package_ids") or []),
                                                  s["section_code"].split("-")[1] == "000",
                                                  s["section_code"]))
        meetings = [m for s in sections for m in meeting_rows(s, pkg, rooms, archive)]
        available = [s.get("seats_available") for s in sections]
        instructors = list(dict.fromkeys(n for s in sections for n in s.get("instructors") or []))
        option = {"id": f"{TERM}:{pkg}", "label": " + ".join(s["section_code"] for s in sections),
                  "instructor": ", ".join(instructors), "sectionId": preferred["section_id"],
                  "sectionIds": [s["section_id"] for s in sections], "meetings": meetings,
                  "available": min(available) if available and None not in available else None,
                  "capacity": preferred.get("capacity"), "waitlist": preferred.get("waitlist_enrolled")}
        if pkg in links:
            option["tssUrl"] = links[pkg]
        if pkg in labels:
            option["packageCode"] = labels[pkg]
        if any(s.get("status") == "waitlist_only" for s in sections):
            option["waitlistOnly"] = True
        options.append(option)
    result = {"code": clean_code(course["module_code"]), "title": course.get("course_title") or course["module_name"],
              "units": course.get("units_display") or "", "instructors": course.get("instructors") or [], "options": options}
    if course.get("restrictions"):
        result["restrictions"] = " · ".join(course["restrictions"])
    if course.get("prerequisites"):
        result["prerequisites"] = " · ".join(course["prerequisites"])
    return result


def run():
    args = argparse.ArgumentParser()
    args.add_argument("--cache", type=Path, help="Cache public UCSD pages and secondary room records during a build")
    p = args.parse_args()

    def cached(name, fetch):
        if not p.cache:
            return fetch()
        path = p.cache / name
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        data = fetch()
        write_json(path, data)
        return data

    def snapshot():
        courses = read_catalog()
        return {"courses": courses, "observedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    raw = cached("catalog.json", snapshot)
    DATA.mkdir(parents=True, exist_ok=True)
    by_name = json.loads(get(TSSPLUS_RAW + "data/buildings.json"))["buildings"]
    campus = json.loads(get(CLASSROOMS_RAW + "src/lib/buildings.json"))
    buildings = campus_codes(by_name, campus)
    archive = defaultdict(dict)
    for course in cached("webreg-" + ROOM_ARCHIVE + ".json", archived_courses):
        code = clean_code(course["subject"] + " " + course["number"])
        archive[code].update(archived_rooms(course, buildings))
    for owner, url in (("tssplusplus", TSSPLUS_RAW), ("classroom-codes", CLASSROOMS_RAW)):
        (DATA / f"{owner}-LICENSE.txt").write_bytes(get(url + "LICENSE"))
    ids = {clean_code(row["code"]): row["module_id"] for row in
           csv.DictReader(io.StringIO(get(TSSPLUS_RAW + "data/offered/wi27.csv").decode("utf-8-sig")))}
    annotations = {}
    for code in STARTER:
        if code in ids:
            module = ids[code]
            detail = cached(f"room-{module}.json", lambda: json.loads(get(f"{TSSPLUS}{module}?term=wi27")))
            if clean_code(detail["code"]).split("/")[0] == code:
                annotations[code] = rooms_for(detail, buildings)
    # Topic offerings can have the same catalog number. Keep each schedulable
    # package; a topic's subtitle belongs to its package when grouped.
    by_code = {}
    for offering in raw["courses"]:
        code = clean_code(offering["module_code"])
        c = convert(offering, *annotations.get(code, ({}, {}, {})), archive[code])
        prior = by_code.get(c["code"])
        if prior is None:
            by_code[c["code"]] = c
            continue
        previous_ids = {o["id"] for o in prior["options"]}
        if prior["title"] != c["title"]:
            for o in prior["options"]:
                o.setdefault("topic", prior["title"])
            for o in c["options"]:
                o["topic"] = c["title"]
        prior["options"].extend(o for o in c["options"] if o["id"] not in previous_ids)
        prior["instructors"] = list(dict.fromkeys(prior["instructors"] + c["instructors"]))
    courses = list(by_code.values())
    catalog = {"term": TERM, "source": SOURCE, "observedAt": raw["observedAt"], "courses": courses}
    write_json(DATA / "catalog.json", catalog)
    seats = {s["section_id"]: {"available": s.get("seats_available"), "capacity": s.get("capacity"),
                               "waitlist": s.get("waitlist_enrolled")}
             for c in raw["courses"] for s in c.get("sections") or []}
    write_json(DATA / "seats.json", {"term": TERM, "observedAt": raw["observedAt"], "seats": seats})
    starter = [c for code in STARTER for c in courses if c["code"] == code]
    write_json(DATA / "starter.json", {**catalog, "courses": starter})
    print(f"{len(courses)} official courses, {sum(len(c['options']) for c in courses)} packages; "
          f"{len(starter)} starter courses; observed {catalog['observedAt']}", flush=True)


if __name__ == "__main__":
    run()
