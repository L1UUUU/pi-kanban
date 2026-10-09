#pragma once
#include "launcher.hpp"
#include "json.hpp"
#ifdef _WIN32
#include <bcrypt.h>
#include <filesystem>
namespace pi_kanban {
// Only the trusted helper owns this secret/path. Never inherit or forward it to
// the sandbox. Caller must first confirm actual Job zero and successful revoke.
inline DWORD WriteRecoveryReceipt(const Json& launch,const ProcessIdentity& identity,DWORD reason=ERROR_SUCCESS,bool never_created=false) {
  const auto path=launch.at(L"recoveryReceiptPath").str(),key=launch.at(L"recoveryKey").str(),context=launch.at(L"recoveryContextSha256").str();
  if(path.empty()&&key.empty()&&context.empty())return ERROR_SUCCESS;
  if(key.size()!=64||context.size()!=64||path.size()<4||path[1]!=L':'||path[2]!=L'\\'||(!identity.pid&&!never_created))return ERROR_INVALID_PARAMETER;
  std::array<unsigned char,32> secret{};
  for(size_t i=0;i<64;i++){const wchar_t c=key[i];if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f')))return ERROR_INVALID_PARAMETER;const unsigned value=c>=L'a'?c-L'a'+10:c-L'0';secret[i/2]=static_cast<unsigned char>((secret[i/2]<<4)|value);const wchar_t d=context[i];if(!((d>=L'0'&&d<=L'9')||(d>=L'a'&&d<=L'f')))return ERROR_INVALID_PARAMETER;}
  for(auto current=std::filesystem::path(path).parent_path();!current.empty();current=current.parent_path()){const DWORD attributes=GetFileAttributesW(current.c_str());if(attributes==INVALID_FILE_ATTRIBUTES)return GetLastError();if(attributes&FILE_ATTRIBUTE_REPARSE_POINT)return ERROR_REPARSE_TAG_INVALID;if(current==current.root_path())break;}
  const uint64_t birth=(static_cast<uint64_t>(identity.creation_time.dwHighDateTime)<<32)|identity.creation_time.dwLowDateTime;
  const std::string payload="{\"version\":1,\"generation\":"+ToUtf8(JsonString(identity.generation.empty()?launch.at(L"generation").str():identity.generation))+",\"pid\":"+(never_created?"null":std::to_string(identity.pid))+",\"birth\":"+(never_created?std::string("null"):"\""+std::to_string(birth)+"\"")+",\"contextSha256\":"+ToUtf8(JsonString(context))+",\"stopConfirmed\":true,\"resourcesRevoked\":true,\"activeProcesses\":0,\"neverCreated\":"+(never_created?"true":"false")+",\"terminationStatus\":"+std::to_string(reason)+"}";
  BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
  NTSTATUS status=BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,BCRYPT_ALG_HANDLE_HMAC_FLAG);
  if(status<0)return ERROR_INVALID_FUNCTION;
  status=BCryptCreateHash(algorithm,&hash,nullptr,0,secret.data(),static_cast<ULONG>(secret.size()),0);
  const char prefix[]="pi-kanban.native-stop-receipt.v1";
  if(status>=0)status=BCryptHashData(hash,reinterpret_cast<PUCHAR>(const_cast<char*>(prefix)),sizeof(prefix),0);
  if(status>=0)status=BCryptHashData(hash,reinterpret_cast<PUCHAR>(const_cast<char*>(payload.data())),static_cast<ULONG>(payload.size()),0);
  std::array<unsigned char,32> mac{};if(status>=0)status=BCryptFinishHash(hash,mac.data(),static_cast<ULONG>(mac.size()),0);
  if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);SecureZeroMemory(secret.data(),secret.size());if(status<0)return ERROR_INVALID_DATA;
  const char hex[]="0123456789abcdef";std::string signature;for(const auto byte:mac){signature+=hex[byte>>4];signature+=hex[byte&15];}
  const std::string envelope="{\"payload\":"+ToUtf8(JsonString(FromUtf8(payload)))+",\"mac\":\""+signature+"\"}";
  const auto temporary=path+L"."+std::to_wstring(GetCurrentProcessId())+L".tmp";
  HANDLE file=CreateFileW(temporary.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_WRITE_THROUGH|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(file==INVALID_HANDLE_VALUE)return GetLastError();DWORD written=0;const bool saved=!!WriteFile(file,envelope.data(),static_cast<DWORD>(envelope.size()),&written,nullptr)&&written==envelope.size()&&!!FlushFileBuffers(file);const DWORD error=saved?ERROR_SUCCESS:GetLastError();CloseHandle(file);
  if(error){DeleteFileW(temporary.c_str());return error;}
  if(!MoveFileExW(temporary.c_str(),path.c_str(),MOVEFILE_WRITE_THROUGH)){const DWORD move_error=GetLastError();DeleteFileW(temporary.c_str());return move_error;}return ERROR_SUCCESS;
}
}
#endif
