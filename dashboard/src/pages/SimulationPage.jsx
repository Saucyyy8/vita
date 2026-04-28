import React, { useState, useEffect, useRef, useCallback } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../api/firebaseConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Play, Pause, RotateCcw, Activity, Shield, Zap } from 'lucide-react';
import * as d3 from 'd3';
import { feature } from 'topojson-client';
import { runSimulation, NODE_COORDS } from '../utils/aegisEngine';

const WORLD_URL = "https://unpkg.com/world-atlas@2/countries-110m.json";

const CASE_META = {
  semiconductor: { label: 'Semiconductor', icon: '🔬', color: '#60a5fa', desc: 'Chip fabrication supply chain — Japan, Taiwan, Korea → India assembly' },
  logistics: { label: 'Global Logistics', icon: '🚢', color: '#22c55e', desc: 'Shipping corridor — China ports → Singapore/Dubai → Distribution centers' },
  humanitarian: { label: 'Humanitarian Aid', icon: '🏥', color: '#f59e0b', desc: 'Emergency aid pipeline — WFP/UNICEF → East Africa conflict zones' }
};

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

    // Edges
    svg.selectAll("line").data(links).enter().append("line")
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y)
      .attr("stroke", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? "#06b6d4" : "rgba(255,255,255,0.08)")
      .attr("stroke-width", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? 2.5 : 0.8);

    // Flow animation on best path
    links.filter(d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id)).forEach(link => {
      const p = svg.append("circle").attr("r", 3).attr("fill", "#06b6d4").attr("opacity", 0.9);
      (function anim() {
        p.attr("cx", link.source.x).attr("cy", link.source.y)
          .transition().duration(1200).ease(d3.easeLinear)
          .attr("cx", link.target.x).attr("cy", link.target.y).on("end", anim);
      })();
    });

    // Nodes
    svg.selectAll("circle.node").data(nodes).enter().append("circle").attr("class", "node")
      .attr("cx", d => d.x).attr("cy", d => d.y)
      .attr("r", d => 5 + (scores[d.id] || 0) * 10)
      .attr("fill", d => color(scores[d.id] || 0))
      .attr("stroke", d => bestPath.includes(d.id) ? "#06b6d4" : "none")
      .attr("stroke-width", 2).style("cursor", "pointer")
      .on("click", (_, d) => onNodeClick(d.id));

    // Labels
    svg.selectAll("text").data(nodes).enter().append("text")
      .text(d => d.id.split("(")[0].trim().substring(0, 14))
      .attr("x", d => d.x + 10).attr("y", d => d.y + 4)
      .attr("fill", "rgba(255,255,255,0.6)").attr("font-size", "10px");
  }, [data, time, bestPath]);

  return <svg ref={ref} width="100%" height="100%" style={{ minHeight: '280px' }} />;
}

