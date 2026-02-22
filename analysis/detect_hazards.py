# analysis/detect_hazards.py
"""
ADA Sentinel - Brookline (Cross-slope + residual steps, robust + safe)

Key outputs:
- cross_slope_max_pct: max cross-slope (perpendicular to sidewalk direction)
- cross_slope_mean_pct: mean of sampled cross-slopes
- cross_slope_std_pct: stability indicator
- max_step_m: max "lip" step from residual field (detrended)
- step_cells_total / step_cells_exported: counts + export cap transparency
- inlier_ratio: RANSAC plane inliers / total
- ransac_fallback_used: whether LS fallback happened
- quality: HIGH/MED/LOW based on signals

CRS safety:
- If GeoJSON CRS is missing, we infer whether it looks like lon/lat vs UTM.
- We refuse to blindly "allow_override=True" without range checks.

NaN safety:
- All floats are sanitized before JSON/GeoJSON output.
"""

import argparse
import json
import math
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import geopandas as gpd
from shapely.geometry import Point


ROI_DIR = Path("data/brookline/roi")
CAND_BUFFERS_PATH = Path("data/brookline/processed/candidates_buffer.geojson")
CAND_LINES_PATH = Path("data/brookline/processed/candidates.geojson")
OUT_METRICS = Path("data/brookline/processed/candidate_metrics.json")
OUT_FLAGS = Path("data/brookline/processed/flagged_points.geojson")


# ---------------------------
# Helpers: safety & sanitization
# ---------------------------
def safe_float(x, default: float = 0.0) -> float:
    """Convert to finite float; replace NaN/Inf with default."""
    try:
        v = float(x)
    except Exception:
        return float(default)
    if math.isnan(v) or math.isinf(v):
        return float(default)
    return v


def clamp(v: float, lo: float, hi: float) -> Tuple[float, bool]:
    v = safe_float(v, lo)
    if v < lo:
        return lo, True
    if v > hi:
        return hi, True
    return v, False


def infer_crs_from_coords(gdf: gpd.GeoDataFrame) -> str:
    """
    If CRS missing, infer whether coordinates look like lon/lat (EPSG:4326)
    or projected meters (EPSG:32619).
    """
    # sample a few bounds
    b = gdf.total_bounds  # (minx, miny, maxx, maxy)
    minx, miny, maxx, maxy = map(float, b)

    looks_lonlat = (-180 <= minx <= 180) and (-180 <= maxx <= 180) and (-90 <= miny <= 90) and (-90 <= maxy <= 90)
    if looks_lonlat:
        return "EPSG:4326"

    # UTM 19N rough range for Brookline area
    # x ~ [200k..800k], y ~ [4.5M..5.5M]
    looks_utm = (0 <= minx <= 1_000_000) and (0 <= maxx <= 1_000_000) and (3_000_000 <= miny <= 7_000_000)
    if looks_utm:
        return "EPSG:32619"

    # default conservative: treat as unknown lon/lat to avoid insane reprojection
    # but we will still set 4326 as best guess.
    return "EPSG:4326"


def ensure_crs(gdf: gpd.GeoDataFrame, desired_if_missing: Optional[str] = None) -> gpd.GeoDataFrame:
    """
    Ensure GeoDataFrame has a CRS. If missing, infer or use desired_if_missing.
    """
    if gdf.crs is not None:
        return gdf
    if desired_if_missing:
        # only accept if bounds make sense; otherwise infer
        inferred = infer_crs_from_coords(gdf)
        # If user insists, allow, but pick inferred if it contradicts wildly
        if desired_if_missing == "EPSG:4326" and inferred == "EPSG:32619":
            return gdf.set_crs(inferred, allow_override=True)
        if desired_if_missing == "EPSG:32619" and inferred == "EPSG:4326":
            return gdf.set_crs(inferred, allow_override=True)
        return gdf.set_crs(desired_if_missing, allow_override=True)
    return gdf.set_crs(infer_crs_from_coords(gdf), allow_override=True)


