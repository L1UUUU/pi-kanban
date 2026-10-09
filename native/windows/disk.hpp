#pragma once
#include "launcher.hpp"
#ifdef _WIN32
#include <filesystem>
#include <limits>
namespace pi_kanban {
struct DiskObservation { DWORD status=ERROR_SUCCESS;uint64_t bytes=0,entries=0,workspace_free=0,scratch_free=0;bool free_space_observed=false; };
// Sampled accounting, not a hard disk quota: a process can write between samples.
// No data is deleted, and unreadable/reparse paths fail closed rather than skipped.
inline DiskObservation ObserveDisk(const LaunchDescriptor& d){
  DiskObservation result;
  try{
    for(const auto& root:{d.workspace,d.scratch}){
      const DWORD root_attributes=GetFileAttributesW(root.c_str());if(root_attributes==INVALID_FILE_ATTRIBUTES){result.status=GetLastError();return result;}if(root_attributes&FILE_ATTRIBUTE_REPARSE_POINT){result.status=ERROR_REPARSE_TAG_INVALID;return result;}
      for(const auto& entry:std::filesystem::recursive_directory_iterator(root)){
        const DWORD attributes=GetFileAttributesW(entry.path().c_str());if(attributes==INVALID_FILE_ATTRIBUTES){result.status=GetLastError();return result;}if(attributes&FILE_ATTRIBUTE_REPARSE_POINT){result.status=ERROR_REPARSE_TAG_INVALID;return result;}
        if(++result.entries>d.file_limit){result.status=ERROR_TOO_MANY_OPEN_FILES;return result;}
        if(!(attributes&FILE_ATTRIBUTE_DIRECTORY)){const uint64_t bytes=std::filesystem::file_size(entry.path());if(bytes>std::numeric_limits<uint64_t>::max()-result.bytes){result.status=ERROR_ARITHMETIC_OVERFLOW;return result;}result.bytes+=bytes;if(result.bytes>d.disk_limit_bytes){result.status=ERROR_DISK_FULL;return result;}}
      }
    }
    ULARGE_INTEGER available{},total{},free{};
    if(!GetDiskFreeSpaceExW(d.workspace.c_str(),&available,&total,&free)){result.status=GetLastError();return result;}result.workspace_free=available.QuadPart;
    if(!GetDiskFreeSpaceExW(d.scratch.c_str(),&available,&total,&free)){result.status=GetLastError();return result;}result.scratch_free=available.QuadPart;result.free_space_observed=true;
    if(result.workspace_free<d.minimum_free_bytes||result.scratch_free<d.minimum_free_bytes)result.status=ERROR_DISK_FULL;
  }catch(...){result.status=ERROR_ACCESS_DENIED;}
  return result;
}
}
#endif
