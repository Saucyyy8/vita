const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { onValueWritten, onValueCreated } = require("firebase-functions/v2/database");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { VertexAI } = require("@google-cloud/vertexai");
const axios = require("axios");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.database();

const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDLx8hwg2Zmh-llqTZA2UMOTbmDM0YhJBs';
const WEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || 'a90d0db3b6c329df004bf206b915369e';

/** ==========================================
 *  1. SENSOR INGEST & TELEMETRY
 *  ========================================== */
exports.ingestSensorData = onMessagePublished("telemetry-topic", (event) => {
  const payload = event.data.message.json;
  const deviceId = payload.device_id || "esp32_001";
  return db.ref(`/devices/${deviceId}/current`).set({
    gps: payload.gps,
    sensors: payload.sensors,
    last_updated: admin.database.ServerValue.TIMESTAMP
  });
});

exports.telemetryWatcher = onValueWritten("/devices/{deviceId}/current", async (event) => {
  const deviceId = event.params.deviceId;
  const data = event.data.after.val();
  const sensors = data ? data.sensors : null;

  if (!sensors) return null;

  try {
    const tripSnap = await db.ref("/trips").orderByChild("truck_id").equalTo(deviceId).get();
    if (!tripSnap.exists()) return null;

    const [tripId, trip] = Object.entries(tripSnap.val())[0];
    if (trip.status !== "EN_ROUTE") return null;

    const now = Date.now();
    const lastEvent = trip.last_event_timestamp || 0;

    if (now - lastEvent < 5 * 60 * 1000) return null; // Cooldown

    if (sensors.temperature > (trip.rules?.max_temp || 10) || sensors.sound_db > (trip.rules?.max_sound_db || 100)) {
      await db.ref("/events").push({
        type: sensors.temperature > (trip.rules?.max_temp || 10) ? "TEMP_BREACH" : "SOUND_BREACH",
        trip_id: tripId,
        value: sensors.temperature || sensors.sound_db,
        timestamp: admin.database.ServerValue.TIMESTAMP
      });
      await db.ref(`/trips/${tripId}`).update({ last_event_timestamp: now });
    }
  } catch (error) {
    console.error("CRITICAL ERROR in Watcher:", error.message);
  }
  return null;
});

/** ==========================================
 *  1.5 INFRASTRUCTURE HUB 
 *  ========================================== */
exports.getInfrastructure = onCall({ cors: true }, async (request) => {
  try {
    const snap = await db.ref('/infrastructure').once('value');
    const data = snap.val() || {};
    return {
      factories: data.factories || {},
      cold_storage: data.cold_storage || {}
    };
  } catch (err) {
    throw new HttpsError('internal', err.message);
  }
});

/** ==========================================
 *  1.5.1 AEGIS SUPPLY CHAIN SIMULATION — ROUTE EXPLANATION
 *  ========================================== */
exports.explainRoute = onCall({ cors: true }, async (request) => {
  const { path: routePath, risk, caseType } = request.data;
  if (!routePath || routePath.length === 0) {
    throw new HttpsError('invalid-argument', 'path is required.');
  }

  const prompt = `You are an expert in supply chain risk analysis for the ${caseType || 'global'} sector.

Compare this route with alternatives and explain WHY it is the optimal choice.

Path: ${routePath.join(' → ')}
Risk Score: ${(risk || 0).toFixed(2)}

Requirements:
- Mention specific nodes (factories, hubs, suppliers) by name
- Identify which node reduces or increases risk
- Explain why alternative paths would be worse
- Be concrete and data-driven, no vague statements
- Maximum 4 sentences`;

  try {
    const generativeModel = vertexAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await generativeModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { path: routePath, risk, explanation: text.trim() };
  } catch (err) {
    // Fallback if Gemini fails
    const fallback = `This route is selected due to lower cumulative disruption risk (${(risk || 0).toFixed(2)}). ` +
      `Node "${routePath[Math.floor(routePath.length / 2)]}" acts as a stable intermediary, ` +
      `reducing risk propagation compared to higher-risk alternatives.`;
    return { path: routePath, risk, explanation: fallback };
  }
});

exports.createInfrastructureNode = onCall({ cors: true }, async (request) => {
  const data = request.data;
  try {
    const parentRef = db.ref(`/infrastructure/${data.type}`);
    const newRef = parentRef.push();
    await newRef.set({
      name: data.name || "Unnamed Node",
      lat: parseFloat(data.lat),
      lng: parseFloat(data.lng),
      status: 'ACTIVE',
      created_at: admin.database.ServerValue.TIMESTAMP
    });

    // Return the full updated infrastructure so the UI can refresh immediately
    const snap = await db.ref('/infrastructure').once('value');
    const allInfra = snap.val() || {};
    return {
      success: true,
      id: newRef.key,
      infrastructure: {
        factories: allInfra.factories || {},
        cold_storage: allInfra.cold_storage || {}
      }
    };
  } catch (err) {
    throw new HttpsError('internal', err.message);
  }
});

