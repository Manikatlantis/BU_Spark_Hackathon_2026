import geopandas as gpd
from pathlib import Path

OUT_PATH = Path("../data/brookline/processed/candidates.geojson")
OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

# 1️⃣ Load above ground assets
gdf = gpd.read_file("../data/brookline/raw/aboveGroundAssets.geojson")

print("Total features in AGA:", len(gdf))
print("Available asset types:", gdf["asset_type"].unique())

# 2️⃣ Filter ONLY sidewalks
sidewalks = gdf[gdf["asset_type"] == "SIDEWALK"].copy()

print("Total sidewalk features:", len(sidewalks))
print("Geometry types:", sidewalks.geom_type.unique())

# 3️⃣ Check if condition column exists
if "condition" in sidewalks.columns:
    print("Condition values:", sidewalks["condition"].unique())
else:
    print("No condition field found!")

# 4️⃣ Create risk flag (Poor + Fair)
sidewalks["risk_flag"] = sidewalks["condition"].isin(["Poor", "Fair"])

# candidates = sidewalks[sidewalks["risk_flag"] == True].copy()
# candidates = sidewalks.copy()

N = 250
candidates = sidewalks.sample(n=N, random_state=42).copy()

# 6️⃣ Assign candidate IDs
candidates["candidate_id"] = [
    f"CAND_{i+1}" for i in range(len(candidates))
]

# 7️⃣ Keep only essential columns
candidates = candidates[
    ["candidate_id", "asset_type", "condition", "geometry"]
]

# 8️⃣ Save output
candidates.to_file(str(OUT_PATH), driver="GeoJSON")

print("Saved candidates.geojson successfully.")