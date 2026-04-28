import React, { useState, useEffect, useRef, useCallback } from 'react';
import { httpsCallable } from 'firebase/functions';
import { ref, onValue } from 'firebase/database';
import { db, functions } from '../api/firebaseConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Play, Pause, RotateCcw, Activity, Shield, Zap, Leaf, Truck, Send, Clock } from 'lucide-react';
import * as d3 from 'd3';
import { feature } from 'topojson-client';
import { runSimulation, NODE_COORDS, haversineKm } from '../utils/aegisEngine';

const WORLD_URL = "https://unpkg.com/world-atlas@2/countries-110m.json";

const CASE_META = {
  semiconductor: { label: 'Semiconductor', icon: '🔬', color: '#60a5fa', desc: 'Chip fabrication supply chain — Japan, Taiwan, Korea → India assembly' },
  logistics: { label: 'Global Logistics', icon: '🚢', color: '#22c55e', desc: 'Shipping corridor — China ports → Singapore/Dubai → Distribution centers' },
  humanitarian: { label: 'Humanitarian Aid', icon: '🏥', color: '#f59e0b', desc: 'Emergency aid pipeline — WFP/UNICEF → East Africa conflict zones' },
  live: { label: 'Live Fleet Sync', icon: '🚚', color: '#22c55e', desc: 'Real-time telemetry routed through AEGIS Monte Carlo risk engine' }
};

// Helper for Live Fleet graph building
function generateLiveFleetSimulation(activeTrips) {
  const nodes = [];
  const edges = [];
  const coords = { ...NODE_COORDS };
  const timeline = [];
  const timePaths = [];

  activeTrips.forEach(trip => {
    const truckNode = `Truck ${trip.truck_id}`;
    const destNode = trip.destination?.name || `Dest ${trip.truck_id}`;
    
    nodes.push([truckNode, { tier: 3 }]);
    nodes.push([destNode, { tier: 1 }]);
    edges.push([truckNode, destNode]);
    
    coords[truckNode] = [trip.current_location?.lng || 77.59, trip.current_location?.lat || 12.97];
    coords[destNode] = [trip.destination?.lng || 77.6, trip.destination?.lat || 13.0];
    
    const hubNode = `Safe Hub ${trip.truck_id}`;
    nodes.push([hubNode, { tier: 2 }]);
    edges.push([truckNode, hubNode]);
    edges.push([hubNode, destNode]);
    
    coords[hubNode] = [coords[truckNode][0] + 0.1, coords[truckNode][1] + 0.1];
  });

  if (activeTrips.length === 0) {
    nodes.push(["No Active Fleet", { tier: 2 }]);
    coords["No Active Fleet"] = [77.59, 12.97];
  }

  for (let t = 0; t < 12; t++) {
    const scores = {};
    nodes.forEach(([n]) => {
      let risk = 0.1 + Math.random() * 0.2;
      if (t > 4 && n.includes("Hub")) risk += 0.5;
      scores[n] = Math.min(1, risk);
    });
    timeline.push(scores);
  }

  timeline.forEach(scores => {
    const results = [];
    activeTrips.forEach(trip => {
      const truckNode = `Truck ${trip.truck_id}`;
      const destNode = trip.destination?.name || `Dest ${trip.truck_id}`;
      const hubNode = `Safe Hub ${trip.truck_id}`;
      
      const d1 = haversineKm(coords[truckNode], coords[destNode]);
      results.push({
        path: [truckNode, destNode],
        risk: (scores[truckNode] + scores[destNode]) / 2,
        distance_km: Math.round(d1),
        co2_kg: Math.round(d1 * 0.9),
        trip_id: trip.id,
        dest_lat: coords[destNode][1],
        dest_lng: coords[destNode][0],
        dest_name: destNode
      });

      const d2 = haversineKm(coords[truckNode], coords[hubNode]) + haversineKm(coords[hubNode], coords[destNode]);
      results.push({
        path: [truckNode, hubNode, destNode],
        risk: (scores[truckNode] + scores[hubNode] + scores[destNode]) / 3,
        distance_km: Math.round(d2),
        co2_kg: Math.round(d2 * 0.9),
        trip_id: trip.id,
        dest_lat: coords[hubNode][1],
        dest_lng: coords[hubNode][0],
        dest_name: hubNode
      });
    });
    results.sort((a, b) => a.risk - b.risk);
    timePaths.push(results.slice(0, 5));
  });

  return { nodes, edges, timeline, timePaths, coords };
}

