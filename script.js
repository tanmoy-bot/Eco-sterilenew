// ==========================================
// EcoSterile pH Regulator Dashboard Script
// ==========================================

// Data Storage
let phData = {
  timestamps: [],
  values: [],
  pumpLog: [],
  lastPump: null,
  systemStartTime: new Date(),
};

// Runtime state for serial/demo
let simInterval = null;
let arduinoConnected = false;
let lastReportedPump = null; // track last pump reported by Arduino to avoid duplicate logs
// Dynamic optimal pH range (defaults)
let optimalPHMin = 6.5;
let optimalPHMax = 7.5;
// Load data from localStorage
function loadData() {
  const stored = localStorage.getItem("ecosterile_data");
  if (stored) {
    try {
      phData = JSON.parse(stored);
      phData.systemStartTime = new Date(phData.systemStartTime);
    } catch (e) {
      console.log("Starting with fresh data");
    }
  }
}

// Use this function in place of the previous startStaticPlayback
// It maps wall-clock time to an index inside the JSON so EVERY visitor sees the same pH at the same real time.
// readings[] should be an array of objects like { "ts": "...", "ph": 7.02 } but ts is used only to determine epoch.
// intervalMs must be same as the spacing used when you generated the JSON (default: 5000 ms).
async function startStaticPlayback(
  url = "ph_readings.json",
  intervalMs = 5000
) {
  try {
    console.log("Fetching static playback data from:", url);

    // Fetch the JSON file
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Static file missing or inaccessible: " + url);

    // Parse the JSON data
    const readings = await res.json();
    console.log("Readings fetched:", readings);

    if (!Array.isArray(readings) || readings.length === 0) {
      throw new Error("Invalid readings JSON format");
    }

    // Determine epoch: use first reading's timestamp if present, else fallback to now
    let epoch = Date.now();
    if (readings[0].ts) {
      const parsed = Date.parse(readings[0].ts);
      if (!isNaN(parsed)) epoch = parsed;
    }

    // Ensure simulation is not already running
    stopSimulation();

    // Helper function to set the current reading based on wall-clock time
    function applyCurrentReading() {
      const now = Date.now();
      const elapsed = Math.max(0, now - epoch);
      const index = Math.floor(elapsed / intervalMs) % readings.length;
      const phValue = parseFloat(readings[index].ph);
      console.log("Applying reading:", readings[index]); // Debug log
      if (!isNaN(phValue)) {
        // Add pH reading to the dashboard
        addPHReading(phValue);
        simulatePumpControl(phValue);
      }
    }

    // Immediately apply the current reading once
    applyCurrentReading();

    // Schedule updates exactly on interval boundaries to stay synced with wall-clock
    const now = Date.now();
    const sinceEpoch = now - epoch;
    const delayToNext = intervalMs - (sinceEpoch % intervalMs);

    // First timeout to align, then fixed interval
    setTimeout(() => {
      applyCurrentReading(); // Apply once at the exact boundary
      simInterval = setInterval(() => {
        applyCurrentReading();
      }, intervalMs);
    }, delayToNext);
  } catch (err) {
    console.error("Static playback failed:", err);
    // Fallback: if static playback fails, start normal local simulation
    if (!simInterval) startSimulation();
  }
}

// Save data to localStorage
function saveData() {
  localStorage.setItem("ecosterile_data", JSON.stringify(phData));
}

// Update pH display
function updatePHDisplay(pH) {
  const phValue = document.getElementById("phValue");
  const phStatus = document.getElementById("phStatus");
  const phIndicator = document.getElementById("phIndicator");

  phValue.textContent = pH.toFixed(1);

  // Update status using dynamic optimal range
  if (pH < optimalPHMin) {
    phStatus.textContent = "🔴 Too Acidic";
    phStatus.style.color = "#e74c3c";
  } else if (pH > optimalPHMax) {
    phStatus.textContent = "🔵 Too Basic";
    phStatus.style.color = "#3498db";
  } else {
    phStatus.textContent = "🟢 Optimal";
    phStatus.style.color = "#27ae60";
  }

  // Update scale indicator position (0-14 pH scale)
  const percentage = (pH / 14) * 100;
  phIndicator.style.left = percentage + "%";
}

// Log pump activity
function logPumpActivity(type, concentration = "1%") {
  const timestamp = new Date();
  const logEntry = {
    timestamp: timestamp,
    type: type, // 'basic' or 'acidic'
    concentration: concentration,
    solution:
      type === "basic" ? "Ammonium Hydroxide (NH4OH)" : "Acetic Acid (CH3COOH)",
  };

  phData.pumpLog.push(logEntry);
  phData.lastPump = logEntry;

  // Keep only last 30 days of logs
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  phData.pumpLog = phData.pumpLog.filter(
    (log) => new Date(log.timestamp) > thirtyDaysAgo
  );

  saveData();
  updatePumpInfo();
  updateLog();
  updateStats();
}