// ─── D3 World Map ───
function WorldMap({ data, time, bestPath }) {
  const ref = useRef();
  useEffect(() => {
    if (!data || !ref.current) return;
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    const width = ref.current.clientWidth || 500;
    const height = 280;
    const projection = d3.geoMercator().scale(90).translate([width / 2, height / 1.4]);
    const pathGen = d3.geoPath().projection(projection);
    const scores = data.timeline[time];
    const color = s => d3.interpolateRdYlGn(1 - s);

    d3.json(WORLD_URL).then(world => {
      if (!world) return;
      const countries = feature(world, world.objects.countries);
      svg.selectAll("path.country").data(countries.features).enter().append("path").attr("class", "country")
        .attr("d", pathGen).attr("fill", "rgba(255,255,255,0.03)").attr("stroke", "rgba(255,255,255,0.08)");

      const nodes = data.nodes.map(([n]) => {
        const [lon, lat] = NODE_COORDS[n] || [0, 0];
        const [x, y] = projection([lon, lat]) || [0, 0];
        return { id: n, x, y };
      });
      const links = data.edges.map(e => ({
        source: nodes.find(n => n.id === e[0]), target: nodes.find(n => n.id === e[1])
      })).filter(l => l.source && l.target);

      svg.selectAll("line").data(links).enter().append("line")
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y)
        .attr("stroke", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? "#06b6d4" : "rgba(255,255,255,0.12)")
        .attr("stroke-width", d => bestPath.includes(d.source.id) && bestPath.includes(d.target.id) ? 2 : 0.6)
        .attr("opacity", 0.7);

      svg.selectAll("circle").data(nodes).enter().append("circle")
        .attr("cx", d => d.x).attr("cy", d => d.y)
        .attr("r", d => 3 + (scores[d.id] || 0) * 6)
        .attr("fill", d => color(scores[d.id] || 0));

      svg.selectAll("text").data(nodes).enter().append("text")
        .text(d => d.id.split(" ")[0]).attr("x", d => d.x + 6).attr("y", d => d.y + 3)
        .attr("fill", "rgba(255,255,255,0.4)").style("font-size", "8px");
    });
  }, [data, time, bestPath]);

  return <svg ref={ref} width="100%" height="280px" />;
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

  // Run simulation on mount
  useEffect(() => { setSimData(runSimulation()); }, []);

  // Auto-advance timeline
  useEffect(() => {
    if (!simData || !isPlaying) return;
    const max = simData.cases[caseType].timeline.length;
    const interval = setInterval(() => setTime(t => (t + 1) % max), 1500);
    return () => clearInterval(interval);
  }, [simData, caseType, isPlaying]);

  const handleRerun = useCallback(() => {
    setSimData(runSimulation());
    setTime(0);
    setSelectedNode(null);
    setExplanations({});
  }, []);

  const getExplanation = async (p, idx) => {
    setExplainLoading(idx);
    try {
      const res = await httpsCallable(functions, 'explainRoute')({ path: p.path, risk: p.risk, caseType });
      setExplanations(prev => ({ ...prev, [idx]: res.data.explanation }));
    } catch (err) {
      setExplanations(prev => ({ ...prev, [idx]: `Analysis unavailable: ${err.message}` }));
    } finally { setExplainLoading(null); }
  };

  if (!simData) return <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center' }}>Initializing AEGIS engine...</div>;

  const caseData = simData.cases[caseType];
  const activePaths = caseData.timePaths[time] || [];
  const bestPath = activePaths[0]?.path || [];
  const meta = CASE_META[caseType];
  const scores = caseData.timeline[time];
  const avgRisk = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length;
  const maxRiskNode = Object.entries(scores).sort(([,a], [,b]) => b - a)[0];
  const systemCost = Object.values(scores).reduce((a, b) => a + b, 0) * 1000000;

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
        <button className="btn-ghost" onClick={handleRerun}><RotateCcw size={16} /> Re-run Simulation</button>
      </div>

      {/* Scenario Selector */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        {Object.entries(CASE_META).map(([key, m]) => (
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

      {/* Timeline Controls + Stats */}
      <div className="glass-panel" style={{ padding: '1rem 1.5rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
        <button onClick={() => setIsPlaying(p => !p)} className="btn-primary" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {isPlaying ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Play</>}
        </button>
        <div style={{ flex: 1 }}>
          <input type="range" min={0} max={caseData.timeline.length - 1} value={time}
            onChange={e => { setTime(Number(e.target.value)); setIsPlaying(false); }}
            style={{ width: '100%', accentColor: meta.color }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
            <span>T=0</span><span style={{ color: meta.color, fontWeight: 700 }}>Step {time + 1}/{caseData.timeline.length}</span><span>T={caseData.timeline.length - 1}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.78rem' }}>
          <div><span style={{ opacity: 0.5 }}>Avg Risk</span><br/><strong style={{ color: avgRisk > 0.4 ? '#ef4444' : '#22c55e', fontSize: '1.1rem' }}>{avgRisk.toFixed(2)}</strong></div>
          <div><span style={{ opacity: 0.5 }}>System Cost</span><br/><strong style={{ color: '#f59e0b', fontSize: '1.1rem' }}>${Math.floor(systemCost).toLocaleString()}</strong></div>
          <div><span style={{ opacity: 0.5 }}>Hot Node</span><br/><strong style={{ color: '#ef4444', fontSize: '0.85rem' }}>{maxRiskNode?.[0]?.split('(')[0]}</strong></div>
        </div>
      </div>

      {/* Main Grid: Graph + Map + Panel */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '1.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Network Graph */}
          <div className="glass-panel" style={{ padding: '0.5rem', flex: 1 }}>
            <div style={{ padding: '0.5rem 1rem 0', fontSize: '0.72rem', opacity: 0.4 }}>
              <Activity size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> SUPPLY CHAIN NETWORK — Tier 3 (Suppliers) → Tier 2 (Assembly) → Tier 1 (Manufacturing)
            </div>
            <NetworkGraph data={caseData} time={time} bestPath={bestPath} onNodeClick={setSelectedNode} />
          </div>
          {/* World Map */}
          <div className="glass-panel" style={{ padding: '0.5rem' }}>
            <div style={{ padding: '0.5rem 1rem 0', fontSize: '0.72rem', opacity: 0.4 }}>🌍 GEO-SPATIAL RISK OVERLAY</div>
            <WorldMap data={caseData} time={time} bestPath={bestPath} />
          </div>
        </div>

        {/* Right Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto', maxHeight: 'calc(100vh - 22rem)' }}>
          {/* Node Inspector */}
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

          {/* Best Routes */}
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
                  <button onClick={() => getExplanation(p, i)} disabled={explainLoading === i}
                    className="btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.68rem' }}>
                    <Brain size={12} /> {explainLoading === i ? 'Analyzing...' : 'AI Explain'}
                  </button>
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