// ─── D3 Network Graph ───
function NetworkGraph({ data, time, bestPath, onNodeClick }) {
  const ref = useRef();
  useEffect(() => {
    if (!data || !ref.current) return;
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    const width = ref.current.clientWidth || 500;
    const height = ref.current.clientHeight || 300;
    const scores = data.timeline[time];
    const tierX = { 3: width * 0.15, 2: width * 0.5, 1: width * 0.85 };
    const grouped = { 3: [], 2: [], 1: [] };
    data.nodes.forEach(([n, d]) => grouped[d.tier]?.push(n));

    const nodes = [];
    Object.keys(grouped).forEach(t => {
      const arr = grouped[t];
      const spacing = (height - 60) / (arr.length - 1 || 1);
      arr.forEach((n, i) => nodes.push({ id: n, x: tierX[t], y: 30 + i * spacing }));
    });

    const links = data.edges.map(e => ({
      source: nodes.find(n => n.id === e[0]),
      target: nodes.find(n => n.id === e[1])
    })).filter(l => l.source && l.target);

    const color = s => d3.interpolateRdYlGn(1 - s);

    svg.selectAll("line").data(links).enter().append("line")
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y)
      .attr("stroke", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? "#06b6d4" : "rgba(255,255,255,0.08)")
      .attr("stroke-width", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? 2.5 : 0.8);

    links.filter(d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id)).forEach(link => {
      const p = svg.append("circle").attr("r", 3).attr("fill", "#06b6d4").attr("opacity", 0.9);
      (function anim() {
        p.attr("cx", link.source.x).attr("cy", link.source.y)
          .transition().duration(1200).ease(d3.easeLinear)
          .attr("cx", link.target.x).attr("cy", link.target.y).on("end", anim);
      })();
    });

    // Node glow for best path
    svg.selectAll("circle.glow").data(nodes.filter(d => bestPath.includes(d.id))).enter().append("circle").attr("class", "glow")
      .attr("cx", d => d.x).attr("cy", d => d.y)
      .attr("r", d => 12 + (scores[d.id] || 0) * 10)
      .attr("fill", "none").attr("stroke", "#06b6d4").attr("stroke-width", 1.5).attr("opacity", 0.3);

    svg.selectAll("circle.node").data(nodes).enter().append("circle").attr("class", "node")
      .attr("cx", d => d.x).attr("cy", d => d.y)
      .attr("r", d => 6 + (scores[d.id] || 0) * 10)
      .attr("fill", d => color(scores[d.id] || 0))
      .attr("stroke", d => bestPath.includes(d.id) ? "#06b6d4" : "rgba(255,255,255,0.2)")
      .attr("stroke-width", d => bestPath.includes(d.id) ? 2.5 : 1).style("cursor", "pointer")
      .on("click", (_, d) => onNodeClick(d.id));

    // Label background pills
    const labelGroups = svg.selectAll("g.label").data(nodes).enter().append("g").attr("class", "label");
    labelGroups.append("rect")
      .attr("x", d => d.x - 2)
      .attr("y", d => d.y + 12)
      .attr("rx", 4).attr("ry", 4)
      .attr("width", d => (d.id.split("(")[0].trim().substring(0, 16).length) * 6 + 8)
      .attr("height", 16)
      .attr("fill", "rgba(0,0,0,0.6)");
    labelGroups.append("text")
      .text(d => d.id.split("(")[0].trim().substring(0, 16))
      .attr("x", d => d.x + 2).attr("y", d => d.y + 24)
      .attr("fill", "#fff").attr("font-size", "11px").attr("font-weight", "600")
      .attr("font-family", "'Inter', sans-serif");
  }, [data, time, bestPath]);

  return <svg ref={ref} width="100%" height="100%" style={{ minHeight: '320px' }} />;
}