// Update pump info display
function updatePumpInfo() {
  const lastPumpName = document.getElementById("lastPumpName");
  const lastPumpTime = document.getElementById("lastPumpTime");
  const lastPumpSolution = document.getElementById("lastPumpSolution");
  const lastPumpConcentration = document.getElementById(
    "lastPumpConcentration"
  );

  if (phData.lastPump) {
    const pump = phData.lastPump;
    lastPumpName.textContent =
      pump.type === "basic" ? "💧 Basic Pump" : "⚗️ Acidic Pump";
    lastPumpName.style.color = pump.type === "basic" ? "#3498db" : "#e74c3c";

    const timeAgo = getTimeAgo(new Date(pump.timestamp));
    lastPumpTime.textContent = timeAgo;
    lastPumpSolution.textContent = pump.solution;
    lastPumpConcentration.textContent = pump.concentration;
  }
}

// Calculate time difference
function getTimeAgo(date) {
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return seconds + " sec ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " hr ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + " day" + (days > 1 ? "s" : "") + " ago";

  return date.toLocaleDateString();
}

// Update activity log
function updateLog() {
  const logContainer = document.getElementById("logContainer");
  const logCount = document.getElementById("logCount");

  logCount.textContent = phData.pumpLog.length + " entries";

  if (phData.pumpLog.length === 0) {
    logContainer.innerHTML =
      '<p class="empty-state">No pump activity recorded yet</p>';
    return;
  }

  // Show last 20 entries
  const recentLogs = phData.pumpLog.slice(-20).reverse();
  logContainer.innerHTML = recentLogs
    .map(
      (log) => `
        <div class="log-entry ${log.type}">
            <div>
                <div class="log-pump ${log.type}">${
        log.type === "basic" ? "💧 Basic" : "⚗️ Acidic"
      }</div>
                <div class="log-time">${new Date(
                  log.timestamp
                ).toLocaleString()}</div>
            </div>
            <div style="text-align: right;">
                <div style="font-size: 0.9em; color: #7f8c8d;">${
                  log.solution
                }</div>
                <div style="font-size: 0.85em; color: #95a5a6;">${
                  log.concentration
                }</div>
            </div>
        </div>
    `
    )
    .join("");
}

// Update statistics
function updateStats() {
  const avgPH = document.getElementById("avgPH");
  const pHRange = document.getElementById("pHRange");
  const basicPumpCount = document.getElementById("basicPumpCount");
  const acidicPumpCount = document.getElementById("acidicPumpCount");

  // Calculate average pH
  if (phData.values.length > 0) {
    const avg = (
      phData.values.reduce((a, b) => a + b, 0) / phData.values.length
    ).toFixed(2);
    avgPH.textContent = avg;
  }

  // Calculate pH range
  if (phData.values.length > 0) {
    const min = Math.min(...phData.values).toFixed(1);
    const max = Math.max(...phData.values).toFixed(1);
    pHRange.textContent = min + " - " + max;
  }

  // Count pump usage
  const basicCount = phData.pumpLog.filter(
    (log) => log.type === "basic"
  ).length;
  const acidicCount = phData.pumpLog.filter(
    (log) => log.type === "acidic"
  ).length;
  basicPumpCount.textContent = basicCount;
  acidicPumpCount.textContent = acidicCount;
}

// Initialize Chart.js
let phChart = null;

function initializeChart() {
  const ctx = document.getElementById("phChart").getContext("2d");
  phChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "pH Level",
          data: [],
          borderColor: "#27ae60",
          backgroundColor: "rgba(39, 174, 96, 0.1)",
          tension: 0.4,
          fill: true,
          pointRadius: 4,
          pointBackgroundColor: "#27ae60",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            font: { size: 12 },
            usePointStyle: true,
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: 14,
          title: {
            display: true,
            text: "pH Level",
          },
          ticks: {
            stepSize: 1,
          },
        },
        x: {
          title: {
            display: true,
            text: "Time",
          },
        },
      },
    },
  });
}

