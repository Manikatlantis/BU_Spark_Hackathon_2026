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

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const [expanded, setExpanded] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  // ✅ keep one popup at a time
  const popupRef = useRef<maplibregl.Popup | null>(null);

  // =========================
  // Side panel state (added)
  // =========================
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

  // -----------------------------
  // Popup helper (used by panel + click)
  // -----------------------------
  function openPopupAt(coords: [number, number], props: any) {
    if (!mapRef.current) return;

    if (popupRef.current) popupRef.current.remove();

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

    setSelected({
      ...props,
      severity: priority,
      __coords: [coords[0], coords[1]],
    });

    popupRef.current = new maplibregl.Popup()
      .setLngLat(coords)
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
      .addTo(mapRef.current);
  }

  // -----------------------------
  // Fly-to helper (panel click)
  // -----------------------------
  function flyToHazard(h: HazardRow) {
    setSelected(h);
    if (!mapRef.current) return;

    mapRef.current.flyTo({
      center: h.__coords,
      zoom: 17,
      speed: 1.2,
    });

    mapRef.current.once("moveend", () => {
      openPopupAt(h.__coords, h);
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
      attributionControl: false,
    });

    mapRef.current = map;

    // ✅ remove top-right arrows by NOT adding NavigationControl
    // map.addControl(new maplibregl.NavigationControl());

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

      // ---- 3D Buildings ----
      const layers = map.getStyle().layers;
      const labelLayerId = layers?.find(
        (layer) =>
          layer.type === "symbol" &&
          layer.layout &&
          (layer.layout as any)["text-field"]
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
      // 🚨 CLICK POPUP WITH PRIORITY LOGIC
      // =====================================================
      map.on("click", "hazard-points", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties as any;
        const coordinates = (feature.geometry as any).coordinates.slice() as [number, number];

        openPopupAt([coordinates[0], coordinates[1]], props);
      });

      map.on("mouseenter", "hazard-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "hazard-points", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      if (popupRef.current) popupRef.current.remove();
      map.remove();
    };
  }, [darkMode]);

  // scroll updates CSS var only — jitter fix (Safari bounce + no rounding)
  useEffect(() => {
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    const collapsePx = 900;

    let raf = 0;

    const update = () => {
      raf = 0;
      const y = Math.max(0, window.scrollY);
      const t = 1 - clamp01(y / collapsePx);
      document.documentElement.style.setProperty("--scrollExpand", String(t));
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    update();

    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    setTimeout(() => {
      mapRef.current?.resize();
    }, 350);
  }, [expanded]);

  return (
    <>
      <div
        ref={wrapperRef}
        onClick={() => !expanded && setExpanded(true)}
        style={{
          position: expanded ? "fixed" : "absolute",
          top: expanded ? 0 : "calc(50% + 78px + 2in)",
          right: expanded ? 0 : "5%",
          width: expanded ? "100vw" : "calc(45vw + 2in)",
          height: expanded ? "100vh" : "calc(55vh + 2in)",
          transform: expanded
            ? "none"
            : `translateY(-50%) scale(calc(0.25 + (var(--scrollExpand) * 1.25)))`,
          transformOrigin: expanded ? "center center" : "100% 100%",
          borderRadius: expanded ? 0 : 18,
          overflow: "hidden",
          boxShadow: expanded ? "none" : "0 25px 80px rgba(0,0,0,0.45)",
          transition: expanded ? "all 0.4s ease" : "transform 0ms",
          willChange: "transform",
          cursor: expanded ? "default" : "pointer",
          zIndex: 10,
          background: "#111",
        }}
      >
        {/* ✅ Fullscreen minimize moved to bottom-right */}
        {expanded && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
            style={{
              position: "absolute",
              bottom: 20,
              right: 20,
              zIndex: 40,
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

        {/* ✅ Light/Dark moved to bottom-left */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setDarkMode(!darkMode);
          }}
          style={{
            position: "absolute",
            bottom: 20,
            left: 20,
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
              top: "50%",
              transform: "translateY(-50%)",
              left: 0,
              height: "70%",
              width: panelOpen ? 360 : 44,
              background: "rgba(10,10,12,0.95)",
              borderRight: "1px solid rgba(255,255,255,0.1)",
              color: "white",
              zIndex: 25,
              transition: "width 0.25s ease",
              overflow: "hidden",
              borderTopRightRadius: 14,
              borderBottomRightRadius: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {panelOpen && (
              <div
                style={{
                  padding: 14,
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>Hazards</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>
                    Showing {Math.min(filtered.length, 250)} / {hazards.length}
                  </div>
                </div>

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

            {/* ✅ Collapse/Expand button moved to TOP-RIGHT of panel */}
            <button
              onClick={() => setPanelOpen(!panelOpen)}
              style={{
                position: "absolute",
                top: 10,
                right: 10,
                width: 32,
                height: 32,
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(0,0,0,0.2)",
                color: "white",
                cursor: "pointer",
              }}
              title={panelOpen ? "Collapse panel" : "Expand panel"}
            >
              {panelOpen ? "⟨" : "⟩"}
            </button>
          </div>
        )}

        <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      </div>
    </>
  );
}