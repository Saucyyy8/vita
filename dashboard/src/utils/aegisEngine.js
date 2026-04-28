/**
 * AEGIS Supply Chain Risk Simulation Engine
 * Ported from Python (networkx) to pure JavaScript
 */

const CASES = {
  semiconductor: {
    suppliers: ["Renesas (Japan)", "TSMC (Taiwan)", "Samsung Semi (Korea)", "Infineon (Germany)", "NXP (Netherlands)", "GlobalFoundries (US)", "SMIC (China)"],
    assemblers: ["Denso (Thailand)", "Bosch (Germany)", "Foxconn (Vietnam)", "Flex (India)"],
    manufacturers: ["Toyota Plant (India)", "Hyundai Plant (India)", "Tata Motors (India)"]
  },
  logistics: {
    suppliers: ["Shenzhen Supplier", "Guangzhou Supplier", "Shanghai Supplier"],
    assemblers: ["Yantian Port", "Singapore Hub", "Dubai Hub"],
    manufacturers: ["India DC", "Europe DC"]
  },
  humanitarian: {
    suppliers: ["WFP Warehouse (Dubai)", "UNICEF Supply (EU)"],
    assemblers: ["Nairobi Hub", "Sudan Transit"],
    manufacturers: ["Sudan Camp", "Somalia Camp"]
  }
};

export const NODE_COORDS = {
  "Renesas (Japan)": [139.7, 35.6], "TSMC (Taiwan)": [121.0, 24.9],
  "Samsung Semi (Korea)": [127.0, 37.5], "Infineon (Germany)": [10.0, 51.0],
  "NXP (Netherlands)": [5.3, 52.1], "GlobalFoundries (US)": [-73.9, 40.7],
  "SMIC (China)": [116.4, 39.9], "Denso (Thailand)": [100.5, 13.7],
  "Bosch (Germany)": [10.0, 51.0], "Foxconn (Vietnam)": [105.8, 21.0],
  "Flex (India)": [77.6, 12.9], "Toyota Plant (India)": [77.6, 12.9],
  "Hyundai Plant (India)": [80.2, 13.0], "Tata Motors (India)": [72.8, 19.0],
  "Shenzhen Supplier": [114.1, 22.5], "Guangzhou Supplier": [113.3, 23.1],
  "Shanghai Supplier": [121.5, 31.2], "Yantian Port": [114.3, 22.6],
  "Singapore Hub": [103.8, 1.3], "Dubai Hub": [55.3, 25.2],
  "India DC": [77.2, 28.6], "Europe DC": [4.9, 52.3],
  "WFP Warehouse (Dubai)": [55.3, 25.2], "UNICEF Supply (EU)": [6.1, 50.8],
  "Nairobi Hub": [36.8, -1.29], "Sudan Transit": [32.5, 15.5],
  "Sudan Camp": [32.5, 14.5], "Somalia Camp": [45.3, 2.0],
};

function gaussRand() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function buildGraph(caseType) {
  const c = CASES[caseType];
  const nodes = [];
  const edges = [];

  c.suppliers.forEach(n => nodes.push({ id: n, tier: 3 }));
  c.assemblers.forEach(n => nodes.push({ id: n, tier: 2 }));
  c.manufacturers.forEach(n => nodes.push({ id: n, tier: 1 }));

  c.suppliers.forEach(s => {
    c.assemblers.forEach(a => { if (Math.random() > 0.3) edges.push([s, a]); });
  });
  c.assemblers.forEach(a => {
    c.manufacturers.forEach(m => { if (Math.random() > 0.2) edges.push([a, m]); });
  });

  return { nodes, edges };
}

function simulate(graph, caseType, steps = 12) {
  const timeline = [];
  for (let t = 0; t < steps; t++) {
    const scores = {};
    graph.nodes.forEach(node => {
      let base = 0.15 + 0.05 * gaussRand();
      if (caseType === "semiconductor" && node.id.includes("Renesas") && t > 2) base += 0.8;
      if (caseType === "logistics" && node.id.includes("Yantian") && t > 3) base += 0.7;
      if (caseType === "humanitarian" && node.id.includes("Nairobi") && t > 4) base += 0.9;

      if (t > 0) {
        const predecessors = graph.edges.filter(e => e[1] === node.id).map(e => e[0]);
        predecessors.forEach(p => { base += 0.35 * (timeline[t - 1][p] || 0); });
      }
      scores[node.id] = Math.max(0, Math.min(1, base));
    });
    timeline.push(scores);
  }
  return timeline;
}

// Haversine formula — distance between two [lon, lat] coords in km
export function haversineKm(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const EMISSION_FACTOR = 0.9; // kg CO2 per km (heavy-duty diesel truck)

function computePaths(graph, scores) {
  const sources = graph.nodes.filter(n => n.tier === 3).map(n => n.id);
  const targets = graph.nodes.filter(n => n.tier === 1).map(n => n.id);
  const adj = {};
  graph.edges.forEach(([u, v]) => {
    if (!adj[u]) adj[u] = [];
    const w = 1 + ((scores[u] || 0) + (scores[v] || 0)) / 2 * 5;
    adj[u].push({ to: v, w });
  });

  const results = [];
  sources.forEach(s => {
    targets.forEach(t => {
      const dist = {}, prev = {};
      const queue = [s];
      dist[s] = 0;
      const visited = new Set();
      while (queue.length > 0) {
        queue.sort((a, b) => (dist[a] || Infinity) - (dist[b] || Infinity));
        const u = queue.shift();
        if (visited.has(u)) continue;
        visited.add(u);
        (adj[u] || []).forEach(({ to, w }) => {
          const nd = (dist[u] || 0) + w;
          if (nd < (dist[to] ?? Infinity)) {
            dist[to] = nd;
            prev[to] = u;
            queue.push(to);
          }
        });
      }
      if (dist[t] !== undefined) {
        const path = [];
        let cur = t;
        while (cur) { path.unshift(cur); cur = prev[cur]; }
        const risk = path.reduce((a, n) => a + (scores[n] || 0), 0) / path.length;

        // Calculate total distance and CO2 emission along the path
        let distance_km = 0;
        for (let i = 0; i < path.length - 1; i++) {
          const c1 = NODE_COORDS[path[i]] || [0, 0];
          const c2 = NODE_COORDS[path[i + 1]] || [0, 0];
          distance_km += haversineKm(c1, c2);
        }
        const co2_kg = distance_km * EMISSION_FACTOR;

        results.push({ path, risk, distance_km: Math.round(distance_km), co2_kg: Math.round(co2_kg) });
      }
    });
  });
  results.sort((a, b) => a.risk - b.risk);
  return results.slice(0, 5);
}

export function runSimulation() {
  const cases = {};
  ["semiconductor", "logistics", "humanitarian"].forEach(caseType => {
    const graph = buildGraph(caseType);
    const timeline = simulate(graph, caseType);
    const timePaths = timeline.map(scores => computePaths(graph, scores));
    cases[caseType] = {
      nodes: graph.nodes.map(n => [n.id, { tier: n.tier }]),
      edges: graph.edges,
      timeline,
      timePaths
    };
  });
  return { cases };
}