// Update chart data
function updateChart(timeRange = "24h") {
  if (!phChart) return;

  const now = new Date();
  let cutoffTime;

  switch (timeRange) {
    case "24h":
      cutoffTime = new Date(now - 24 * 60 * 60 * 1000);
      break;
    case "7d":
      cutoffTime = new Date(now - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
      cutoffTime = new Date(now - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      cutoffTime = new Date(now - 24 * 60 * 60 * 1000);
  }

  const filteredData = phData.timestamps
    .map((time, index) => ({
      time: new Date(time),
      value: phData.values[index],
    }))
    .filter((item) => item.time > cutoffTime);

  phChart.data.labels = filteredData.map((item) =>
    item.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
  phChart.data.datasets[0].data = filteredData.map((item) => item.value);
  phChart.update();
}

// Add pH reading (simulated or from serial)
function addPHReading(pH) {
  const timestamp = new Date();
  phData.timestamps.push(timestamp.toISOString());
  phData.values.push(pH);

  // Keep only last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const validIndices = phData.timestamps
    .map((time, idx) => (new Date(time) > thirtyDaysAgo ? idx : -1))
    .filter((idx) => idx !== -1);

  if (validIndices.length < phData.timestamps.length) {
    phData.timestamps = validIndices.map((idx) => phData.timestamps[idx]);
    phData.values = validIndices.map((idx) => phData.values[idx]);
  }

  updatePHDisplay(pH);
  updateChart();
  updateStats();
  updateLastUpdate();
  saveData();
}

// Simulate pump activation based on pH
function simulatePumpControl(pH) {
  // Use dynamic optimal range so pumps react to selected crop
  if (pH < optimalPHMin) {
    logPumpActivity("basic", "1%");
    console.log("BASIC pump activated - pH too low");
  } else if (pH > optimalPHMax) {
    logPumpActivity("acidic", "1%");
    console.log("ACIDIC pump activated - pH too high");
  }
}

// Update timestamp
function updateLastUpdate() {
  const lastUpdate = document.getElementById("lastUpdate");
  const footerTime = document.getElementById("footerTime");
  const now = new Date();
  lastUpdate.textContent = now.toLocaleTimeString();
  footerTime.textContent = now.toLocaleString();
}

// Event listeners for chart controls
document.getElementById("btn24h").addEventListener("click", function () {
  document
    .querySelectorAll(".btn-time")
    .forEach((btn) => btn.classList.remove("active"));
  this.classList.add("active");
  updateChart("24h");
});

document.getElementById("btn7d").addEventListener("click", function () {
  document
    .querySelectorAll(".btn-time")
    .forEach((btn) => btn.classList.remove("active"));
  this.classList.add("active");
  updateChart("7d");
});

document.getElementById("btnMonth").addEventListener("click", function () {
  document
    .querySelectorAll(".btn-time")
    .forEach((btn) => btn.classList.remove("active"));
  this.classList.add("active");
  updateChart("month");
});

document.getElementById("btnClear").addEventListener("click", function () {
  if (confirm("Are you sure you want to delete all historical data?")) {
    phData.timestamps = [];
    phData.values = [];
    phData.pumpLog = [];
    phData.lastPump = null;
    saveData();
    updateChart();
    updateLog();
    updateStats();
    alert("All data cleared!");
  }
});

// ==========================================
// Simulated Data Stream (Demo Mode)
// ==========================================
// Replace this with actual Arduino serial connection in production
function startSimulation() {
  console.log("Starting demo simulation...");

  let currentPH = 7.0;

  // store interval id so we can stop simulation when Arduino connects
  simInterval = setInterval(() => {
    // Simulate random pH fluctuation
    const change = (Math.random() - 0.5) * 0.3;
    currentPH = Math.max(4, Math.min(10, currentPH + change));

    addPHReading(currentPH);
    simulatePumpControl(currentPH);
  }, 5000); // Update every 5 seconds (adjust as needed)
}

function stopSimulation() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
    console.log("Simulation stopped");
  }
}

// ==========================================
// Arduino Serial Communication (Optional)
// ==========================================
// If using serial communication, use connectArduino() to request a serial port
// ==========================================
// Arduino Serial Communication (Optional)
// Stores a reference to the opened port so we can close it later
let currentPort = null;

// Update Arduino connection status in the UI
function updateArduinoStatus(connected) {
  const el = document.getElementById("arduinoStatus");
  const btn = document.getElementById("connectBtn");
  if (!el || !btn) return;
  if (connected) {
    el.textContent = "Connected (Live)";
    el.classList.remove("offline");
    el.classList.add("arduino-connected");
    btn.textContent = "Disconnect Arduino";
  } else {
    el.textContent = "Disconnected (Demo)";
    el.classList.remove("arduino-connected");
    el.classList.add("offline");
    btn.textContent = "Connect Arduino";
  }
}

async function connectArduino() {
  if (!("serial" in navigator)) {
    alert("Web Serial API not supported in this browser. Use Chrome or Edge.");
    return;
  }

  try {
    console.log("Requesting serial port...");
    const port = await navigator.serial.requestPort();
    
    if (!port) {
      console.log("User cancelled port selection.");
      alert("You cancelled the port selection.");
      return;
    }

    console.log("Opening port at 9600 baud...");
    await port.open({ baudRate: 9600 });
    console.log("Port opened successfully.");
    currentPort = port;

    // Stop demo simulation when Arduino connects
    arduinoConnected = true;
    if (simInterval) clearInterval(simInterval);
    simInterval = null;
    stopSimulation();
    updateArduinoStatus(true);
    console.log("Connected to Arduino. Awaiting data...");

    const textDecoder = new TextDecoder();
    const reader = port.readable.getReader();

    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          console.log("Serial port closed by Arduino.");
          break;
        }
        if (!value) continue;

        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop(); // last partial line

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          try {
            // Try parsing as JSON first (Arduino sends JSON format)
            // Example: {"pH":7.45,"voltage":2.441,"pump":"basic"}
            const obj = JSON.parse(line);

            // pH
            if (obj.pH !== undefined) {
              const pH = parseFloat(obj.pH);
              if (!isNaN(pH)) {
                addPHReading(pH);
                console.log("Arduino pH reading:", pH);
              }
            }

            // Pump activity reported by Arduino
            if (obj.pump) {
              const pumpRaw = obj.pump.toLowerCase();

              // Normalize pump type
              let pumpType = null;
              if (pumpRaw.includes("basic")) pumpType = "basic";
              else if (pumpRaw.includes("acidic")) pumpType = "acidic";

              if (pumpType && pumpType !== "off") {
                // avoid duplicate logs for the same pump
                if (lastReportedPump !== pumpType) {
                  logPumpActivity(pumpType, "1%");
                  lastReportedPump = pumpType;
                  console.log("Arduino pump:", pumpType);
                }
              } else {
                // reset last reported pump to allow future ON logs
                lastReportedPump = null;
              }
            }
          } catch (parseError) {
            // If JSON parsing fails, log it but don't crash
            console.log("Non-JSON line from Arduino:", line);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {}
    }

    // close port and cleanup
    try {
      await port.close();
    } catch (e) {}
    currentPort = null;
    arduinoConnected = false;
    console.log("Arduino disconnected");
    updateArduinoStatus(false);
    if (!simInterval) startSimulation();
  } catch (error) {
    console.error("Serial error:", error);
    const errorMsg = error.message || error.toString();
    
    // Check if user cancelled
    if (errorMsg.includes("cancelled") || errorMsg.includes("User cancelled")) {
      console.log("User cancelled the port request.");
      // No alert — user intentionally cancelled
    } else {
      alert("Could not connect to Arduino:\n" + errorMsg + "\n\nResuming demo mode.");
    }

    arduinoConnected = false;
    currentPort = null;
    updateArduinoStatus(false);

    // Restart demo mode
    if (!simInterval) startSimulation();
  }
}

