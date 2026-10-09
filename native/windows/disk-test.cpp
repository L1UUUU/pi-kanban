#include "disk.hpp"
#ifdef _WIN32
#include <fstream>
#include <functional>
#include <iostream>
#include <stdexcept>
using namespace pi_kanban;
namespace fs=std::filesystem;
namespace {
void Require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
void Write(const fs::path& path,size_t bytes){std::ofstream out(path,std::ios::binary);out<<std::string(bytes,'x');Require(!!out,"write disposable disk fixture");}
struct Fixture {
  fs::path root;LaunchDescriptor descriptor;
  explicit Fixture(unsigned index){
    wchar_t temp[MAX_PATH]{};const DWORD temp_chars=GetTempPathW(MAX_PATH,temp);Require(temp_chars>0&&temp_chars<MAX_PATH,"get bounded native temp path");
    root=fs::path(temp)/(L"pi-kanban-disk-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64())+L"-"+std::to_wstring(index));
    Require(fs::create_directory(root),"create unique disk fixture");fs::create_directory(root/L"source");fs::create_directory(root/L"scratch");
    descriptor.workspace=(root/L"source").wstring();descriptor.scratch=(root/L"scratch").wstring();descriptor.disk_limit_bytes=1024;descriptor.file_limit=100;descriptor.minimum_free_bytes=1;
  }
  ~Fixture(){std::error_code ignored;fs::remove_all(root,ignored);}
};
struct TestIo:disk_detail::Win32DiskIo {
  std::function<void(const fs::path&,unsigned)> before;
  std::function<void(const fs::path&)> before_size;
  std::function<void(const fs::path&,DWORD)> after_attributes;
  fs::path attribute_failure_path,reparse_path,size_failure_path,free_failure_path;
  DWORD attribute_failure=ERROR_ACCESS_DENIED,size_failure=ERROR_ACCESS_DENIED,free_failure=ERROR_FILE_NOT_FOUND;
  uint64_t forced_free=0;bool giant_files=false;
  void BeforeEntry(const fs::path& path,unsigned attempt){if(before)before(path,attempt);}
  DWORD Attributes(const fs::path& path,DWORD& status){
    if(path==attribute_failure_path){status=attribute_failure;return INVALID_FILE_ATTRIBUTES;}
    const DWORD attributes=Win32DiskIo::Attributes(path,status);if(after_attributes)after_attributes(path,attributes);return path==reparse_path?attributes|FILE_ATTRIBUTE_REPARSE_POINT:attributes;
  }
  uint64_t FileSize(const fs::path& path,DWORD& status){
    if(before_size)before_size(path);
    if(path==size_failure_path){status=size_failure;return 0;}
    if(giant_files){status=ERROR_SUCCESS;return std::numeric_limits<uint64_t>::max();}
    return Win32DiskIo::FileSize(path,status);
  }
  uint64_t FreeSpace(const fs::path& path,DWORD& status){
    if(path==free_failure_path){status=free_failure;return 0;}
    if(forced_free){status=ERROR_SUCCESS;return forced_free;}
    return Win32DiskIo::FreeSpace(path,status);
  }
};
void RenameAndRestart(bool during_size){
  Fixture f(during_size?2:1);const fs::path source=fs::path(f.descriptor.workspace)/L"counted.txt",pending=fs::path(f.descriptor.scratch)/L"ready.tmp",ready=fs::path(f.descriptor.scratch)/L"ready.json";
  Write(source,3);Write(pending,17);TestIo io;bool renamed=false;unsigned source_visits=0;
  const auto rename=[&](const fs::path& path){if(path==pending&&!renamed){fs::rename(pending,ready);Write(source,7);renamed=true;}};
  io.before=[&](const fs::path& path,unsigned){if(path==source)++source_visits;if(!during_size)rename(path);};
  if(during_size)io.before_size=rename;
  const auto observed=disk_detail::Observe(f.descriptor,io);
  Require(renamed&&observed.status==ERROR_SUCCESS,"atomic rename must allow a complete new sample");
  Require(observed.attempts==2&&observed.transient_retries==1&&disk_detail::Missing(observed.transient_status),"record one missing-child rescan");
  Require(source_visits==2&&observed.bytes==24&&observed.entries==2,"restart both trees and reset all partial counters");
  Require(observed.free_space_observed&&observed.workspace_free>0&&observed.scratch_free>0,"sample both volumes after successful rescan");
  Require(observed.failure_path.empty(),"successful result is a complete sample");
}
void PersistentChurn(){
  Fixture f(3);fs::path current=fs::path(f.descriptor.scratch)/L"churn.tmp";Write(current,17);TestIo io;unsigned renames=0;
  io.before=[&](const fs::path& path,unsigned attempt){if(path==current){const auto next=fs::path(f.descriptor.scratch)/(L"churn-"+std::to_wstring(attempt)+L".tmp");fs::rename(current,next);current=next;++renames;}};
  const auto observed=disk_detail::Observe(f.descriptor,io);
  Require(disk_detail::Missing(observed.status)&&renames==3&&observed.attempts==3&&observed.transient_retries==2,"persistent churn fails at exactly three attempts");
  Require(!observed.free_space_observed,"partial churn count is never success");
}
void ImmediateFailures(){
  Fixture f(4);const fs::path file=fs::path(f.descriptor.workspace)/L"data",second=fs::path(f.descriptor.scratch)/L"data";Write(file,17);Write(second,3);
  const auto check=[&](TestIo& io,DWORD status){const auto value=disk_detail::Observe(f.descriptor,io);Require(value.status==status&&value.attempts==1&&value.transient_retries==0,"non-transient failures never retry");};
  // Inject specific OS metadata failures to cover decision branches; the rename
  // regressions above use real native filesystem calls and disposable files.
  TestIo denied;denied.attribute_failure_path=file;check(denied,ERROR_ACCESS_DENIED);
  TestIo unreadable;unreadable.size_failure_path=file;check(unreadable,ERROR_ACCESS_DENIED);
  TestIo reparse;reparse.reparse_path=file;check(reparse,ERROR_REPARSE_TAG_INVALID);
  TestIo root_reparse;root_reparse.reparse_path=f.descriptor.workspace;check(root_reparse,ERROR_REPARSE_TAG_INVALID);
  TestIo root_missing;root_missing.attribute_failure_path=f.descriptor.workspace;root_missing.attribute_failure=ERROR_PATH_NOT_FOUND;check(root_missing,ERROR_PATH_NOT_FOUND);
  TestIo free_error;free_error.free_failure_path=f.descriptor.scratch;check(free_error,ERROR_FILE_NOT_FOUND);
  TestIo low_space;low_space.forced_free=1;f.descriptor.minimum_free_bytes=2;check(low_space,ERROR_DISK_FULL);f.descriptor.minimum_free_bytes=1;
  TestIo quota;f.descriptor.disk_limit_bytes=16;check(quota,ERROR_DISK_FULL);f.descriptor.disk_limit_bytes=1024;
  TestIo count;f.descriptor.file_limit=1;check(count,ERROR_TOO_MANY_OPEN_FILES);f.descriptor.file_limit=100;
  TestIo overflow;overflow.giant_files=true;f.descriptor.disk_limit_bytes=std::numeric_limits<uint64_t>::max();check(overflow,ERROR_ARITHMETIC_OVERFLOW);
}
void RootDisappears(){
  Fixture f(5);const fs::path source=f.descriptor.workspace,file=source/L"data";Write(file,3);TestIo io;bool moved=false;
  io.before=[&](const fs::path&,unsigned){if(!moved){fs::rename(source,f.root/L"held-source");moved=true;}};
  const auto observed=disk_detail::Observe(f.descriptor,io);
  Require(moved&&disk_detail::Missing(observed.status)&&observed.attempts==1&&observed.transient_retries==0,"vanished root must fail before rescan");
  Require(std::string(observed.failure_phase)=="root-attributes","root error retains its own classification");
}
void RenamedQuotaStillFails(){
  Fixture f(6);const fs::path pending=fs::path(f.descriptor.scratch)/L"big.tmp",ready=fs::path(f.descriptor.scratch)/L"big";Write(pending,17);f.descriptor.disk_limit_bytes=16;TestIo io;
  io.before=[&](const fs::path& path,unsigned attempt){if(path==pending&&attempt==1)fs::rename(pending,ready);};
  const auto observed=disk_detail::Observe(f.descriptor,io);
  Require(observed.status==ERROR_DISK_FULL&&observed.bytes==17&&observed.attempts==2&&observed.transient_retries==1,"renamed file is included in full quota rescan");
}
void DirectoryDisappearsBeforeRecursion(){
  Fixture f(7);const fs::path pending=fs::path(f.descriptor.scratch)/L"pending",ready=fs::path(f.descriptor.scratch)/L"ready";
  fs::create_directory(pending);Write(pending/L"data",17);Write(fs::path(f.descriptor.workspace)/L"data",3);TestIo io;bool renamed=false;
  io.after_attributes=[&](const fs::path& path,DWORD attributes){if(path==pending&&!renamed){Require((attributes&FILE_ATTRIBUTE_DIRECTORY)!=0,"observe real directory before rename");fs::rename(pending,ready);renamed=true;}};
  const auto observed=disk_detail::Observe(f.descriptor,io);
  Require(renamed&&observed.status==ERROR_SUCCESS&&observed.attempts==2&&observed.transient_retries==1,"missing enumerated directory requires complete retry");
  Require(observed.entries==3&&observed.bytes==20&&observed.free_space_observed,"renamed directory contents remain accounted");
}
}
int wmain(){try{RenameAndRestart(false);RenameAndRestart(true);PersistentChurn();ImmediateFailures();RootDisappears();RenamedQuotaStillFails();DirectoryDisappearsBeforeRecursion();std::cout<<"Native disk accounting: atomic rename, complete rescan, finite churn and immediate policy failures passed\n";return 0;}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
#endif