exports.deleteInfrastructureNode = onCall({ cors: true }, async (request) => {
  const { type, id } = request.data;
  if (!type || !id) throw new HttpsError('invalid-argument', 'type and id are required.');
  if (!['factories', 'cold_storage'].includes(type)) {
    throw new HttpsError('invalid-argument', 'type must be "factories" or "cold_storage".');
  }

  try {
    const nodeRef = db.ref(`/infrastructure/${type}/${id}`);
    const snap = await nodeRef.get();
    if (!snap.exists()) throw new HttpsError('not-found', `${type} node ${id} does not exist.`);
    
    const nodeName = snap.val().name || id;
    await nodeRef.remove();

    // Return updated infrastructure
    const infraSnap = await db.ref('/infrastructure').once('value');
    const allInfra = infraSnap.val() || {};
    console.log(`[deleteInfrastructureNode] Deleted ${type}/${id} (${nodeName})`);
    return {
      success: true,
      deleted: { type, id, name: nodeName },
      infrastructure: {
        factories: allInfra.factories || {},
        cold_storage: allInfra.cold_storage || {}
      }
    };
  } catch (err) {
    if (err.code && err.httpErrorCode) throw err;
    throw new HttpsError('internal', err.message);
  }
});

/** ==========================================
 *  1.6 TRIP MANAGEMENT
 *  ========================================== */
exports.listTrips = onCall({ cors: true }, async (request) => {
  try {
    const snap = await db.ref('/trips').once('value');
    return { trips: snap.val() || {} };
  } catch (err) {
    throw new HttpsError('internal', err.message);
  }
});

exports.killTrip = onCall({ cors: true }, async (request) => {
  const { trip_id } = request.data;
  if (!trip_id) throw new HttpsError('invalid-argument', 'trip_id is required.');
  
  try {
    const tripSnap = await db.ref(`/trips/${trip_id}`).get();
    if (!tripSnap.exists()) throw new HttpsError('not-found', 'Trip does not exist.');
    
    await db.ref(`/trips/${trip_id}`).update({
      status: 'KILLED',
      simulator_active: null,
      killed_at: admin.database.ServerValue.TIMESTAMP
    });

    console.log(`[killTrip] Trip ${trip_id} terminated.`);
    return { success: true, message: `Trip ${trip_id} has been killed.` };
  } catch (err) {
    if (err.code && err.httpErrorCode) throw err;
    throw new HttpsError('internal', err.message);
  }
});

exports.startTripSimulation = onCall({ cors: true }, async (request) => {
  const { trip_id } = request.data;
  if (!trip_id) throw new HttpsError('invalid-argument', 'trip_id is required.');
  
  try {
    const tripSnap = await db.ref(`/trips/${trip_id}`).get();
    if (!tripSnap.exists()) throw new HttpsError('not-found', 'Trip does not exist.');
    
    await db.ref(`/trips/${trip_id}`).update({
      status: 'EN_ROUTE',
      simulator_active: null
    });

    console.log(`[startTripSimulation] Trip ${trip_id} set to EN_ROUTE for simulator pickup.`);
    return { success: true, message: `Trip ${trip_id} is now EN_ROUTE. Run the simulator script to begin movement.` };
  } catch (err) {
    if (err.code && err.httpErrorCode) throw err;
    throw new HttpsError('internal', err.message);
  }
});

exports.pauseTrip = onCall({ cors: true }, async (request) => {
  const { trip_id, reason } = request.data;
  if (!trip_id) throw new HttpsError('invalid-argument', 'trip_id is required.');
  
  try {
    const tripSnap = await db.ref(`/trips/${trip_id}`).get();
    if (!tripSnap.exists()) throw new HttpsError('not-found', 'Trip does not exist.');
    
    await db.ref(`/trips/${trip_id}`).update({
      status: 'WAITING',
      wait_reason: reason || 'Paused for processing',
      simulator_active: null
    });

    console.log(`[pauseTrip] Trip ${trip_id} halted: ${reason}`);
    return { success: true };
  } catch (err) {
    if (err.code && err.httpErrorCode) throw err;
    throw new HttpsError('internal', err.message);
  }
});

