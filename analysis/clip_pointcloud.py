# analysis/clip_pointcloud.py
"""
Person 2: Tile Fetch + Clip (Brookline)

Input:
- data/brookline/processed/candidates_buffer.geojson  (WGS84 polygons, candidate_id)
- data/brookline/processed/candidate_tiles.json       (candidate_id -> list of tile urls)

Output:
- data/brookline/roi/roi_points_<CAND_ID>.npz         (x,y,z (+ optional intensity/rgb))

Notes:
- Brookline LAZ tiles use projected meters. We assume EPSG:32619 (UTM Zone 19N).
- We transform candidate polygons from EPSG:4326 -> EPSG:32619, then clip LAZ points in that CRS.
- Tiles are downloaded lazily and cached in data/brookline/pointcloud_tiles/.
"""

import argparse
import json
from pathlib import Path
from typing import Dict, List, Tuple, Optional

import numpy as np
import geopandas as gpd
import requests
import laspy

from shapely import points, contains


DEFAULT_CANDIDATES = Path("data/brookline/processed/candidates_buffer.geojson")
DEFAULT_TILES_JSON = Path("data/brookline/processed/candidate_tiles.json")
DEFAULT_TILE_CACHE = Path("data/brookline/pointcloud_tiles")
DEFAULT_OUT_DIR = Path("data/brookline/roi")


def load_candidate_polygon_utm(
    candidate_buffers_path: Path, candidate_id: str, utm_epsg: int = 32619
):
    """Load candidate polygon from GeoJSON (EPSG:4326) and convert to UTM meters (EPSG:32619)."""
    gdf = gpd.read_file(candidate_buffers_path)

    # candidates_buffer.geojson uses CRS84 (lon/lat). Treat it as EPSG:4326.
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326", allow_override=True)
    else:
        gdf = gdf.to_crs("EPSG:4326")

    row = gdf[gdf["candidate_id"] == candidate_id]
    if row.empty:
        raise ValueError(f"candidate_id not found: {candidate_id}")
    if len(row) > 1:
        raise ValueError(f"candidate_id not unique: {candidate_id}")

    # Convert polygon to UTM meters
    row_utm = row.to_crs(f"EPSG:{utm_epsg}")
    geom = row_utm.iloc[0].geometry
    if geom is None:
        raise ValueError(f"No geometry for candidate_id={candidate_id}")
    return geom


def load_candidate_tiles(tiles_json_path: Path) -> Dict[str, List[Dict]]:
    """Load candidate_tiles.json mapping candidate_id -> list of tiles (filename/download_url/potree_url)."""
    with tiles_json_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    mapping: Dict[str, List[Dict]] = {}
    for item in data:
        mapping[item["candidate_id"]] = item.get("tiles", [])
    return mapping


def current_cache_size_bytes(tile_cache: Path) -> int:
    if not tile_cache.exists():
        return 0
    total = 0
    for p in tile_cache.glob("*.laz"):
        try:
            total += p.stat().st_size
        except FileNotFoundError:
            pass
    for p in tile_cache.glob("*.las"):
        try:
            total += p.stat().st_size
        except FileNotFoundError:
            pass
    return total


def download_with_cache(
    url: str,
    out_path: Path,
    *,
    no_download: bool,
    max_download_bytes: int,
    tile_cache: Path,
) -> Optional[Path]:
    """
    Download URL to out_path if not already present.
    Returns Path if available, or None if skipped (no-download or budget exceeded).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.exists() and out_path.stat().st_size > 0:
        print(f"✅ Using cached tile: {out_path.name} ({out_path.stat().st_size/1e6:.1f} MB)")
        return out_path

    if no_download:
        print(f"⏭️  Skipping (not cached, --no-download): {out_path.name}")
        return None

    # Budget guard (approximate): if cache already exceeds limit, skip
    cache_bytes = current_cache_size_bytes(tile_cache)
    if cache_bytes >= max_download_bytes:
        print(
            f"⏭️  Skipping download (cache budget reached {cache_bytes/1e9:.2f} GB >= {max_download_bytes/1e9:.2f} GB): "
            f"{out_path.name}"
        )
        return None

    print(f"⬇️  Downloading {url}")
    with requests.get(url, stream=True, timeout=180) as r:
        r.raise_for_status()
        with out_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)

    print(f"✅ Saved tile: {out_path} ({out_path.stat().st_size/1e6:.1f} MB)")
    return out_path


def polygon_bounds(poly) -> Tuple[float, float, float, float]:
    """Bounds in the polygon's coordinate system."""
    return poly.bounds


