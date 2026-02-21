import requests
import os

BASE = "https://dcygqrjfsypox.cloudfront.net/cyvl_public_data/11_2025/brookline_data"

FILES = {
    "aboveGroundAssets.geojson": "/gis/assets/aboveGroundAssets.geojson",
    "pavements.geojson": "/gis/pavement/pavements.geojson",
    "rollup.geojson": "/gis/pavement/rollup.geojson",
    "streetviewImages.geojson": "/gis/imagery/streetviewImages.geojson",
    "panoramicImagery.geojson": "/gis/imagery/panoramicImagery.geojson",
    "pointcloud_coverage.json": "/pointclouds/pointcloud_coverage.json",
}

os.makedirs("../data/brookline/raw", exist_ok=True)

for name, path in FILES.items():
    url = BASE + path
    r = requests.get(url)
    with open(f"../data/brookline/raw/{name}", "wb") as f:
        f.write(r.content)
    print(f"Downloaded {name}")