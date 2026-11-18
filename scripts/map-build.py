"""Build the pedestrian graph and building distance tables from map-fetch.py's OSM extracts."""
import argparse
import heapq
import json
import math
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

# Registrar codes matched by building names against OSM. r-prefixed IDs are relations.
# Ambiguous complexes are omitted until the actual building can be identified.
BUILDINGS = {
    "APM":"31819246","ASANT":"628638100","BIO":"31839879","BONN":"295155737",
    "BRF2":"103615500","BSB":"31842565","CALIT":"38561159","CENTR":"31816858",
    "CMME":"31818522","CMRR":"31817156","COA":"1274990079","CPMC":"r15074291",
    "CSB":"31818271","CSC":"31819178","CTL":"893580776","DANCE":"31816001",
    "DIB":"768694090","EBU1":"31818824","EBU3B":"38561158","ECKRT":"31816846",
    "FAH":"918376054","GEISEL":"159385495","GH":"31842038","GREAT":"31842034",
    "HSS":"31816208","HUBBS":"31816189","HYDRO":"31840902","JEANN":"911401512",
    "LASB":"31817670","LFFB":"31819120","MALK":"1274990078","MANDE":"31816297",
    "MAYER":"295142027","MCGIL":"295155740","MET":"130101300","MNDLR":"295155741",
    "MOS":"911401513","MTF":"31840070","MWEIS":"31819876","NIERN":"31842334",
    "NSB":"295142031","OTRSN":"r15054706","PACIF":"31818239","PCYNH":"r2076105",
    "PETER":"31807101","PFBH":"31816451","PODEM":"1078326952","POTKR":"335148528",
    "PRICE":"31819709","PSB":"103615499","RECGM":"31842194","RITTR":"31817642",
    "RVCOM":"295142030","RWAC":"r13272759","SCRB":"r15068156","SCRM":"289500542",
    "SDSC":"r4736608","SERF":"31818367","SME":"275171539","SOLIS":"31816958",
    "SPIES":"31817925","SSRB":"31841883","STCTR":"139958506","SUMNR":"379795787",
    "TAMRK":"334733487","TATA":"821246683","UREY":"31818876","VAUGN":"31815979",
    "WFH":"r15054707","WLH":"31844605","WSAC":"31808533","YORK":"31816207",
}
ORIGIN = [-117.24, 32.88]
SCALE = [111320 * math.cos(math.radians(ORIGIN[1])), 111195]
ROOT = Path(__file__).resolve().parents[1]
PEDESTRIAN = {"footway", "pedestrian", "steps", "path", "living_street", "service", "residential", "unclassified"}
DENIED = {"private", "no", "customers", "military", "delivery"}


def tags(element):
    return {v.get("k"): v.get("v") for v in element.findall("tag")}


def foot_allowed(t):
    kind = t.get("highway")
    # A mapped pedestrian plaza provides walkable perimeter edges (e.g. Revelle
    # Plaza). Never create diagonal shortcuts across areas or building polygons.
    if not kind or (t.get("area") == "yes" and kind != "pedestrian") or t.get("indoor") == "yes" or "access:conditional" in t or "foot:conditional" in t:
        return False
    if t.get("foot", t.get("access", "yes")) in DENIED or t.get("construction") or t.get("access") in {"emergency", "permit"}:
        return False
    if kind in PEDESTRIAN:
        return True
    return kind in {"cycleway", "tertiary", "secondary"} and t.get("foot") in {"yes", "designated", "permissive"}


def reachable(adjacency, start):
    visited, stack = {start}, [start]
    while stack:
        for target in adjacency[stack.pop()]:
            if target not in visited:
                visited.add(target)
                stack.append(target)
    return visited


def distances(adjacency, source, avoid_stairs):
    best, heap = {source: 0}, [(0, source)]
    while heap:
        current, node = heapq.heappop(heap)
        if current != best[node]:
            continue
        for target, (length, stairs) in adjacency[node].items():
            cost = current + length
            if (not avoid_stairs or not stairs) and cost < best.get(target, math.inf):
                best[target] = cost
                heapq.heappush(heap, (cost, target))
    return best


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8")