def load_npz_xyz(npz_path: Path) -> Optional[np.ndarray]:
    """
    Load xyz from npz with validation:
    - requires keys x,y,z
    - same length
    - at least 3 points
    - finite values
    """
    if not npz_path.exists():
        return None

    data = np.load(npz_path)
    required = {"x", "y", "z"}
    if not required.issubset(set(data.files)):
        print(f"⚠️ {npz_path.name}: missing keys {required - set(data.files)} (skipping)")
        return None

    x = np.asarray(data["x"])
    y = np.asarray(data["y"])
    z = np.asarray(data["z"])

    if not (len(x) == len(y) == len(z)):
        print(f"⚠️ {npz_path.name}: x/y/z lengths differ (skipping)")
        return None

    if len(x) < 3:
        print(f"⚠️ {npz_path.name}: <3 points (skipping)")
        return None

    xyz = np.column_stack([x, y, z]).astype(np.float64)
    finite = np.isfinite(xyz).all(axis=1)
    xyz = xyz[finite]
    if xyz.shape[0] < 3:
        print(f"⚠️ {npz_path.name}: not enough finite points after cleaning (skipping)")
        return None

    return xyz


# ---------------------------
# Plane fitting (RANSAC)
# ---------------------------
def fit_plane_least_squares(xyz: np.ndarray):
    """Fit z = a x + b y + c. Returns (a,b,c)."""
    X, Y, Z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    A = np.column_stack([X, Y, np.ones_like(X)])
    coeff, *_ = np.linalg.lstsq(A, Z, rcond=None)
    a, b, c = coeff
    return float(a), float(b), float(c)


def fit_plane_ransac(xyz: np.ndarray, iters=200, inlier_thresh_m=0.03, seed=42):
    """
    RANSAC plane fit for z = ax + by + c.
    Returns (a,b,c), inlier_mask, fallback_used(bool)
    """
    rng = np.random.default_rng(seed)
    n = xyz.shape[0]

    if n < 3:
        a, b, c = fit_plane_least_squares(xyz)
        return (a, b, c), np.ones(n, dtype=bool), True

    if n < 200:
        a, b, c = fit_plane_least_squares(xyz)
        return (a, b, c), np.ones(n, dtype=bool), True

    X = xyz[:, 0]
    Y = xyz[:, 1]
    Z = xyz[:, 2]

    best_inliers = None
    best_count = -1

    for _ in range(iters):
        idx = rng.choice(n, size=3, replace=False)
        pts = xyz[idx]
        A3 = np.column_stack([pts[:, 0], pts[:, 1], np.ones(3)])
        try:
            a, b, c = np.linalg.solve(A3, pts[:, 2])
        except np.linalg.LinAlgError:
            continue

        Zhat = a * X + b * Y + c
        resid = np.abs(Z - Zhat)
        inliers = resid <= inlier_thresh_m
        count = int(inliers.sum())

        if count > best_count:
            best_count = count
            best_inliers = inliers

    if best_inliers is None or best_count < 50:
        # fallback
        a, b, c = fit_plane_least_squares(xyz)
        return (a, b, c), np.ones(n, dtype=bool), True

    # refine on inliers
    a, b, c = fit_plane_least_squares(xyz[best_inliers])
    return (a, b, c), best_inliers, False


# ---------------------------
# Cross-slope computation (sampled local tangents)
# ---------------------------
def _unit(vx: float, vy: float):
    length = float(np.sqrt(vx * vx + vy * vy))
    if length < 1e-12:
        return None
    return (vx / length, vy / length)


def _cross_slope_from_tangent(a: float, b: float, tx: float, ty: float) -> float:
    # cross dir = (-ty, tx)
    cx, cy = -ty, tx
    cross_ratio = a * cx + b * cy
    return float(abs(cross_ratio) * 100.0)