def clip_laz_to_roi_bbox_then_polygon(
    laz_path: Path,
    roi_poly,  # polygon already in SAME CRS as LAZ (UTM meters)
    max_points: Optional[int] = 800_000,
    seed: int = 42,
):
    """
    Read LAZ, filter by ROI bbox (fast), optional downsample, then precise polygon contains (vectorized).
    Assumes LAZ x/y units match roi_poly CRS (EPSG:32619 meters).
    """
    las = laspy.read(str(laz_path))

    x = np.asarray(las.x)
    y = np.asarray(las.y)
    z = np.asarray(las.z)

    minx, miny, maxx, maxy = polygon_bounds(roi_poly)
    bbox_mask = (x >= minx) & (x <= maxx) & (y >= miny) & (y <= maxy)

    idx = np.nonzero(bbox_mask)[0]
    if idx.size == 0:
        return None

    # Optional downsample for speed
    if max_points is not None and idx.size > max_points:
        rng = np.random.default_rng(seed)
        idx = rng.choice(idx, size=max_points, replace=False)

    # Vectorized polygon contains
    pts = points(x[idx], y[idx])
    inside = contains(roi_poly, pts)
    idx2 = idx[inside]

    if idx2.size == 0:
        return None

    out = {
        "x": x[idx2].astype(np.float64),
        "y": y[idx2].astype(np.float64),
        "z": z[idx2].astype(np.float64),
    }

    # Optional fields if present
    for field in ["intensity", "red", "green", "blue"]:
        if hasattr(las, field):
            out[field] = np.asarray(getattr(las, field))[idx2]

    return out


def order_tiles_for_candidate(tiles: List[Dict], tile_cache: Path) -> List[Dict]:
    """
    Order tiles to minimize downloads:
    1) cached tiles first
    2) then non-cached tiles (stable order)
    """
    def is_cached(t: Dict) -> bool:
        fname = t.get("filename")
        if not fname:
            return False
        return (tile_cache / fname).exists()

    cached = [t for t in tiles if is_cached(t)]
    not_cached = [t for t in tiles if not is_cached(t)]
    return cached + not_cached


def main():
    ap = argparse.ArgumentParser(description="Download candidate LAZ tiles and clip ROI points to candidate polygon.")
    ap.add_argument("--candidates", type=Path, default=DEFAULT_CANDIDATES)
    ap.add_argument("--tiles-json", type=Path, default=DEFAULT_TILES_JSON)
    ap.add_argument("--candidate-id", required=True)
    ap.add_argument("--tile-cache", type=Path, default=DEFAULT_TILE_CACHE)
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    ap.add_argument("--utm-epsg", type=int, default=32619, help="UTM CRS for Brookline pointcloud tiles")

    ap.add_argument("--max-tiles", type=int, default=1, help="Use only the first N tiles (after caching preference).")
    ap.add_argument("--max-points", type=int, default=300_000, help="Cap points per tile for speed")
    ap.add_argument("--seed", type=int, default=42)

    ap.add_argument("--no-download", action="store_true", help="Do not download any new LAZ tiles; use cache only.")
    ap.add_argument("--max-download-gb", type=float, default=5.0, help="Max cache size allowed for LAZ tiles (GB).")

    args = ap.parse_args()

    if not args.candidates.exists():
        raise FileNotFoundError(f"Missing candidates file: {args.candidates}")
    if not args.tiles_json.exists():
        raise FileNotFoundError(f"Missing tiles json: {args.tiles_json}")

    max_download_bytes = int(args.max_download_gb * 1e9)

    roi_poly = load_candidate_polygon_utm(args.candidates, args.candidate_id, utm_epsg=args.utm_epsg)
    tiles_map = load_candidate_tiles(args.tiles_json)

    tiles = tiles_map.get(args.candidate_id, [])
    if not tiles:
        raise ValueError(f"No tiles found for candidate_id={args.candidate_id}")

    # Prefer cached tiles first
    tiles = order_tiles_for_candidate(tiles, args.tile_cache)
    tiles = tiles[: args.max_tiles]

    combined = []

    for t in tiles:
        url = t.get("download_url")
        fname = t.get("filename")
        if not url or not fname:
            continue

        local_tile = args.tile_cache / fname
        local_tile = download_with_cache(
            url,
            local_tile,
            no_download=args.no_download,
            max_download_bytes=max_download_bytes,
            tile_cache=args.tile_cache,
        )
        if local_tile is None:
            continue

        clipped = clip_laz_to_roi_bbox_then_polygon(
            local_tile,
            roi_poly,
            max_points=args.max_points,
            seed=args.seed,
        )

        if clipped is None:
            print(f"⚠️ No points in ROI for tile {fname}")
            continue

        combined.append(clipped)

    if not combined:
        raise RuntimeError(
            f"No ROI points produced for {args.candidate_id}. "
            f"Try --max-tiles 2, increase --max-points, disable --no-download, "
            f"or verify EPSG:{args.utm_epsg}."
        )

    # Merge arrays across tiles
    out = {}
    keys = set().union(*[c.keys() for c in combined])
    for k in keys:
        arrs = [c[k] for c in combined if k in c]
        out[k] = np.concatenate(arrs)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.out_dir / f"roi_points_{args.candidate_id}.npz"
    np.savez_compressed(out_path, **out)

    print(f"✅ Wrote ROI NPZ: {out_path}")
    print("   fields:", sorted(out.keys()))
    print("   points:", out["x"].shape[0])


if __name__ == "__main__":
    main()