exports.resumeTrip = onCall({ cors: true }, async (request) => {
  const { trip_id, reason } = request.data;
  if (!trip_id) throw new HttpsError('invalid-argument', 'trip_id is required.');
  
  try {
    const tripSnap = await db.ref(`/trips/${trip_id}`).get();
    if (!tripSnap.exists()) throw new HttpsError('not-found', 'Trip does not exist.');
    const trip = tripSnap.val();
    
    if (trip.status !== 'WAITING' && trip.status !== 'AWAITING_RESCUE_ACCEPTANCE') {
      throw new HttpsError('failed-precondition', `Trip is not in a resumable state (current: ${trip.status}).`);
    }
    
    await db.ref(`/trips/${trip_id}`).update({
      status: 'EN_ROUTE',
      wait_reason: null,
      last_reason: reason || 'Manually resumed by operator',
      simulator_active: null
    });

    // Log the manual resume as an agent decision for audit trail
    await db.ref('/agent_log').push({
      event_type: 'MANUAL_RESUME',
      trip_id: trip_id,
      action: 'resume_trip',
      reason: reason || 'Manually resumed by operator — conditions cleared',
      timestamp: admin.database.ServerValue.TIMESTAMP
    });

    console.log(`[resumeTrip] Trip ${trip_id} resumed: ${reason}`);
    return { success: true, message: `Trip ${trip_id} has been resumed.` };
  } catch (err) {
    if (err.code && err.httpErrorCode) throw err;
    throw new HttpsError('internal', err.message);
  }
});

/** ==========================================
 *  2. CREATE MULTI-STOP TRIP 
 *  ========================================== */
exports.createMultiStopTrip = onCall({ cors: true }, async (request) => {
  try {
    const data = request.data;
    console.log('[createMultiStopTrip] Received payload:', JSON.stringify(data));

    if (!data || !data.waypoints || data.waypoints.length < 2) {
      throw new HttpsError('invalid-argument', 'Trip requires at least 2 waypoints (origin and destination).');
    }

    const originWP = data.waypoints[0];
    const destWP = data.waypoints[data.waypoints.length - 1];
    const intermediatesWPs = data.waypoints.slice(1, data.waypoints.length - 1);

    const routePayload = {
      origin: { location: { latLng: { latitude: originWP.lat, longitude: originWP.lng } } },
      destination: { location: { latLng: { latitude: destWP.lat, longitude: destWP.lng } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE"
    };

    if (intermediatesWPs.length > 0) {
      routePayload.intermediates = intermediatesWPs.map(wp => ({
        location: { latLng: { latitude: wp.lat, longitude: wp.lng } }
      }));
    }

    console.log('[createMultiStopTrip] Calling Routes API with key:', MAPS_API_KEY.substring(0, 10) + '...');

    let response;
    try {
      response = await axios.post(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        routePayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': MAPS_API_KEY,
            'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
          }
        }
      );
    } catch (axiosErr) {
      const detail = axiosErr.response
        ? JSON.stringify(axiosErr.response.data)
        : axiosErr.message;
      console.error('[createMultiStopTrip] Routes API FAILED:', detail);
      throw new HttpsError('failed-precondition',
        `Google Routes API error: ${detail}. Make sure "Routes API" is ENABLED in your Google Cloud Console.`
      );
    }

    if (!response.data.routes || response.data.routes.length === 0) {
      console.error('[createMultiStopTrip] Routes API returned empty routes:', JSON.stringify(response.data));
      throw new HttpsError('internal', 'Maps API returned no routes for the given waypoints.');
    }

    const route = response.data.routes[0];
    const newTripRef = db.ref('/trips').push();

    await newTripRef.set({
      assigned_driver_uid: data.assigned_driver_uid || null,
      truck_id: data.assigned_truck_id || null,
      cargo_type: data.cargo_type || "GENERAL",
      waypoints: data.waypoints,
      encoded_polyline: route.polyline.encodedPolyline,
      eta: route.duration,
      status: "PENDING_DRIVER_START",
      current_location: { lat: originWP.lat, lng: originWP.lng },
      created_at: admin.database.ServerValue.TIMESTAMP
    });

    console.log('[createMultiStopTrip] Trip created:', newTripRef.key);
    return { success: true, trip_id: newTripRef.key };

  } catch (err) {
    // If it's already an HttpsError, re-throw it directly
    if (err.code && err.httpErrorCode) {
      throw err;
    }
    console.error('[createMultiStopTrip] UNEXPECTED ERROR:', err.message, err.stack);
    throw new HttpsError('internal', `Unexpected server error: ${err.message}`);
  }
});


/** ==========================================
 *  3. MASTER AGENT (Gemini-Powered Autonomous Control Tower)
 *  ========================================== */
const vertexAI = new VertexAI({ project: 'keen-proton-493005-c7', location: 'us-central1' });

