import json
from pathlib import Path

import geopandas as gpd
from shapely.geometry import shape

# Paths (relative to analysis/)
CAND_BUFFERS_PATH = Path("../data/brookline/processed/candidates_buffer.geojson")
PC_COVERAGE_PATH = Path("../data/brookline/raw/pointcloud_coverage.json")

OUT_JSON_PATH = Path("../data/brookline/processed/candidate_tiles.json")
OUT_TILE_INDEX_PATH = Path("../data/brookline/processed/tile_index.geojson")


def load_pointcloud_tiles(coverage_path: Path) -> gpd.GeoDataFrame:
    """Load pointcloud_coverage.json into a GeoDataFrame of tile polygons + useful URLs."""
    with coverage_path.open("r", encoding="utf-8") as f:
        pc = json.load(f)

    features = pc.get("features", [])
    rows = []
    for ft in features:
        geom = shape(ft["geometry"])
        props = ft.get("properties", {}) or {}

        base_url = props.get("baseUrl") or ""
        las_path = props.get("lasPath") or ""
        potree_path = props.get("potreePath") or ""

        rows.append(
            {
                "geometry": geom,
                "filename": props.get("filename"),
                "filename_no_ext": props.get("filename_no_ext"),
                "dataset": props.get("dataset"),
                "baseUrl": base_url,
                "lasPath": las_path,
                "potreePath": potree_path,
                "download_url": (base_url + las_path) if (base_url and las_path) else None,
                "potree_url": (base_url + potree_path) if (base_url and potree_path) else None,
                "lon": props.get("lon"),
                "lat": props.get("lat"),
                "alt": props.get("alt"),
            }
        )

    tiles = gpd.GeoDataFrame(rows, crs="EPSG:4326")
    return tiles


def main():
    # Sanity checks
    if not CAND_BUFFERS_PATH.exists():
        raise FileNotFoundError(f"Missing: {CAND_BUFFERS_PATH}")
    if not PC_COVERAGE_PATH.exists():
        raise FileNotFoundError(f"Missing: {PC_COVERAGE_PATH}")

    # Load candidate buffers
    cand = gpd.read_file(CAND_BUFFERS_PATH)
    # Ensure CRS is set
    if cand.crs is None:
        cand = cand.set_crs("EPSG:4326", allow_override=True)
    else:
        cand = cand.to_crs("EPSG:4326")

    required_cols = {"candidate_id", "geometry"}
    if not required_cols.issubset(set(cand.columns)):
        raise ValueError(f"candidates_buffer.geojson must contain columns: {required_cols}")

    # Load tiles
    tiles = load_pointcloud_tiles(PC_COVERAGE_PATH)

    # Save tile index for debugging (optional but useful)
    OUT_TILE_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    tiles.to_file(OUT_TILE_INDEX_PATH, driver="GeoJSON")

    # Spatial join: candidate buffers ↔ tiles
    # Note: geopandas sjoin requires spatial index; if it errors, install rtree or pygeos (rtree is easiest)
    joined = gpd.sjoin(
        cand[["candidate_id", "geometry"]],
        tiles[["filename", "download_url", "potree_url", "geometry"]],
        predicate="intersects",
        how="left",
    )

    # Build mapping as JSON
    result = []
    for cid, grp in joined.groupby("candidate_id"):
        tiles_list = []
        for _, r in grp.iterrows():
            if r.get("filename") is None:
                continue
            tiles_list.append(
                {
                    "filename": r.get("filename"),
                    "download_url": r.get("download_url"),
                    "potree_url": r.get("potree_url"),
                }
            )

        # Remove duplicates (sometimes join repeats)
        seen = set()
        unique_tiles = []
        for t in tiles_list:
            key = (t["filename"], t["download_url"], t["potree_url"])
            if key in seen:
                continue
            seen.add(key)
            unique_tiles.append(t)

        result.append({"candidate_id": cid, "tiles": unique_tiles})

    # Write JSON
    OUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_JSON_PATH.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    # Print summary
    print("✅ Saved:", OUT_JSON_PATH)
    for item in result:
        print(f"  {item['candidate_id']}: {len(item['tiles'])} tiles")
    print("🗺️  Saved tile index:", OUT_TILE_INDEX_PATH)


if __name__ == "__main__":
    main()