// ─── D3 World Map ───
function WorldMap({ data, time, bestPath }) {
  const ref = useRef();
  useEffect(() => {
    if (!data || !ref.current) return;
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    const width = ref.current.clientWidth || 500;
    const height = 340;
    const projection = d3.geoMercator().scale(100).translate([width / 2, height / 1.35]);
    const pathGen = d3.geoPath().projection(projection);
    const scores = data.timeline[time];
    const color = s => d3.interpolateRdYlGn(1 - s);

    // Ocean background
    svg.append("rect").attr("width", width).attr("height", height)
      .attr("fill", "#0a1628").attr("rx", 8);

    // Subtle grid lines
    for (let lat = -60; lat <= 80; lat += 30) {
      const pts = d3.range(-180, 181, 10).map(lon => projection([lon, lat])).filter(p => p);
      if (pts.length > 1) {
        svg.append("path").datum(pts)
          .attr("d", d3.line().x(d => d[0]).y(d => d[1]))
          .attr("stroke", "rgba(255,255,255,0.04)").attr("fill", "none").attr("stroke-width", 0.5);
      }
    }

    d3.json(WORLD_URL).then(world => {
      if (!world) return;
      const countries = feature(world, world.objects.countries);
      svg.selectAll("path.country").data(countries.features).enter().append("path").attr("class", "country")
        .attr("d", pathGen)
        .attr("fill", "rgba(255,255,255,0.07)")
        .attr("stroke", "rgba(255,255,255,0.15)")
        .attr("stroke-width", 0.5);

      const nodes = data.nodes.map(([n]) => {
        const [lon, lat] = (data.coords && data.coords[n]) || NODE_COORDS[n] || [0, 0];
        const [x, y] = projection([lon, lat]) || [0, 0];
        return { id: n, x, y };
      });
      const links = data.edges.map(e => ({
        source: nodes.find(n => n.id === e[0]), target: nodes.find(n => n.id === e[1])
      })).filter(l => l.source && l.target);

      // Route lines
      svg.selectAll("line.route").data(links).enter().append("line").attr("class", "route")
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y)
        .attr("stroke", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? "#06b6d4" : "rgba(255,255,255,0.15)")
        .attr("stroke-width", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? 2.5 : 0.8)
        .attr("stroke-dasharray", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? "none" : "4,3");

      // Node glows
      svg.selectAll("circle.glow").data(nodes).enter().append("circle").attr("class", "glow")
        .attr("cx", d => d.x).attr("cy", d => d.y)
        .attr("r", d => 8 + (scores[d.id] || 0) * 8)
        .attr("fill", d => color(scores[d.id] || 0)).attr("opacity", 0.2);

      // Nodes
      svg.selectAll("circle.node").data(nodes).enter().append("circle").attr("class", "node")
        .attr("cx", d => d.x).attr("cy", d => d.y)
        .attr("r", d => 4 + (scores[d.id] || 0) * 6)
        .attr("fill", d => color(scores[d.id] || 0))
        .attr("stroke", d => bestPath.includes(d.id) ? "#06b6d4" : "rgba(255,255,255,0.3)")
        .attr("stroke-width", d => bestPath.includes(d.id) ? 2 : 0.8);

      // Labels
      svg.selectAll("text.label").data(nodes).enter().append("text").attr("class", "label")
        .text(d => d.id.split("(")[0].trim().substring(0, 12))
        .attr("x", d => d.x + 8).attr("y", d => d.y + 4)
        .attr("fill", "rgba(255,255,255,0.75)").style("font-size", "9px").style("font-weight", "600")
        .style("font-family", "'Inter', sans-serif")
        .style("text-shadow", "0 1px 3px rgba(0,0,0,0.8)");
    });
  }, [data, time, bestPath]);

  return <svg ref={ref} width="100%" height="340px" style={{ borderRadius: '8px' }} />;
}

