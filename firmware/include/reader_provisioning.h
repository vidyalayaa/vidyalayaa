#pragma once
#include <ArduinoJson.h>
#include <Preferences.h>
#include <memory>

struct ReaderProvisioning {
  String ssid, password, origin, code, secret, rootCa;

  bool parse(const char* input) {
    JsonDocument doc;
    if (deserializeJson(doc, input) || !doc.is<JsonObject>()) return false;
    ssid = doc["ssid"] | "";
    password = doc["password"] | "";
    origin = doc["origin"] | "";
    code = doc["code"] | "";
    secret = doc["secret"] | "";
    rootCa = doc["root_ca"] | "";
    return ssid.length() > 0 && ssid.length() <= 32 && password.length() >= 8 &&
      (password.length() < 64 || (password.length() == 64 &&
       strspn(password.c_str(), "0123456789ABCDEFabcdef") == 64)) &&
      origin.startsWith("https://") && origin.length() > 8 && origin.length() <= 200 &&
      strspn(origin.c_str() + 8, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:") == origin.length() - 8 &&
      code.length() >= 3 && code.length() <= 64 &&
      strspn(code.c_str(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") == code.length() &&
      secret.length() >= 32 && secret.length() <= 256 &&
      strspn(secret.c_str(), "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") == secret.length() &&
      rootCa.length() <= 4096 && rootCa.startsWith("-----BEGIN CERTIFICATE-----") &&
      rootCa.indexOf("-----END CERTIFICATE-----") > 0;
  }

  bool load() {
    Preferences storage;
    if (!storage.begin("vd-reader", true)) return false;
    const size_t length = storage.getBytesLength("config");
    if (!length || length > 6134) return false;
    auto saved = std::unique_ptr<char[]>(new (std::nothrow) char[length + 1]);
    if (!saved || storage.getBytes("config", saved.get(), length) != length) return false;
    saved[length] = '\0';
    return parse(saved.get());
  }

  static bool save(const char* input) {
    Preferences storage;
    if (!storage.begin("vd-reader", false)) return false;
    // Store all fields as one NVS blob so a reset cannot mix credentials.
    const size_t length = strlen(input);
    return storage.putBytes("config", input, length) == length;
  }
};
