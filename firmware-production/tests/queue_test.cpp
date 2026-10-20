#include "../core/queue.h"
#include <cassert>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <memory>
using namespace vidya;
struct MemoryFlash:Flash{
 std::vector<uint8_t> data=std::vector<uint8_t>(1024*16384,0xff);int cut=-1;
 uint32_t size()const override{return data.size();}
 bool read(uint32_t at,void* p,uint32_t n)override{if(at+n>data.size())return false;memcpy(p,data.data()+at,n);return true;}
 bool read_raw(uint32_t at,void*p,uint32_t n)override{return read(at,p,n);}
 bool write(uint32_t at,const void*p,uint32_t n)override{if(at+n>data.size())return false;auto b=static_cast<const uint8_t*>(p);auto count=cut<0?n:std::min(n,uint32_t(cut));for(uint32_t i=0;i<count;i++){if((data[at+i]&b[i])!=b[i])return false;data[at+i]&=b[i];}bool complete=count==n;cut=-1;return complete;}
 bool erase(uint32_t at,uint32_t n)override{if(at+n>data.size())return false;auto count=cut<0?n:std::min(n,uint32_t(cut));std::fill(data.begin()+at,data.begin()+at+count,0xff);bool complete=count==n;cut=-1;return complete;}
};
struct MemoryState:State{
 Cursor copies[2]{};bool present[2]{false,false};uint64_t high=0;
 bool load_cursor(unsigned n,Cursor&c)override{c=copies[n];return present[n];}
 bool save_cursor(unsigned n,const Cursor&c)override{copies[n]=c;present[n]=true;return true;}
 bool load_reserved(uint64_t&v)override{v=high;return true;}bool save_reserved(uint64_t v)override{high=v;return true;}
};
Record event(uint32_t id){Record r;r.uid_length=4;r.uid={0xAA,0xBB,0xCC,0xDD};memcpy(r.event_id.data(),&id,sizeof(id));r.timestamp_ms=1792454400000;r.uptime_ms=id;return r;}
int main(){
 MemoryFlash flash;MemoryState state;auto queue=std::make_unique<Queue>(flash,state);assert(queue->begin());
 std::set<std::array<uint8_t,16>> green,server;std::mt19937 random(42);uint32_t cuts=0;
 for(uint32_t n=1;n<=1500;n++){
  auto e=event(n);if(n%3==0){flash.cut=random()%128;cuts++;}
  if(queue->append(e,n<750?"1.0.0":"1.1.0"))green.insert(e.event_id);
  flash.cut=-1;
  auto batch=queue->peek(50);std::vector<std::array<uint8_t,16>> ids;
  if(n%4==0){for(size_t i=0;i<batch.size();i++){if(i==0&&n%8==0)continue;ids.push_back(batch[i].event.event_id);server.insert(batch[i].event.event_id);}queue->acknowledge_prefix(batch,ids);}
  if(n%3==0){queue=std::make_unique<Queue>(flash,state);assert(queue->begin());}
  // Corrupt segments consume capacity; test never treats storage-full as recorded feedback.
  auto pending=queue->peek(100);assert(pending.size()<=100);
  for(size_t i=1;i<pending.size();i++)assert(pending[i-1].event.sequence<pending[i].event.sequence);
 }
 // Verify every acknowledged-to-the-user event still has durable bytes or an actual server acknowledgement.
 std::set<std::array<uint8_t,16>> durable;
 for(uint32_t at=0;at+sizeof(Record)<=flash.size();at+=128){Record r;flash.read(at,&r,sizeof(r));auto stored=r.crc;r.crc=0;if(r.magic==0x56455654&&stored==crc32(&r,sizeof(r)))durable.insert(r.event_id);}
 for(const auto&id:green){assert(server.count(id)||durable.count(id));}
 assert(cuts==500);
 // A later UUID must never authorize purging an earlier unacknowledged event.
 MemoryFlash clean;MemoryState s;Queue q(clean,s);assert(q.begin());auto first=event(2001),second=event(2002);assert(q.append(first,"1.0.0")&&q.append(second,"1.0.0"));auto batch=q.peek(50);assert(q.acknowledge_prefix(batch,{second.event_id}));assert(q.pending()==2);assert(q.acknowledge_prefix(batch,{first.event_id,second.event_id}));assert(q.pending()==0);
 s.copies[0].crc^=1;s.copies[1].crc^=1;Queue recovered(clean,s);assert(recovered.begin());auto next=event(2003);assert(recovered.append(next,"1.0.0"));assert(next.sequence>second.sequence);
 std::cout<<"Queue core passed: 500 injected cuts, CRC/reboot recovery, bounded batches, durable feedback, firmware segments and UUID-prefix acknowledgement.\n";
}