def compute_cross_slope_for_candidate(
    a: float,
    b: float,
    candidate_id: str,
    roi_xyz: np.ndarray,
    lines_gdf_utm: gpd.GeoDataFrame,
    n_samples: int = 7,
):
    """
    Sample along the candidate LineString and compute cross-slope using local tangent.
    Prefer candidate_id match if column exists; else fallback to nearest line by centroid.

    Returns dict with samples, max/mean/std, max_point_utm, max_sample_index, direction_source, direction_valid.
    """
    if len(lines_gdf_utm) == 0:
        return {
            "samples": [],
            "cross_slope_max_pct": 0.0,
            "cross_slope_mean_pct": 0.0,
            "cross_slope_std_pct": 0.0,
            "max_point_utm": None,
            "max_sample_index": None,
            "direction_source": "empty_lines",
            "direction_valid": False,
        }

    centroid = Point(float(np.mean(roi_xyz[:, 0])), float(np.mean(roi_xyz[:, 1])))

    line = None
    source = "nearest_linestring"
    if "candidate_id" in lines_gdf_utm.columns:
        row = lines_gdf_utm[lines_gdf_utm["candidate_id"] == candidate_id]
        if not row.empty:
            line = row.iloc[0].geometry
            source = "candidate_linestring"
        else:
            # explicit warning about fallback (avoids silent mismatch)
            print(f"⚠️ {candidate_id}: candidate_id not found in candidates.geojson, using nearest line fallback")

    if line is None:
        distances = lines_gdf_utm.geometry.distance(centroid)
        nearest_idx = distances.idxmin()
        line = lines_gdf_utm.geometry.loc[nearest_idx]

    if line is None or line.length == 0:
        return {
            "samples": [],
            "cross_slope_max_pct": 0.0,
            "cross_slope_mean_pct": 0.0,
            "cross_slope_std_pct": 0.0,
            "max_point_utm": None,
            "max_sample_index": None,
            "direction_source": source,
            "direction_valid": False,
        }

    L = float(line.length)
    if L < 1e-6:
        return {
            "samples": [],
            "cross_slope_max_pct": 0.0,
            "cross_slope_mean_pct": 0.0,
            "cross_slope_std_pct": 0.0,
            "max_point_utm": None,
            "max_sample_index": None,
            "direction_source": source,
            "direction_valid": False,
        }

    # avoid endpoints; pick epsilon for tangent estimation
    eps = min(1.0, 0.05 * L)
    eps = max(eps, 0.05)

    ts = np.linspace(0.15, 0.85, n_samples)

    samples = []
    max_val = -1.0
    max_pt = None
    max_i = None

    for i, t in enumerate(ts):
        s = float(t * L)
        p = line.interpolate(s)
        p0 = line.interpolate(max(0.0, s - eps))
        p1 = line.interpolate(min(L, s + eps))

        vx = float(p1.x - p0.x)
        vy = float(p1.y - p0.y)
        u = _unit(vx, vy)
        if u is None:
            continue

        tx, ty = u
        cross_pct = _cross_slope_from_tangent(a, b, tx, ty)
        if not (math.isnan(cross_pct) or math.isinf(cross_pct)):
            samples.append(float(cross_pct))
            if cross_pct > max_val:
                max_val = float(cross_pct)
                max_pt = (float(p.x), float(p.y))
                max_i = i

    if not samples:
        return {
            "samples": [],
            "cross_slope_max_pct": 0.0,
            "cross_slope_mean_pct": 0.0,
            "cross_slope_std_pct": 0.0,
            "max_point_utm": None,
            "max_sample_index": None,
            "direction_source": source,
            "direction_valid": False,
        }

    arr = np.array(samples, dtype=np.float64)
    return {
        "samples": [safe_float(x) for x in arr.tolist()],
        "cross_slope_max_pct": safe_float(np.max(arr)),
        "cross_slope_mean_pct": safe_float(np.mean(arr)),
        "cross_slope_std_pct": safe_float(np.std(arr)),
        "max_point_utm": max_pt,
        "max_sample_index": max_i,
        "direction_source": source,
        "direction_valid": True,
    }


# ---------------------------
# Vertical lips (residual step jumps)
# ---------------------------
def grid_residual_field(xy: np.ndarray, r: np.ndarray, cell=0.10, min_pts=10):
    """
    Grid residuals by XY cell; median residual per cell.
    Note: cells with < min_pts are skipped; we surface this via residual_cells count.
    """
    X = xy[:, 0]
    Y = xy[:, 1]
    minx, miny = float(X.min()), float(Y.min())

    gx = np.floor((X - minx) / cell).astype(np.int32)
    gy = np.floor((Y - miny) / cell).astype(np.int32)

    bins = {}
    for ix, iy, rv in zip(gx, gy, r):
        bins.setdefault((ix, iy), []).append(rv)

    med_r = {}
    centers = {}
    for (ix, iy), vals in bins.items():
        if len(vals) < min_pts:
            continue
        med = float(np.median(vals))
        cx = minx + (ix + 0.5) * cell
        cy = miny + (iy + 0.5) * cell
        if not (math.isnan(cx) or math.isnan(cy) or math.isinf(cx) or math.isinf(cy)):
            med_r[(ix, iy)] = safe_float(med, 0.0)
            centers[(ix, iy)] = (float(cx), float(cy))

    return med_r, centers


def residual_steps(med_r: dict, centers: dict, step_thresh_m=0.015):
    """Neighbor residual jumps on an 8-neighborhood."""
    nbrs8 = [(-1, -1), (-1, 0), (-1, 1),
             (0, -1),          (0, 1),
             (1, -1),  (1, 0), (1, 1)]
    max_step = 0.0
    flagged = []

    for (ix, iy), r0 in med_r.items():
        worst = 0.0
        for dx, dy in nbrs8:
            k2 = (ix + dx, iy + dy)
            if k2 not in med_r:
                continue
            dz = abs(r0 - med_r[k2])
            if dz > worst:
                worst = dz
        max_step = max(max_step, worst)
        if worst >= step_thresh_m:
            cx, cy = centers[(ix, iy)]
            flagged.append({"x": float(cx), "y": float(cy), "step_m": safe_float(worst)})
    return safe_float(max_step), flagged