// ==========================================
// Initialize Application
document.addEventListener("DOMContentLoaded", function () {
  loadData();
  initializeChart();
  updateChart("24h");
  updatePumpInfo();
  updateLog();
  updateStats();
  updateLastUpdate();

  // Initialize weather and forecasts
  updateWeatherDisplay();
  generateHourlyForecast();
  generateDailyForecast();

  // Update weather every 10 minutes
  setInterval(async () => {
    await updateWeatherDisplay();
  }, 10 * 60 * 1000);

  // Start simulation (demo mode)
  console.log("DOMContentLoaded: checking if simulation should start...", { arduinoConnected, simInterval });
  if (!arduinoConnected && !simInterval) {
    console.log("Starting simulation now...");
    startSimulation();
  } else {
    console.log("Simulation already running or Arduino connected.");
  }

  // Wire Connect button (toggle connect/disconnect)
  

  // Initialize Arduino status UI
  updateArduinoStatus(false);

  const cropSelector = document.getElementById("cropSelector");
  // Crop image element reference
  const cropImage = document.getElementById("cropImage");
  const optimalPHRange = document.getElementById("optimalPHRange");
  // Map crop values to emoji icons (kept for fallback)
  const cropIconMap = {
    rice: "🌾",
    wheat: "🌾",
    maize: "🌽",
    barley: "🌾",
    sorghum: "🌾",
    pearl_millet: "🌾",
    finger_millet: "🌾",
    chickpea: "🫘",
    pigeon_pea: "🫘",
    black_gram: "🫘",
    green_gram: "🫘",
    lentil: "🫘",
    kidney_bean: "🫘",
    cowpea: "🫘",
    horse_gram: "🫘",
    mustard: "🌼",
    groundnut: "🥜",
    soybean: "🌱",
    sunflower: "🌻",
    sesame: "🌿",
    castor: "🌱",
    linseed: "🌿",
    tomato: "🍅",
    potato: "🥔",
    onion: "🧅",
    brinjal: "🍆",
    cabbage: "🥬",
    cauliflower: "🥦",
    carrot: "🥕",
    spinach: "🥬",
    capsicum: "🫑",
    okra: "🥒",
    bottle_gourd: "🫛",
    bitter_gourd: "🥒",
    pumpkin: "🎃",
    peas: "🫛",
    mango: "🥭",
    banana: "🍌",
    guava: "🫐",
    apple: "🍎",
    grapes: "🍇",
    papaya: "🍈",
    watermelon: "🍉",
    muskmelon: "🍈",
    pomegranate: "🍎",
    orange: "🍊",
    lemon: "🍋",
    coconut: "🥥",
    sugarcane: "🌾",
    cotton: "☁️",
    jute: "🌿",
    tobacco: "🌿",
    tea: "🍃",
    coffee: "☕",
    rubber: "🌳",
    cocoa: "🍫",
    cardamom: "🌿",
    black_pepper: "🧂",
    turmeric: "🌿",
    ginger: "🌿",
    coriander: "🌿",
    cumin: "🌿",
    fenugreek: "🌿",
    cinnamon: "🌿",
    clove: "🌿",
    capsicum_protected: "🫑",
    tomato_protected: "🍅",
    cucumber: "🥒",
    lettuce_protected: "🥬",
    strawberries: "🍓",
    exotic_greens: "🥬",
  };
  // Track current selection and provide change protection
  let currentCropIndex = cropSelector ? cropSelector.selectedIndex : -1;
  let suppressCropChange = false; // used to avoid re-entrant change handling

  // Initialize optimal pH range and image from the currently selected option
  if (cropSelector && cropSelector.options && currentCropIndex >= 0) {
    const opt = cropSelector.options[currentCropIndex];
    const minPH = opt.dataset.min;
    const maxPH = opt.dataset.max;
    const cropValue = opt.value;
    optimalPHRange.textContent = `${minPH} - ${maxPH}`;
    optimalPHMin = parseFloat(minPH) || optimalPHMin;
    optimalPHMax = parseFloat(maxPH) || optimalPHMax;
    if (cropImage) {
      cropImage.src = `images/${cropValue}.png`;
      cropImage.alt = opt.text || cropValue;
      cropImage.title = opt.text || cropValue;
    }
  }

  // Insert a small lock button into the header to allow setting/removing password protection
  const cropHeader = cropSelector ? cropSelector.parentElement : null;
  if (cropHeader) {
    const lockBtn = document.createElement("button");
    lockBtn.id = "cropLockBtn";
    lockBtn.type = "button";
    lockBtn.title = "Protect crop changes";
    lockBtn.style.marginLeft = "8px";
    lockBtn.style.padding = "6px 8px";
    lockBtn.style.borderRadius = "6px";
    lockBtn.style.background = "rgba(255,255,255,0.08)";
    lockBtn.style.color = "white";
    lockBtn.style.border = "none";
    lockBtn.style.cursor = "pointer";
    lockBtn.style.fontWeight = "700";

    function isPasswordSet() {
      return !!localStorage.getItem("cropProtectPassword");
    }

    function updateLockButtonUI() {
      lockBtn.textContent = isPasswordSet() ? "🔒" : "🔓";
    }

    function verifyPassword(pw) {
      return localStorage.getItem("cropProtectPassword") === pw;
    }

    function setPassword(pw) {
      localStorage.setItem("cropProtectPassword", pw);
    }

    function removePassword() {
      localStorage.removeItem("cropProtectPassword");
    }

    lockBtn.addEventListener("click", function () {
      if (!isPasswordSet()) {
        const pw = prompt(
          "Set new crop-change password (leave blank to cancel):"
        );
        if (!pw) return;
        const pw2 = prompt("Confirm password:");
        if (pw !== pw2) return alert("Passwords do not match");
        setPassword(pw);
        alert("Password set for crop changes");
        updateLockButtonUI();
        return;
      }

      // Password already set: offer remove or change
      const removeAction = confirm(
        "Password protection is enabled. Click OK to remove the password, Cancel to change it."
      );
      if (removeAction) {
        const cur = prompt("Enter current password to remove:");
        if (!verifyPassword(cur)) return alert("Incorrect password");
        removePassword();
        alert("Password removed");
        updateLockButtonUI();
        return;
      }

      // Change password
      const cur = prompt("Enter current password:");
      if (!verifyPassword(cur)) return alert("Incorrect password");
      const np = prompt("Enter new password (leave blank to cancel):");
      if (!np) return;
      const np2 = prompt("Confirm new password:");
      if (np !== np2) return alert("Passwords do not match");
      setPassword(np);
      alert("Password changed");
      updateLockButtonUI();
    });

    updateLockButtonUI();
    cropHeader.appendChild(lockBtn);
    // Image toggle removed - images now always visible
  }

  // Update optimal pH range and crop image when a crop is selected (with confirmation/password)
  cropSelector.addEventListener("change", function () {
    if (suppressCropChange) {
      // change was programmatic - ignore and reset flag
      suppressCropChange = false;
      return;
    }

    const newIndex = cropSelector.selectedIndex;
    const selectedOption = cropSelector.options[newIndex];
    const minPH = selectedOption.dataset.min;
    const maxPH = selectedOption.dataset.max;
    const cropValue = selectedOption.value;

    const message = `Change crop to ${selectedOption.text} (pH ${minPH} - ${maxPH})? This may trigger pumps and affect your plants.`;

    // If password is set, verify first
    if (localStorage.getItem("cropProtectPassword")) {
      const pw = prompt("Enter password to change crop:");
      if (!verifyPassword(pw)) {
        alert("Incorrect password. Crop selection cancelled.");
        suppressCropChange = true;
        cropSelector.selectedIndex = currentCropIndex;
        return;
      }
    }

    // Ask for confirmation
    if (!confirm(message)) {
      suppressCropChange = true;
      cropSelector.selectedIndex = currentCropIndex;
      return;
    }

    // User confirmed and password (if needed) passed — apply changes
    optimalPHRange.textContent = `${minPH} - ${maxPH}`;
    optimalPHMin = parseFloat(minPH) || optimalPHMin;
    optimalPHMax = parseFloat(maxPH) || optimalPHMax;

    // Immediately update pH status display if there's a current value
    const currentPH = parseFloat(
      document.getElementById("phValue").textContent
    );
    if (!isNaN(currentPH)) updatePHDisplay(currentPH);

    // Update crop icon
    if (cropImage) {
      cropImage.src = `images/${cropValue}.png`;
      cropImage.alt = selectedOption.text || cropValue;
      cropImage.title = selectedOption.text || cropValue;
    }

    // Send updated pH range to Arduino (if connected)
    if (arduinoConnected) {
      sendPHRangeToArduino(minPH, maxPH);
    }

    // commit the selection index
    currentCropIndex = newIndex;
  });

  // Function to send pH range to Arduino
  function sendPHRangeToArduino(minPH, maxPH) {
    if (!currentPort) return;
    const command = `SET_PH_RANGE:${minPH},${maxPH}\n`;
    const encoder = new TextEncoder();
    currentPort.writable.getWriter().write(encoder.encode(command));
    console.log("Sent to Arduino:", command);
  }

  // Password recovery: Listen for Ctrl+Shift+Alt+R to reset forgotten password
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey && e.shiftKey && e.altKey && e.key === "R") {
      e.preventDefault();
      const stored = localStorage.getItem("cropProtectPassword");
      if (!stored) {
        alert("No password is currently set.");
        return;
      }

      const confirmReset = confirm(
        "Reset crop protection password? This requires verification.\n\nClick OK to proceed."
      );
      if (!confirmReset) return;

      const securityAnswer = prompt(
        "To reset, enter the answer to your security question:\n\nWhat is this system called? (Hint: First word is 'Eco')"
      );

      // Simple security question - answer is "EcoSterile"
      if (securityAnswer && securityAnswer.toLowerCase() === "ecosterile") {
        localStorage.removeItem("cropProtectPassword");
        alert(
          "✓ Password reset successfully! You can now set a new password by clicking the lock button."
        );
        // Update lock button UI if it exists
        const lockBtn = document.getElementById("cropLockBtn");
        if (lockBtn) lockBtn.textContent = "🔓";
        return;
      }

      alert("✗ Incorrect answer. Password not reset.");
    }
  });
});

