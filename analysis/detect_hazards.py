# analysis/detect_hazards.py
"""
ADA Sentinel - Brookline (robust, detrended)

Why this works:
- Absolute Z varies a lot (curbs, walls, driveways). That creates meter-scale dz.
- We fit the dominant sidewalk/ground plane and analyze residuals (z - plane).
- Cross-slope = plane slope (%). Vertical lips = residual jumps (mm/cm).

Inputs:
- data/brookline/roi/roi_points_<CAND_ID>.npz  (UTM meters x,y,z)
- data/brookline/processed/candidates_buffer.geojson

Outputs:
- data/brookline/processed/candidate_metrics.json
- data/brookline/processed/flagged_points.geojson (WGS84)
"""

import argparse
import json
from pathlib import Path

import numpy as np
import geopandas as gpd
from scipy.spatial import cKDTree


ROI_DIR = Path("data/brookline/roi")
CANDIDATES_PATH = Path("data/brookline/processed/candidates_buffer.geojson")
OUT_METRICS = Path("data/brookline/processed/candidate_metrics.json")
OUT_FLAGS = Path("data/brookline/processed/flagged_points.geojson")


def fit_plane_least_squares(xyz: np.ndarray):
    """Fit z = a x + b y + c. Returns (a,b,c)."""
    X, Y, Z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    A = np.column_stack([X, Y, np.ones_like(X)])
    coeff, *_ = np.linalg.lstsq(A, Z, rcond=None)
    a, b, c = coeff
    return float(a), float(b), float(c)


def fit_plane_ransac(xyz: np.ndarray, iters=200, inlier_thresh_m=0.03, seed=42):
    """
    Simple RANSAC plane fit for z = ax + by + c.
    Returns best (a,b,c) and inlier mask.
    """
    rng = np.random.default_rng(seed)
    n = xyz.shape[0]
    if n < 200:
        a, b, c = fit_plane_least_squares(xyz)
        return (a, b, c), np.ones(n, dtype=bool)

    best_inliers = None
    best_count = -1
    best_params = None

    X = xyz[:, 0]
    Y = xyz[:, 1]
    Z = xyz[:, 2]

    for _ in range(iters):
        idx = rng.choice(n, size=3, replace=False)
        pts = xyz[idx]
        # Solve for plane through 3 points: z = ax + by + c
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
            best_params = (float(a), float(b), float(c))

    # Refine using least squares on inliers
    if best_inliers is None or best_count < 50:
        a, b, c = fit_plane_least_squares(xyz)
        return (a, b, c), np.ones(n, dtype=bool)

    a, b, c = fit_plane_least_squares(xyz[best_inliers])
    return (a, b, c), best_inliers


def slope_percent_from_plane(a: float, b: float) -> float:
    # slope magnitude = sqrt((dz/dx)^2 + (dz/dy)^2), percent = 100 * slope
    return float(100.0 * np.sqrt(a * a + b * b))


