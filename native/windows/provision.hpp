#pragma once
#include "launcher.hpp"
#include <mutex>
#include <set>
#ifdef _WIN32
namespace pi_kanban {
struct ResourceFailure { std::string phase;std::wstring path;DWORD status; };
/** Scope-authorized per-generation grants; never rewrites unrelated principals. */
class ScopedResources {
 public:
  DWORD Provision(const LaunchDescriptor&,const std::vector<std::wstring>& readonly_roots,const std::wstring& authorization);
  DWORD Revoke();
  const std::vector<ResourceFailure>& Failures() const { return failures_; }
  ~ScopedResources();
 private:
  std::mutex mutex_;std::set<std::wstring> recursive_;
  std::vector<ResourceFailure> failures_;
  void RecordFailure(const char* phase,const std::wstring& path,DWORD status){if(status&&failures_.size()<8)failures_.push_back({phase,path.substr(0,512),status});}
  PSID sid_=nullptr;std::wstring profile_;std::vector<std::wstring> changed_;
};
}
#endif
