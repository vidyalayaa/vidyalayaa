#include "reader.h"
#include <cstring>
#include <ctime>
#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_flash_encrypt.h"
#include "esp_secure_boot.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "esp_ota_ops.h"
#include "esp_log.h"
#include "nvs_flash.h"
Provision provision;std::string boot_id;
std::atomic<bool> reader_ok{false},rtc_ok{false},rtc_drift{false},config_verified{false},buzzer_enabled{true};
std::atomic<uint32_t> heartbeat_seconds{60},debounce_ms{1500},batch_max{50},config_version{0},last_sync{0},ntp_epoch{0};
SemaphoreHandle_t bus_mutex,queue_mutex;QueueHandle_t feedback_events;vidya::Queue* durable=nullptr;
static DeviceFlash flash;static DeviceState state;static std::array<uint8_t,16> boot;
static bool secret_string(nvs_handle_t handle,const char* name,std::string& out,size_t max){size_t n=0;if(nvs_get_str(handle,name,nullptr,&n)!=ESP_OK||n<2||n>max+1)return false;out.resize(n);if(nvs_get_str(handle,name,out.data(),&n)!=ESP_OK)return false;out.resize(n-1);return true;}
bool load_provision(){
 nvs_handle_t h;if(nvs_open("provision",NVS_READONLY,&h)!=ESP_OK)return false;
 bool ok=secret_string(h,"ssid",provision.ssid,32)&&secret_string(h,"wifi_password",provision.password,64)&&secret_string(h,"api_origin",provision.origin,200)&&secret_string(h,"device_code",provision.code,64)&&secret_string(h,"device_secret",provision.secret,256)&&secret_string(h,"root_ca",provision.ca,4096)&&secret_string(h,"hardware",provision.hardware,80)&&nvs_get_u32(h,"peak_72h",&provision.peak_72h)==ESP_OK;
 nvs_close(h);return ok&&provision.secret.size()>=32&&provision.origin.rfind("https://",0)==0&&provision.origin.find('/',8)==std::string::npos&&provision.origin.find('@')==std::string::npos&&provision.ca.find("BEGIN CERTIFICATE")!=std::string::npos;
}
static void scan_task(void*){
 esp_task_wdt_add(nullptr);std::array<uint8_t,10> last{};uint8_t last_size=0;uint64_t last_at=0;
 for(;;){esp_task_wdt_reset();std::array<uint8_t,10> uid{};uint8_t size=0;
  if(read_uid(uid,size)){auto now=uint64_t(esp_timer_get_time()/1000);if(!(uid==last&&size==last_size&&now-last_at<debounce_ms)){
   last=uid;last_size=size;last_at=now;vidya::Record event;event.event_id=uuid_bytes();event.boot_id=boot;event.uid=uid;event.uid_length=size;event.uptime_ms=now;event.timestamp_ms=clock_ms(&event.source);
   int success;{Lock lock(queue_mutex);success=durable->append(event,esp_app_get_description()->version)?1:0;}
   xQueueSend(feedback_events,&success,0);
  }}vTaskDelay(pdMS_TO_TICKS(10));
 }
}
static void health_task(void*){
 esp_task_wdt_add(nullptr);auto started=esp_timer_get_time();esp_ota_img_states_t state;bool pending=esp_ota_get_state_partition(esp_ota_get_running_partition(),&state)==ESP_OK&&state==ESP_OTA_IMG_PENDING_VERIFY;
 for(;;){esp_task_wdt_reset();if(pending){bool queue_ready;{Lock lock(queue_mutex);queue_ready=durable->ready();}
   if(reader_ok&&rtc_ok&&config_verified&&last_sync&&queue_ready){if(esp_ota_mark_app_valid_cancel_rollback()==ESP_OK)pending=false;}
   else if(esp_timer_get_time()-started>180000000)esp_ota_mark_app_invalid_rollback_and_reboot();
  }vTaskDelay(pdMS_TO_TICKS(1000));}
}
static void boot_failure(const char* code){
 ESP_LOGE("boot","%s",code);int failure=0;xQueueSend(feedback_events,&failure,0);
 esp_ota_img_states_t status;if(esp_ota_get_state_partition(esp_ota_get_running_partition(),&status)==ESP_OK&&status==ESP_OTA_IMG_PENDING_VERIFY)esp_ota_mark_app_invalid_rollback_and_reboot();
}
extern "C" void app_main(){
 setenv("TZ","UTC0",1);tzset();bus_mutex=xSemaphoreCreateMutex();queue_mutex=xSemaphoreCreateMutex();feedback_events=xQueueCreate(16,sizeof(int));
 xTaskCreate(feedback_task,"feedback",3072,nullptr,2,nullptr);
 esp_chip_info_t chip;esp_chip_info(&chip);uint32_t size=0;esp_flash_get_size(nullptr,&size);
 // No unsigned or plaintext-storage fallback, including for a mistakenly flashed build profile.
 if(chip.revision<300||size!=4*1024*1024||!esp_secure_boot_enabled()||!esp_flash_encryption_enabled()){boot_failure("SECURE_HARDWARE_PROFILE_REQUIRED");return;}
 // Never erase NVS or a queue automatically in response to a mount/configuration error.
 if(nvs_flash_init()!=ESP_OK||!load_provision()||provision.hardware!="ESP32_ECO3_4MB"||!state.begin()){boot_failure("SECURE_PROVISIONING_REQUIRED");return;}
 static vidya::Queue queue(flash,state);durable=&queue;if(!queue.begin()||!provision.peak_72h||queue.capacity()<provision.peak_72h*1.1){boot_failure("QUEUE_CAPACITY_APPROVAL_REQUIRED");return;}
 if(!hardware_init()){boot_failure("READER_SELF_TEST_FAILED");return;}
 boot=uuid_bytes();boot_id=uuid_string(boot);start_wifi();
 xTaskCreate(clock_task,"clock",4096,nullptr,3,nullptr);xTaskCreate(scan_task,"nfc",6144,nullptr,5,nullptr);xTaskCreate(network_task,"sync",14336,nullptr,3,nullptr);xTaskCreate(health_task,"health",3072,nullptr,2,nullptr);
}
