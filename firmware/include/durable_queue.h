#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <algorithm>
#include <deque>
#include <vector>
#include "esp_partition.h"

inline uint32_t crc32(const uint8_t* data, size_t size) {
  uint32_t crc = 0xffffffff;
  while (size--) {
    crc ^= *data++;
    for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & -int32_t(crc & 1));
  }
  return ~crc;
}

class DurableQueue {
 public:
  bool begin() {
    if (!LittleFS.begin(false, "/littlefs", 10, "queue") &&
        (!erased() || !LittleFS.begin(true, "/littlefs", 10, "queue"))) return false;
    if (!state.begin("queue", false)) return false;
    purged = state.getULong64("purged", 0);
    next = std::max(state.getULong64("next", 1), purged + 1);
    File root = LittleFS.open("/");
    if (!root) return false;
    std::vector<String> cleanup, damaged;
    File file = root.openNextFile();
    while (file) {
      String name = file.name();
      file.close();
      if (!name.startsWith("/")) name = "/" + name;
      if (name.endsWith(".evt")) {
        const uint64_t sequence = strtoull(name.c_str() + 1, nullptr, 10);
        if (!sequence || sequence > maxSequence || name != path(sequence)) {
          damaged.push_back(name);
        } else if (sequence <= purged) {
          cleanup.push_back(name);
        } else {
          next = std::max(next, sequence + 1);
          String payload;
          if (read(sequence, payload)) items.push_back(sequence);
          else damaged.push_back(name);
        }
      } else if (name.endsWith(".evt.tmp")) {
        cleanup.push_back(name);
      } else if (name.endsWith(".evt.bad")) {
        ++corruptionCount;
      }
      file = root.openNextFile();
    }
    root.close();
    for (const auto& name : cleanup) LittleFS.remove(name);
    for (const auto& name : damaged) {
      ++corruptionCount;
      LittleFS.rename(name, name + ".bad");
    }
    std::sort(items.begin(), items.end());
    return true;
  }

  uint64_t reserveSequence() {
    if (next > maxSequence || LittleFS.totalBytes() - LittleFS.usedBytes() < 8192 ||
        state.putULong64("next", next + 1) != sizeof(uint64_t)) return 0;
    return next++;
  }

  bool append(uint64_t sequence, const String& payload) {
    const String name = path(sequence);
    const String temporary = name + ".tmp";
    File file = LittleFS.open(temporary, "w");
    if (!file) return false;
    const uint32_t header[] = {magic, uint32_t(payload.length()),
                               crc32(reinterpret_cast<const uint8_t*>(payload.c_str()), payload.length())};
    const bool stored = file.write(reinterpret_cast<const uint8_t*>(header), sizeof(header)) == sizeof(header) &&
                        file.print(payload) == payload.length();
    file.flush();
    file.close();
    if (!stored || !LittleFS.rename(temporary, name)) {
      LittleFS.remove(temporary);
      return false;
    }
    items.push_back(sequence);
    return true;
  }

  bool read(uint64_t sequence, String& payload) {
    File file = LittleFS.open(path(sequence), "r");
    uint32_t header[3];
    if (!file || file.read(reinterpret_cast<uint8_t*>(header), sizeof(header)) != sizeof(header) ||
        header[0] != magic || !header[1] || header[1] > 2048 || file.size() != sizeof(header) + header[1])
      return false;
    char bytes[2049];
    if (file.read(reinterpret_cast<uint8_t*>(bytes), header[1]) != header[1] ||
        crc32(reinterpret_cast<const uint8_t*>(bytes), header[1]) != header[2]) return false;
    bytes[header[1]] = '\0';
    payload = bytes;
    return payload.length() == header[1];
  }

  // Call only for the acknowledged prefix of the exact UUIDs sent to the server.
  bool purgeThrough(uint64_t last) {
    if (!last || last <= purged || state.putULong64("purged", last) != sizeof(uint64_t)) return false;
    purged = last;
    while (!items.empty() && items.front() <= purged) {
      LittleFS.remove(path(items.front()));
      items.pop_front();
    }
    return true;
  }

  bool quarantine(uint64_t sequence) {
    const String name = path(sequence);
    if (!LittleFS.rename(name, name + ".bad")) return false;
    const auto item = std::find(items.begin(), items.end(), sequence);
    if (item != items.end()) items.erase(item);
    ++corruptionCount;
    return true;
  }

  uint64_t lastSequence() const { return next - 1; }
  int usedPercent() const {
    return LittleFS.totalBytes() ? 100ULL * LittleFS.usedBytes() / LittleFS.totalBytes() : 100;
  }

  std::deque<uint64_t> items;
  uint32_t corruptionCount = 0;
  uint64_t purged = 0;

 private:
  static constexpr uint32_t magic = 0x56494459;
  static constexpr uint64_t maxSequence = 9007199254740991ULL;
  Preferences state;
  uint64_t next = 1;

  static String path(uint64_t sequence) {
    char name[32];
    snprintf(name, sizeof(name), "/%020llu.evt", (unsigned long long)sequence);
    return String(name);
  }

  static bool erased() {
    const auto* partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "queue");
    if (!partition) return false;
    uint8_t bytes[512];
    for (size_t offset = 0; offset < partition->size; offset += sizeof(bytes)) {
      if (esp_partition_read(partition, offset, bytes, sizeof(bytes)) != ESP_OK) return false;
      for (uint8_t byte : bytes) if (byte != 0xff) return false;
    }
    return true;
  }
};
