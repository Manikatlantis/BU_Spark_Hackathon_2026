import { useEffect, useRef, useState } from "react";
import maplibregl, { MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export default function Map() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  useEffect(() => {
    if (!mapContainer.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: darkMode
        ? `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`
        : `https://api.maptiler.com/maps/streets/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
      center: [-71.13, 42.335],
      zoom: 13,
      pitch: 60,
      bearing: -20,
      antialias: true,
      maxZoom: 18,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl());

    map.on("load", async () => {
      // =====================================================
      // 🧱 BROOKLINE BOUNDARY + MASK
      // =====================================================
      const response = await fetch("/brookline_boundary.geojson");
      const geo = await response.json();
      const coords = geo.features[0].geometry.coordinates;

      // ---- Fit & Lock Bounds ----
      const bounds = new maplibregl.LngLatBounds();
      coords[0].forEach((coord: number[]) => bounds.extend(coord));
      map.fitBounds(bounds, { padding: 40, duration: 0 });
      map.setMaxBounds(bounds);

      // ---- Mask ----
      const maskGeoJSON = {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-180, -90],
              [180, -90],
              [180, 90],
              [-180, 90],
              [-180, -90],
            ],
            ...coords,
          ],
        },
      };

      map.addSource("brookline-mask", {
        type: "geojson",
        data: maskGeoJSON as any,
      });

      map.addLayer({
        id: "brookline-mask-layer",
        type: "fill",
        source: "brookline-mask",
        paint: {
          "fill-color": "#000000",
          "fill-opacity": darkMode ? 0.18 : 0.08,
        },
      });

      // ---- Outline ----
      map.addSource("brookline", {
        type: "geojson",
        data: geo,
      });

      map.addLayer({
        id: "brookline-outline",
        type: "line",
        source: "brookline",
        paint: {
          "line-color": darkMode ? "#00e5ff" : "#ff4d4d",
          "line-width": 2.5,
        },
      });

      // =====================================================
      // 🏙️ 3D BUILDINGS
      // =====================================================
      const layers = map.getStyle().layers;
      const labelLayerId = layers?.find(
        (layer) =>
          layer.type === "symbol" &&
          layer.layout &&
          (layer.layout as any)["text-field"]
      )?.id;

      // MapTiler styles often name the vector source differently.
      // Only add 3D buildings if the source exists.
      const styleSources = map.getStyle().sources as Record<string, any>;
      const hasOpenMapTiles = !!styleSources["openmaptiles"];
      const hasMapTiler = !!styleSources["maptiler_planet"];

      const buildingsSource = hasOpenMapTiles
        ? { source: "openmaptiles", sourceLayer: "building" }
        : hasMapTiler
          ? { source: "maptiler_planet", sourceLayer: "building" }
          : null;

      if (buildingsSource) {
        map.addLayer(
          {
            id: "3d-buildings",
            source: buildingsSource.source,
            "source-layer": buildingsSource.sourceLayer,
            type: "fill-extrusion",
            minzoom: 14,
            paint: {
              "fill-extrusion-color": darkMode ? "#888888" : "#cccccc",
              "fill-extrusion-height": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                0,
                16,
                ["get", "render_height"],
              ],
              "fill-extrusion-base": ["get", "render_min_height"],
              "fill-extrusion-opacity": 0.85,
            },
          },
          labelLayerId
        );
      } else {
        // No compatible buildings source in this style; skip 3D buildings.
        console.warn("No vector buildings source found in style; skipping 3D buildings.");
      }

      // =====================================================
      // 🚨 HAZARDS SOURCE
      // =====================================================
      map.addSource("hazards", {
        type: "geojson",
        data: "/api/brookline/flags",
      });

      // =====================================================
      // 🚨 HAZARD LAYERS
      // =====================================================

      // 1) Vertical steps
      map.addLayer({
        id: "hazard-vertical-steps",
        type: "circle",
        source: "hazards",
        filter: ["==", ["get", "hazard_type"], "VERTICAL_STEP"],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["*", ["to-number", ["get", "step_m"], 0], 1000], // meters -> mm
            0,
            4,
            20,
            7,
            40,
            10,
            80,
            14,
          ],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
          "circle-color": [
            "case",
            [">=", ["*", ["to-number", ["get", "step_m"], 0], 1000], 40],
            "#ff0000", // >= 40mm
            [">=", ["*", ["to-number", ["get", "step_m"], 0], 1000], 20],
            "#ffaa00", // >= 20mm
            "#00cc66",
          ],
          "circle-opacity": 0.9,
        },
      });

      // 2) Cross-slope max points (uses cross_slope_max_pct)
      map.addLayer({
        id: "hazard-cross-slope",
        type: "circle",
        source: "hazards",
        filter: ["==", ["get", "hazard_type"], "CROSS_SLOPE_MAX"],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["to-number", ["get", "cross_slope_max_pct"], 0],
            0,
            5,
            2,
            7,
            10,
            10,
            20,
            12,
            30,
            14,
          ],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
          "circle-color": [
            "case",
            [">=", ["to-number", ["get", "cross_slope_max_pct"], 0], 10],
            "#ff00aa", // very steep
            [">=", ["to-number", ["get", "cross_slope_max_pct"], 0], 2],
            "#00e5ff", // ADA-ish threshold
            "#00cc66",
          ],
          "circle-opacity": 0.9,
        },
      });

      // =====================================================
      // 🖱️ CLICK POPUP (works for both hazard layers)
      // =====================================================
      const hazardLayerIds = ["hazard-vertical-steps", "hazard-cross-slope"] as const;

      function showHazardPopup(e: MapLayerMouseEvent) {
        // Important: stop the wrapper div click from expanding the map
        e.originalEvent?.stopPropagation();

        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties as any;
        const coordinates = (feature.geometry as any).coordinates.slice();

        // step_m is meters in your GeoJSON (or null for cross-slope points)
        const stepMm = props.step_m != null ? Number(props.step_m) * 1000 : 0;

        // your slope field is cross_slope_max_pct (not cross_max / plane_slope_pct)
        // const slope =
        //   props.cross_slope_max_pct != null ? Number(props.cross_slope_max_pct) : 0;

        const slope =
          props.cross_slope_max_pct != null
            ? Number(props.cross_slope_max_pct)
            : props.cross_slope_pct != null
              ? Number(props.cross_slope_pct)
              : 0;

        let priority = "LOW";
        let priorityColor = "#00cc66";

        // keep your logic, but use >= so exact thresholds count
        if (stepMm >= 40 || slope >= 8) {
          priority = "HIGH";
          priorityColor = "#ff0000";
        } else if (stepMm >= 20 || slope >= 5) {
          priority = "MEDIUM";
          priorityColor = "#ffaa00";
        }

        new maplibregl.Popup()
          .setLngLat(coordinates)
          .setHTML(`
            <div style="font-size:14px">
              <strong>Sidewalk Hazard</strong><br/>
              Candidate: ${props.candidate_id ?? "—"}<br/>
              Type: ${props.hazard_type ?? "—"}<br/>
              Step: ${stepMm.toFixed(1)} mm<br/>
              Cross-slope: ${slope.toFixed(2)} %<br/>
              
              <strong style="color:${priorityColor}">
                Repair Priority: ${priority}
              </strong>
            </div>
          `)
          .addTo(map);
      }

      for (const id of hazardLayerIds) {
        map.on("click", id, showHazardPopup);

        map.on("mouseenter", id, () => {
          map.getCanvas().style.cursor = "pointer";
        });

        map.on("mouseleave", id, () => {
          map.getCanvas().style.cursor = "";
        });
      }
    });

    return () => {
      map.remove();
    };
  }, [darkMode]);

  useEffect(() => {
    setTimeout(() => {
      mapRef.current?.resize();
    }, 350);
  }, [expanded]);

  return (
    <>
      <div
        onClick={(e) => {
          // Only expand when clicking the wrapper itself (not the map canvas / markers / controls)
          if (e.target !== e.currentTarget) return;
          if (!expanded) setExpanded(true);
        }}
        style={{
          position: expanded ? "fixed" : "absolute",
          top: expanded ? 0 : "50%",
          right: expanded ? 0 : "5%",
          transform: expanded ? "none" : "translateY(-50%)",
          width: expanded ? "100vw" : "45vw",
          height: expanded ? "100vh" : "55vh",
          borderRadius: expanded ? 0 : 18,
          overflow: "hidden",
          boxShadow: expanded ? "none" : "0 25px 80px rgba(0,0,0,0.45)",
          transition: "all 0.4s ease",
          cursor: expanded ? "default" : "pointer",
          zIndex: 10,
          background: "#111",
        }}
      >
        {expanded && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
            style={{
              position: "absolute",
              top: 20,
              right: 20,
              zIndex: 20,
              padding: "8px 14px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
              background: "#ffffff",
              color: "#000000",
            }}
          >
            ✕ Close
          </button>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            setDarkMode(!darkMode);
          }}
          style={{
            position: "absolute",
            top: 20,
            left: 20,
            zIndex: 20,
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            fontWeight: 600,
            background: darkMode ? "#ffffff" : "#111111",
            color: darkMode ? "#000000" : "#ffffff",
          }}
        >
          {darkMode ? "☀ Light" : "🌙 Dark"}
        </button>

        <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      </div>
    </>
  );
}