const supplyChainTools = [{
  functionDeclarations: [
    {
      name: "reroute_to_alternate_pickup",
      description: "Reroute a truck to an alternate active facility (factory or cold storage). Use when: (a) the targeted destination is down/on fire/offline, OR (b) for TEMP_BREACH on temperature-sensitive cargo — reroute to the nearest ACTIVE cold_storage hub for emergency preservation. Pick the geographically nearest ACTIVE facility from INFRASTRUCTURE STATUS.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING", description: "The trip ID to reroute" },
          new_destination_id: { type: "STRING", description: "ID of an alternate ACTIVE facility from the INFRASTRUCTURE STATUS. MUST be a real ID from the provided data. NEVER guess or hallucinate." },
          reason: { type: "STRING", description: "Human-readable reason explaining what happened and why this specific facility was chosen. 2-3 sentences." }
        },
        required: ["trip_id", "new_destination_id", "reason"]
      }
    },
    {
      name: "recalculate_route_to_current_destination",
      description: "Recalculate an alternative route to the SAME destination, bypassing the roadblock or obstruction. The system will use Google Routes API with computeAlternativeRoutes to find a completely different path. Use this for ROAD_BLOCK / ROAD_COLLAPSE events.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "What obstruction is being bypassed and why an alternative route is being computed. Reference the event details." }
        },
        required: ["trip_id", "reason"]
      }
    },
    {
      name: "instruct_driver_shelter",
      description: "Order the driver to STOP immediately and take shelter. Use for severe/dangerous weather (Blizzard, Thunderstorm, Tornado, Flood, Cyclone, Arctic conditions). The truck halts until conditions improve. Do NOT verify weather — trust the event data.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          wait_time_minutes: { type: "INTEGER", description: "Estimated wait in minutes based on severity" },
          reason: { type: "STRING", description: "Why the driver must stop. Describe the danger. 2-3 sentences." }
        },
        required: ["trip_id", "wait_time_minutes", "reason"]
      }
    },
    {
      name: "return_to_origin_or_safe_harbor",
      description: "ABORT the mission entirely and send truck back to the origin or nearest safe location. Use when: (a) ALL factories/destinations are down with no alternatives, (b) route is completely impassable with no detour possible, (c) cargo is compromised beyond recovery and continuing is futile.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "Why the mission is aborted and what the driver should do. 2-3 sentences." }
        },
        required: ["trip_id", "reason"]
      }
    },
    {
      name: "dispatch_backup_truck",
      description: "Summon a replacement truck when the current truck has a mechanical failure, engine seizure, or breakdown. The original truck is immobilized and the driver waits for cargo transfer to the backup.",
      parameters: {
        type: "OBJECT",
        properties: {
          original_trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "Details of the breakdown, what failed, and the backup/rescue plan. 2-3 sentences." }
        },
        required: ["original_trip_id", "reason"]
      }
    },
    {
      name: "resume_trip",
      description: "Resume a halted trip. Use when conditions have improved (weather cleared, backup arrived, obstruction removed, etc.).",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "Why the trip can safely resume" }
        },
        required: ["trip_id", "reason"]
      }
    },
    {
      name: "mark_cargo_compromised",
      description: "Flag the cargo as compromised due to temperature breach, contamination, or damage. For temperature-sensitive cargo (VACCINES, FROZEN_FOOD, PRODUCE): if temp exceeded safe limits for extended period, cargo is unsafe. For NORMAL_PACKAGE cargo: temperature breaches are not critical.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "What happened to the cargo and why it is compromised. Include temp data if available." }
        },
        required: ["trip_id", "reason"]
      }
    },
    {
      name: "no_action_needed",
      description: "Use when the event does not require any intervention (e.g., temp breach on NORMAL_PACKAGE cargo). Log the reasoning.",
      parameters: {
        type: "OBJECT",
        properties: {
          reason: { type: "STRING", description: "Why no action is needed" }
        },
        required: ["reason"]
      }
    }
  ]
}];

