#pragma once
#include "queue.h"
#include <atomic>
#include <string>
#include "esp_partition.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "cJSON.h"
struct Provision {std::string ssid,password,origin,code,secret,ca,hardware;uint32_t peak_72h=0;};
extern Provision provision;
extern std::atomic<bool> reader_ok,rtc_ok,rtc_drift,config_verified,buzzer_enabled;
extern std::atomic<uint32_t> heartbeat_seconds,debounce_ms,batch_max,config_version,last_sync,ntp_epoch;
extern SemaphoreHandle_t bus_mutex,queue_mutex;
extern QueueHandle_t feedback_events;
extern std::string boot_id;
extern vidya::Queue* durable;
class DeviceFlash final:public vidya::Flash{
 const esp_partition_t* partition;
 public:DeviceFlash():partition(esp_partition_find_first(ESP_PARTITION_TYPE_DATA,(esp_partition_subtype_t)0x40,"queue")){}
 uint32_t size()const override{return partition?partition->size:0;}
 bool read(uint32_t o,void*p,uint32_t n)override{return partition&&esp_partition_read(partition,o,p,n)==ESP_OK;}
 bool read_raw(uint32_t o,void*p,uint32_t n)override{return partition&&esp_partition_read_raw(partition,o,p,n)==ESP_OK;}
 bool write(uint32_t o,const void*p,uint32_t n)override{return partition&&partition->encrypted&&esp_partition_write(partition,o,p,n)==ESP_OK;}
 bool erase(uint32_t o,uint32_t n)override{return partition&&esp_partition_erase_range(partition,o,n)==ESP_OK;}
};
class DeviceState final:public vidya::State{
 nvs_handle_t handle=0;
 public:bool begin(){return nvs_open("queue",NVS_READWRITE,&handle)==ESP_OK;}
 bool load_cursor(unsigned n,vidya::Cursor& c)override{size_t size=sizeof(c);return nvs_get_blob(handle,n?"cursor1":"cursor0",&c,&size)==ESP_OK&&size==sizeof(c);}
 bool save_cursor(unsigned n,const vidya::Cursor& c)override{return nvs_set_blob(handle,n?"cursor1":"cursor0",&c,sizeof(c))==ESP_OK&&nvs_commit(handle)==ESP_OK;}
 bool load_reserved(uint64_t& n)override{return nvs_get_u64(handle,"reserved",&n)==ESP_OK;}
 bool save_reserved(uint64_t n)override{return nvs_set_u64(handle,"reserved",n)==ESP_OK&&nvs_commit(handle)==ESP_OK;}
};
class Lock {SemaphoreHandle_t handle;public:explicit Lock(SemaphoreHandle_t h):handle(h){xSemaphoreTake(handle,portMAX_DELAY);}~Lock(){xSemaphoreGive(handle);}};
std::string uuid();std::string uuid_string(const std::array<uint8_t,16>&);std::array<uint8_t,16> uuid_bytes();
std::string iso(uint64_t);uint64_t clock_ms(vidya::TimeSource* source=nullptr);
bool hardware_init();bool read_uid(std::array<uint8_t,10>&,uint8_t&);void clock_task(void*);void feedback_task(void*);
void network_task(void*);bool load_provision();void start_wifi();
