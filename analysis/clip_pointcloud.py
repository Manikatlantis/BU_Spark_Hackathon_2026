import json
import argparse
import requests
import os
from shapely.geometry import shape


def load_candidate_polygon(path, candidate_id):
    with open(path) as f:
        data = json.load(f)

    for feature in data["features"]:
        props = feature.get("properties", {})

        # adjust this key if your id field is named differently
        if props.get("id") == candidate_id:
            return shape(feature["geometry"])

    raise ValueError("Candidate ID not found")

def load_tiles(coverage_path):
    with open(coverage_path) as f:
        data = json.load(f)

    tiles = []

    for feature in data["features"]:
        geom = shape(feature["geometry"])
        props = feature["properties"]
        url = props["baseUrl"] + props["lasPath"]

        tiles.append((geom, url))

    return tiles

def find_intersecting_tiles(candidate_geom, tiles):
    selected = []

    for tile_geom, url in tiles:
        if tile_geom.intersects(candidate_geom):
            selected.append(url)

    return selected

def download_tiles(urls, output_folder):
    os.makedirs(output_folder, exist_ok=True)

    for url in urls:
        filename = url.split("/")[-1]
        output_path = os.path.join(output_folder, filename)

        if os.path.exists(output_path):
            print(f"Skipping {filename} (already downloaded)")
            continue

        print(f"Downloading {filename}...")
        response = requests.get(url, stream=True)
        response.raise_for_status()

        with open(output_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

    print("Download complete.")
    
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, help="Path to candidate GeoJSON")
    parser.add_argument("--candidate-id", required=True, help="Candidate ID")
    parser.add_argument("--coverage", required=True, help="Path to coverage GeoJSON")
    parser.add_argument("--output", required=True, help="Output folder for LAZ files")

    args = parser.parse_args()

    print("Loading candidate polygon...")
    candidate_geom = load_candidate_polygon(args.candidate, args.candidate_id)

    print("Loading tile coverage...")
    tiles = load_tiles(args.coverage)

    print("Finding intersecting tiles...")
    urls = find_intersecting_tiles(candidate_geom, tiles)

    print(f"Found {len(urls)} intersecting tiles.")

    if not urls:
        print("No tiles intersect this candidate.")
        return

    download_tiles(urls, args.output)


if __name__ == "__main__":
    main()