// Helper: fetch weather data for a location
async function fetchWeatherForLocation(lat, lng) {
  if (!WEATHER_API_KEY || WEATHER_API_KEY === 'YOUR_OPENWEATHER_KEY') {
    return { condition: "Unknown", temp_celsius: "N/A", description: "No weather API key configured", wind_speed: "N/A", humidity: "N/A" };
  }
  try {
    const result = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${WEATHER_API_KEY}&units=metric`
    );
    if (!result.data || !result.data.weather || result.data.weather.length === 0) {
      throw new Error("Invalid response from Weather API");
    }
    return {
      condition: result.data.weather[0].main,
      description: result.data.weather[0].description,
      temp_celsius: result.data.main.temp,
      wind_speed: result.data.wind.speed,
      humidity: result.data.main.humidity
    };
  } catch (err) {
    console.error(`[Weather API Error] ${err.response?.data?.message || err.message}`);
    return { condition: "API_ERROR", description: err.response?.data?.message || err.message, temp_celsius: "N/A", wind_speed: "N/A", humidity: "N/A" };
  }
}

exports.masterAgent = onValueCreated("/events/{eventId}", async (event) => {
  const eventId = event.params.eventId;
  const eventData = event.data.val();
  
  if (eventData.is_system_generated) return null;

  console.log(`[Master Agent] Processing event ${eventId}: ${eventData.type}`);

  // Cooldown: skip if another event of the same type was processed <10s ago
  const cooldownKey = `${eventData.type}_${eventData.trip_id || eventData.factory_id || 'global'}`;
  const cooldownSnap = await db.ref(`/agent_cooldowns/${cooldownKey}`).get();
  if (cooldownSnap.exists()) {
    const lastFired = cooldownSnap.val();
    if (Date.now() - lastFired < 10000) {
      console.log(`[Master Agent] Cooldown active for ${cooldownKey}. Skipping duplicate event.`);
      return null;
    }
  }
  await db.ref(`/agent_cooldowns/${cooldownKey}`).set(Date.now());

  try {
    // 1. Gather context — only what we need
    const tripId = eventData.trip_id || null;
    const [tripSnap, allTripsSnap, facSnap, csSnap] = await Promise.all([
      tripId ? db.ref(`/trips/${tripId}`).get() : Promise.resolve(null),
      db.ref('/trips').once('value'),
      db.ref('/infrastructure/factories').once('value'),
      db.ref('/infrastructure/cold_storage').once('value')
    ]);

    const trip = tripSnap && tripSnap.exists() ? tripSnap.val() : null;

    // If no trip found and event references a truck, find the trip by truck_id
    let resolvedTripId = tripId;
    let resolvedTrip = trip;
    if (!trip && eventData.truck_id) {
      const truckTrips = await db.ref('/trips').orderByChild('truck_id').equalTo(eventData.truck_id).limitToFirst(1).get();
      if (truckTrips.exists()) {
        const entries = Object.entries(truckTrips.val());
        resolvedTripId = entries[0][0];
        resolvedTrip = entries[0][1];
      }
    }

    const allFactories = facSnap.val() || {};
    const allColdStorages = csSnap.val() || {};
    const allTrips = allTripsSnap.val() || {};

    // Provide ALL active infrastructure — trimmed to essential fields only
    let factories = {};
    let coldStorages = {};
    for (const [id, f] of Object.entries(allFactories)) {
      if (f.status === 'ACTIVE') factories[id] = { name: f.name, lat: f.lat, lng: f.lng };
    }
    for (const [id, cs] of Object.entries(allColdStorages)) {
      if (cs.status === 'ACTIVE') coldStorages[id] = { name: cs.name, lat: cs.lat, lng: cs.lng };
    }

    // 2. Check weather at truck's current location if available
    let weatherContext = "No location available for weather check.";
    if (resolvedTrip && resolvedTrip.current_location) {
      const wx = await fetchWeatherForLocation(resolvedTrip.current_location.lat, resolvedTrip.current_location.lng);
      weatherContext = `Current weather at truck location: ${wx.condition} (${wx.description}), Temp: ${wx.temp_celsius}°C, Wind: ${wx.wind_speed} m/s, Humidity: ${wx.humidity}%`;
    }

    const eventLabel = eventData.label || eventData.metadata?.desc || eventData.type;

    // Trim trip data to essential fields to reduce token count
    const trimmedTrip = resolvedTrip ? {
      truck_id: resolvedTrip.truck_id,
      status: resolvedTrip.status,
      cargo_type: resolvedTrip.cargo_type,
      cargo_compromised: resolvedTrip.cargo_compromised || false,
      current_location: resolvedTrip.current_location,
      waypoints: resolvedTrip.waypoints,
      destination: resolvedTrip.destination
    } : null;

    // Trim fleet data — only active trips, essential fields
    const trimmedFleet = Object.fromEntries(
      Object.entries(allTrips)
        .filter(([_, t]) => ['EN_ROUTE', 'PENDING_DRIVER_START', 'WAITING'].includes(t.status))
        .map(([id, t]) => [id, { truck_id: t.truck_id, status: t.status, cargo_type: t.cargo_type, destination: t.destination, current_location: t.current_location }])
    );

    // 3. Build prompt — optimized for token efficiency
    const prompt = `
You are the VITA Autonomous Logistics Brain. Make ONE autonomous decision by calling exactly ONE tool function.

## EVENT
Type: ${eventData.type} | Label: ${eventLabel}
Details: ${eventData.reason || eventData.description || eventData.metadata?.desc || 'N/A'}
${eventData.value ? `Temp: ${eventData.value}°C (rule: ${eventData.rule}°C)` : ''}
${eventData.factory_id ? `Factory: ${eventData.factory_id}` : ''}
${eventData.cold_storage_id ? `Cold Storage: ${eventData.cold_storage_id} (${eventData.cold_storage_name || ''})` : ''}

## AFFECTED TRIP
ID: ${resolvedTripId || 'NONE'}
${trimmedTrip ? `Truck: ${trimmedTrip.truck_id} | Cargo: ${trimmedTrip.cargo_type} | Status: ${trimmedTrip.status}${trimmedTrip.cargo_compromised ? ' | ⚠️ CARGO ALREADY COMPROMISED' : ''}
Location: ${JSON.stringify(trimmedTrip.current_location)}
Waypoints: ${JSON.stringify(trimmedTrip.waypoints)}` : 'No trip data'}

## WEATHER
${weatherContext}

## INFRASTRUCTURE (ACTIVE)
Factories: ${JSON.stringify(factories)}
Cold Storages: ${JSON.stringify(coldStorages)}

## FLEET
${JSON.stringify(trimmedFleet)}

## SOPs
1. ROAD_BLOCK → 'recalculate_route_to_current_destination' (default detour). Abort if no alternatives. Hold if minor/temporary.
2. TRUCK_BREAKDOWN → 'dispatch_backup_truck' immediately. No other option.
3. TEMP_BREACH → For VACCINES/FROZEN_FOOD/PRODUCE: call 'reroute_to_alternate_pickup' to nearest cold_storage (emergency diversion, #1 priority). If none available, 'mark_cargo_compromised'. For NORMAL_PACKAGE: 'no_action_needed'.
4. FACTORY_FAILURE → 'reroute_to_alternate_pickup' to nearest ACTIVE factory. If none, 'return_to_origin_or_safe_harbor'.
5. COLD_STORAGE_FAILURE → Intercept trucks heading to affected hub, 'reroute_to_alternate_pickup' to another ACTIVE cold storage.
6. WEATHER_WARNING → 'instruct_driver_shelter' immediately. Blizzard: 180min, storm: 90min.

RULES: Call exactly ONE tool. Use real facility IDs from INFRASTRUCTURE only. Give detailed reasoning in 'reason'. NORMAL_PACKAGE has no temp constraints.
`;

    // 4. Call Gemini with retry for rate limiting
    const generativeModel = vertexAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    let result;
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await generativeModel.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: supplyChainTools,
          tool_config: { function_calling_config: { mode: "ANY" } }
        });
        break; // Success — exit retry loop
      } catch (apiErr) {
        const isRateLimit = apiErr.message?.includes('429') || apiErr.message?.includes('RESOURCE_EXHAUSTED');
        const isTransient = apiErr.message?.includes('503') || apiErr.message?.includes('UNAVAILABLE');
        
        if ((isRateLimit || isTransient) && attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          console.log(`[Master Agent] Rate limited (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${delay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw apiErr; // Non-retryable or max retries exceeded
        }
      }
    }

    const candidate = result.response?.candidates?.[0];
    const functionCall = candidate?.content?.parts?.[0]?.functionCall;
    
    // Also try to extract text reasoning if Gemini provides it
    const textParts = candidate?.content?.parts?.filter(p => p.text) || [];
    const geminiThinking = textParts.map(p => p.text).join(' ').substring(0, 500);

    if (!functionCall) {
      console.log('[Master Agent] No function call returned. Gemini thinking:', geminiThinking);
      return null;
    }

    const args = functionCall.args || {};
    const actionName = functionCall.name;
    const actionReason = args.reason || args.context || 'Autonomous AI decision';
    console.log(`[Master Agent] Decision: ${actionName}`, args);

    // 5. EXECUTE the action
    const targetTripId = args.trip_id || args.original_trip_id || resolvedTripId;

    if (actionName === "recalculate_route_to_current_destination") {
      if (args.trip_id && resolvedTrip) {
        // Halt the truck first if it's still moving
        await db.ref(`/trips/${args.trip_id}`).update({
          status: "WAITING", wait_reason: `Computing alternative route: ${args.reason}`, simulator_active: null
        });
        await executeRecalculateCurrentRoute(db, args.trip_id, args.reason);
      }
    } else if (actionName === "reroute_to_alternate_pickup") {
      await executeReroute(db, args.trip_id, args.new_destination_id, args.reason);
    } else if (actionName === "instruct_driver_shelter") {
      if (args.trip_id) {
        await db.ref(`/trips/${args.trip_id}`).update({
          status: "WAITING", wait_reason: args.reason, simulator_active: null
        });
      }
    } else if (actionName === "return_to_origin_or_safe_harbor") {
      if (args.trip_id) {
        await executeReturnToOrigin(db, args.trip_id, args.reason);
      }
    } else if (actionName === "dispatch_backup_truck") {
      if (args.original_trip_id) {
        // Simulating the backend finding 3 closest driver uids / truck ids for the Flutter app
        const nearbyTrucks = ["trk_rescue_001", "trk_rescue_002", "trk_rescue_003"];
        await db.ref(`/trips/${args.original_trip_id}`).update({
          status: "AWAITING_RESCUE_ACCEPTANCE",
          notified_rescue_trucks: nearbyTrucks, 
          last_reason: args.reason, 
          simulator_active: null
        });
      }
    } else if (actionName === "resume_trip") {
      if (args.trip_id) {
        await db.ref(`/trips/${args.trip_id}`).update({
          status: "EN_ROUTE", last_reason: args.reason, simulator_active: null
        });
      }
    } else if (actionName === "mark_cargo_compromised") {
      if (args.trip_id) {
        await db.ref(`/trips/${args.trip_id}`).update({
          cargo_compromised: true, 
          cargo_compromise_reason: args.reason,
          status: "EN_ROUTE", // Resume the trip automatically so it doesn't get stuck forever
          simulator_active: null
        });
      }
    }

    // 6. LOG the decision for Explainable AI (shown on dashboard)
    // Sanitize: Firebase rejects undefined values, so we filter them out
    const sanitizedArgs = JSON.parse(JSON.stringify(args));
    const agentLog = {
      event_id: eventId,
      event_type: eventData.type,
      trip_id: targetTripId || 'unknown',
      action: actionName,
      reason: actionReason,
      args: sanitizedArgs,
      gemini_thinking: geminiThinking || '',
      weather_context: weatherContext,
      timestamp: admin.database.ServerValue.TIMESTAMP
    };
    
    await db.ref('/agent_log').push(agentLog);

    // Also write a summary directly onto the trip for easy Flutter/React access
    if (targetTripId) {
      await db.ref(`/trips/${targetTripId}/last_agent_decision`).set({
        action: actionName,
        reason: actionReason,
        timestamp: admin.database.ServerValue.TIMESTAMP
      });
    }

    // 7. System acknowledgment event (prevents re-triggering)
    await db.ref('/events').push({
      type: `AGENT_EXECUTED_${actionName.toUpperCase()}`,
      trip_id: targetTripId || 'unknown',
      reason: actionReason,
      timestamp: admin.database.ServerValue.TIMESTAMP,
      is_system_generated: true
    });

  } catch (error) {
    console.error("[Master Agent] CRITICAL ERROR:", error.message, error.stack);
    
    // Log the failure
    await db.ref('/agent_log').push({
      event_id: eventId,
      event_type: eventData.type,
      action: 'AGENT_ERROR',
      reason: error.message,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
  }
});

async function executeReroute(db, tripId, newDestId, reason) {
  try {
    const tripSnap = await db.ref(`/trips/${tripId}`).get();
    const trip = tripSnap.val();
    if (!trip || !trip.current_location) return;

    const origin = trip.current_location;
    let dest;
    const facSnap = await db.ref(`/infrastructure/factories/${newDestId}`).get();
    if (facSnap.exists()) dest = facSnap.val();
    else {
      const csSnap = await db.ref(`/infrastructure/cold_storage/${newDestId}`).get();
      if (csSnap.exists()) dest = csSnap.val();
    }

    if (!dest) {
      await db.ref(`/trips/${tripId}`).update({
        status: "REROUTING", last_reason: reason + " (Destination not found, manual intervention needed)", simulator_active: null
      });
      return;
    }

    const response = await axios.post(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
        travelMode: "DRIVE"
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': MAPS_API_KEY,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
        }
      }
    );

    const route = response.data.routes[0];
    // We update the encoded_polyline. The simulator watches for EN_ROUTE and will 
    // pick up the NEW path from the NEW currentIndex 0.
    await db.ref(`/trips/${tripId}`).update({
      status: "EN_ROUTE",
      destination: newDestId,
      encoded_polyline: route.polyline.encodedPolyline,
      current_step: 0, // Force simulator reset
      eta: route.duration,
      last_reason: reason,
      simulator_active: null
    });
  } catch (e) {
    console.error('[executeReroute] Failed:', e.message);
  }
}

