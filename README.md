# VITA — Autonomous Logistics Intelligence Platform

> **V**ehicle **I**ntelligence & **T**ransport **A**utomation — An AI-powered supply chain simulation platform with real-time IoT telemetry, autonomous decision-making, and geospatial route optimization.

![Firebase](https://img.shields.io/badge/Firebase-2nd_Gen_Functions-orange?logo=firebase)
![Gemini](https://img.shields.io/badge/Vertex_AI-Gemini_2.5_Flash-blue?logo=google)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite)

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    VITA Platform Architecture                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────┐ │
│  │  Flutter App  │    │  React Admin │    │  ESP32 / IoT   │ │
│  │  (Driver UI)  │◄──►│  Dashboard   │◄──►│  Sensors       │ │
│  └──────┬───────┘    └──────┬───────┘    └───────┬────────┘ │
│         │                    │                     │          │
│         ▼                    ▼                     ▼          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Firebase Realtime Database                │   │
│  │   /trips  /infrastructure  /events  /agent_log        │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Firebase Cloud Functions (2nd Gen)             │   │
│  │  masterAgent │ startTrip │ fireEvent │ sensorIngest   │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                          │                                    │
│              ┌───────────┼───────────┐                       │
│              ▼           ▼           ▼                       │
│  ┌──────────────┐ ┌───────────┐ ┌──────────────┐           │
│  │  Vertex AI    │ │  Google   │ │ OpenWeather  │           │
│  │  Gemini 2.5   │ │ Routes API│ │     API      │           │
│  └──────────────┘ └───────────┘ └──────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Features Implemented

### 🧠 Autonomous Agentic Intelligence
- **Master Agent** — Gemini 2.5 Flash-powered AI that autonomously responds to logistics anomalies using tool-calling
- **SOP-driven decisions** — Standard Operating Procedures for 6 event types (road blocks, breakdowns, temp breaches, factory failures, cold storage failures, weather warnings)
- **Explainable AI** — Every decision is logged with full reasoning, event context, and weather data
- **Typewriter UI** — AI decisions stream line-by-line in the dashboard for a real-time buffering effect

### 🗺️ Real-Time Geospatial Simulation
- **Live Google Maps** — Real-time truck position tracking with animated markers
- **Route Simulation Engine** — Node.js simulator decodes Google Routes API polylines and moves trucks step-by-step
- **Dynamic Rerouting** — When AI decides to reroute, the simulator automatically detects the new `encoded_polyline` and follows the updated path
- **ETA & CO2 Estimation** — Calculated from route distance and duration
- **Multi-stop trips** — Support for waypoints covering multiple factories and cold storages

### 🏭 Infrastructure Management
- **Factory & Cold Storage CRUD** — Add/remove infrastructure nodes with Google Places Autocomplete
- **IoT Sensor Telemetry** — Simulated ESP32 data (sound dB, temperature) for factories, cold storages, and truck cargo
- **Sensor Dead Zone Detection** — If factory sound drops to 0 dB for 48+ hours, triggers `FACTORY_DOWNTIME_DETECTED`
- **Fleet Overview** — Real-time status of all trucks with AI decision summaries

### ⚡ Chaos Engineering Panel
- **8 Anomaly Types**: Road Block, Truck Breakdown, Temperature Breach, Cargo Theft, Factory Fire, Cold Storage Power Failure, Sensor Dead Zone, Blizzard/Storm
- **Location-aware events** — Select which factory/cold storage is affected
- **AI Agent Log** — Full history of autonomous decisions with filtering
- **IoT Telemetry Panel** — Reactive sensor data that reflects active anomalies

### 📊 Simulation Analytics
- **Network Graph** — D3.js force-directed graph of infrastructure nodes with labeled connections
- **Geospatial Risk Overlay** — Google Maps with risk heat markers
- **Trip History** — Past simulation results with AI decision replay

### 🔐 Authentication & Security
- **Firebase Authentication** — Email/password login
- **Protected Routes** — All dashboard pages require authentication
- **Cloud Functions** — All database writes go through server-side functions (bypasses client DB rules)

---

## 📁 Project Structure

```
ProjectVITA/
├── dashboard/                  # React Admin Dashboard (Vite)
│   ├── src/
│   │   ├── api/
│   │   │   └── firebaseConfig.js    # Firebase client SDK config
│   │   ├── components/
│   │   │   ├── GlobalAlertBanner.jsx # Real-time alert notifications
│   │   │   └── ProtectedRoute.jsx   # Auth guard component
│   │   ├── context/
│   │   │   └── AuthContext.jsx      # Firebase auth state provider
│   │   ├── pages/
│   │   │   ├── MapPage.jsx          # Live Command Center (main dashboard)
│   │   │   ├── InfraPage.jsx        # Infrastructure management
│   │   │   ├── CreateTripPage.jsx   # Trip creation + Quick Test Trip
│   │   │   ├── ChaosPage.jsx        # Anomaly injection + IoT panel
│   │   │   ├── SimulationPage.jsx   # Analytics & network graph
│   │   │   └── LoginPage.jsx        # Authentication page
│   │   ├── styles/
│   │   │   └── glassmorphism.css    # Design system (light mode + aurora)
│   │   └── App.jsx                  # Router + Sidebar + Layout
│   ├── .env                         # Frontend env vars (VITE_*)
│   └── package.json
│
├── functions/                  # Firebase Cloud Functions (Node.js 24)
│   ├── index.js                # All cloud functions & AI agent logic
│   ├── simulator.js            # Local truck movement simulator
│   ├── .env                    # Backend secrets (API keys)
│   └── package.json
│
├── firebase.json               # Firebase config (hosting + functions + DB)
├── database.rules.json         # Realtime Database security rules
└── README.md                   # This file
```

---

## 🔌 Flutter Integration

The VITA platform is designed as the **backend brain** for a Flutter mobile app used by truck drivers. Here's how they connect:

### Data Flow: Flutter ↔ Firebase ↔ Dashboard

```
Flutter Driver App                    Firebase RTDB                    React Dashboard
─────────────────                    ──────────────                    ───────────────
1. Driver logs in          ──►      /trips/{id}/status                Sees trip appear
2. Accepts trip            ──►      status: EN_ROUTE                  Map marker moves
3. GPS updates             ──►      /trips/{id}/current_location      Real-time tracking
4. Anomaly detected        ──►      /events/{id} (triggers agent)     AI decision logged
5. AI says "reroute"       ◄──      /trips/{id}/encoded_polyline      New route on map
6. AI says "shelter"       ◄──      /trips/{id}/status: WAITING       Shows "Resume" btn
7. Driver resumes          ──►      status: EN_ROUTE                  Truck moves again
8. Trip completes          ──►      status: COMPLETED                 Moves to "Past"
```

### Flutter reads from:
| Firebase Path | Purpose |
|---|---|
| `/trips/{trip_id}` | Trip details, status, waypoints, encoded_polyline |
| `/trips/{trip_id}/last_agent_decision` | Latest AI decision (action + reason) |
| `/trips/{trip_id}/current_location` | Real-time GPS position |
| `/infrastructure/factories` | Factory locations for pickup |
| `/infrastructure/cold_storage` | Cold storage locations for delivery |

### Flutter writes to:
| Firebase Path | Purpose |
|---|---|
| `/trips/{trip_id}/current_location` | GPS updates from driver's phone |
| `/trips/{trip_id}/status` | Status changes (accepted, completed) |
| `/sensor_data/{device_id}` | ESP32 IoT telemetry (via MQTT bridge) |

### Flutter calls these Cloud Functions:
| Function | Purpose |
|---|---|
| `startTripSimulation` | Begin trip after driver accepts |
| `resumeTrip` | Resume after a WAITING state |
| `applySimulationRoute` | Calculate route via Google Routes API |

### Key: The simulator (`simulator.js`) replaces the Flutter app for demo purposes
During development/demo, `node simulator.js` simulates what the Flutter app would do:
- Moves the truck along the polyline step-by-step
- Updates `current_location` in Firebase every 2 seconds
- Detects route changes (AI reroutes) and follows the new path
- Completes the trip when the destination is reached

---

## ☁️ Cloud Functions Reference

| Function | Trigger | Description |
|---|---|---|
| `sensorIngest` | HTTPS Callable | Ingests IoT sensor data from ESP32 devices |
| `addInfrastructure` | HTTPS Callable | Adds a factory or cold storage node |
| `deleteInfrastructure` | HTTPS Callable | Removes an infrastructure node |
| `getInfrastructure` | HTTPS Callable | Fetches all infrastructure (bypasses DB rules) |
| `createTrip` | HTTPS Callable | Creates a new trip with waypoints |
| `startTripSimulation` | HTTPS Callable | Starts the trip simulation (EN_ROUTE) |
| `killTrip` | HTTPS Callable | Terminates a trip (KILLED) |
| `resumeTrip` | HTTPS Callable | Resumes a WAITING trip |
| `fireEvent` | HTTPS Callable | Injects a chaos anomaly event |
| `applySimulationRoute` | HTTPS Callable | Calculates route via Google Routes API |
| `masterAgent` | Realtime DB Trigger | **AI Brain** — triggers on `/events/{id}`, calls Gemini 2.5 Flash |

---

## 🛠️ Setup & Deployment

### Prerequisites
- Node.js 18+
- Firebase CLI (`npm install -g firebase-tools`)
- Google Cloud project with:
  - Firebase Realtime Database
  - Firebase Authentication (Email/Password enabled)
  - Firebase Hosting
  - Cloud Functions (2nd Gen)
  - Vertex AI API enabled
  - Google Routes API enabled
  - Google Maps JavaScript API enabled

### 1. Clone & Install
```bash
git clone https://github.com/Saucyyy8/vita.git
cd vita

# Install dashboard dependencies
cd dashboard && npm install && cd ..

# Install functions dependencies
cd functions && npm install && cd ..
```

### 2. Configure Environment Variables

**Dashboard** (`dashboard/.env`):
```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

**Functions** (`functions/.env`):
```env
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
OPENWEATHER_API_KEY=your_openweather_api_key
```

### 3. Deploy
```bash
# Login to Firebase
firebase login

# Deploy everything
firebase deploy

# Or deploy individually:
firebase deploy --only hosting        # Dashboard
firebase deploy --only functions      # Cloud Functions
```

### 4. Run Locally (Development)
```bash
# Terminal 1: Dashboard dev server
cd dashboard && npm run dev

# Terminal 2: Simulator (replaces Flutter app)
cd functions && node simulator.js
```

---

## 🌐 Live Deployment

| Service | URL |
|---|---|
| **Dashboard** | https://keen-proton-493005-c7.web.app |
| **Firebase Console** | https://console.firebase.google.com/project/keen-proton-493005-c7 |
| **Region** | `us-central1` |
| **Runtime** | Node.js 24 (2nd Gen Cloud Functions) |

---

## 🔑 External APIs Used

| API | Purpose | Provider |
|---|---|---|
| Vertex AI (Gemini 2.5 Flash) | Autonomous decision-making agent | Google Cloud |
| Google Routes API | Route calculation & polyline encoding | Google Maps Platform |
| Google Maps JavaScript API | Live map rendering in dashboard | Google Maps Platform |
| Google Places API | Address autocomplete for infrastructure | Google Maps Platform |
| OpenWeatherMap API | Real-time weather at truck locations | OpenWeatherMap |

---

## 📱 IoT Integration (ESP32)

The platform is designed to receive real-time sensor data from ESP32 microcontrollers deployed at:

- **Factories** — Microphone (dB) + Temperature sensor
  - If sound = 0 dB for 48+ hours → `FACTORY_DOWNTIME_DETECTED`
  - If temperature > 200°C → `FACTORY_FIRE` alert
- **Cold Storage** — Temperature sensor
  - If temperature > -10°C → `COLD_STORAGE_FAILURE` alert
- **Trucks** — Cargo temperature + GPS + Speed
  - If cargo temp exceeds safe threshold → `TEMP_BREACH` event

ESP32 devices push data via the `sensorIngest` Cloud Function:
```bash
curl -X POST https://us-central1-keen-proton-493005-c7.cloudfunctions.net/sensorIngest \
  -H "Content-Type: application/json" \
  -d '{"device_id": "esp32_factory_01", "type": "factory", "sound_db": 75, "temp_celsius": 24}'
```

---

## 🧪 Testing the Platform

1. **Create a trip** — Use "Quick Test Trip" on the Create Trip page (covers all infrastructure nodes)
2. **Start simulation** — Click "Start Sim" on the Live Map
3. **Run the simulator** — `cd functions && node simulator.js` (moves the truck)
4. **Inject anomalies** — Go to Chaos Panel and trigger events (Road Block, Blizzard, Cold Storage Failure, etc.)
5. **Watch AI respond** — The Master Agent processes the event, calls Gemini, and executes the decision
6. **See reroute happen** — If AI decides to reroute, the simulator detects the new polyline and follows it

---

## 📝 License

This project was built for the **Google Solution Challenge 2025**.

---

*Built with ❤️ using Firebase, Gemini AI, Google Maps, and React*