// ==========================================
// Initialize Application
// ==========================================
// Update status every 10 seconds
setInterval(() => {
  const statusBadge = document.getElementById("systemStatus");
  statusBadge.textContent = "Online";
  statusBadge.classList.add("online");
  statusBadge.classList.remove("offline");
}, 10000);

// ==========================================
// Weather Forecast (Real Data via Open-Meteo API)
// ==========================================

// Map WMO weather codes to emoji and description
const wmoCodeMap = {
  0: { icon: "☀️", text: "Clear" },
  1: { icon: "🌤️", text: "Mostly Clear" },
  2: { icon: "⛅", text: "Partly Cloudy" },
  3: { icon: "☁️", text: "Overcast" },
  45: { icon: "🌫️", text: "Foggy" },
  48: { icon: "🌫️", text: "Foggy" },
  51: { icon: "🌧️", text: "Light Drizzle" },
  53: { icon: "🌧️", text: "Drizzle" },
  55: { icon: "🌧️", text: "Heavy Drizzle" },
  61: { icon: "🌧️", text: "Light Rain" },
  63: { icon: "🌧️", text: "Rain" },
  65: { icon: "🌧️", text: "Heavy Rain" },
  71: { icon: "❄️", text: "Light Snow" },
  73: { icon: "❄️", text: "Snow" },
  75: { icon: "❄️", text: "Heavy Snow" },
  77: { icon: "❄️", text: "Snow Grains" },
  80: { icon: "🌧️", text: "Light Showers" },
  81: { icon: "🌧️", text: "Showers" },
  82: { icon: "🌧️", text: "Heavy Showers" },
  85: { icon: "❄️", text: "Snow Showers" },
  86: { icon: "❄️", text: "Heavy Snow Showers" },
};