async function executeReturnToOrigin(db, tripId, reason) {
  try {
    const tripSnap = await db.ref(`/trips/${tripId}`).get();
    const trip = tripSnap.val();
    if (!trip || !trip.current_location || !trip.waypoints || trip.waypoints.length === 0) return;

    const origin = trip.current_location;
    const dest = trip.waypoints[0]; // The very first origin waypoint

    const response = await axios.post(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
        travelMode: "DRIVE"
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': MAPS_API_KEY,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
        }
      }
    );

    const route = response.data.routes[0];
    await db.ref(`/trips/${tripId}`).update({
      status: "EN_ROUTE",
      encoded_polyline: route.polyline.encodedPolyline,
      current_step: 0, // Force simulator reset
      waypoints: [
        { lat: origin.lat, lng: origin.lng },
        { lat: dest.lat, lng: dest.lng } // Reversing waypoints
      ],
      eta: route.duration,
      last_reason: reason,
      simulator_active: null
    });
    console.log(`[executeReturnToOrigin] Successfully routed truck ${tripId} back to origin.`);
  } catch (e) {
    console.error('[executeReturnToOrigin] Failed:', e.message);
  }
}

async function executeRecalculateCurrentRoute(db, tripId, reason) {
  try {
    const tripSnap = await db.ref(`/trips/${tripId}`).get();
    const trip = tripSnap.val();
    if (!trip || !trip.current_location || !trip.waypoints || trip.waypoints.length < 2) return;

    const origin = trip.current_location;
    const dest = trip.waypoints[trip.waypoints.length - 1]; // Current final destination

    console.log(`[executeRecalculateCurrentRoute] Computing alternative routes from [${origin.lat},${origin.lng}] to [${dest.lat},${dest.lng}]`);

    const response = await axios.post(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE_OPTIMAL",
        computeAlternativeRoutes: true // Request alternative routes to avoid the blocked path
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': MAPS_API_KEY,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
        }
      }
    );

    const routes = response.data.routes || [];
    console.log(`[executeRecalculateCurrentRoute] Received ${routes.length} route(s) from API.`);

    // Pick the ALTERNATIVE route (routes[1]) if available, otherwise fall back to routes[0]
    // routes[0] is the fastest/default (likely goes through the blocked road)
    // routes[1] is the best alternative that takes a different path
    const selectedRoute = routes.length > 1 ? routes[1] : routes[0];
    const routeLabel = routes.length > 1 ? 'ALTERNATIVE (routes[1])' : 'PRIMARY (only route available)';

    if (!selectedRoute) {
      console.error(`[executeRecalculateCurrentRoute] No routes returned for ${tripId}.`);
      await db.ref(`/trips/${tripId}`).update({
        status: "WAITING", last_reason: reason + ' — No alternative route found, manual intervention needed.',
        simulator_active: null
      });
      return;
    }

    console.log(`[executeRecalculateCurrentRoute] Selected ${routeLabel} — Distance: ${selectedRoute.distanceMeters}m, Duration: ${selectedRoute.duration}`);

    await db.ref(`/trips/${tripId}`).update({
      status: "EN_ROUTE",
      encoded_polyline: selectedRoute.polyline.encodedPolyline,
      current_step: 0, // Force simulator reset
      eta: selectedRoute.duration,
      last_reason: reason,
      simulator_active: null,
      reroute_type: routeLabel
    });
    console.log(`[executeRecalculateCurrentRoute] Successfully bypassed blockage for ${tripId} using ${routeLabel}.`);
  } catch (e) {
    console.error('[executeRecalculateCurrentRoute] Failed:', e.message);
    // If routing fails, leave trip in WAITING so it doesn't get stuck
    await db.ref(`/trips/${tripId}`).update({
      status: "WAITING", last_reason: reason + ` — Route calculation failed: ${e.message}`,
      simulator_active: null
    }).catch(() => {});
  }
}

