#pragma once
#include "launcher.hpp"
#include <mutex>
#include <set>
#ifdef _WIN32
namespace pi_kanban {
/** Scope-authorized per-generation grants; never rewrites unrelated principals. */
class ScopedResources {
 public:
  DWORD Provision(const LaunchDescriptor&,const std::vector<std::wstring>& readonly_roots,const std::wstring& authorization);
  DWORD Revoke();
  ~ScopedResources();
 private:
  std::mutex mutex_;std::set<std::wstring> recursive_;
  PSID sid_=nullptr;std::wstring profile_;std::vector<std::wstring> changed_;
};
}
#endif
