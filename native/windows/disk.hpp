#pragma once
#include "launcher.hpp"
#ifdef _WIN32
#include <filesystem>
#include <limits>
#include <system_error>
namespace pi_kanban {
struct DiskObservation {
  DWORD status=ERROR_SUCCESS;uint64_t bytes=0,entries=0,workspace_free=0,scratch_free=0;bool free_space_observed=false;
  unsigned attempts=1,transient_retries=0;DWORD transient_status=ERROR_SUCCESS;
  const char* failure_phase="complete";std::wstring failure_path;
};
namespace disk_detail {
constexpr unsigned kMaximumAttempts=3;
inline bool Missing(DWORD status){return status==ERROR_FILE_NOT_FOUND||status==ERROR_PATH_NOT_FOUND;}
inline DWORD FilesystemStatus(const std::error_code& error){
  if(!error)return ERROR_SUCCESS;
  if(error.category()==std::system_category())return static_cast<DWORD>(error.value());
  if(error==std::errc::no_such_file_or_directory)return ERROR_FILE_NOT_FOUND;
  return ERROR_ACCESS_DENIED;
}
// Compile-time test seam: production always uses these real OS operations.
// Test observers rename disposable paths exactly after enumeration, without a
// timing race or changes to the helper's runtime protocol or permissions.
struct Win32DiskIo {
  void BeforeEntry(const std::filesystem::path&,unsigned){}
  DWORD Attributes(const std::filesystem::path& path,DWORD& status){
    const DWORD attributes=GetFileAttributesW(path.c_str());status=attributes==INVALID_FILE_ATTRIBUTES?GetLastError():ERROR_SUCCESS;return attributes;
  }
  uint64_t FileSize(const std::filesystem::path& path,DWORD& status){
    std::error_code error;const auto bytes=std::filesystem::file_size(path,error);status=FilesystemStatus(error);return bytes;
  }
  uint64_t FreeSpace(const std::filesystem::path& path,DWORD& status){
    ULARGE_INTEGER available{},total{},free{};status=GetDiskFreeSpaceExW(path.c_str(),&available,&total,&free)?ERROR_SUCCESS:GetLastError();return available.QuadPart;
  }
};
inline void Fail(DiskObservation& result,DWORD status,const char* phase,const std::filesystem::path& path){
  result.status=status;result.failure_phase=phase;result.failure_path=path.wstring();
}
template<class Io> bool Roots(const LaunchDescriptor& d,Io& io,DiskObservation& result){
  for(const auto& root:{d.workspace,d.scratch}){
    DWORD status=ERROR_SUCCESS;const DWORD attributes=io.Attributes(root,status);
    if(status){Fail(result,status,"root-attributes",root);return false;}
    if(attributes&FILE_ATTRIBUTE_REPARSE_POINT){Fail(result,ERROR_REPARSE_TAG_INVALID,"root-reparse",root);return false;}
    if(!(attributes&FILE_ATTRIBUTE_DIRECTORY)){Fail(result,ERROR_DIRECTORY,"root-directory",root);return false;}
  }
  return true;
}
template<class Io> DiskObservation Pass(const LaunchDescriptor& d,Io& io,unsigned attempt,bool& retryable){
  DiskObservation result;result.attempts=attempt;retryable=false;
  try{
    if(!Roots(d,io,result))return result;
    for(const auto& root:{d.workspace,d.scratch}){
      std::error_code error;std::filesystem::recursive_directory_iterator entries(root,std::filesystem::directory_options::none,error),end;
      if(error){Fail(result,FilesystemStatus(error),"root-enumeration",root);return result;}
      while(entries!=end){
        const auto path=entries->path();io.BeforeEntry(path,attempt);
        DWORD status=ERROR_SUCCESS;const DWORD attributes=io.Attributes(path,status);
        if(status){Fail(result,status,"child-attributes",path);retryable=Missing(status);return result;}
        if(attributes&FILE_ATTRIBUTE_REPARSE_POINT){Fail(result,ERROR_REPARSE_TAG_INVALID,"child-reparse",path);return result;}
        if(++result.entries>d.file_limit){Fail(result,ERROR_TOO_MANY_OPEN_FILES,"entry-limit",path);return result;}
        if(!(attributes&FILE_ATTRIBUTE_DIRECTORY)){
          const uint64_t bytes=io.FileSize(path,status);
          if(status){Fail(result,status,"child-size",path);retryable=Missing(status);return result;}
          if(bytes>std::numeric_limits<uint64_t>::max()-result.bytes){Fail(result,ERROR_ARITHMETIC_OVERFLOW,"byte-overflow",path);return result;}
          result.bytes+=bytes;if(result.bytes>d.disk_limit_bytes){Fail(result,ERROR_DISK_FULL,"byte-limit",path);return result;}
        }
        entries.increment(error);
        if(error){const DWORD failure=FilesystemStatus(error);Fail(result,failure,"child-enumeration",path);retryable=Missing(failure);return result;}
      }
    }
    DWORD status=ERROR_SUCCESS;result.workspace_free=io.FreeSpace(d.workspace,status);
    if(status){Fail(result,status,"workspace-free-space",d.workspace);return result;}
    result.scratch_free=io.FreeSpace(d.scratch,status);
    if(status){Fail(result,status,"scratch-free-space",d.scratch);return result;}
    result.free_space_observed=true;
    if(result.workspace_free<d.minimum_free_bytes||result.scratch_free<d.minimum_free_bytes)Fail(result,ERROR_DISK_FULL,"free-space-limit",result.workspace_free<d.minimum_free_bytes?d.workspace:d.scratch);
  }catch(...){Fail(result,ERROR_ACCESS_DENIED,"filesystem-exception",L"");retryable=false;}
  return result;
}
template<class Io> DiskObservation Observe(const LaunchDescriptor& d,Io& io){
  DWORD transient_status=ERROR_SUCCESS;
  for(unsigned attempt=1;attempt<=kMaximumAttempts;++attempt){
    bool retryable=false;auto result=Pass(d,io,attempt,retryable);
    result.transient_retries=attempt-1;result.transient_status=transient_status;
    if(!retryable||attempt==kMaximumAttempts)return result;
    // A missing root is not descendant churn. Reparse/non-directory roots and
    // every other root error terminate before any new traversal is allowed.
    try{if(!Roots(d,io,result))return result;}
    catch(...){result.status=ERROR_ACCESS_DENIED;result.failure_phase="root-exception";result.failure_path.clear();return result;}
    transient_status=result.status;
    // Discard incomplete counts and restart BOTH trees. Never accept a skipped
    // entry or carry partial totals forward as a successful observation.
  }
  DiskObservation unreachable;unreachable.status=ERROR_INVALID_DATA;return unreachable;
}
}
// Sampled accounting, not a hard quota: writes can occur between observations.
// Only disappearing enumerated descendants permit at most two full rescans.
// Persistent churn and all unreadable/reparse/quota/root errors remain failures.
inline DiskObservation ObserveDisk(const LaunchDescriptor& d){disk_detail::Win32DiskIo io;return disk_detail::Observe(d,io);}
}
#endif
