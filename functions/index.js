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
      description: "Reroute a truck to an alternate active facility. Use when targeted pickup location (factory or cold storage) is down, on fire, or unavailable. Pick the geographically nearest active facility.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING", description: "The trip ID to reroute" },
          new_destination_id: { type: "STRING", description: "ID of an alternate ACTIVE facility from the INFRASTRUCTURE STATUS. NEVER guess or hallucinate this ID." },
          reason: { type: "STRING", description: "Human-readable reason for rerouting. Describe the specific coordinates or area involved." }
        },
        required: ["trip_id", "new_destination_id", "reason"]
      }
    },
    {
      name: "recalculate_route_to_current_destination",
      description: "Use this to recalculate a new route to the SAME destination, avoiding the roadblock or traffic anomaly. The truck will autonomously find a detour.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "Why we are recalculating. DO NOT mention 'Highway 44' unless it's in the event data. Mention the specific area or incident." }
        },
        required: ["trip_id", "reason"]
      }
    },
    {
      name: "instruct_driver_shelter",
      description: "Order the driver to STOP immediately and pull over to shelter. Use for severe weather (Thunderstorm, Tornado, Flood, Cyclone). The truck halts until conditions improve.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          wait_time_minutes: { type: "INTEGER", description: "Estimated wait in minutes" },
          reason: { type: "STRING", description: "Why the driver must stop (2-3 sentences)" }
        },
        required: ["trip_id", "wait_time_minutes", "reason"]
      }
    },
    {
      name: "return_to_origin_or_safe_harbor",
      description: "ABORT the mission entirely. Send truck back to nearest safe location. Use when ALL factories are down, route is completely impassable, or cargo is compromised beyond recovery.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "Why the mission is aborted (2-3 sentences)" }
        },
        required: ["trip_id", "reason"]
      }
    },
    {
      name: "dispatch_backup_truck",
      description: "Summon a replacement truck when the current truck has a mechanical failure or breakdown. The original truck halts and a backup is requested.",
      parameters: {
        type: "OBJECT",
        properties: {
          original_trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "Details of the breakdown and backup plan (2-3 sentences)" }
        },
        required: ["original_trip_id", "reason"]
      }
    },

    {
      name: "resume_trip",
      description: "Resume a halted trip. Use when conditions have improved (weather cleared, backup arrived, etc.).",
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
      description: "Flag the cargo as compromised due to temperature breach, contamination, or damage. The trip continues but cargo is marked for inspection at destination.",
      parameters: {
        type: "OBJECT",
        properties: {
          trip_id: { type: "STRING" },
          reason: { type: "STRING", description: "What happened to the cargo" }
        },
        required: ["trip_id", "reason"]
      }
    },
    {
      name: "no_action_needed",
      description: "Use when the event does not require any intervention. Log the reasoning.",
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

  try {
    // 1. Gather ALL context
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

    let factories = {};
    let coldStorages = {};

    if (resolvedTrip && resolvedTrip.waypoints) {
      const wpCoords = resolvedTrip.waypoints.map(w => `${parseFloat(w.lat).toFixed(4)},${parseFloat(w.lng).toFixed(4)}`);
      for (const [id, f] of Object.entries(allFactories)) {
        if (wpCoords.includes(`${parseFloat(f.lat).toFixed(4)},${parseFloat(f.lng).toFixed(4)}`)) factories[id] = f;
      }
      for (const [id, cs] of Object.entries(allColdStorages)) {
        if (wpCoords.includes(`${parseFloat(cs.lat).toFixed(4)},${parseFloat(cs.lng).toFixed(4)}`)) coldStorages[id] = cs;
      }
    }

    // 2. Check weather at truck's current location if available
    let weatherContext = "No location available for weather check.";
    if (resolvedTrip && resolvedTrip.current_location) {
      const wx = await fetchWeatherForLocation(resolvedTrip.current_location.lat, resolvedTrip.current_location.lng);
      weatherContext = `Current weather at truck location: ${wx.condition} (${wx.description}), Temp: ${wx.temp_celsius}°C, Wind: ${wx.wind_speed} m/s, Humidity: ${wx.humidity}%`;
    }

    const eventLabel = eventData.label || eventData.metadata?.desc || eventData.type;

    // 3. Build comprehensive prompt
    const prompt = `
You are VITA Master Agent — an autonomous AI logistics commander. You have FULL AUTHORITY to make real-time decisions.

## INCOMING EVENT
Type: ${eventData.type}
Label: ${eventLabel}
Full Event Data: ${JSON.stringify(eventData)}

## AFFECTED TRIP
Trip ID: ${resolvedTripId || 'NONE'}
Trip Data: ${JSON.stringify(resolvedTrip)}

## LIVE WEATHER INTELLIGENCE
${weatherContext}

## INFRASTRUCTURE STATUS
Active Factories (${Object.keys(factories).length}): ${JSON.stringify(factories)}
Active Cold Storages (${Object.keys(coldStorages).length}): ${JSON.stringify(coldStorages)}

## ALL ACTIVE FLEET
${JSON.stringify(Object.fromEntries(Object.entries(allTrips).filter(([_, t]) => ['EN_ROUTE', 'PENDING_DRIVER_START'].includes(t.status))))}

## DECISION PROTOCOL
1. TRUCK_BREAKDOWN → IMMEDIATELY halt the truck. Call 'dispatch_backup_truck'. The driver waits for rescue.
2. FACTORY_DOWNTIME_DETECTED / SIMULATED_FACTORY_FAILURE → Find ALL trips heading to the downed factory. Reroute each to the nearest ACTIVE alternate factory. If NO factories remain, abort.
3. WEATHER_WARNING → Do NOT verify. The weather is already critically dangerous. Immediately call 'instruct_driver_shelter' to protect the driver.
4. SIMULATED_TEMP_BREACH → Cargo may be compromised. Call 'mark_cargo_compromised' and decide if the trip should continue.
5. SIMULATED_ROAD_BLOCK → Use 'recalculate_route_to_current_destination' to simply detour around the blockage to the same destination. ONLY use 'reroute_to_alternate_pickup' to abandon the destination if a much closer ACTIVE facility exists in the INFRASTRUCTURE STATUS. NEVER hallucinate facility IDs!

IMPORTANT: You MUST call exactly ONE tool function. Use the provided event label wording verbatim in your reasoning (no renaming). Provide detailed reasoning in the 'reason' field — this will be shown to the operations manager as an Explainable AI decision log.
`;

    // 4. Call Gemini
    const generativeModel = vertexAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const result = await generativeModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: supplyChainTools,
      tool_config: { function_calling_config: { mode: "ANY" } }
    });

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
        const roadBlockLocation = eventData.metadata?.location || '';
        const avoidHighways = /highway|nh\s*\d+/i.test(roadBlockLocation);
        await executeRecalculateCurrentRoute(db, args.trip_id, args.reason, { avoidHighways });
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

async function executeRecalculateCurrentRoute(db, tripId, reason, routeModifiers = {}) {
  try {
    const tripSnap = await db.ref(`/trips/${tripId}`).get();
    const trip = tripSnap.val();
    if (!trip || !trip.current_location || !trip.waypoints || trip.waypoints.length < 2) return;

    const origin = trip.current_location;
    const dest = trip.waypoints[trip.waypoints.length - 1]; // Current final destination

    const response = await axios.post(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        routeModifiers
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
      eta: route.duration,
      last_reason: reason,
      simulator_active: null
    });
    console.log(`[executeRecalculateCurrentRoute] Successfully bypassed blockage for ${tripId}.`);
  } catch (e) {
    console.error('[executeRecalculateCurrentRoute] Failed:', e.message);
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