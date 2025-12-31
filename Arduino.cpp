/*  Robust pH reader + pump control
    - Computes linear calibration from 3 calibration points (least squares)
    - Moving-average filter for voltage
    - JSON output: {"pH":x.xx,"voltage":y.yyy,"pump":"basic|acidic|none"}
    - Hysteresis and pump burst dosing for safety
    - Prints calibration slope/intercept at startup for verification
*/

const int phPin = A0;

// motor pins
const int basic_pump_in1 = 6;
const int basic_pump_in2 = 7;
const int acidic_pump_in3 = 8;
const int acidic_pump_in4 = 9;

// ---------- User-supplied calibration voltages (from your measurements) ----------
// Use the averaged values you reported
// pH 4  -> ~3.60 V   (you gave 3.5-3.7 -> average 3.6)
// pH 7  -> ~ (2.957 + 3.055)/2 = 3.006 V
// pH10  -> 1.466 V
const float cal_pH1 = 4.0;
const float cal_V1  = 3.60;

const float cal_pH2 = 7.0;
const float cal_V2  = (2.957 + 3.055f) / 2.0f; // 3.006

const float cal_pH3 = 10.0;
const float cal_V3  = 1.466;

// ---------- Filtering ----------
const int MA_SIZE = 10;              // moving average sample count
float maBuffer[MA_SIZE];
int maIndex = 0;
int maCount = 0;

// ---------- Pump control & safety ----------
const unsigned long pumpBurstMs = 1200UL;  // how long to run pump per correction (ms)
const unsigned long minGapBetweenBursts = 10UL * 1000UL; // minimum gap between bursts (10s)
unsigned long lastPumpMillis = 0;
bool pumpRunning = false;

// Hysteresis thresholds (to avoid on/off oscillation)
const float pH_low_threshold = 6.45;   // below this -> run base
const float pH_low_exit      = 6.7;    // above this -> stop base

const float pH_high_threshold = 7.55;  // above this -> run acid
const float pH_high_exit      = 7.3;   // below this -> stop acid

// Calibration result (computed on startup)
float slope = 0.0;
float intercept = 0.0;

// helper: read raw voltage (uses default 5V analog ref)
float readVoltage() {
  int raw = analogRead(phPin);
  float v = raw * (5.0f / 1023.0f);
  return v;
}

// moving average
float applyMA(float v) {
  maBuffer[maIndex] = v;
  maIndex = (maIndex + 1) % MA_SIZE;
  if (maCount < MA_SIZE) maCount++;

  float sum = 0.0f;
  for (int i = 0; i < maCount; ++i) sum += maBuffer[i];
  return sum / maCount;
}

// compute linear least-squares fit for (V->pH) using three points
void computeCalibration() {
  // x = voltage, y = pH
  float x[3] = { cal_V1, cal_V2, cal_V3 };
  float y[3] = { cal_pH1, cal_pH2, cal_pH3 };
  const int N = 3;

  float sumx = 0.0f, sumy = 0.0f, sumxy = 0.0f, sumx2 = 0.0f;
  for (int i = 0; i < N; ++i) {
    sumx += x[i];
    sumy += y[i];
    sumxy += x[i] * y[i];
    sumx2 += x[i] * x[i];
  }

  float denom = (N * sumx2 - sumx * sumx);
  if (fabs(denom) < 1e-6) {
    // fallback: avoid division by zero
    slope = 0.0;
    intercept = 7.0;
  } else {
    slope = (N * sumxy - sumx * sumy) / denom;
    intercept = (sumy - slope * sumx) / N;
  }
}