// Generate fake weather data as fallback
function generateFakeWeatherData() {
  const weatherConditions = [
    { icon: "☀️", text: "Sunny" },
    { icon: "⛅", text: "Partly Cloudy" },
    { icon: "🌤️", text: "Mostly Sunny" },
    { icon: "☁️", text: "Cloudy" },
    { icon: "🌧️", text: "Rainy" },
    { icon: "⛈️", text: "Thunderstorm" },
    { icon: "🌫️", text: "Foggy" },
  ];

  const baseTemp = 22 + Math.random() * 12;
  const humidity = 45 + Math.random() * 50;
  const windSpeed = 5 + Math.random() * 20;
  const uvIndex = Math.floor(Math.random() * 11);
  const dewPoint = baseTemp - (100 - humidity) / 5;

  let aqiValue = Math.floor(20 + Math.random() * 80);
  let aqiStatus = "Good";
  if (aqiValue > 150) {
    aqiStatus = "Unhealthy";
  } else if (aqiValue > 100) {
    aqiStatus = "Moderate";
  } else if (aqiValue > 50) {
    aqiStatus = "Fair";
  }

  const weather =
    weatherConditions[Math.floor(Math.random() * weatherConditions.length)];

  return {
    temp: Math.round(baseTemp * 10) / 10,
    feelsLike: Math.round((baseTemp - 2) * 10) / 10,
    condition: weather.text,
    icon: weather.icon,
    humidity: Math.round(humidity),
    windSpeed: Math.round(windSpeed * 10) / 10,
    pressure: 1000 + Math.round(Math.random() * 30),
    visibility: Math.round((5 + Math.random() * 5) * 10) / 10,
    uvIndex: uvIndex,
    dewPoint: Math.round(dewPoint * 10) / 10,
    aqiValue: aqiValue,
    aqiStatus: aqiStatus,
    pm25: Math.round((aqiValue / 3) * 10) / 10,
    pm10: Math.round((aqiValue / 2.5) * 10) / 10,
    o3: Math.round(20 + Math.random() * 40),
    no2: Math.round(10 + Math.random() * 30),
    so2: Math.round(2 + Math.random() * 15),
    co: (0.3 + Math.random() * 0.7).toFixed(1),
  };
}

