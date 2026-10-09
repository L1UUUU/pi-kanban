#pragma once
#ifdef _WIN32
#include <windows.h>
#include <cstdint>
#include <cmath>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
namespace pi_kanban {
struct Json {
  enum class Kind { object, array, string, number, boolean, null_value } kind;
  std::map<std::wstring,Json> fields;std::vector<Json> items;std::wstring text;double number=0;bool boolean=false;
  const Json& at(const std::wstring& key) const {const auto it=fields.find(key);if(kind!=Kind::object||it==fields.end())throw std::runtime_error("missing JSON field");return it->second;}
  std::wstring str()const{if(kind!=Kind::string)throw std::runtime_error("JSON string required");return text;}
  uint64_t num()const{if(kind!=Kind::number||number<0||number>9007199254740991.0||std::floor(number)!=number)throw std::runtime_error("JSON integer required");return static_cast<uint64_t>(number);}
};
inline std::wstring FromUtf8(const std::string& input){int size=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,input.data(),static_cast<int>(input.size()),nullptr,0);if(!size)throw std::runtime_error("invalid UTF8");std::wstring output(static_cast<size_t>(size),L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,input.data(),static_cast<int>(input.size()),output.data(),size);return output;}
inline std::string ToUtf8(const std::wstring& input){int size=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,input.data(),static_cast<int>(input.size()),nullptr,0,nullptr,nullptr);if(!size&&!input.empty())throw std::runtime_error("invalid Unicode");std::string output(static_cast<size_t>(size),'\0');WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,input.data(),static_cast<int>(input.size()),output.data(),size,nullptr,nullptr);return output;}
class JsonParser {
 std::wstring source_;size_t cursor_=0;
 void space(){while(cursor_<source_.size()&&(source_[cursor_]==L' '||source_[cursor_]==L'\r'||source_[cursor_]==L'\n'||source_[cursor_]==L'\t'))cursor_++;}
 wchar_t next(){if(cursor_>=source_.size())throw std::runtime_error("truncated JSON");return source_[cursor_++];}
 std::wstring string(){if(next()!=L'"')throw std::runtime_error("JSON quote required");std::wstring value;for(;;){wchar_t c=next();if(c==L'"')return value;if(c<L' ')throw std::runtime_error("control in JSON string");if(c!=L'\\'){value+=c;continue;}c=next();switch(c){case L'"':case L'\\':case L'/':value+=c;break;case L'b':value+=L'\b';break;case L'f':value+=L'\f';break;case L'n':value+=L'\n';break;case L'r':value+=L'\r';break;case L't':value+=L'\t';break;case L'u':{unsigned value16=0;for(int i=0;i<4;i++){const auto h=next();value16*=16;if(h>=L'0'&&h<=L'9')value16+=h-L'0';else if(h>=L'a'&&h<=L'f')value16+=10+h-L'a';else if(h>=L'A'&&h<=L'F')value16+=10+h-L'A';else throw std::runtime_error("bad Unicode escape");}value+=static_cast<wchar_t>(value16);break;}default:throw std::runtime_error("invalid JSON escape");}}}
 Json value(unsigned depth){if(depth>32)throw std::runtime_error("JSON depth limit");space();if(cursor_>=source_.size())throw std::runtime_error("missing JSON value");const auto c=source_[cursor_];
  if(c==L'{'){cursor_++;Json out{Json::Kind::object};space();if(cursor_<source_.size()&&source_[cursor_]==L'}'){cursor_++;return out;}for(;;){space();const auto key=string();space();if(next()!=L':')throw std::runtime_error("JSON colon required");if(out.fields.contains(key))throw std::runtime_error("duplicate JSON key");out.fields.emplace(key,value(depth+1));space();const auto end=next();if(end==L'}')return out;if(end!=L',')throw std::runtime_error("JSON comma required");}}
  if(c==L'['){cursor_++;Json out{Json::Kind::array};space();if(cursor_<source_.size()&&source_[cursor_]==L']'){cursor_++;return out;}for(;;){out.items.push_back(value(depth+1));space();const auto end=next();if(end==L']')return out;if(end!=L',')throw std::runtime_error("JSON comma required");}}
  if(c==L'"'){Json out{Json::Kind::string};out.text=string();return out;}
  for(const auto& literal:{std::wstring(L"true"),std::wstring(L"false"),std::wstring(L"null")})if(source_.compare(cursor_,literal.size(),literal)==0){cursor_+=literal.size();Json out{literal==L"null"?Json::Kind::null_value:Json::Kind::boolean};out.boolean=literal==L"true";return out;}
  if(c==L'-'||(c>=L'0'&&c<=L'9')){Json out{Json::Kind::number};const size_t begin=cursor_;if(source_[cursor_]==L'-')cursor_++;if(cursor_>=source_.size())throw std::runtime_error("bad JSON number");if(source_[cursor_]==L'0')cursor_++;else{if(source_[cursor_]<L'1'||source_[cursor_]>L'9')throw std::runtime_error("bad JSON number");while(cursor_<source_.size()&&source_[cursor_]>=L'0'&&source_[cursor_]<=L'9')cursor_++;}if(cursor_<source_.size()&&source_[cursor_]==L'.'){cursor_++;const auto digits=cursor_;while(cursor_<source_.size()&&source_[cursor_]>=L'0'&&source_[cursor_]<=L'9')cursor_++;if(cursor_==digits)throw std::runtime_error("bad JSON fraction");}if(cursor_<source_.size()&&(source_[cursor_]==L'e'||source_[cursor_]==L'E')){cursor_++;if(cursor_<source_.size()&&(source_[cursor_]==L'+'||source_[cursor_]==L'-'))cursor_++;const auto digits=cursor_;while(cursor_<source_.size()&&source_[cursor_]>=L'0'&&source_[cursor_]<=L'9')cursor_++;if(cursor_==digits)throw std::runtime_error("bad JSON exponent");}out.text=source_.substr(begin,cursor_-begin);out.number=std::stod(out.text);if(!std::isfinite(out.number))throw std::runtime_error("nonfinite JSON");return out;}
  throw std::runtime_error("invalid JSON value");
 }
 public:explicit JsonParser(const std::string& input):source_(FromUtf8(input)){}Json parse(){auto out=value(0);space();if(cursor_!=source_.size())throw std::runtime_error("trailing JSON data");return out;}
};
inline std::wstring JsonString(const std::wstring& input){std::wstring out=L"\"";const wchar_t* hex=L"0123456789abcdef";for(auto c:input){if(c==L'"'||c==L'\\'){out+=L'\\';out+=c;}else if(c<L' '){out+=L"\\u00";out+=hex[(c>>4)&15];out+=hex[c&15];}else out+=c;}return out+L"\"";}
inline std::wstring Serialize(const Json& value){switch(value.kind){case Json::Kind::string:return JsonString(value.text);case Json::Kind::number:return value.text;case Json::Kind::boolean:return value.boolean?L"true":L"false";case Json::Kind::null_value:return L"null";case Json::Kind::array:{std::wstring out=L"[";for(const auto& item:value.items){if(out.size()>1)out+=L",";out+=Serialize(item);}return out+L"]";}case Json::Kind::object:{std::wstring out=L"{";for(const auto& pair:value.fields){if(out.size()>1)out+=L",";out+=JsonString(pair.first)+L":"+Serialize(pair.second);}return out+L"}";}}throw std::runtime_error("unknown JSON type");}
}
#endif
