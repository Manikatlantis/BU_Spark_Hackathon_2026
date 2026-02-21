import geopandas as gpd

CANDIDATES_PATH = "../data/brookline/processed/candidates.geojson"
OUT_PATH = "../data/brookline/processed/candidates_buffer.geojson"

# Load candidates
candidates = gpd.read_file(CANDIDATES_PATH)

# IMPORTANT: buffer needs projected CRS (meters), not lat/lon.
# Brookline is UTM Zone 19N typically (EPSG:32619)
candidates = candidates.set_crs("EPSG:4326", allow_override=True).to_crs("EPSG:32619")

# Buffer width: sidewalk corridor ~ 2 meters (tweak later)
BUFFER_METERS = 2.0
buffers = candidates.copy()
buffers["geometry"] = buffers.geometry.buffer(BUFFER_METERS)

# Back to WGS84 for easy mapping + frontend
buffers = buffers.to_crs("EPSG:4326")

buffers.to_file(OUT_PATH, driver="GeoJSON")
print("Saved:", OUT_PATH, "count:", len(buffers))