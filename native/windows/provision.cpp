#include "provision.hpp"
#ifdef _WIN32
#include <aclapi.h>
#include <userenv.h>
#include <filesystem>
#include <algorithm>
#include <cwctype>
namespace pi_kanban {
namespace {
namespace fs=std::filesystem;
DWORD SafeTree(const fs::path& root){
  try{if(root==root.root_path()||!root.is_absolute())return ERROR_BAD_PATHNAME;
    fs::path cursor=root;while(!cursor.empty()){const DWORD attrs=GetFileAttributesW(cursor.c_str());if(attrs==INVALID_FILE_ATTRIBUTES)return GetLastError();if(attrs&FILE_ATTRIBUTE_REPARSE_POINT)return ERROR_REPARSE_TAG_INVALID;if(cursor==cursor.root_path())break;cursor=cursor.parent_path();}
    if(fs::is_directory(root))for(const auto& entry:fs::recursive_directory_iterator(root)){const DWORD attrs=GetFileAttributesW(entry.path().c_str());if(attrs==INVALID_FILE_ATTRIBUTES)return GetLastError();if(attrs&FILE_ATTRIBUTE_REPARSE_POINT)return ERROR_REPARSE_TAG_INVALID;}
    return ERROR_SUCCESS;
  }catch(...){return ERROR_ACCESS_DENIED;}
}
DWORD Edit(const std::wstring& path,PSID sid,DWORD rights,ACCESS_MODE mode,bool inherit){
  PACL previous=nullptr,next=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
  DWORD error=GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&previous,nullptr,&descriptor);if(error)return error;
  EXPLICIT_ACCESSW entry{};entry.grfAccessPermissions=rights;entry.grfAccessMode=mode;entry.grfInheritance=inherit?SUB_CONTAINERS_AND_OBJECTS_INHERIT:NO_INHERITANCE;
  entry.Trustee.TrusteeForm=TRUSTEE_IS_SID;entry.Trustee.TrusteeType=TRUSTEE_IS_UNKNOWN;entry.Trustee.ptstrName=static_cast<LPWSTR>(sid);
  error=SetEntriesInAclW(1,&entry,previous,&next);
  if(!error)error=SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,next,nullptr);
  if(next)LocalFree(next);if(descriptor)LocalFree(descriptor);return error;
}
bool Contains(const std::wstring& root,const std::wstring& path){auto r=root,p=path;std::transform(r.begin(),r.end(),r.begin(),towlower);std::transform(p.begin(),p.end(),p.begin(),towlower);return p==r||(p.size()>r.size()&&p.compare(0,r.size(),r)==0&&p[r.size()]==L'\\');}
}
DWORD ScopedResources::Provision(const LaunchDescriptor& d,const std::vector<std::wstring>& readonly_roots,const std::wstring& authorization){
  std::lock_guard lock(mutex_);
  if(sid_||authorization.empty()||authorization.size()>200||readonly_roots.empty()||readonly_roots.size()>16)return ERROR_ACCESS_DENIED;
  DWORD error=ValidateDescriptor(d);if(error)return error;
  if((error=SafeTree(d.workspace))||(error=SafeTree(d.scratch)))return error;
  bool node_covered=false,worker_covered=false;
  for(const auto& root:readonly_roots){if((error=SafeTree(root)))return error;if(Contains(root,d.workspace)||Contains(root,d.scratch)||Contains(d.workspace,root)||Contains(d.scratch,root))return ERROR_ACCESS_DENIED;node_covered|=Contains(root,d.node_executable);worker_covered|=Contains(root,d.worker_entry);}
  if(!node_covered||!worker_covered)return ERROR_ACCESS_DENIED;
  profile_=d.profile_name;const HRESULT created=CreateAppContainerProfile(profile_.c_str(),profile_.c_str(),L"pi-kanban generation-scoped Worker",nullptr,0,&sid_);
  if(FAILED(created))return HRESULT_CODE(created); // Never reuse an old identity or its mutable grants.
  const auto grant=[&](const std::wstring& path,DWORD rights,ACCESS_MODE mode,bool inherit){const DWORD result=Edit(path,sid_,rights,mode,inherit);if(!result){changed_.push_back(path);if(inherit)recursive_.insert(path);}return result;};
  for(const auto& root:readonly_roots)if((error=grant(root,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,GRANT_ACCESS,true)))return error;
  if((error=grant(d.workspace,FILE_GENERIC_READ|(d.role==L"implementation"?FILE_GENERIC_WRITE:0),GRANT_ACCESS,true)))return error;
  if((error=grant(d.scratch,FILE_ALL_ACCESS,GRANT_ACCESS,true)))return error;
  for(const auto* name:{L".git",L".local"}){const auto internal=(fs::path(d.workspace)/name).wstring();if(GetFileAttributesW(internal.c_str())!=INVALID_FILE_ATTRIBUTES&&
      (error=grant(internal,FILE_ALL_ACCESS,DENY_ACCESS,true)))return error;}
  // Traverse only ancestors; no enumeration or content permission on parent directories.
  std::vector<std::wstring> roots=readonly_roots;roots.push_back(d.workspace);roots.push_back(d.scratch);
  for(const auto& root:roots){auto parent=fs::path(root).parent_path();while(parent!=parent.root_path()&&!parent.empty()){
    if(std::find(changed_.begin(),changed_.end(),parent.wstring())==changed_.end()&&(error=grant(parent.wstring(),FILE_TRAVERSE,GRANT_ACCESS,false)))return error;
    parent=parent.parent_path();}}
  return ERROR_SUCCESS;
}
DWORD ScopedResources::Revoke(){
  std::lock_guard lock(mutex_);if(profile_.empty()||!sid_)return ERROR_SUCCESS;
  DWORD first=ERROR_SUCCESS;
  for(auto it=changed_.rbegin();it!=changed_.rend();++it){const DWORD attrs=GetFileAttributesW(it->c_str());if(attrs==INVALID_FILE_ATTRIBUTES){if(!first)first=GetLastError();continue;}if(attrs&FILE_ATTRIBUTE_REPARSE_POINT){if(!first)first=ERROR_REPARSE_TAG_INVALID;continue;}
    if(recursive_.contains(*it)){const DWORD safe=SafeTree(*it);if(safe){if(!first)first=safe;continue;}}
    const DWORD result=Edit(*it,sid_,0,REVOKE_ACCESS,false);if(result&&!first)first=result;}
  if(!first){changed_.clear();const HRESULT deleted=DeleteAppContainerProfile(profile_.c_str());if(FAILED(deleted))first=HRESULT_CODE(deleted);else profile_.clear();}
  return first;
}
ScopedResources::~ScopedResources(){if(sid_)FreeSid(sid_);}
}
#endif
