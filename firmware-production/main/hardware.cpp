#include "reader.h"
#include <algorithm>
#include <cstdio>
#include <ctime>
#include <sys/time.h>
#include "driver/i2c_master.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"
static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t pn532,ds3231;
static constexpr gpio_num_t green=GPIO_NUM_26,red=GPIO_NUM_27,buzzer=GPIO_NUM_25,amber=GPIO_NUM_33;
static bool ready_byte(){uint8_t byte=0;return i2c_master_receive(pn532,&byte,1,20)==ESP_OK&&(byte&1);}
static bool wait_ready(unsigned timeout){auto start=esp_timer_get_time();while((esp_timer_get_time()-start)/1000<timeout){if(ready_byte())return true;vTaskDelay(pdMS_TO_TICKS(5));}return false;}
static bool command(uint8_t cmd,const uint8_t* data,size_t n,uint8_t* answer,size_t size){
 if(n>64||size>80)return false;uint8_t frame[73]={0,0,0xff,uint8_t(n+2),uint8_t(-(n+2)),0xd4,cmd};
 uint8_t sum=0xd4+cmd;for(size_t i=0;i<n;i++){frame[7+i]=data[i];sum+=data[i];}frame[7+n]=uint8_t(-sum);frame[8+n]=0;
 if(i2c_master_transmit(pn532,frame,n+9,50)!=ESP_OK||!wait_ready(150))return false;
 uint8_t ack[7];if(i2c_master_receive(pn532,ack,7,50)!=ESP_OK||memcmp(ack+1,"\0\0\xff\0\xff\0",6)!=0||!wait_ready(250))return false;
 uint8_t response[81];if(i2c_master_receive(pn532,response,size+1,50)!=ESP_OK)return false;memcpy(answer,response+1,size);
 if(size<9||answer[0]!=0||answer[1]!=0||answer[2]!=0xff||uint8_t(answer[3]+answer[4])!=0||answer[3]+7>size||answer[5]!=0xd5||answer[6]!=uint8_t(cmd+1))return false;
 sum=0;for(unsigned i=5;i<5+answer[3]+1;i++)sum+=answer[i];return sum==0;
}
static int bcd(uint8_t v){return (v>>4)*10+(v&15);}static uint8_t packed(int v){return uint8_t((v/10)<<4|(v%10));}
static uint64_t rtc_read(){
 uint8_t reg=0,status_reg=0x0f,status=0,bytes[7];
 if(i2c_master_transmit_receive(ds3231,&status_reg,1,&status,1,25)!=ESP_OK||(status&0x80)||i2c_master_transmit_receive(ds3231,&reg,1,bytes,7,25)!=ESP_OK){rtc_ok=false;return 0;}
 if(bytes[2]&0x40){rtc_ok=false;return 0;} // Provision DS3231 in UTC, 24-hour mode.
 tm t{};t.tm_sec=bcd(bytes[0]&0x7f);t.tm_min=bcd(bytes[1]);t.tm_hour=bcd(bytes[2]);t.tm_mday=bcd(bytes[4]);t.tm_mon=bcd(bytes[5]&0x1f)-1;t.tm_year=bcd(bytes[6])+100+((bytes[5]&0x80)?100:0);
 if(t.tm_sec>59||t.tm_min>59||t.tm_hour>23||t.tm_mday<1||t.tm_mday>31||t.tm_mon<0||t.tm_mon>11||t.tm_year<124||t.tm_year>180){rtc_ok=false;return 0;}
 time_t seconds=mktime(&t);rtc_ok=seconds>1700000000;return rtc_ok?uint64_t(seconds)*1000:0;
}
static bool rtc_write(time_t now){
 tm t;gmtime_r(&now,&t);uint8_t bytes[]={0,packed(t.tm_sec),packed(t.tm_min),packed(t.tm_hour),packed(t.tm_wday? t.tm_wday:7),packed(t.tm_mday),packed(t.tm_mon+1),packed(t.tm_year-100)};
 if(i2c_master_transmit(ds3231,bytes,sizeof(bytes),25)!=ESP_OK)return false;
 uint8_t reg=0x0f,status=0;if(i2c_master_transmit_receive(ds3231,&reg,1,&status,1,25)!=ESP_OK)return false;uint8_t clear[]={0x0f,uint8_t(status&0x7f)};return i2c_master_transmit(ds3231,clear,2,25)==ESP_OK;
}
bool hardware_init(){
 i2c_master_bus_config_t cfg{};cfg.i2c_port=I2C_NUM_0;cfg.sda_io_num=GPIO_NUM_21;cfg.scl_io_num=GPIO_NUM_22;cfg.clk_source=I2C_CLK_SRC_DEFAULT;cfg.glitch_ignore_cnt=7;cfg.flags.enable_internal_pullup=true;
 if(i2c_new_master_bus(&cfg,&bus)!=ESP_OK)return false;
 i2c_device_config_t device{};device.dev_addr_length=I2C_ADDR_BIT_LEN_7;device.scl_speed_hz=100000;device.device_address=0x24;
 if(i2c_master_bus_add_device(bus,&device,&pn532)!=ESP_OK)return false;device.device_address=0x68;if(i2c_master_bus_add_device(bus,&device,&ds3231)!=ESP_OK)return false;
 gpio_set_direction(GPIO_NUM_5,GPIO_MODE_OUTPUT);gpio_set_level(GPIO_NUM_5,0);vTaskDelay(pdMS_TO_TICKS(100));gpio_set_level(GPIO_NUM_5,1);vTaskDelay(pdMS_TO_TICKS(200));
 uint8_t result[24],sam[]={1,0x14,1},retry[]={5,0xff,1,1};
 reader_ok=command(2,nullptr,0,result,16)&&command(0x14,sam,sizeof(sam),result,16)&&command(0x32,retry,sizeof(retry),result,16);
 {Lock lock(bus_mutex);auto at=rtc_read();if(at){timeval tv{time_t(at/1000),0};settimeofday(&tv,nullptr);}}
 return reader_ok;
}
bool read_uid(std::array<uint8_t,10>& uid,uint8_t& length){
 Lock lock(bus_mutex);uint8_t args[]={1,0},response[40];
 reader_ok=command(0x4a,args,2,response,sizeof(response));if(!reader_ok)return false;
 if(response[7]!=1||response[12]<4||response[12]>10)return false;
 length=response[12];memcpy(uid.data(),response+13,length);reader_ok=true;return true;
}
uint64_t clock_ms(vidya::TimeSource* source){
 Lock lock(bus_mutex);auto rtc=rtc_read();auto now=time(nullptr);auto synced=last_sync.load();
 if(rtc&&synced&&rtc/1000>=synced&&rtc/1000-synced<=7*86400){if(source)*source=vidya::TimeSource::rtc_synced;return rtc;}
 if(synced&&now>=synced&&uint64_t(now)-synced<7*86400){if(source)*source=vidya::TimeSource::ntp;return uint64_t(now)*1000;}
 if(source)*source=rtc?vidya::TimeSource::rtc_unsynced:vidya::TimeSource::monotonic;return rtc?rtc:std::max<int64_t>(0,now)*1000;
}
void clock_task(void*){
 esp_task_wdt_add(nullptr);nvs_handle_t state=0;nvs_open("clock",NVS_READWRITE,&state);uint32_t saved=0;nvs_get_u32(state,"last_sync",&saved);last_sync=saved;
 for(;;){esp_task_wdt_reset();time_t now=ntp_epoch.load();if(now>1700000000&&uint64_t(now)>last_sync){
  Lock lock(bus_mutex);auto old=rtc_read();rtc_drift=old&&std::abs(int64_t(old/1000)-now)>120;
  if(rtc_write(now)){last_sync=now;nvs_set_u32(state,"last_sync",now);nvs_commit(state);rtc_ok=true;}
 }vTaskDelay(pdMS_TO_TICKS(1000));}
}
std::array<uint8_t,16> uuid_bytes(){std::array<uint8_t,16>b;esp_fill_random(b.data(),16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;return b;}
std::string uuid_string(const std::array<uint8_t,16>& b){char s[37];snprintf(s,sizeof(s),"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);return s;}
std::string uuid(){return uuid_string(uuid_bytes());}
std::string iso(uint64_t milliseconds){time_t now=milliseconds/1000;tm utc;gmtime_r(&now,&utc);char text[32];strftime(text,sizeof(text),"%Y-%m-%dT%H:%M:%S.000Z",&utc);return text;}
void feedback_task(void*){
 for(auto pin:{green,red,amber}){gpio_set_direction(pin,GPIO_MODE_OUTPUT);gpio_set_level(pin,0);}
 ledc_timer_config_t timer{};timer.speed_mode=LEDC_LOW_SPEED_MODE;timer.duty_resolution=LEDC_TIMER_10_BIT;timer.timer_num=LEDC_TIMER_0;timer.freq_hz=2200;timer.clk_cfg=LEDC_AUTO_CLK;ledc_timer_config(&timer);
 ledc_channel_config_t channel{};channel.gpio_num=buzzer;channel.speed_mode=LEDC_LOW_SPEED_MODE;channel.channel=LEDC_CHANNEL_0;channel.timer_sel=LEDC_TIMER_0;ledc_channel_config(&channel);esp_task_wdt_add(nullptr);
 for(;;){int value=0;esp_task_wdt_reset();if(xQueueReceive(feedback_events,&value,pdMS_TO_TICKS(1000))==pdTRUE){
  auto pin=value?green:red;gpio_set_level(pin,1);if(buzzer_enabled){ledc_set_freq(LEDC_LOW_SPEED_MODE,LEDC_TIMER_0,value?2200:500);ledc_set_duty(LEDC_LOW_SPEED_MODE,LEDC_CHANNEL_0,512);ledc_update_duty(LEDC_LOW_SPEED_MODE,LEDC_CHANNEL_0);}vTaskDelay(pdMS_TO_TICKS(value?80:350));ledc_set_duty(LEDC_LOW_SPEED_MODE,LEDC_CHANNEL_0,0);ledc_update_duty(LEDC_LOW_SPEED_MODE,LEDC_CHANNEL_0);gpio_set_level(pin,0);
 }gpio_set_level(amber,!config_verified||!reader_ok||!rtc_ok);}
}
