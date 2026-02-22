import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type Severity = "HIGH" | "MEDIUM" | "LOW";

type HazardRow = {
  candidate_id?: string;
  hazard_type?: string;
  step_m?: any;
  plane_slope_pct?: any;
  severity: Severity;
  __coords: [number, number]; // [lng, lat]
  [k: string]: any;
};

export default function Map() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // ✅ NEW (minimal): keep one popup at a time
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const [expanded, setExpanded] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  // ✅ Graph drawer state (ADD THIS)
const [graphOpen, setGraphOpen] = useState(false);
const [graphCandidate, setGraphCandidate] = useState<string | null>(null);

function openGraphDrawer(candidateId?: string) {
  setGraphCandidate(candidateId ?? null);
  setGraphOpen(true);
}

  // -----------------------------
  // Overlay Side Panel State
  // -----------------------------
  const [panelOpen, setPanelOpen] = useState(true);
  const [hazards, setHazards] = useState<HazardRow[]>([]);
  const [selected, setSelected] = useState<HazardRow | null>(null);
  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"ALL" | Severity>("ALL");

  // -----------------------------
  // Load hazard data for panel
  // -----------------------------
  useEffect(() => {
    fetch("/flagged_points.geojson")
      .then((r) => r.json())
      .then((geo) => {
        const feats = Array.isArray(geo?.features) ? geo.features : [];
        const rows: HazardRow[] = feats
          .map((f: any) => {
            const props = f?.properties ?? {};
            const coords = f?.geometry?.coordinates;

            if (!coords || !Array.isArray(coords) || coords.length < 2) return null;

            const stepMm = props.step_m ? Number(props.step_m) * 1000 : 0;
            const slope = props.plane_slope_pct ? Number(props.plane_slope_pct) : 0;

            let severity: Severity = "LOW";
            if (stepMm > 40 || slope > 8) severity = "HIGH";
            else if (stepMm > 20 || slope > 5) severity = "MEDIUM";

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

  // ✅ NEW (minimal): popup builder used by panel-click flyTo
  function openPopupFromHazard(h: HazardRow) {
    if (!mapRef.current) return;

    // keep only one popup open
    if (popupRef.current) popupRef.current.remove();

    const stepMm = h.step_m ? Number(h.step_m) * 1000 : 0;
    const slope = h.plane_slope_pct ? Number(h.plane_slope_pct) : 0;

    let priority: Severity = "LOW";
    let priorityColor = "#00cc66";

    if (stepMm > 40 || slope > 8) {
      priority = "HIGH";
      priorityColor = "#ff0000";
    } else if (stepMm > 20 || slope > 5) {
      priority = "MEDIUM";
      priorityColor = "#ffaa00";
    }

    popupRef.current = new maplibregl.Popup()
      .setLngLat(h.__coords)
      .setHTML(`
        <div style="font-size:14px">
          <strong>Sidewalk Hazard</strong><br/>
          Candidate: ${h.candidate_id}<br/>
          Type: ${h.hazard_type}<br/>
          Step: ${stepMm.toFixed(1)} mm<br/>
          Slope: ${slope.toFixed(2)} %<br/>
          <strong style="color:${priorityColor}">
            Repair Priority: ${priority}
          </strong>
        </div>
      `)
      .addTo(mapRef.current);
  }

  // -----------------------------
  // Fly-to helper (ONLY change: open popup after move)
  // -----------------------------
  function flyToHazard(h: HazardRow) {
    setSelected(h);
    if (!mapRef.current) return;

    mapRef.current.flyTo({
      center: h.__coords,
      zoom: 17,
      speed: 1.2,
    });

    // ✅ show popup automatically when the fly animation ends
    mapRef.current.once("moveend", () => {
      openPopupFromHazard(h);
    });
  }

  // -----------------------------
  // Map setup
  // -----------------------------
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
      attributionControl: false // 👈 (your existing setting)
    });

    mapRef.current = map;

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

      // =====================================================
      // ✅ OUTLINE SOURCE + "FLOATING" OUTLINE STACK (ONLY CHANGED PART)
      // =====================================================

      // ---- Outline SOURCE (you need this for any line layer that uses source "brookline") ----
      map.addSource("brookline", {
        type: "geojson",
        data: geo
      });

      // Shadow (under everything)
      map.addLayer({
        id: "brookline-outline-shadow",
        type: "line",
        source: "brookline",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#000000",
          "line-width": 26,
          "line-opacity": darkMode ? 0.22 : 0.16,
          "line-blur": 18
        }
      });

      // Outer glow
      map.addLayer({
        id: "brookline-outline-outerglow",
        type: "line",
        source: "brookline",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": darkMode ? "#00e5ff" : "#ff4d4d",
          "line-width": 18,
          "line-opacity": darkMode ? 0.30 : 0.22,
          "line-blur": 12
        }
      });

      // Inner glow
      map.addLayer({
        id: "brookline-outline-innerglow",
        type: "line",
        source: "brookline",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": darkMode ? "#7ff6ff" : "#ff9a9a",
          "line-width": 8,
          "line-opacity": darkMode ? 0.55 : 0.40,
          "line-blur": 6
        }
      });

      // Crisp main line (ON TOP) — your original color line
      map.addLayer({
        id: "brookline-outline",
        type: "line",
        source: "brookline",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": darkMode ? "#00e5ff" : "#ff4d4d",
          "line-width": 2.5,
          "line-opacity": 1
        }
      });

      // ---- 3D Buildings ----
      const layers = map.getStyle().layers;
      const labelLayerId = layers?.find(
        (layer) => layer.type === "symbol" && layer.layout && (layer.layout as any)["text-field"]
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
            [">", ["*", ["to-number", ["get", "step_m"]], 1000], 40],
            "#ff0000",
            [">", ["*", ["to-number", ["get", "step_m"]], 1000], 20],
            "#ffaa00",
            "#00cc66",
          ],
        },
      });

      // =====================================================
      // 🚨 CLICK POPUP WITH PRIORITY LOGIC (unchanged)
      // =====================================================
      map.on("click", "hazard-points", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties as any;
        const coordinates = (feature.geometry as any).coordinates.slice() as [number, number];

        const stepMm = props.step_m ? Number(props.step_m) * 1000 : 0;
        const slope = props.plane_slope_pct ? Number(props.plane_slope_pct) : 0;

        let priority: Severity = "LOW";
        let priorityColor = "#00cc66";

        if (stepMm > 40 || slope > 8) {
          priority = "HIGH";
          priorityColor = "#ff0000";
        } else if (stepMm > 20 || slope > 5) {
          priority = "MEDIUM";
          priorityColor = "#ffaa00";
        }

        // sync selection (your existing behavior)
        setSelected({
          ...props,
          severity: priority,
          __coords: [coordinates[0], coordinates[1]],
        });

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

  // Resize map after expand animation completes
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
            boxShadow: "0 8px 20px rgba(0,0,0,0.35)"
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
            {/* Header */}
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
                {/* Search */}
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

                {/* Filters */}
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

                {/* Selected */}
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

                {/* List */}
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
                        <div style={{ fontWeight: 800, fontSize: 13 }}>
                          {h.severity} • {h.hazard_type ?? "Unknown"}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 3 }}>
                          {h.candidate_id ?? "-"}
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