// ─── Main Page ───
export default function SimulationPage() {
  const [simData, setSimData] = useState(null);
  const [caseType, setCaseType] = useState("semiconductor");
  const [time, setTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [explanations, setExplanations] = useState({});
  const [explainLoading, setExplainLoading] = useState(null);
  const [liveMode, setLiveMode] = useState(false);
  const [activeTrips, setActiveTrips] = useState([]);
  const [applyingRoute, setApplyingRoute] = useState(null);

  useEffect(() => {
    const tripsRef = ref(db, 'trips');
    const unsubscribe = onValue(tripsRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const arr = Object.entries(data).map(([id, t]) => ({ id, ...t }));
        setActiveTrips(arr.filter(t => ['EN_ROUTE', 'WAITING'].includes(t.status)));
      } else {
        setActiveTrips([]);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => { 
    if (liveMode) {
      setSimData(prev => ({ cases: { ...prev?.cases, live: generateLiveFleetSimulation(activeTrips) } }));
      setCaseType('live');
    } else {
      setSimData(runSimulation()); 
      if (caseType === 'live') setCaseType('semiconductor');
    }
  }, [liveMode, activeTrips]);

  useEffect(() => {
    if (!simData || !isPlaying) return;
    const max = simData.cases[caseType].timeline.length;
    const interval = setInterval(() => setTime(t => (t + 1) % max), 1500);
    return () => clearInterval(interval);
  }, [simData, caseType, isPlaying]);

  const handleRerun = useCallback(() => {
    if (liveMode) {
      setSimData(prev => ({ cases: { ...prev?.cases, live: generateLiveFleetSimulation(activeTrips) } }));
    } else {
      setSimData(runSimulation());
    }
    setTime(0);
    setSelectedNode(null);
    setExplanations({});
  }, [liveMode, activeTrips]);

  const getExplanation = async (p, idx) => {
    setExplainLoading(idx);
    try {
      const res = await httpsCallable(functions, 'explainRoute')({ path: p.path, risk: p.risk, caseType, co2_kg: p.co2_kg, distance_km: p.distance_km });
      setExplanations(prev => ({ ...prev, [idx]: res.data.explanation }));
    } catch (err) {
      setExplanations(prev => ({ ...prev, [idx]: `Analysis unavailable: ${err.message}` }));
    } finally { setExplainLoading(null); }
  };

  const handleApplyRoute = async (p) => {
    if (!window.confirm(`Apply this route to ${p.path[0]}? This will update the live fleet Database.`)) return;
    setApplyingRoute(p.trip_id);
    try {
      const res = await httpsCallable(functions, 'applySimulationRoute')({
        trip_id: p.trip_id, recommended_path: p.path, risk: p.risk,
        co2_kg: p.co2_kg, destination_lat: p.dest_lat, destination_lng: p.dest_lng, destination_name: p.dest_name
      });
      alert(`✅ Success: ${res.data.message}`);
    } catch (err) {
      alert(`❌ Failed to apply route: ${err.message}`);
    } finally {
      setApplyingRoute(null);
    }
  };

  if (!simData) return <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center' }}>Initializing AEGIS engine...</div>;

  const caseData = simData.cases[caseType];
  const activePaths = caseData?.timePaths?.[time] || [];
  const bestPath = activePaths[0]?.path || [];
  const meta = CASE_META[caseType];
  const scores = caseData?.timeline?.[time] || {};
  const avgRisk = Object.values(scores).reduce((a, b) => a + b, 0) / (Object.values(scores).length || 1);
  const maxRiskNode = Object.entries(scores).sort(([,a], [,b]) => b - a)[0];
  const systemCost = Object.values(scores).reduce((a, b) => a + b, 0) * 1000000;
  const bestRoute = activePaths[0];
  const bestCo2 = bestRoute?.co2_kg || 0;
  const bestDistKm = bestRoute?.distance_km || 0;
  const bestEtaHrs = bestDistKm > 0 ? (bestDistKm / 60).toFixed(1) : '—';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Shield size={28} style={{ color: '#06b6d4' }} /> AEGIS Risk Simulation
          </h1>
          <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0 0', fontSize: '0.85rem' }}>
            Supply chain disruption propagation engine — Monte Carlo risk analysis
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button 
            onClick={() => setLiveMode(!liveMode)}
            className={`btn-${liveMode ? 'primary' : 'ghost'}`}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: liveMode ? '#22c55e' : '', border: liveMode ? 'none' : '' }}
          >
            <Truck size={16} /> Live Fleet Sync: {liveMode ? 'ON' : 'OFF'}
          </button>
          <button className="btn-ghost" onClick={handleRerun}><RotateCcw size={16} /> Re-run Simulation</button>
        </div>
      </div>

      {/* Scenario Selector */}
      {!liveMode && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
          {Object.entries(CASE_META).filter(([k]) => k !== 'live').map(([key, m]) => (
            <button key={key} onClick={() => { setCaseType(key); setTime(0); setSelectedNode(null); setExplanations({}); }}
              className="glass-panel" style={{
                padding: '1rem 1.25rem', cursor: 'pointer', textAlign: 'left', border: 'none',
                borderLeft: `4px solid ${caseType === key ? m.color : 'transparent'}`,
                background: caseType === key ? `linear-gradient(135deg, ${m.color}12, ${m.color}05)` : undefined,
                transition: 'all 0.3s'
              }}>
              <div style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>{m.icon} <strong style={{ fontSize: '0.9rem' }}>{m.label}</strong></div>
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.3 }}>{m.desc}</p>
            </button>
          ))}
        </div>
      )}

      {/* Timeline Controls + Stats */}
      <div className="glass-panel" style={{ padding: '1rem 1.5rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
        <button onClick={() => setIsPlaying(p => !p)} className="btn-primary" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {isPlaying ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Play</>}
        </button>
        <div style={{ flex: 1 }}>
          <input type="range" min={0} max={(caseData?.timeline?.length || 1) - 1} value={time}
            onChange={e => { setTime(Number(e.target.value)); setIsPlaying(false); }}
            style={{ width: '100%', accentColor: meta?.color }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
            <span>T=0</span><span style={{ color: meta?.color, fontWeight: 700 }}>Step {time + 1}/{caseData?.timeline?.length || 1}</span><span>T={(caseData?.timeline?.length || 1) - 1}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.78rem' }}>
          <div><span style={{ opacity: 0.5 }}>Avg Risk</span><br/><strong style={{ color: avgRisk > 0.4 ? '#ef4444' : '#22c55e', fontSize: '1.1rem' }}>{avgRisk.toFixed(2)}</strong></div>
          <div><span style={{ opacity: 0.5 }}>System Cost</span><br/><strong style={{ color: '#f59e0b', fontSize: '1.1rem' }}>${Math.floor(systemCost).toLocaleString()}</strong></div>
          <div style={{ borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: '1rem' }}>
            <span style={{ opacity: 0.5, display: 'flex', alignItems: 'center', gap: '3px' }}><Leaf size={11} /> CO₂</span>
            <strong style={{ color: '#22c55e', fontSize: '1.1rem' }}>{bestCo2.toLocaleString()} kg</strong>
          </div>
          <div>
            <span style={{ opacity: 0.5, display: 'flex', alignItems: 'center', gap: '3px' }}><Clock size={11} /> ETA</span>
            <strong style={{ color: '#06b6d4', fontSize: '1.1rem' }}>{bestEtaHrs}h</strong>
          </div>
          <div><span style={{ opacity: 0.5 }}>Hot Node</span><br/><strong style={{ color: '#ef4444', fontSize: '0.85rem' }}>{maxRiskNode?.[0]?.split('(')[0]}</strong></div>
        </div>
      </div>

      {/* Main Grid: Graph + Map + Panel */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '1.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="glass-panel" style={{ padding: '0.5rem', flex: 1 }}>
            <div style={{ padding: '0.5rem 1rem 0', fontSize: '0.72rem', opacity: 0.4 }}>
              <Activity size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> SUPPLY CHAIN NETWORK — Tier 3 (Suppliers) → Tier 2 (Assembly) → Tier 1 (Manufacturing)
            </div>
            <NetworkGraph data={caseData} time={time} bestPath={bestPath} onNodeClick={setSelectedNode} />
          </div>
          <div className="glass-panel" style={{ padding: '0.5rem' }}>
            <div style={{ padding: '0.5rem 1rem 0', fontSize: '0.72rem', opacity: 0.4 }}>🌍 GEO-SPATIAL RISK OVERLAY</div>
            <WorldMap data={caseData} time={time} bestPath={bestPath} />
          </div>
        </div>

        {/* Right Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto', maxHeight: 'calc(100vh - 22rem)' }}>
          <div className="glass-panel" style={{ padding: '1.25rem' }}>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9rem' }}>🔎 Node Inspector</h3>
            {selectedNode ? (
              <div>
                <p style={{ fontWeight: 700, margin: '0 0 0.25rem' }}>{selectedNode}</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <div style={{ padding: '0.5rem', borderRadius: '8px', background: 'rgba(255,255,255,0.03)' }}>
                    <span style={{ opacity: 0.5, fontSize: '0.7rem' }}>Risk Score</span><br/>
                    <strong style={{ color: (scores[selectedNode] || 0) > 0.5 ? '#ef4444' : '#22c55e', fontSize: '1.2rem' }}>
                      {(scores[selectedNode] || 0).toFixed(3)}
                    </strong>
                  </div>
                  <div style={{ padding: '0.5rem', borderRadius: '8px', background: 'rgba(255,255,255,0.03)' }}>
                    <span style={{ opacity: 0.5, fontSize: '0.7rem' }}>Impact Cost</span><br/>
                    <strong style={{ color: '#f59e0b', fontSize: '1.2rem' }}>
                      ${Math.floor((scores[selectedNode] || 0) * 1000000).toLocaleString()}
                    </strong>
                  </div>
                </div>
                <div style={{ marginTop: '0.5rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                  On best path: <strong style={{ color: bestPath.includes(selectedNode) ? '#06b6d4' : '#ef4444' }}>
                    {bestPath.includes(selectedNode) ? 'YES ✓' : 'NO ✗'}
                  </strong>
                </div>
              </div>
            ) : (
              <p style={{ opacity: 0.4, fontSize: '0.8rem' }}>Click a node in the graph to inspect it</p>
            )}
          </div>

          <div className="glass-panel" style={{ padding: '1.25rem' }}>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Zap size={14} style={{ color: '#06b6d4' }} /> Optimal Routes
            </h3>
            {activePaths.length === 0 ? (
              <p style={{ opacity: 0.4, fontSize: '0.8rem' }}>No viable routes at this timestep</p>
            ) : (
              activePaths.map((p, i) => (
                <div key={i} style={{
                  padding: '0.75rem', marginBottom: '0.6rem', borderRadius: '10px',
                  background: i === 0 ? 'linear-gradient(135deg, rgba(6,182,212,0.1), rgba(6,182,212,0.03))' : 'rgba(255,255,255,0.02)',
                  borderLeft: `3px solid ${i === 0 ? '#06b6d4' : 'rgba(255,255,255,0.06)'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                    <span style={{ fontSize: '0.65rem', opacity: 0.4 }}>Option {i + 1}</span>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: p.risk > 0.4 ? '#ef4444' : '#22c55e' }}>
                      Risk: {p.risk.toFixed(3)}
                    </span>
                  </div>
                  <p style={{ margin: '0 0 0.4rem', fontSize: '0.78rem', color: i === 0 ? '#06b6d4' : 'var(--text-secondary)', fontWeight: i === 0 ? 600 : 400, lineHeight: 1.4 }}>
                    {p.path.join(' → ')}
                  </p>

                  <div style={{ display: 'flex', gap: '1rem', marginTop: '0.2rem', marginBottom: '0.6rem', fontSize: '0.75rem' }}>
                    <span style={{ color: '#22c55e', display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: 600 }}>
                      <Leaf size={12} /> {p.co2_kg} kg CO₂
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{p.distance_km} km</span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={() => getExplanation(p, i)} disabled={explainLoading === i}
                      className="btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.68rem', flex: 1, justifyContent: 'center' }}>
                      <Brain size={12} /> {explainLoading === i ? 'Analyzing...' : 'AI Explain'}
                    </button>
                    {liveMode && p.trip_id && (
                      <button 
                        onClick={() => handleApplyRoute(p)} 
                        disabled={applyingRoute === p.trip_id}
                        className="btn-primary" 
                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.68rem', flex: 1, justifyContent: 'center', background: '#06b6d4', border: 'none' }}
                      >
                        <Send size={12} /> {applyingRoute === p.trip_id ? 'Applying...' : 'Apply Pivot'}
                      </button>
                    )}
                  </div>

                  <AnimatePresence>
                    {explanations[i] && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0 }}
                        style={{ marginTop: '0.5rem', padding: '0.6rem', borderRadius: '8px', background: 'rgba(139,92,246,0.08)', borderLeft: '3px solid #8b5cf6', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        🧠 {explanations[i]}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