/** ==========================================
 *  4. OSINT AGENT (Weather & Environment Watcher)
 *  ========================================== */
exports.osintAgent = onSchedule("every 30 minutes", async (event) => {
  console.log("[OSINT Agent] Scanning environment for all EN_ROUTE trucks...");
  
  try {
    const tripsSnap = await db.ref('/trips').orderByChild('status').equalTo('EN_ROUTE').get();
    if (!tripsSnap.exists()) {
      console.log("[OSINT Agent] No EN_ROUTE trips to monitor.");
      return;
    }
    
    const trips = tripsSnap.val();
    
    for (const [tripId, trip] of Object.entries(trips)) {
      if (trip.current_location) {
        const { lat, lng } = trip.current_location;
        const wx = await fetchWeatherForLocation(lat, lng);
        
        console.log(`[OSINT Agent] Trip ${tripId}: ${wx.condition} at [${lat}, ${lng}]`);
        
        if (["Thunderstorm", "Tornado", "Extreme", "Snow"].includes(wx.condition)) {
          console.log(`[OSINT Agent] ⚠️ ${wx.condition} detected over Trip ${tripId}! Triggering warning.`);
          await db.ref('/events').push({
            type: "WEATHER_WARNING",
            trip_id: tripId,
            condition: wx.condition,
            description: wx.description,
            severity: "CRITICAL",
            weather_data: wx,
            timestamp: admin.database.ServerValue.TIMESTAMP
          });
        }
      }
    }
  } catch (err) {
    console.error("OSINT Agent Core Failure:", err);
  }
});