// Fetch real weather data from Open-Meteo API (free, no API key needed)
async function fetchRealWeatherData(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,pressure_msl,visibility,uv_index&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`;

    console.log("Fetching weather from:", url);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Weather API call failed");

    const data = await res.json();
    console.log("Weather API response:", data);

    if (!data.current) throw new Error("No current weather data");

    const current = data.current;
    const wmo = current.weather_code || 0;
    const cond = wmoCodeMap[wmo] || { icon: "🌤️", text: "Unknown" };

    // Estimate AQI based on conditions (simplified) - randomized for variation
    let aqiValue = Math.floor(30 + Math.random() * 120);
    if (wmo >= 45 && wmo <= 48) aqiValue = Math.floor(60 + Math.random() * 50); // foggy = worse air quality
    let aqiStatus = "Good";
    if (aqiValue > 150) aqiStatus = "Unhealthy";
    else if (aqiValue > 100) aqiStatus = "Moderate";
    else if (aqiValue > 50) aqiStatus = "Fair";

    return {
      temp:
        current.temperature_2m !== undefined
          ? Math.round(current.temperature_2m * 10) / 10
          : 25,
      feelsLike:
        current.apparent_temperature !== undefined
          ? Math.round(current.apparent_temperature * 10) / 10
          : 25,
      condition: cond.text,
      icon: cond.icon,
      humidity: current.relative_humidity_2m || 65,
      windSpeed:
        current.wind_speed_10m !== undefined
          ? Math.round(current.wind_speed_10m * 10) / 10
          : 10,
      pressure: current.pressure_msl ? Math.round(current.pressure_msl) : 1013,
      visibility: current.visibility
        ? Math.round((current.visibility / 1000) * 10) / 10
        : 10,
      uvIndex:
        current.uv_index !== undefined ? Math.round(current.uv_index) : 5,
      dewPoint:
        current.apparent_temperature && current.relative_humidity_2m
          ? Math.round(
              (current.apparent_temperature -
                (100 - current.relative_humidity_2m) / 5) *
                10
            ) / 10
          : 15,
      aqiValue: aqiValue,
      aqiStatus: aqiStatus,
      pm25: Math.round((aqiValue / 3) * 10) / 10,
      pm10: Math.round((aqiValue / 2.5) * 10) / 10,
      o3: Math.round(20 + Math.random() * 40),
      no2: Math.round(10 + Math.random() * 30),
      so2: Math.round(2 + Math.random() * 15),
      co: (0.3 + Math.random() * 0.7).toFixed(1),
      hourly: data.hourly || {},
      daily: data.daily || {},
    };
  } catch (err) {
    console.error("Real weather fetch failed:", err);
    return null;
  }
}

// Get user location via geolocation API
async function getUserLocation() {
  return new Promise((resolve) => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        },
        (err) => {
          console.warn("Geolocation failed:", err);
          resolve(null);
        }
      );
    } else {
      resolve(null);
    }
  });
}

// Main weather data function: tries real API, falls back to fake
async function generateWeatherData() {
  // Use Karimganj, Assam coordinates (24.8692°N, 92.3554°E)
  const karimganjCoords = { lat: 24.8692, lon: 92.3554 };

  // Fetch real weather for Karimganj using Open-Meteo
  const realData = await fetchRealWeatherData(
    karimganjCoords.lat,
    karimganjCoords.lon
  );
  if (realData) {
    console.log("Using real weather data for Karimganj, Assam");
    return realData;
  }

  // Fallback: use fake data if API fails
  console.log("Falling back to simulated weather");
  return generateFakeWeatherData();
}

// Update weather display
async function updateWeatherDisplay() {
  const data = await generateWeatherData();

  // Current weather
  document.getElementById("temperature").textContent = data.temp + "°C";
  document.getElementById("feelsLike").textContent = data.feelsLike + "°C";
  document.getElementById("condition").textContent = data.condition;
  document.getElementById("weatherIcon").textContent = data.icon;

  // Weather details
  document.getElementById("humidity").textContent = data.humidity + "%";
  document.getElementById("windSpeed").textContent =
    Math.round(data.windSpeed) + " km/h";
  document.getElementById("pressure").textContent = data.pressure + " mb";
  document.getElementById("visibility").textContent = data.visibility + " km";
  document.getElementById("uvIndex").textContent = data.uvIndex;
  document.getElementById("dewPoint").textContent = data.dewPoint + "°C";

  // AQI
  document.getElementById("aqiValue").textContent = data.aqiValue;
  document.getElementById("aqiStatus").textContent = data.aqiStatus;
  document.getElementById("aqiBar").style.width =
    (data.aqiValue / 500) * 100 + "%";

  // AQI status color
  const aqiBar = document.getElementById("aqiBar");
  if (data.aqiValue < 50) {
    aqiBar.style.background = "linear-gradient(to right, #2ecc71, #2ecc71)";
  } else if (data.aqiValue < 100) {
    aqiBar.style.background = "linear-gradient(to right, #f39c12, #f39c12)";
  } else {
    updateArduinoStatus(false);
    aqiBar.style.background = "linear-gradient(to right, #e74c3c, #e74c3c)";
  }

  // AQI details
  document.getElementById("pm25").textContent = data.pm25 + " μg/m³";
  updateArduinoStatus(false);
  document.getElementById("pm10").textContent = data.pm10 + " μg/m³";
  document.getElementById("o3").textContent = data.o3 + " ppb";
  document.getElementById("no2").textContent = data.no2 + " ppb";
  document.getElementById("so2").textContent = data.so2 + " ppb";
  document.getElementById("co").textContent = data.co + " ppm";
  // Update Arduino connection status in the UI
  function updateArduinoStatus(connected) {
    const el = document.getElementById("arduinoStatus");
    const btn = document.getElementById("connectBtn");
    if (!el || !btn) return;
    if (connected) {
      el.textContent = "Connected";
      el.classList.remove("offline");
      el.classList.add("arduino-connected");
      btn.textContent = "Disconnect Arduino";
    } else {
      el.textContent = "Disconnected";
      el.classList.remove("arduino-connected");
      el.classList.add("offline");
      btn.textContent = "Connect Arduino";
    }
  }

  // Generate hourly forecast
  generateHourlyForecast();

  // Wire Connect button
  const connectBtn = document.getElementById("connectBtn");
  if (connectBtn) {
    connectBtn.addEventListener("click", async function () {
      // If already connected, do nothing or allow disconnect later
      if (arduinoConnected) {
        alert(
          "Arduino already connected. To reconnect, please refresh the page after disconnecting."
        );
        return;
      }
      await connectArduino();
    });
  }

  // Initialize Arduino status UI
  updateArduinoStatus(false);
  // Generate daily forecast
  generateDailyForecast();

  // Randomly show weather alerts
  if (Math.random() > 0.7) {
    showWeatherAlerts();
  } else {
    document.getElementById("weatherAlerts").style.display = "none";
  }
}

// Generate hourly forecast
function generateHourlyForecast() {
  const hourlyContainer = document.getElementById("hourlyForecast");
  const conditions = ["☀️", "⛅", "🌤️", "☁️", "🌧️"];
  let html = "";

  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const hour = new Date(now.getTime() + i * 60 * 60 * 1000);
    const temp = 22 + Math.random() * 10;
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    const timeStr = hour.getHours().toString().padStart(2, "0") + ":00";

    html += `
            <div class="hourly-item">
                <div class="hourly-time">${timeStr}</div>
                <div class="hourly-icon">${condition}</div>
                <div class="hourly-temp">${Math.round(temp)}°</div>
            </div>
        `;
  }

  hourlyContainer.innerHTML = html;
}

// Generate 5-day forecast
function generateDailyForecast() {
  const dailyContainer = document.getElementById("dailyForecast");
  const conditions = [
    { icon: "☀️", text: "Sunny" },
    { icon: "⛅", text: "Partly Cloudy" },
    { icon: "☁️", text: "Cloudy" },
    { icon: "🌧️", text: "Rainy" },
  ];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  let html = "";

  for (let i = 0; i < 5; i++) {
    const high = 25 + Math.random() * 10;
    const low = 15 + Math.random() * 8;
    const condition = conditions[Math.floor(Math.random() * conditions.length)];

    html += `
            <div class="daily-item">
                <div class="daily-day">${days[i]}</div>
                <div class="daily-icon">${condition.icon}</div>
                <div class="daily-temp-range">
                    <span class="daily-high">${Math.round(high)}°</span> / 
                    <span class="daily-low">${Math.round(low)}°</span>
                </div>
                <div class="daily-condition">${condition.text}</div>
            </div>
        `;
  }

  dailyContainer.innerHTML = html;
}

// Show random weather alerts
function showWeatherAlerts() {
  const alerts = [
    // General Weather Alerts
    "High UV Index - Use sunscreen",
    "Strong wind warning - Secure outdoor items",
    "High humidity - Stay hydrated",
    "Air Quality Alert - Sensitive groups should limit outdoor activity",
    "Frost Advisory - Plant protection recommended",

    // Crop-Related Alerts
    "🌾 Disease Risk Alert - High humidity may increase fungal diseases",
    "🌾 Watering Advisory - Heavy rainfall expected, reduce irrigation",
    "🌾 Heat Stress Alert - High temperatures may stress plants",
    "🌾 Frost Warning - Below freezing tonight, cover sensitive crops",
    "🌾 Wind Damage Risk - Strong winds may damage young plants",
    "🌾 Nutrient Leaching Alert - Heavy rain may wash away soil nutrients",
    "🌾 Pest Activity Warning - Warm, humid weather ideal for pest breeding",
    "🌾 Pollination Favorable - Good weather for crop pollination",
    "🌾 Drought Risk Alert - Low rainfall and high temperature stress incoming",
    "🌾 Hail Warning - Severe hail may cause crop damage",
    "🌾 Nitrogen Fixation Alert - Optimal conditions for nitrogen-fixing plants",
    "🌾 Germination Favorable - Ideal soil and air temperature for seed germination",
    "🌾 Growth Acceleration - Perfect weather for rapid plant growth",
    "🌾 Salt Accumulation Warning - Low rainfall may cause salt buildup in soil",
    "🌾 Sunlight Optimal - Excellent light conditions for photosynthesis",
  ];

  const randomAlerts = alerts.slice(0, Math.floor(Math.random() * 3) + 1);
  const alertsContainer = document.getElementById("weatherAlerts");
  const alertItemsContainer = document.getElementById("alertItems");

  let html = "";
  randomAlerts.forEach((alert) => {
    html += `<div class="alert-item">${alert}</div>`;
  });

  alertItemsContainer.innerHTML = html;
  alertsContainer.style.display = "block";
}
