"""Compare 28 outdoor distances with the independently operated FOSSGIS OSRM foot router.

Only public OSM building access points are sent. The routers share OSM geography.
The report compares modeled distances; it is not a timed walk or a field survey.
"""
import argparse
from datetime import datetime, timezone
import itertools
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CODES = ["CENTR", "YORK", "WLH", "EBU3B", "PETER", "SOLIS", "GH", "FAH"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--response", type=Path, help="Read a cached OSRM matrix instead of requesting it.")
    parser.add_argument("--save-response", type=Path)
    args = parser.parse_args()
    graph = json.loads((ROOT/"public/data/routes-graph.json").read_text(encoding="utf8"))
    table = json.loads((ROOT/"src/routing/distances.json").read_text(encoding="utf8"))
    coordinates = []
    for code in CODES:
        x, y = graph["nodes"][graph["buildings"][code]["node"]]
        lon = graph["origin"][0] + x/graph["scale"][0]
        lat = graph["origin"][1] - y/graph["scale"][1]
        coordinates.append(f"{lon:.6f},{lat:.6f}")
    url = "https://routing.openstreetmap.de/routed-foot/table/v1/foot/" + ";".join(coordinates) + "?annotations=distance"
    if args.response:
        response = json.loads(args.response.read_text(encoding="utf8"))
    else:
        request = urllib.request.Request(url, headers={"User-Agent":"UCSD-Campus-Planner/1.0 (pedestrian distance comparison)"})
        with urllib.request.urlopen(request, timeout=35) as handle:
            response = json.load(handle)
        if args.save_response:
            args.save_response.write_text(json.dumps(response), encoding="utf8")
    if response.get("code") != "Ok" or len(response.get("distances") or []) != len(CODES):
        raise RuntimeError("External router returned no valid distance matrix.")
    rows = []
    for i,j in itertools.combinations(range(len(CODES)), 2):
        lo,hi = sorted((table["codes"].index(CODES[i]),table["codes"].index(CODES[j])))
        own = table["walk"][hi*(hi-1)//2+lo]
        other = response["distances"][i][j]
        if own < 0 or other is None or other <= 0:
            raise RuntimeError(f"Missing independent comparison for {CODES[i]}–{CODES[j]}")
        rows.append({"from":CODES[i],"to":CODES[j],"localMeters":own,"referenceMeters":round(other),"differenceMeters":round(own-other)})
    report = {"checkedAt":datetime.now(timezone.utc).isoformat(timespec="seconds"),"graphDate":table["snapshot"],
              "method":"OSM-based network distances between the same access points, computed by two independent routing engines. Not measured walking times.",
              "reference":"https://routing.openstreetmap.de/about.html","query":url,"pairs":rows}
    (ROOT/"public/data/routes-verification.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf8")
    print(f"Compared {len(rows)} routes. Largest absolute distance difference: {max(abs(r['differenceMeters']) for r in rows)} m.")


if __name__ == "__main__":
    main()
