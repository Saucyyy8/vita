/**
 * ============================================
 *  VITA LIVE TRUCK MOVEMENT SIMULATOR
 * ============================================
 * 
 * This script simulates real truck movement along the polyline route
 * stored in Firebase. It watches for trips with status "EN_ROUTE" and
 * moves the truck's GPS coordinates along the decoded polyline path.
 * 
 * USAGE:
 *   node simulator.js
 * 
 * PREREQUISITES:
 *   1. Set GOOGLE_APPLICATION_CREDENTIALS env var pointing to your
 *      Firebase service account key JSON file, OR run:
 *      `gcloud auth application-default login`
 *   2. npm install (in the functions/ directory)
 * 
 * HOW IT WORKS:
 *   1. Listens for trips with status = "EN_ROUTE" in Firebase
 *   2. Decodes the encoded_polyline into GPS coordinates
 *   3. Every 2 seconds, advances the truck to the next coordinate
 *   4. Updates /trips/{id}/current_location AND /devices/{truck_id}/current
 *   5. When it reaches the end, sets status to "COMPLETED"
 *   6. If the trip status changes (KILLED, WAITING, etc.), it stops
 * 
 * FROM THE DASHBOARD:
 *   - Create a trip on the "Create Trip" page
 *   - Go to "Live Map" and click "Start Sim" on the pending trip
 *   - Run this script — it will pick up the trip automatically
 *   - Watch the truck move on the map in real-time!
 *   - Click "Kill" to stop the simulation
 */

const admin = require('firebase-admin');
const polyline = require('@mapbox/polyline');
const path = require('path');
const fs = require('fs');

// Try to load service account key
const keyPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error('\n❌ ERROR: serviceAccountKey.json not found in the functions/ directory!');
  console.error('\n📋 How to fix:');
  console.error('   1. Go to: https://console.firebase.google.com/project/keen-proton-493005-c7/settings/serviceaccounts/adminsdk');
  console.error('   2. Click "Generate New Private Key"');
  console.error('   3. Save the file as "serviceAccountKey.json" in the functions/ folder');
  console.error('   4. Run this script again: node simulator.js\n');
  process.exit(1);
}

const serviceAccount = require(keyPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://keen-proton-493005-c7-default-rtdb.firebaseio.com'
});

const db = admin.database();
const activeSimulations = new Set();

// How many milliseconds between each GPS coordinate update
const STEP_INTERVAL_MS = 2000;

// Skip N points to speed up simulation (1 = use every point, 3 = use every 3rd point)
const SKIP_FACTOR = 3;

async function startSimulation() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   🚛  VITA LIVE TRUCK MOVEMENT SIMULATOR     ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log("║  Watching Firebase for EN_ROUTE trips...      ║");
  console.log("║  Press Ctrl+C to stop the simulator.          ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  
  // Listen for trips that become EN_ROUTE
  const query = db.ref('/trips').orderByChild('status').equalTo('EN_ROUTE');
  
  query.on('child_added', (snapshot) => {
    simulateTrip(snapshot.key, snapshot.val());
  });

  query.on('child_changed', (snapshot) => {
    simulateTrip(snapshot.key, snapshot.val());
  });

  // Also do an initial scan
  const initialSnap = await db.ref('/trips').orderByChild('status').equalTo('EN_ROUTE').once('value');
  if (initialSnap.exists()) {
    const trips = initialSnap.val();
    Object.entries(trips).forEach(([id, trip]) => simulateTrip(id, trip));
  } else {
    console.log("ℹ️  No EN_ROUTE trips found yet. Waiting...\n");
    console.log("   💡 TIP: Go to the dashboard → Live Map → Click 'Start Sim' on a pending trip.\n");
  }
}

function simulateTrip(tripId, trip) {
  // Prevent duplicate simulations
  if (activeSimulations.has(tripId)) return;
  if (trip.simulator_active) return;
  if (!trip.encoded_polyline) {
    console.log(`⚠️  Trip ${tripId} has no encoded_polyline. Skipping.`);
    return;
  }

  activeSimulations.add(tripId);
  
  console.log(`\n🟢 Starting simulation for Trip: ${tripId}`);
  console.log(`   Truck: ${trip.truck_id || 'Unknown'}`);
  console.log(`   Cargo: ${trip.cargo_type || 'N/A'}`);
  
  // Mark as actively simulating
  db.ref(`/trips/${tripId}/simulator_active`).set(true);

  // Decode polyline
  let decodedPath = [];
  try {
    decodedPath = polyline.decode(trip.encoded_polyline);
  } catch (e) {
    console.error(`   ❌ Failed to decode polyline: ${e.message}`);
    activeSimulations.delete(tripId);
    return;
  }

  // Apply skip factor for faster simulation
  const path = decodedPath.filter((_, i) => i % SKIP_FACTOR === 0);
  // Always include the last point (destination)
  const lastPoint = decodedPath[decodedPath.length - 1];
  if (path[path.length - 1] !== lastPoint) path.push(lastPoint);

  console.log(`   📍 Route: ${decodedPath.length} raw points → ${path.length} simulation steps`);
  console.log(`   ⏱️  ETA: ~${Math.ceil(path.length * STEP_INTERVAL_MS / 1000)}s at ${STEP_INTERVAL_MS}ms/step\n`);
  
  let currentIndex = 0;
  
  const interval = setInterval(async () => {
    try {
      // Check if trip status changed (killed, waiting, etc.)
      const statusSnap = await db.ref(`/trips/${tripId}/status`).once('value');
      const currentStatus = statusSnap.val();
      
      if (currentStatus !== 'EN_ROUTE' && currentStatus !== 'REROUTING') {
        console.log(`\n⏸️  Trip ${tripId} status changed to "${currentStatus}". Stopping simulation.`);
        clearInterval(interval);
        activeSimulations.delete(tripId);
        await db.ref(`/trips/${tripId}/simulator_active`).remove();
        return;
      }

      // Check if we reached the destination
      if (currentIndex >= path.length) {
        clearInterval(interval);
        activeSimulations.delete(tripId);
        console.log(`\n🎉 Trip ${tripId} COMPLETED! Truck ${trip.truck_id} arrived at destination.`);
        await db.ref(`/trips/${tripId}`).update({ 
          status: 'COMPLETED', 
          simulator_active: null,
          completed_at: admin.database.ServerValue.TIMESTAMP
        });
        return;
      }
      
      const [lat, lng] = path[currentIndex];
      
      // Update trip location
      await db.ref(`/trips/${tripId}/current_location`).set({ lat, lng });
      
      // Also update device GPS (for telemetry watcher)
      if (trip.truck_id) {
        await db.ref(`/devices/${trip.truck_id}/current`).update({
          gps: { lat, lng },
          last_updated: admin.database.ServerValue.TIMESTAMP
        });
      }
      
      // Progress bar
      const progress = Math.floor((currentIndex / path.length) * 100);
      const bar = '█'.repeat(Math.floor(progress / 5)) + '░'.repeat(20 - Math.floor(progress / 5));
      process.stdout.write(`\r   [${bar}] ${progress}% | Step ${currentIndex + 1}/${path.length} | [${lat.toFixed(4)}, ${lng.toFixed(4)}]`);
      
      currentIndex++;
    } catch (err) {
      console.error(`\n❌ Simulation error for ${tripId}: ${err.message}`);
    }
  }, STEP_INTERVAL_MS);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down simulator...');
  for (const tripId of activeSimulations) {
    await db.ref(`/trips/${tripId}/simulator_active`).remove();
  }
  console.log('Done. Goodbye!\n');
  process.exit(0);
});

startSimulation();
