import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type Severity = "HIGH" | "MEDIUM" | "LOW";

type HazardRow = {
  candidate_id?: string;
  hazard_type?: string;
  step_m?: any;
  cross_slope_max_pct?: any;
  cross_slope_pct?: any;
  severity: Severity;
  __coords: [number, number]; // [lng, lat]
  [k: string]: any;
};

export default function Map() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Keep only one popup open at a time
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const [expanded, setExpanded] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  // -----------------------------
  // Side Panel State
  // -----------------------------
  const [panelOpen, setPanelOpen] = useState(true);
  const [hazards, setHazards] = useState<HazardRow[]>([]);
  const [selected, setSelected] = useState<HazardRow | null>(null);
  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"ALL" | Severity>("ALL");

  // -----------------------------
  // Load hazard data for panel
  // (same source your map uses)
  // -----------------------------
  useEffect(() => {
    fetch("/api/brookline/flags")
      .then((r) => r.json())
      .then((geo) => {
        const feats = Array.isArray(geo?.features) ? geo.features : [];

        const rows: HazardRow[] = feats
          .map((f: any) => {
            const props = f?.properties ?? {};
            const coords = f?.geometry?.coordinates;

            if (!coords || !Array.isArray(coords) || coords.length < 2) return null;

            const stepMm = props.step_m != null ? Number(props.step_m) * 1000 : 0;

            // prefer cross_slope_max_pct (your current field), fallback to cross_slope_pct
            const slope =
              props.cross_slope_max_pct != null
                ? Number(props.cross_slope_max_pct)
                : props.cross_slope_pct != null
                  ? Number(props.cross_slope_pct)
                  : 0;

            let severity: Severity = "LOW";
            if (stepMm >= 40 || slope >= 8) severity = "HIGH";
            else if (stepMm >= 20 || slope >= 5) severity = "MEDIUM";

            return {
              ...props,
              severity,
              __coords: [coords[0], coords[1]],
            } as HazardRow;
          })
          .filter(Boolean);

        setHazards(rows);
      })
      .catch(console.error);
  }, []);

  // -----------------------------
  // Filtered list for panel
  // -----------------------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return hazards.filter((h) => {
      const sevOk = severityFilter === "ALL" ? true : h.severity === severityFilter;

      const qOk =
        !q ||
        String(h.candidate_id ?? "").toLowerCase().includes(q) ||
        String(h.hazard_type ?? "").toLowerCase().includes(q);

      return sevOk && qOk;
    });
  }, [hazards, query, severityFilter]);

  // -----------------------------
  // Popup builder used by panel flyTo and map clicks
  // -----------------------------
  function openPopupFromHazard(h: HazardRow) {
    const map = mapRef.current;
    if (!map) return;

    if (popupRef.current) popupRef.current.remove();

    const stepMm = h.step_m != null ? Number(h.step_m) * 1000 : 0;
    const slope =
      h.cross_slope_max_pct != null
        ? Number(h.cross_slope_max_pct)
        : h.cross_slope_pct != null
          ? Number(h.cross_slope_pct)
          : 0;

    let priority: Severity = "LOW";
    let priorityColor = "#00cc66";
    if (stepMm >= 40 || slope >= 8) {
      priority = "HIGH";
      priorityColor = "#ff0000";
    } else if (stepMm >= 20 || slope >= 5) {
      priority = "MEDIUM";
      priorityColor = "#ffaa00";
    }

    popupRef.current = new maplibregl.Popup()
      .setLngLat(h.__coords)
      .setHTML(`
        <div style="font-size:14px">
          <strong>Sidewalk Hazard</strong><br/>
          Candidate: ${h.candidate_id ?? "—"}<br/>
          Type: ${h.hazard_type ?? "—"}<br/>
          Step: ${stepMm.toFixed(1)} mm<br/>
          Cross-slope: ${slope.toFixed(2)} %<br/>
          <strong style="color:${priorityColor}">
            Repair Priority: ${priority}
          </strong>
        </div>
      `)
      .addTo(map);
  }

  // -----------------------------
  // Fly-to helper for panel clicks
  // -----------------------------
function flyToHazard(h: HazardRow) {
  const map = mapRef.current;
  if (!map) return;

  setSelected(h);

  map.flyTo({
    center: h.__coords,
    zoom: 17,
    speed: 1.2,
    essential: true,
  });

  map.once("moveend", () => {
    openPopupFromHazard(h);
  });
}

function onImageRefClick(h: HazardRow) {
  console.log("image ref:", h.candidate_id);
}

