#include "queue.h"
#include <algorithm>
#include <limits>
namespace vidya {
uint32_t crc32(const void* input,size_t n){auto p=static_cast<const uint8_t*>(input);uint32_t crc=0xffffffff;while(n--){crc^=*p++;for(int k=0;k<8;k++)crc=(crc>>1)^(0xedb88320u&-(int32_t)(crc&1));}return ~crc;}
template<class T> bool valid(T value){auto stored=value.crc;value.crc=0;return stored==crc32(&value,sizeof(value));}
template<class T> void seal(T& value){value.crc=0;value.crc=crc32(&value,sizeof(value));}
bool Queue::empty(uint32_t offset){uint8_t bytes[128];if(!flash.read_raw(offset,bytes,sizeof(bytes)))return false;return std::all_of(bytes,bytes+128,[](uint8_t v){return v==0xff;});}
bool Queue::persist_cursor(){cursor.generation++;seal(cursor);if(!state.save_cursor(cursor.generation%2,cursor)){healthy=false;return false;}return true;}
bool Queue::begin(){
 segments.clear();pending_count=quarantine_count=0;Cursor a{},b{};bool va=state.load_cursor(0,a)&&valid(a),vb=state.load_cursor(1,b)&&valid(b);
 cursor=va&&(!vb||a.generation>b.generation)?a:vb?b:Cursor{};uint64_t maximum=0;
 for(uint32_t offset=0;offset+segment_bytes<=flash.size();offset+=segment_bytes){
  if(empty(offset))continue;
  SegmentHeader header{};Segment s;s.offset=offset;
  if(!flash.read(offset,&header,sizeof(header))||header.magic!=0x56534547||header.format!=1||!valid(header)||!memchr(header.firmware,0,sizeof(header.firmware))){s.quarantined=true;s.used=127;quarantine_count++;segments.push_back(s);continue;}
  s.first=header.first_sequence;s.firmware=header.firmware;
  for(uint32_t slot=1;slot<128;slot++){
   auto at=offset+slot*128;if(empty(at))continue;s.used=slot;
   Record r{};if(!flash.read(at,&r,sizeof(r))||r.magic!=0x56455654||r.format!=1||r.uid_length<4||r.uid_length>10||!valid(r)){s.quarantined=true;quarantine_count++;continue;}
   maximum=std::max(maximum,r.sequence);s.last=std::max(s.last,r.sequence);if(r.sequence>cursor.acknowledged)pending_count++;
  }segments.push_back(s);
 }
 std::sort(segments.begin(),segments.end(),[](const Segment&a,const Segment&b){return a.first<b.first;});
 // Reservation high-water is committed before a block of sequence numbers is used.
 // A reboot can leave a reported gap, but can never reuse a previously reserved sequence.
 if(!state.load_reserved(reserved))reserved=0;
 next=std::max({maximum,cursor.acknowledged,reserved})+1;
 if(next>=9007199254740000ULL)return false;
 healthy=true;return persist_cursor();
}
bool Queue::allocate(uint64_t sequence,const std::string& version,Segment*& out){
 for(auto& s:segments)if(!s.quarantined&&s.used<127&&s.firmware==version&&s.last<=sequence){out=&s;return true;}
 auto count=flash.size()/segment_bytes;
 for(uint32_t n=0;n<count;n++){
  auto index=(cursor.next_segment+n)%count,offset=index*segment_bytes;
  if(std::any_of(segments.begin(),segments.end(),[&](const Segment&s){return s.offset==offset;}))continue;
  if(!flash.erase(offset,segment_bytes))return false;
  SegmentHeader header;header.first_sequence=sequence;std::memcpy(header.firmware,version.c_str(),version.size()+1);seal(header);
  if(!flash.write(offset,&header,sizeof(header)))return false;
  SegmentHeader check;
  if(!flash.read(offset,&check,sizeof(check))||!valid(check)){quarantine_count++;healthy=false;return false;}
  segments.push_back({offset,0,sequence,0,false,version});cursor.next_segment=(index+1)%count;
  if(!persist_cursor())return false;
  out=&segments.back();return true;
 }return false;
}
bool Queue::append(Record& event,const std::string& version){
 if(!healthy||version.empty()||version.size()>=80||event.uid_length<4||event.uid_length>10)return false;
 if(next>reserved){reserved=next+63;if(!state.save_reserved(reserved)){healthy=false;return false;}}
 Segment* segment=nullptr;if(!allocate(next,version,segment))return false;
 event.sequence=next++;seal(event);auto offset=segment->offset+(++segment->used)*128;
 // A torn slot is quarantined and never overwritten, including after restart.
 if(!flash.write(offset,&event,sizeof(event))){segment->quarantined=true;quarantine_count++;return false;}
 Record check;if(!flash.read(offset,&check,sizeof(check))||!valid(check)||std::memcmp(&check,&event,sizeof(check))!=0){segment->quarantined=true;quarantine_count++;return false;}
 segment->last=event.sequence;pending_count++;return true;
}
std::vector<Pending> Queue::peek(size_t limit)const{
 std::vector<Pending> result;limit=std::min(limit,size_t(100));if(!limit)return result;result.reserve(limit);
 for(const auto& s:segments){if(s.firmware.empty())continue;for(uint32_t slot=1;slot<=s.used&&slot<128;slot++){
  Record r{};if(!flash.read(s.offset+slot*128,&r,sizeof(r))||r.magic!=0x56455654||!valid(r)||r.sequence<=cursor.acknowledged)continue;
  if(result.size()==limit&&r.sequence>=result.back().event.sequence)continue;
  auto at=std::lower_bound(result.begin(),result.end(),r.sequence,[](const Pending& p,uint64_t seq){return p.event.sequence<seq;});
  result.insert(at,{r,s.firmware});if(result.size()>limit)result.pop_back();
 }}return result;
}
bool Queue::acknowledge_prefix(const std::vector<Pending>& sent,const std::vector<std::array<uint8_t,16>>& ids){
 if(!healthy)return false;
 auto prefix=peek(100);uint64_t advance=cursor.acknowledged;uint32_t removed=0;
 for(const auto& p:prefix){
  if(std::none_of(sent.begin(),sent.end(),[&](const Pending& s){return s.event.sequence==p.event.sequence&&s.event.event_id==p.event.event_id;})||std::find(ids.begin(),ids.end(),p.event.event_id)==ids.end())break;
  advance=p.event.sequence;removed++;
 }
 if(advance==cursor.acknowledged)return true;
 cursor.acknowledged=advance;if(!persist_cursor())return false;
 pending_count-=std::min(pending_count,removed);
 for(auto it=segments.begin();it!=segments.end();){
  if(!it->quarantined&&it->last&&it->last<=advance){
   // Header is erased LAST: power loss during reclaim cannot make pending data look free.
   if(!flash.erase(it->offset+4096,segment_bytes-4096)||!flash.erase(it->offset,4096)){healthy=false;return false;}
   it=segments.erase(it);
  }else ++it;
 }return true;
}
uint32_t Queue::used_percent()const{return flash.size()?std::min(uint32_t(100),uint32_t(segments.size()*segment_bytes*100ULL/flash.size())):100;}
}
