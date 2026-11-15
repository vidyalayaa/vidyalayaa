#pragma once
#include <Arduino.h>

inline bool formatCardUid(const uint8_t* uid, uint8_t size, char (&hex)[15]) {
  if (size != 4 && size != 7) return false;
  for (uint8_t i = 0; i < size; ++i) snprintf(hex + 2 * i, 3, "%02X", unsigned(uid[i]));
  return true;
}

class UsbEnrollment {
 public:
  void command(const char* line, bool enrollment, bool readerReady) {
    const char* id = strchr(line, ' ');
    if (!id) return;
    const size_t commandSize = id++ - line;
    if (strlen(id) != 36 || strspn(id, "0123456789abcdef-") != 36) return;
    const bool probe = commandSize == 5 && strncmp(line, "PROBE", 5) == 0;
    const bool scan = commandSize == 4 && strncmp(line, "SCAN", 4) == 0;
    if (!probe && !scan) return;
    if (!enrollment || !readerReady) {
      Serial.printf("VIDYALAYAA ERROR %s %s\n", id, enrollment ? "READER" : "MODE");
    } else if (probe) {
      Serial.printf("VIDYALAYAA READY %s\n", id);
    } else {
      memcpy(scanId, id, sizeof(scanId));
      armedAt = millis();
      clearReads = 0;
      active = true;
    }
  }

  bool scanning() {
    if (active && millis() - armedAt >= 12000) {
      Serial.printf("VIDYALAYAA ERROR %s TIMEOUT\n", scanId);
      active = false;
    }
    return active;
  }

  void sample(bool present, const uint8_t* uid, uint8_t size) {
    if (!scanning()) return;
    if (!present) {
      if (clearReads < 2 && ++clearReads == 2) Serial.printf("VIDYALAYAA ARMED %s\n", scanId);
      return;
    }
    const bool newTap = clearReads >= 2;
    clearReads = 0;
    if (!newTap) return;
    char hex[15]{};
    if (formatCardUid(uid, size, hex)) {
      Serial.printf("VIDYALAYAA UID %s %s\n", scanId, hex);
    } else {
      Serial.printf("VIDYALAYAA ERROR %s CARD_TYPE\n", scanId);
    }
    active = false;
  }

 private:
  bool active = false;
  uint8_t clearReads = 0;
  uint32_t armedAt = 0;
  char scanId[37]{};
};

template <size_t Capacity>
class UsbLines {
 public:
  template <typename Callback>
  void poll(Callback onLine) {
    for (size_t count = 0; count < 256 && Serial.available(); ++count) {
      const char byte = char(Serial.read());
      if (byte == '\n') {
        if (size < Capacity) {
          input[size] = '\0';
          onLine(input);
        }
        size = 0;
      } else if (byte != '\r' && size < Capacity) {
        input[size++] = byte;
      }
    }
  }

 private:
  char input[Capacity]{};
  size_t size = 0;
};