void setup() {
  Serial.begin(9600);
  pinMode(basic_pump_in1, OUTPUT);
  pinMode(basic_pump_in2, OUTPUT);
  pinMode(acidic_pump_in3, OUTPUT);
  pinMode(acidic_pump_in4, OUTPUT);
  stopPumps();

  // initialize MA buffer
  for (int i = 0; i < MA_SIZE; ++i) maBuffer[i] = 0.0f;

  // compute calibration
  computeCalibration();

  // Print calibration info for verification
  Serial.println(F("=== pH Calibration (computed) ==="));
  Serial.print(F("cal points: pH4@")); Serial.print(cal_V1, 3);
  Serial.print(F(" V , pH7@")); Serial.print(cal_V2, 3);
  Serial.print(F(" V , pH10@")); Serial.print(cal_V3, 3); Serial.println(F(" V"));

  Serial.print(F("slope = ")); Serial.println(slope, 6);
  Serial.print(F("intercept = ")); Serial.println(intercept, 6);

  Serial.println(F("Use these to verify: pH = slope * voltage + intercept"));
  Serial.println(F("===================================="));
  delay(500);
}

void loop() {
  // read and filter voltage
  float rawV = readVoltage();
  float v = applyMA(rawV);

  // compute pH from linear calibration
  float pH = slope * v + intercept;

  // clamp pH to reasonable bounds
  if (pH < 0) pH = 0;
  if (pH > 14) pH = 14;

  // Pump decision with hysteresis and burst safety
  String pumpType = "none";
  String pumpAction = "off";

  unsigned long now = millis();

  // If we recently ran a pump, enforce minimum gap
  bool allowedToRun = (now - lastPumpMillis) > minGapBetweenBursts;

  // Decide whether to run base pump
  static bool base_active = false;
  static bool acid_active = false;

  // Exit conditions for each pump
  if (base_active) {
    if (pH >= pH_low_exit) {
      base_active = false;
    }
  } else {
    if (pH <= pH_low_threshold && allowedToRun) {
      base_active = true;
    }
  }

  if (acid_active) {
    if (pH <= pH_high_exit) {
      acid_active = false;
    }
  } else {
    if (pH >= pH_high_threshold && allowedToRun) {
      acid_active = true;
    }
  }

  // Prevent both pumps active at the same time
  if (base_active && acid_active) {
    // conflict -> prioritize whichever has larger deviation
    float devBase = fabs(pH - 6.5);
    float devAcid = fabs(pH - 7.5);
    if (devBase >= devAcid) acid_active = false;
    else base_active = false;
  }

  if (base_active) {
    pumpType = "basic";
    pumpAction = "on";
    runBasicPump();
    lastPumpMillis = now;
    delay(pumpBurstMs);
    stopPumps();
    pumpRunning = false;
    base_active = false; // one-shot burst; re-evaluated after minGapBetweenBursts
  } else if (acid_active) {
    pumpType = "acidic";
    pumpAction = "on";
    runAcidicPump();
    lastPumpMillis = now;
    delay(pumpBurstMs);
    stopPumps();
    pumpRunning = false;
    acid_active = false; // one-shot
  } else {
    pumpType = "none";
    pumpAction = "off";
  }

  // Output JSON for your dashboard
  Serial.print("{\"pH\":");
  Serial.print(pH, 2);
  Serial.print(",\"voltage\":");
  Serial.print(v, 3);
  Serial.print(",\"pump\":\"");
  Serial.print(pumpType);
  Serial.print("\",\"action\":\"");
  Serial.print(pumpAction);
  Serial.println("\"}");

  // small delay (sampling cadence)
  delay(800);
}

// Pump helpers
void runBasicPump() {
  digitalWrite(basic_pump_in1, HIGH);
  digitalWrite(basic_pump_in2, LOW);
  digitalWrite(acidic_pump_in3, LOW);
  digitalWrite(acidic_pump_in4, LOW);
}

void runAcidicPump() {
  digitalWrite(acidic_pump_in3, HIGH);
  digitalWrite(acidic_pump_in4, LOW);
  digitalWrite(basic_pump_in1, LOW);
  digitalWrite(basic_pump_in2, LOW);
}

void stopPumps() {
  digitalWrite(basic_pump_in1, LOW);
  digitalWrite(basic_pump_in2, LOW);
  digitalWrite(acidic_pump_in3, LOW);
  digitalWrite(acidic_pump_in4, LOW);
}