# ---------------------------
# Quality scoring (same spirit as your current)
# ---------------------------
def compute_quality(inlier_ratio: float, residual_cells: int, cross_std: float, direction_valid: bool) -> str:
    if not direction_valid:
        return "LOW"
    # tuned to your observed outputs; don't penalize too harshly
    if inlier_ratio >= 0.20 and residual_cells >= 150 and cross_std <= 1.5:
        return "HIGH"
    if inlier_ratio >= 0.10 and residual_cells >= 75 and cross_std <= 3.0:
        return "MED"
    return "LOW"


# ---------------------------
# Main
# ---------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slope-thresh", type=float, default=2.0, help="ADA cross-slope threshold (%)")
    ap.add_argument("--step-thresh-mm", type=float, default=15.0, help="Vertical lip threshold (mm)")
    ap.add_argument("--strict-ada", action="store_true", help="Use strict ADA lip threshold (0.25in = 6.35mm)")
    ap.add_argument("--cell", type=float, default=0.10, help="Residual grid cell size (m)")
    ap.add_argument("--min-pts", type=int, default=10, help="Min points per residual cell")
    ap.add_argument("--ransac-iters", type=int, default=200)
    ap.add_argument("--ransac-inlier-thresh-cm", type=float, default=3.0)
    ap.add_argument("--cross-slope-samples", type=int, default=7)
    ap.add_argument("--cross-clamp-max", type=float, default=30.0)
    ap.add_argument("--step-marker-cap", type=int, default=800)
    args = ap.parse_args()

    if args.strict_ada:
        args.step_thresh_mm = 6.35

    step_thresh_m = args.step_thresh_mm / 1000.0
    inlier_thresh_m = args.ransac_inlier_thresh_cm / 100.0

    if not CAND_BUFFERS_PATH.exists():
        raise FileNotFoundError(f"Missing: {CAND_BUFFERS_PATH}")
    if not CAND_LINES_PATH.exists():
        raise FileNotFoundError(f"Missing: {CAND_LINES_PATH}")

    buff = ensure_crs(gpd.read_file(CAND_BUFFERS_PATH), desired_if_missing="EPSG:4326")
    buff_utm = buff.to_crs("EPSG:32619")

    lines = ensure_crs(gpd.read_file(CAND_LINES_PATH), desired_if_missing="EPSG:4326")
    lines_utm = lines.to_crs("EPSG:32619")

    if len(lines_utm) == 0:
        raise RuntimeError(f"{CAND_LINES_PATH} contains 0 features; cannot compute cross-slope direction.")

    metrics_out: List[Dict] = []
    flag_features: List[Dict] = []

    processed = 0
    skipped = 0

    for cid in list(buff_utm["candidate_id"]):
        npz_path = ROI_DIR / f"roi_points_{cid}.npz"
        xyz = load_npz_xyz(npz_path)
        if xyz is None:
            skipped += 1
            continue

        processed += 1

        (a, b, c), inliers, ransac_fallback = fit_plane_ransac(
            xyz, iters=args.ransac_iters, inlier_thresh_m=inlier_thresh_m, seed=42
        )
        inlier_ratio = safe_float(inliers.sum() / max(1, xyz.shape[0]))

        cross = compute_cross_slope_for_candidate(
            a=a, b=b, candidate_id=cid, roi_xyz=xyz, lines_gdf_utm=lines_utm, n_samples=args.cross_slope_samples
        )

        cross_max_raw = safe_float(cross["cross_slope_max_pct"])
        cross_mean_raw = safe_float(cross["cross_slope_mean_pct"])
        cross_std = safe_float(cross["cross_slope_std_pct"])
        direction_valid = bool(cross["direction_valid"])

        cross_max, was_clamped = clamp(cross_max_raw, 0.0, float(args.cross_clamp_max))
        cross_mean, _ = clamp(cross_mean_raw, 0.0, float(args.cross_clamp-max)) if False else (cross_mean_raw, False)
        # (keep mean unclamped unless it goes NaN/Inf; clamp() already sanitized max which is what we gate on)
        cross_mean = safe_float(cross_mean_raw)

        slope_flag = bool(cross_max > args.slope_thresh)

        # residual steps on inliers
        xyz_in = xyz[inliers]
        X, Y, Z = xyz_in[:, 0], xyz_in[:, 1], xyz_in[:, 2]
        Zhat = a * X + b * Y + c
        r = Z - Zhat
        xy = np.column_stack([X, Y])

        med_r, centers = grid_residual_field(xy, r, cell=args.cell, min_pts=args.min_pts)
        residual_cells = int(len(med_r))

        max_step_m, step_flags = residual_steps(med_r, centers, step_thresh_m=step_thresh_m)
        step_cells_total = int(len(step_flags))
        step_cells_exported = int(min(step_cells_total, args.step_marker_cap))

        quality = compute_quality(inlier_ratio, residual_cells, cross_std, direction_valid)
        if was_clamped:
            quality = "LOW"

        # condition safe
        row = buff_utm[buff_utm["candidate_id"] == cid]
        cond = ""
        if not row.empty:
            cond = str(row.iloc[0].get("condition", ""))

        metrics_out.append(
            {
                "candidate_id": cid,
                "condition": cond,

                "cross_slope_max_pct": safe_float(cross_max),
                "cross_slope_mean_pct": safe_float(cross_mean),
                "cross_slope_std_pct": safe_float(cross_std),
                "cross_slope_samples": cross.get("samples", []),
                "max_sample_index": cross.get("max_sample_index", None),
                "direction_source": cross.get("direction_source", "unknown"),
                "direction_valid": direction_valid,

                "slope_flag": slope_flag,

                "ransac_inliers": int(inliers.sum()),
                "inlier_ratio": safe_float(inlier_ratio),
                "ransac_fallback_used": bool(ransac_fallback),

                "residual_cells": residual_cells,
                "max_step_m": safe_float(max_step_m),
                "step_flag": bool(max_step_m >= step_thresh_m),
                "step_cells_total": step_cells_total,
                "step_cells_exported": step_cells_exported,

                "quality": quality,
                "was_clamped": bool(was_clamped),

                "thresholds": {
                    "cross_slope_thresh_pct": safe_float(args.slope_thresh),
                    "step_thresh_mm": safe_float(args.step_thresh_mm),
                },
            }
        )

        # marker for cross-slope max point (if available)
        if cross.get("max_point_utm") is not None:
            mx, my = cross["max_point_utm"]
            if np.isfinite(mx) and np.isfinite(my):
                flag_features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "candidate_id": cid,
                            "hazard_type": "CROSS_SLOPE_MAX",
                            "cross_slope_pct": safe_float(cross_max),
                            "cross_slope_std_pct": safe_float(cross_std),
                            "quality": quality,
                        },
                        "geometry": {"type": "Point", "coordinates": [float(mx), float(my)]},
                    }
                )

        # vertical step markers (capped)
        for s in step_flags[: args.step_marker_cap]:
            sx = safe_float(s["x"])
            sy = safe_float(s["y"])
            if np.isfinite(sx) and np.isfinite(sy):
                flag_features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "candidate_id": cid,
                            "hazard_type": "VERTICAL_STEP",
                            "step_m": safe_float(s["step_m"]),
                            "cross_slope_max_pct": safe_float(cross_max),
                            "quality": quality,
                        },
                        "geometry": {"type": "Point", "coordinates": [sx, sy]},
                    }
                )

        print(
            f"✅ {cid}: inliers={int(inliers.sum())} ({inlier_ratio:.2%}), "
            f"cross_max={cross_max:.2f}% (std={cross_std:.2f}), "
            f"max_step={max_step_m*1000:.1f}mm, step_cells={step_cells_total}, "
            f"quality={quality}"
        )

    # Write metrics JSON (safe, finite)
    OUT_METRICS.parent.mkdir(parents=True, exist_ok=True)
    OUT_METRICS.write_text(json.dumps(metrics_out, indent=2, allow_nan=False), encoding="utf-8")
    print(f"✅ Wrote: {OUT_METRICS} (processed={processed}, skipped={skipped})")

    # Write flagged points GeoJSON (UTM -> WGS84)
    if flag_features:
        gdf_flags = gpd.GeoDataFrame.from_features(flag_features, crs="EPSG:32619").to_crs("EPSG:4326")
        OUT_FLAGS.parent.mkdir(parents=True, exist_ok=True)
        gdf_flags.to_file(OUT_FLAGS, driver="GeoJSON")
        print(f"✅ Wrote: {OUT_FLAGS}")
    else:
        print("⚠️ No flagged points produced.")


if __name__ == "__main__":
    main()