def build(cache, snapshot):
    nodes, ways, relations = {}, {}, {}
    for f in sorted(cache.glob("ucsd-osm-*.osm")):
        root = ET.parse(f).getroot()
        for n in root.findall("node"):
            x = (float(n.get("lon")) - ORIGIN[0]) * SCALE[0]
            y = (ORIGIN[1] - float(n.get("lat"))) * SCALE[1]
            nodes[int(n.get("id"))] = ((x, y), tags(n))
        for w in root.findall("way"):
            ways[w.get("id")] = ([int(n.get("ref")) for n in w.findall("nd")], tags(w))
        for rel in root.findall("relation"):
            rings = [m.get("ref") for m in rel.findall("member") if m.get("type") == "way" and m.get("role") == "outer"]
            relations[rel.get("id")] = rings, tags(rel)
    if not ways:
        raise ValueError("No OSM extracts; run map-fetch.py first.")
    net = defaultdict(dict)
    for path, t in ways.values():
        if not foot_allowed(t):
            continue
        unfit = t.get("highway") == "steps" or t.get("wheelchair") == "no" or t.get("smoothness") in {"horrible", "very_horrible", "impassable"}
        for a, b in zip(path, path[1:]):
            if a == b or a not in nodes or b not in nodes:
                continue
            ends = [nodes[a][1], nodes[b][1]]
            if any(s.get("foot", s.get("access")) in DENIED or s.get("locked") == "yes" or s.get("barrier") in {"wall", "fence", "retaining_wall", "hedge"} for s in ends):
                continue
            blocked = unfit or any(s.get("wheelchair") == "no" or s.get("barrier") in {"turnstile", "stile", "kissing_gate"} for s in ends)
            # Edge lengths use decimetres. The renderer can round coordinates independently.
            length = max(1, round(math.dist(nodes[a][0], nodes[b][0]) * 10))
            old = net[a].get(b)
            value = (length, min(int(blocked),old[1])) if old else (length, int(blocked))
            net[a][b] = net[b][a] = value
    left, largest = set(net), set()
    while left:
        component = reachable(net, next(iter(left)))
        left -= component
        if len(component) > len(largest):
            largest = component
    all_ids = sorted(largest)
    idx = {n: i for i,n in enumerate(all_ids)}
    geo = [[round(v, 1) for v in nodes[n][0]] for n in all_ids]
    graph = [[(idx[b], length, stairs) for b,(length,stairs) in net[a].items()] for a in all_ids]
    edges = [[i,b,lg,st] for i,adj in enumerate(graph) for b,lg,st in adj if i<b]
    # Match doors only if the tagged OSM vertex itself joins the walking graph.
    # Otherwise choose a mapped walkway immediately by the footprint; this is labelled separately.
    buildings, outlines, anchorids = {}, [], []
    for code, key in sorted(BUILDINGS.items()):
        if key.startswith("r"):
            members, t = relations[key[1:]]
            rings = [ways[w][0] for w in members if w in ways]
        else:
            ring, t = ways[key]
            rings = [ring]
        boundary = {n for ring in rings for n in ring if n in nodes}
        if not boundary:
            continue
        xy = [nodes[n][0] for n in boundary]
        cx, cy = (sum(v[i] for v in xy) / len(xy) for i in range(2))
        doors = [n for n in sorted(boundary & largest) if nodes[n][1].get("entrance") in {"yes","main","public"} and nodes[n][1].get("access") not in DENIED]
        if doors:
            chosen = min(doors, key=lambda n:(nodes[n][1].get("entrance") != "main", math.dist(nodes[n][0],(cx,cy))))
            quality = "entrance"
        else:
            xmin, xmax = min(x for x,y in xy)-28, max(x for x,y in xy)+28
            ymin, ymax = min(y for x,y in xy)-28, max(y for x,y in xy)+28
            near = [n for n in all_ids if xmin <= nodes[n][0][0] <= xmax and ymin <= nodes[n][0][1] <= ymax]
            if not near:
                continue
            # Prefer the walkway closest to the outline; break ties using the centre.
            def distance_key(n):
                point = nodes[n][0]
                return min(math.dist(point,v) for v in xy), math.dist(point,(cx,cy))
            chosen = min(near, key=distance_key)
            if distance_key(chosen)[0] > 28:
                continue
            quality = "nearby"
        ix = idx[chosen]
        anchorids.append(chosen)
        buildings[code] = {"name":t["name"],"node":ix,"anchor":quality,"osm":("relation/"+key[1:] if key.startswith("r") else "way/"+key)}
        for ring in rings:
            outline = [[round(v) for v in nodes[n][0]] for n in ring if n in nodes]
            if len(outline) >= 3:
                outlines.append(outline)
    tables = []
    for no_steps in (False, True):
        matrix = []
        for i, start in enumerate(anchorids):
            best = distances(net, start, no_steps)
            matrix.extend((best[end]+5)//10 if end in best else -1 for end in anchorids[:i])
        tables.append(matrix)
    meta = {"snapshot":snapshot,"codes":list(buildings),"walk":tables[0],"avoidSteps":tables[1]}
    dump(ROOT/"src/routing/distances.json", meta)
    public = {"snapshot":snapshot,"attribution":"© OpenStreetMap contributors",
              "license":"https://opendatacommons.org/licenses/odbl/1-0/","origin":ORIGIN,
              "scale":SCALE,"nodes":geo,"edges":edges,"buildings":buildings,"outlines":outlines}
    dump(ROOT/"public/data/routes-graph.json", public)
    print(f"{len(buildings)} buildings; {len(geo)} pedestrians' graph nodes; {len(edges)} edges; {sum(b['anchor']=='entrance' for b in buildings.values())} tagged entrances")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("cache", type=Path)
    p.add_argument("--snapshot", required=True, help="Date the OSM extracts were fetched (UTC, YYYY-MM-DD).")
    args = p.parse_args()
    build(args.cache, args.snapshot)