// -----------------------------
// Image reference button handler (for later use)
// -----------------------------
function onImageRefClick(h: HazardRow) {
  console.log("image ref:", h.candidate_id);
}

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
      attributionControl: false, // we’ll add compact attribution manually
    });

    mapRef.current = map;

    // compact attribution bottom-left (keeps bottom-right clean)
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("load", async () => {
      // =====================================================
      // 🧱 BOUNDARY + MASK
      // =====================================================
      const response = await fetch("/brookline_boundary.geojson");
      const geo = await response.json();
      const coords = geo.features[0].geometry.coordinates;

      const bounds = new maplibregl.LngLatBounds();
      coords[0].forEach((coord: number[]) => bounds.extend(coord));

      // a bit more breathing room (you already tuned this)
      map.fitBounds(bounds, { padding: 120, duration: 0 });
      map.setMaxBounds(bounds);

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

      map.addSource("brookline", { type: "geojson", data: geo });

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
      // 🏙️ 3D BUILDINGS (optional if style provides it)
      // =====================================================
      const layers = map.getStyle().layers;
      const labelLayerId = layers?.find(
        (layer) =>
          layer.type === "symbol" &&
          layer.layout &&
          (layer.layout as any)["text-field"]
      )?.id;

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
      }

      // =====================================================
      // 🚨 HAZARDS SOURCE + LAYERS (your current 2 layers)
      // =====================================================
      map.addSource("hazards", {
        type: "geojson",
        data: "/api/brookline/flags",
      });

      map.addLayer({
        id: "hazard-vertical-steps",
        type: "circle",
        source: "hazards",
        filter: ["==", ["get", "hazard_type"], "VERTICAL_STEP"],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["*", ["to-number", ["get", "step_m"], 0], 1000],
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
            "#ff0000",
            [">=", ["*", ["to-number", ["get", "step_m"], 0], 1000], 20],
            "#ffaa00",
            "#00cc66",
          ],
          "circle-opacity": 0.9,
        },
      });

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
            "#ff00aa",
            [">=", ["to-number", ["get", "cross_slope_max_pct"], 0], 2],
            "#00e5ff",
            "#00cc66",
          ],
          "circle-opacity": 0.9,
        },
      });

      // =====================================================
      // 🖱️ Map click popups should also sync panel selection
      // =====================================================
      const hazardLayerIds = ["hazard-vertical-steps", "hazard-cross-slope"] as const;

      function showHazardPopup(e: MapLayerMouseEvent) {
        e.originalEvent?.stopPropagation();

        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties as any;
        const coordinates = (feature.geometry as any).coordinates.slice() as [number, number];

        const row: HazardRow = {
          ...props,
          __coords: [coordinates[0], coordinates[1]],
          severity: "LOW", // will be recomputed in openPopupFromHazard
        };

        // compute severity now for highlighting
        const stepMm = props.step_m != null ? Number(props.step_m) * 1000 : 0;
        const slope =
          props.cross_slope_max_pct != null
            ? Number(props.cross_slope_max_pct)
            : props.cross_slope_pct != null
              ? Number(props.cross_slope_pct)
              : 0;

        if (stepMm >= 40 || slope >= 8) row.severity = "HIGH";
        else if (stepMm >= 20 || slope >= 5) row.severity = "MEDIUM";

        setSelected(row);
        openPopupFromHazard(row);
      }

      for (const id of hazardLayerIds) {
        map.on("click", id, showHazardPopup);
        map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
      }
    });

    return () => {
      if (popupRef.current) popupRef.current.remove();
      map.remove();
    };
  }, [darkMode]);

  useEffect(() => {
  const map = mapRef.current;
  if (!map) return;

  if (!map.getLayer("hazard-vertical-steps")) return;

  if (severityFilter === "ALL") {
    map.setFilter("hazard-vertical-steps", [
      "==",
      ["get", "hazard_type"],
      "VERTICAL_STEP"
    ]);

    map.setFilter("hazard-cross-slope", [
      "==",
      ["get", "hazard_type"],
      "CROSS_SLOPE_MAX"
    ]);

    return;
  }

  const verticalFilter =
    severityFilter === "HIGH"
      ? [
          "all",
          ["==", ["get", "hazard_type"], "VERTICAL_STEP"],
          [">=", ["*", ["to-number", ["get", "step_m"], 0], 1000], 40],
        ]
      : severityFilter === "MEDIUM"
      ? [
          "all",
          ["==", ["get", "hazard_type"], "VERTICAL_STEP"],
          [">=", ["*", ["to-number", ["get", "step_m"], 0], 1000], 20],
          ["<", ["*", ["to-number", ["get", "step_m"], 0], 1000], 40],
        ]
      : [
          "all",
          ["==", ["get", "hazard_type"], "VERTICAL_STEP"],
          ["<", ["*", ["to-number", ["get", "step_m"], 0], 1000], 20],
        ];

  const slopeFilter =
    severityFilter === "HIGH"
      ? [
          "all",
          ["==", ["get", "hazard_type"], "CROSS_SLOPE_MAX"],
          [">=", ["to-number", ["get", "cross_slope_max_pct"], 0], 8],
        ]
      : severityFilter === "MEDIUM"
      ? [
          "all",
          ["==", ["get", "hazard_type"], "CROSS_SLOPE_MAX"],
          [">=", ["to-number", ["get", "cross_slope_max_pct"], 0], 5],
          ["<", ["to-number", ["get", "cross_slope_max_pct"], 0], 8],
        ]
      : [
          "all",
          ["==", ["get", "hazard_type"], "CROSS_SLOPE_MAX"],
          ["<", ["to-number", ["get", "cross_slope_max_pct"], 0], 5],
        ];

  map.setFilter("hazard-vertical-steps", verticalFilter);
  map.setFilter("hazard-cross-slope", slopeFilter);

}, [severityFilter]);

  // Resize map after expand animation completes
  useEffect(() => {
    setTimeout(() => {
      mapRef.current?.resize();
    }, 350);
  }, [expanded]);

  return (
    <>
      <div
        onClick={(e) => {
          const clickedButton = (e.target as HTMLElement).closest("button");
          if (clickedButton) return;
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
              zIndex: 30,
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
            bottom: 20,
            right: 20,
            zIndex: 30,
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            cursor: "pointer",
            fontWeight: 600,
            background: darkMode ? "#ffffff" : "#111111",
            color: darkMode ? "#000000" : "#ffffff",
            boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
          }}
        >
          {darkMode ? "☀ Light" : "🌙 Dark"}
        </button>

        {/* ========================= */}
        {/* OVERLAY SIDE PANEL (only when expanded) */}
        {/* ========================= */}
        {expanded && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              height: "100%",
              width: panelOpen ? 360 : 44,
              background: "rgba(10,10,12,0.95)",
              borderRight: "1px solid rgba(255,255,255,0.1)",
              color: "white",
              zIndex: 25,
              transition: "width 0.25s ease",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 14, display: "flex", gap: 10, alignItems: "center" }}>
              <button
                onClick={() => setPanelOpen(!panelOpen)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "transparent",
                  color: "white",
                  cursor: "pointer",
                }}
                title={panelOpen ? "Collapse panel" : "Expand panel"}
              >
                {panelOpen ? "⟨" : "⟩"}
              </button>

              {panelOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>Hazards</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>
                    Showing {Math.min(filtered.length, 250)} / {hazards.length}
                  </div>
                </div>
              )}
            </div>

            {panelOpen && (
              <div
                style={{
                  padding: 14,
                  height: "calc(100% - 60px)",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search candidate or type"
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.05)",
                    color: "white",
                    outline: "none",
                  }}
                />

                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {(["ALL", "HIGH", "MEDIUM", "LOW"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSeverityFilter(s)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: "1px solid rgba(255,255,255,0.2)",
                        background:
                          severityFilter === s ? "rgba(255,255,255,0.15)" : "transparent",
                        color: "white",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                {selected && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      borderRadius: 12,
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.10)",
                    }}
                  >
                    <div style={{ fontWeight: 800 }}>
                      {selected.severity} • {selected.hazard_type ?? "Unknown"}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                      Candidate: {selected.candidate_id ?? "-"}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 12, overflow: "auto", flex: 1, paddingRight: 4 }}>
                  {filtered.slice(0, 250).map((h, i) => {
                    const isActive =
                      String(selected?.candidate_id ?? "") === String(h.candidate_id ?? "");

                    return (
                      <button
                        key={`${h.candidate_id ?? "row"}-${i}`}
                        onClick={() => flyToHazard(h)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: 10,
                          borderRadius: 10,
                          marginBottom: 8,
                          border: "1px solid rgba(255,255,255,0.1)",
                          background: isActive ? "rgba(255,255,255,0.12)" : "transparent",
                          color: "white",
                          cursor: "pointer",
                        }}
                      >
<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
  <div style={{ flex: 1 }}>
    <div style={{ fontWeight: 800, fontSize: 13 }}>
      {h.severity} • {h.hazard_type ?? "Unknown"}
    </div>
    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 3 }}>
      {h.candidate_id ?? "-"}
    </div>
  </div>

  <button
    onClick={(e) => {
      e.stopPropagation();
      onImageRefClick(h);
    }}
    style={{
      width: 28,
      height: 28,
      borderRadius: 8,
      border: "1px solid rgba(255,255,255,0.2)",
      background: "rgba(255,255,255,0.08)",
      color: "white",
      cursor: "pointer",
    }}
  >
    🖼️
  </button>
</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      </div>
    </>
  );
}