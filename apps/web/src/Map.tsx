import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
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
      maxZoom: 18
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl());

    map.on("load", async () => {
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
              [-180, -90]
            ],
            ...coords
          ]
        }
      };

      map.addSource("brookline-mask", {
        type: "geojson",
        data: maskGeoJSON as any
      });

      map.addLayer({
        id: "brookline-mask-layer",
        type: "fill",
        source: "brookline-mask",
        paint: {
          "fill-color": "#000000",
          "fill-opacity": darkMode ? 0.18 : 0.08
        }
      });

      // ---- Outline ----
      map.addSource("brookline", {
        type: "geojson",
        data: geo
      });

      map.addLayer({
        id: "brookline-outline",
        type: "line",
        source: "brookline",
        paint: {
          "line-color": darkMode ? "#00e5ff" : "#ff4d4d",
          "line-width": 2.5
        }
      });

      // ---- 3D Buildings ----
      const layers = map.getStyle().layers;
      const labelLayerId = layers?.find(
        (layer) =>
          layer.type === "symbol" &&
          layer.layout &&
          layer.layout["text-field"]
      )?.id;

      map.addLayer(
        {
          id: "3d-buildings",
          source: "openmaptiles",
          "source-layer": "building",
          type: "fill-extrusion",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": darkMode ? "#888888" : "#cccccc",
            "fill-extrusion-height": [
              "interpolate",
              ["linear"],
              ["zoom"],
              14, 0,
              16, ["get", "render_height"]
            ],
            "fill-extrusion-base": ["get", "render_min_height"],
            "fill-extrusion-opacity": 0.85
          }
        },
        labelLayerId
      );

      // =====================================================
      // 🚨 HAZARD SOURCE
      // =====================================================

      map.addSource("hazards", {
        type: "geojson",
        data: "/flagged_points.geojson",
      });

      // =====================================================
      // 🚨 HAZARD LAYER (Severity Coloring)
      // =====================================================

      map.addLayer({
        id: "hazard-points",
        type: "circle",
        source: "hazards",
        paint: {
          "circle-radius": 6,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
          "circle-color": [
            "case",
            [">", ["*", ["to-number", ["get", "step_m"]], 1000], 40], "#ff0000",
            [">", ["*", ["to-number", ["get", "step_m"]], 1000], 20], "#ffaa00",
            "#00cc66"
          ]
        }
      });

      // =====================================================
      // 🚨 CLICK POPUP WITH PRIORITY LOGIC
      // =====================================================

      map.on("click", "hazard-points", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties as any;
        const coordinates = (feature.geometry as any).coordinates.slice();

        const stepMm = props.step_m
          ? Number(props.step_m) * 1000
          : 0;

        const slope = props.plane_slope_pct
          ? Number(props.plane_slope_pct)
          : 0;

        let priority = "LOW";
        let priorityColor = "#00cc66";

        if (stepMm > 40 || slope > 8) {
          priority = "HIGH";
          priorityColor = "#ff0000";
        } else if (stepMm > 20 || slope > 5) {
          priority = "MEDIUM";
          priorityColor = "#ffaa00";
        }

        new maplibregl.Popup()
          .setLngLat(coordinates)
          .setHTML(`
            <div style="font-size:14px">
              <strong>Sidewalk Hazard</strong><br/>
              Candidate: ${props.candidate_id}<br/>
              Type: ${props.hazard_type}<br/>
              Step: ${stepMm.toFixed(1)} mm<br/>
              Slope: ${slope.toFixed(2)} %<br/>
              <strong style="color:${priorityColor}">
                Repair Priority: ${priority}
              </strong>
            </div>
          `)
          .addTo(map);
      });

      map.on("mouseenter", "hazard-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "hazard-points", () => {
        map.getCanvas().style.cursor = "";
      });
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
        onClick={() => !expanded && setExpanded(true)}
        style={{
          position: expanded ? "fixed" : "absolute",
          top: expanded ? 0 : "50%",
          right: expanded ? 0 : "5%",
          transform: expanded ? "none" : "translateY(-50%)",
          width: expanded ? "100vw" : "45vw",
          height: expanded ? "100vh" : "55vh",
          borderRadius: expanded ? 0 : 18,
          overflow: "hidden",
          boxShadow: expanded
            ? "none"
            : "0 25px 80px rgba(0,0,0,0.45)",
          transition: "all 0.4s ease",
          cursor: expanded ? "default" : "pointer",
          zIndex: 10,
          background: "#111"
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
              color: "#000000"
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
            color: darkMode ? "#000000" : "#ffffff"
          }}
        >
          {darkMode ? "☀ Light" : "🌙 Dark"}
        </button>

        <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      </div>
    </>
  );
}