def grid_residual_field(xy: np.ndarray, r: np.ndarray, cell=0.10, min_pts=10):
    """
    Grid residuals by XY cell. For each cell take median residual.
    Returns:
      med_r: dict[(ix,iy)] = median residual
      centers: dict[(ix,iy)] = (cx,cy)
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
        med_r[(ix, iy)] = med
        centers[(ix, iy)] = (cx, cy)

    return med_r, centers


def residual_steps(med_r: dict, centers: dict, step_thresh_m=0.015):
    """Compute neighbor residual jumps; return (max_step, flagged_cells)."""
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
            worst = max(worst, dz)
        max_step = max(max_step, worst)
        if worst >= step_thresh_m:
            cx, cy = centers[(ix, iy)]
            flagged.append({"x": float(cx), "y": float(cy), "step_m": float(worst)})
    return float(max_step), flagged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slope-thresh", type=float, default=3.0)          # triage default
    ap.add_argument("--step-thresh-mm", type=float, default=15.0)       # triage default
    ap.add_argument("--cell", type=float, default=0.10)                 # residual grid cell (m)
    ap.add_argument("--min-pts", type=int, default=10)                  # min pts per residual cell
    ap.add_argument("--ransac-iters", type=int, default=200)
    ap.add_argument("--ransac-inlier-thresh-cm", type=float, default=3.0)  # 3 cm inlier band
    args = ap.parse_args()

    step_thresh_m = args.step_thresh_mm / 1000.0
    inlier_thresh_m = args.ransac_inlier_thresh_cm / 100.0

    cand = gpd.read_file(CANDIDATES_PATH)
    if cand.crs is None:
        cand = cand.set_crs("EPSG:4326", allow_override=True)
    cand_utm = cand.to_crs("EPSG:32619")

    metrics_out = []
    flag_features = []

    for cid in list(cand_utm["candidate_id"]):
        npz_path = ROI_DIR / f"roi_points_{cid}.npz"
        if not npz_path.exists():
            print(f"⚠️ Missing ROI npz for {cid}: {npz_path}")
            continue

        data = np.load(npz_path)
        xyz = np.column_stack([data["x"], data["y"], data["z"]]).astype(np.float64)

        # ---- Fit dominant plane with RANSAC (robust to walls/curbs) ----
        (a, b, c), inliers = fit_plane_ransac(
            xyz,
            iters=args.ransac_iters,
            inlier_thresh_m=inlier_thresh_m,
            seed=42,
        )

        slope_pct = slope_percent_from_plane(a, b)

        # Use only inliers for residual analysis (closer to sidewalk surface)
        xyz_in = xyz[inliers]
        X, Y, Z = xyz_in[:, 0], xyz_in[:, 1], xyz_in[:, 2]
        Zhat = a * X + b * Y + c
        r = Z - Zhat  # residual in meters
        xy = np.column_stack([X, Y])

        # ---- Residual heightfield and steps (micro-barriers) ----
        med_r, centers = grid_residual_field(xy, r, cell=args.cell, min_pts=args.min_pts)
        max_step_m, step_flags = residual_steps(med_r, centers, step_thresh_m=step_thresh_m)

        cond = str(cand_utm[cand_utm["candidate_id"] == cid].iloc[0].get("condition", ""))

        metrics_out.append(
            {
                "candidate_id": cid,
                "condition": cond,
                "plane_slope_pct": float(slope_pct),
                "slope_flag": bool(slope_pct >= args.slope_thresh),
                "ransac_inliers": int(inliers.sum()),
                "residual_cells": int(len(med_r)),
                "max_step_m": float(max_step_m),
                "step_flag": bool(max_step_m >= step_thresh_m),
                "num_step_cells": int(len(step_flags)),
            }
        )

        # Flag points (UTM coords; we'll reproject at end)
        # Cross-slope: represent as one marker at candidate centroid (optional)
        # Micro-steps: represent by flagged cells
        for s in step_flags[:800]:
            flag_features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "candidate_id": cid,
                        "hazard_type": "VERTICAL_STEP",
                        "step_m": float(s["step_m"]),
                        "plane_slope_pct": float(slope_pct),
                    },
                    "geometry": {"type": "Point", "coordinates": [s["x"], s["y"]]},
                }
            )

        print(
            f"✅ {cid}: inliers={int(inliers.sum())}, "
            f"slope={slope_pct:.2f}%, max_step={max_step_m*1000:.1f}mm, step_cells={len(step_flags)}"
        )

    OUT_METRICS.parent.mkdir(parents=True, exist_ok=True)
    OUT_METRICS.write_text(json.dumps(metrics_out, indent=2), encoding="utf-8")
    print(f"✅ Wrote: {OUT_METRICS}")

    if flag_features:
        gdf_flags = gpd.GeoDataFrame.from_features(flag_features, crs="EPSG:32619").to_crs("EPSG:4326")
        OUT_FLAGS.parent.mkdir(parents=True, exist_ok=True)
        gdf_flags.to_file(OUT_FLAGS, driver="GeoJSON")
        print(f"✅ Wrote: {OUT_FLAGS}")
    else:
        print("⚠️ No flagged points produced.")


if __name__ == "__main__":
    main()