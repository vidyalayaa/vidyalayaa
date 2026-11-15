#include <Adafruit_PN532.h>
#include <HTTPClient.h>
#include <RTClib.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <atomic>
#include "esp_sntp.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "durable_queue.h"
#include "reader_provisioning.h"
#include "usb_enrollment.h"

namespace {
constexpr char version[] = "1.1.0-devkit";
constexpr int greenLed = 26, redLed = 27, buzzer = 25, usbModePin = 32;
constexpr uint32_t plausibleTime = 1704067200, trustedRtcAge = 7 * 86400;
constexpr size_t batchLimit = 25;
Adafruit_PN532 nfc(4, 5, &Wire);
RTC_DS3231 rtc;
Preferences clockState;
DurableQueue queue;
ReaderProvisioning provision;
UsbEnrollment enrollment;
UsbLines<6144> usb;
SemaphoreHandle_t busMutex, queueMutex;
bool usbMode = true, provisioned = false, storageReady = false, rtcPresent = false;
std::atomic<bool> readerReady{false}, buzzerEnabled{true};
std::atomic<uint32_t> syncedRtc{0}, receivedNtp{0}, debounceMs{1500};
std::atomic<int> lastHttp{0};
uint32_t heartbeatMs = 60000, rtcUpdateMs = 21600000, configVersion = 1;
uint32_t authRetryAt = 0;
size_t batchMax = batchLimit;
String bootId;

class Lock {
 public:
  explicit Lock(SemaphoreHandle_t mutex) : mutex(mutex) { xSemaphoreTake(mutex, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(mutex); }
 private:
  SemaphoreHandle_t mutex;
};

bool due(uint32_t deadline) { return int32_t(millis() - deadline) >= 0; }

String uuid() {
  uint8_t b[16];
  esp_fill_random(b, sizeof(b));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  char out[37];
  snprintf(out, sizeof(out),
    "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
  return out;
}

String iso(uint32_t seconds) {
  const time_t value = seconds;
  struct tm utc;
  gmtime_r(&value, &utc);
  char out[32];
  strftime(out, sizeof(out), "%Y-%m-%dT%H:%M:%S.000Z", &utc);
  return out;
}

struct ClockSample {
  uint32_t seconds;
  const char* source;
  const char* rtcStatus;
};

ClockSample clockSample() {
  Lock lock(busMutex);
  const bool rtcOk = rtcPresent && !rtc.lostPower();
  const uint32_t chipTime = rtcOk ? rtc.now().unixtime() : 0;
  const uint32_t now = time(nullptr);
  const uint32_t last = syncedRtc.load();
  const bool rtcTrusted = last >= plausibleTime && chipTime >= last && chipTime - last <= trustedRtcAge;
  const bool drift = rtcOk && receivedNtp.load() && abs(int64_t(chipTime) - int64_t(now)) > 120;
  const char* health = !rtcPresent ? "UNKNOWN" : !rtcOk ? "LOST_POWER" : drift ? "DRIFT" : "OK";
  if (rtcTrusted && !drift) return {chipTime, "RTC_SYNCED", health};
  if (receivedNtp.load() && now >= plausibleTime) return {now, "NTP", health};
  if (chipTime >= plausibleTime) return {chipTime, "RTC_UNSYNCED", health};
  return {0, "MONOTONIC", health};
}

void updateRtc() {
  Lock lock(busMutex);
  const uint32_t now = time(nullptr);
  if (rtcPresent && receivedNtp.load() && now >= plausibleTime) {
    rtc.adjust(DateTime(now));
    if (!rtc.lostPower() && abs(int64_t(rtc.now().unixtime()) - int64_t(now)) <= 2 &&
        clockState.putUInt("last_sync", now) == sizeof(uint32_t)) syncedRtc = now;
  }
}

void tapSaved() {
  digitalWrite(greenLed, HIGH);
  if (buzzerEnabled) tone(buzzer, 2200, 80);
  delay(90);
  digitalWrite(greenLed, LOW);
}

void storageFailure() {
  digitalWrite(redLed, HIGH);
  if (buzzerEnabled) tone(buzzer, 500, 150);
  delay(150);
  digitalWrite(redLed, LOW);
}

int request(const char* method, const char* path, const String& body, String& response,
            uint32_t& retryAfter, bool conditional = false) {
  retryAfter = 0;
  WiFiClientSecure tls;
  tls.setCACert(provision.rootCa.c_str());
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(7000);
  if (!http.begin(tls, provision.origin + path)) return -1;
  const char* headers[] = {"Retry-After"};
  http.collectHeaders(headers, 1);
  http.addHeader("X-Device-Id", provision.code);
  http.addHeader("Authorization", "Bearer " + provision.secret);
  if (conditional) http.addHeader("If-None-Match", String("\"") + configVersion + "\"");
  if (strcmp(method, "POST") == 0) http.addHeader("Content-Type", "application/json");
  const int status = strcmp(method, "GET") == 0 ? http.GET() : http.POST(body);
  const long seconds = http.header("Retry-After").toInt();
  if (seconds > 0) retryAfter = uint32_t(std::min(seconds, 3600L)) * 1000;
  if (status == 200 && http.getSize() <= 65536) response = http.getString();
  http.end();
  lastHttp = status;
  if (status == 401 || status == 403) authRetryAt = millis() + 300000;
  return status;
}

int post(const char* path, JsonDocument& doc, String& response, uint32_t& retryAfter) {
  String body;
  serializeJson(doc, body);
  return request("POST", path, body, response, retryAfter);
}

bool fetchConfig(bool conditional) {
  String body;
  uint32_t retryAfter;
  const int status = request("GET", "/api/v1/device/config", "", body, retryAfter, conditional);
  if (status != 200) return conditional && status == 304;
  JsonDocument config;
  if (deserializeJson(config, body)) return false;
  configVersion = config["config_version"] | configVersion;
  heartbeatMs = constrain(config["heartbeat_interval_s"] | 60u, 30u, 300u) * 1000;
  debounceMs = constrain(config["tap_debounce_ms"] | 1500u, 500u, 10000u);
  batchMax = constrain(config["batch_max_events"] | uint32_t(batchLimit), 1u, uint32_t(batchLimit));
  rtcUpdateMs = constrain(config["time_sync_interval_h"] | 6u, 1u, 24u) * 3600000;
  buzzerEnabled = config["feedback"]["buzzer"] | true;
  return true;
}

uint32_t heartbeat() {
  const auto clock = clockSample();
  JsonDocument body;
  body["device_id"] = provision.code;
  body["boot_id"] = bootId;
  body["device_time"] = iso(clock.seconds);
  body["uptime_ms"] = uint64_t(esp_timer_get_time() / 1000);
  body["firmware_version"] = version;
  body["config_version"] = configVersion;
  body["reader_status"] = readerReady ? "OK" : "FAIL";
  body["rtc_status"] = clock.rtcStatus;
  const auto ntp = receivedNtp.load();
  if (ntp) body["last_ntp_sync"] = iso(ntp);
  else body["last_ntp_sync"] = nullptr;
  body["wifi_rssi_dbm"] = constrain(WiFi.RSSI(), -127, 0);
  body["reset_reason"] = String(int(esp_reset_reason()));
  {
    Lock lock(queueMutex);
    body["pending_events"] = queue.items.size();
    if (queue.items.empty()) body["oldest_pending_sequence"] = nullptr;
    else body["oldest_pending_sequence"] = queue.items.front();
    body["last_sequence"] = queue.lastSequence();
    body["storage_used_pct"] = storageReady ? queue.usedPercent() : 100;
    if (!storageReady || queue.corruptionCount) {
      auto log = body["logs"].to<JsonArray>().add<JsonObject>();
      log["ts"] = iso(clock.seconds);
      log["level"] = "ERROR";
      log["code"] = storageReady ? "QUEUE_CORRUPTION" : "QUEUE_UNAVAILABLE";
      log["detail"]["count"] = queue.corruptionCount;
    }
  }
  String response;
  uint32_t retryAfter;
  if (post("/api/v1/device/heartbeat", body, response, retryAfter) == 200) {
    JsonDocument result;
    if (!deserializeJson(result, response) && (result["config_version"] | configVersion) != configVersion)
      fetchConfig(true);
  }
  return std::max(heartbeatMs, retryAfter);
}

void syncAck() {
  JsonDocument body;
  body["device_id"] = provision.code;
  body["boot_id"] = bootId;
  {
    Lock lock(queueMutex);
    body["purged_through_sequence"] = queue.purged;
    body["pending_events"] = queue.items.size();
    body["queue_corruption_count"] = queue.corruptionCount;
  }
  String response;
  uint32_t retryAfter;
  post("/api/v1/device/sync-ack", body, response, retryAfter);
}

uint32_t syncQueue(uint32_t& backoff) {
  JsonDocument batch;
  const String id = uuid();
  batch["batch_id"] = id;
  batch["device_id"] = provision.code;
  batch["firmware_version"] = version;
  batch["sent_at"] = iso(clockSample().seconds);
  JsonArray events = batch["events"].to<JsonArray>();
  {
    Lock lock(queueMutex);
    for (size_t i = 0; i < queue.items.size() && events.size() < batchMax; ++i) {
      JsonDocument event;
      String payload;
      const uint64_t sequence = queue.items[i];
      if (!queue.read(sequence, payload) || deserializeJson(event, payload) ||
          !event["event_id"].is<const char*>() || event["sequence_number"].as<uint64_t>() != sequence) {
        queue.quarantine(sequence);
        break;
      }
      events.add(event.as<JsonObject>());
    }
  }
  if (!events.size()) return 2200;
  String response;
  uint32_t retryAfter;
  if (post("/api/v1/device/events/batch", batch, response, retryAfter) == 200) {
    JsonDocument reply;
    if (!deserializeJson(reply, response) && id == (reply["batch_id"] | "")) {
      uint64_t last = 0;
      for (JsonObject event : events) {
        bool acknowledged = false;
        for (JsonObject item : reply["results"].as<JsonArray>()) {
          if (!strcmp(item["event_id"] | "", event["event_id"] | "")) {
            acknowledged = !strcmp(item["device_action"] | "", "DELETE");
            break;
          }
        }
        if (!acknowledged) break;
        last = event["sequence_number"].as<uint64_t>();
      }
      bool purged;
      {
        Lock lock(queueMutex);
        purged = queue.purgeThrough(last);
      }
      if (purged) {
        syncAck();
        backoff = 2000;
        return 2200;
      }
    }
  }
  backoff = std::min(backoff * 2, 300000u);
  return std::max(retryAfter, backoff * (75 + esp_random() % 51) / 100);
}

void networkTask(void*) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(provision.ssid.c_str(), provision.password.c_str());
  sntp_set_time_sync_notification_cb([](struct timeval* tv) { receivedNtp = uint32_t(tv->tv_sec); });
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  bool configured = false;
  uint32_t nextConfig = millis();
  uint32_t nextHeartbeat = millis(), nextUpload = millis(), nextRtcUpdate = millis(), backoff = 2000;
  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      if (receivedNtp.load() && due(nextRtcUpdate)) {
        updateRtc();
        nextRtcUpdate = millis() + rtcUpdateMs;
      }
      if ((!authRetryAt || due(authRetryAt)) && time(nullptr) >= plausibleTime) {
        authRetryAt = 0;
        if (!configured && due(nextConfig)) {
          configured = fetchConfig(false);
          nextConfig = millis() + 30000;
        }
        if (!authRetryAt && due(nextHeartbeat)) {
          const auto interval = heartbeat();
          nextHeartbeat = millis() + interval;
        }
        if (!authRetryAt && storageReady && due(nextUpload)) {
          const auto interval = syncQueue(backoff);
          nextUpload = millis() + interval;
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

void attend(const char* uid) {
  if (!storageReady) {
    storageFailure();
    return;
  }
  const auto clock = clockSample();
  JsonDocument event;
  event["event_id"] = uuid();
  event["device_id"] = provision.code;
  event["card_uid"] = uid;
  event["event_timestamp"] = iso(clock.seconds);
  event["time_source"] = clock.source;
  event["boot_id"] = bootId;
  event["uptime_ms"] = uint64_t(esp_timer_get_time() / 1000);
  event["firmware_version"] = version;
  bool saved = false;
  {
    Lock lock(queueMutex);
    const uint64_t sequence = queue.reserveSequence();
    if (sequence) {
      event["sequence_number"] = sequence;
      String payload;
      serializeJson(event, payload);
      saved = queue.append(sequence, payload);
    }
  }
  if (saved) tapSaved();
  else storageFailure();
}

bool initReader() {
  Lock lock(busMutex);
  nfc.begin();
  return nfc.getFirmwareVersion() && nfc.SAMConfig() && nfc.setPassiveActivationRetries(1);
}

bool matchesQueue(const String& code) {
  Lock lock(queueMutex);
  if (!storageReady || queue.items.empty()) return true;
  String payload;
  JsonDocument event;
  return queue.read(queue.items.front(), payload) && !deserializeJson(event, payload) &&
    code == (event["device_id"] | "");
}

void serialCommand(const char* line) {
  if (!strcmp(line, "STATUS")) {
    const auto clock = clockSample();
    Lock lock(queueMutex);
    Serial.printf("VIDYALAYAA STATUS firmware=%s mode=%s provisioned=%u nfc=%s rtc=%s storage=%s wifi=%u api=%d pending=%u\n",
      version, usbMode ? "enrollment" : "gate", unsigned(provisioned), readerReady ? "OK" : "MISSING",
      clock.rtcStatus, storageReady ? "OK" : "UNAVAILABLE", unsigned(WiFi.status() == WL_CONNECTED),
      lastHttp.load(), unsigned(queue.items.size()));
  } else if (!strncmp(line, "PROVISION ", 10)) {
    if (!usbMode) {
      Serial.println("VIDYALAYAA PROVISION ERROR MODE");
      return;
    }
    ReaderProvisioning input;
    if (!input.parse(line + 10) || (provisioned && input.code != provision.code) || !matchesQueue(input.code)) {
      Serial.println("VIDYALAYAA PROVISION ERROR INVALID_CONFIG");
    } else if (!ReaderProvisioning::save(line + 10)) {
      Serial.println("VIDYALAYAA PROVISION ERROR STORAGE");
    } else {
      provision = input;
      provisioned = true;
      Serial.println("VIDYALAYAA PROVISION OK RESTART_REQUIRED");
    }
  } else {
    enrollment.command(line, usbMode, readerReady);
  }
}
}

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  pinMode(usbModePin, INPUT_PULLUP);
  pinMode(greenLed, OUTPUT);
  pinMode(redLed, OUTPUT);
  pinMode(buzzer, OUTPUT);
  busMutex = xSemaphoreCreateMutex();
  queueMutex = xSemaphoreCreateMutex();
  if (!busMutex || !queueMutex) ESP.restart();
  bootId = uuid();
  provisioned = provision.load();
  usbMode = !provisioned || digitalRead(usbModePin) == LOW;
  storageReady = queue.begin();
  Wire.begin(21, 22);
  Wire.setTimeOut(25);
  rtcPresent = rtc.begin(&Wire);
  if (clockState.begin("clock", false)) syncedRtc = clockState.getUInt("last_sync", 0);
  const auto initial = clockSample();
  if (!strcmp(initial.source, "RTC_SYNCED")) {
    const timeval tv{time_t(initial.seconds), 0};
    settimeofday(&tv, nullptr);
  }
  readerReady = initReader();
  if (!usbMode && xTaskCreate(networkTask, "vidya-network", 12288, nullptr, 1, nullptr) != pdPASS)
    Serial.println("VIDYALAYAA NETWORK ERROR TASK");
  serialCommand("STATUS");
}

void loop() {
  static uint32_t nextProbe = millis() + 30000, lastTap = 0;
  static uint8_t clearReads = 2;
  static String lastUid;
  usb.poll(serialCommand);
  if (due(nextProbe) && !enrollment.scanning()) {
    if (readerReady) {
      Lock lock(busMutex);
      readerReady = nfc.getFirmwareVersion() != 0;
    } else {
      readerReady = initReader();
    }
    nextProbe = millis() + (readerReady ? 60000 : 10000);
  }
  if (readerReady && (!usbMode || enrollment.scanning())) {
    uint8_t uid[256]{}, size = 0;
    bool present;
    {
      Lock lock(busMutex);
      present = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &size, 120);
    }
    if (usbMode) {
      enrollment.sample(present, uid, size);
    } else if (present) {
      char hex[15]{};
      const bool valid = formatCardUid(uid, size, hex);
      const bool different = valid && lastUid != hex;
      if (valid && (different || (clearReads >= 2 && millis() - lastTap >= debounceMs))) {
        lastUid = hex;
        lastTap = millis();
        attend(hex);
      }
      clearReads = 0;
    } else if (clearReads < 2) {
      ++clearReads;
    }
  }
  delay(5);
}
