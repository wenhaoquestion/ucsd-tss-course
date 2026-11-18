"""Download small public OSM XML extracts to a user-specified cache."""
from pathlib import Path
import argparse
import subprocess
import time

TILES = {
    "core-west": (-117.247, 32.869, -117.233, 32.887),
    "core-east": (-117.233, 32.869, -117.215, 32.887),
    "north": (-117.247, 32.887, -117.218, 32.894),
    "south": (-117.250, 32.858, -117.218, 32.869),
    "coast": (-117.260, 32.858, -117.247, 32.889),
}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    for name, bounds in TILES.items():
        dest = args.cache / f"ucsd-osm-{name}.osm"
        if dest.exists() and dest.stat().st_size > 1000:
            continue
        partial = dest.with_suffix(".part")
        url = "https://api.openstreetmap.org/api/0.6/map?bbox=" + ",".join(map(str, bounds))
        subprocess.run(["curl", "-LfsS", "--user-agent", "UCSD-Campus-Planner/1.0",
                        "--max-time", "90", "--retry", "2", "--output", str(partial), url], check=True)
        partial.replace(dest)
        print(name, dest.stat().st_size, flush=True)
        time.sleep(1)
