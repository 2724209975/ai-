// Synthetic data only. This executable never loads WeChat or wxhelper.
#include "voice_candidate.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

using voice_candidate::Status;
using voice_candidate::Read;
void Check(bool ok) { if (!ok) throw std::runtime_error("assertion failed"); }

struct Fixture {
  int prepare_code = 0, first = 100, second = 101, columns = 1;
  int type = 4, length = 4, final_code = 0;
  bool null_pointer = false, partial_prepare = false, null_statement = false;
  bool changed_length = false, throw_copy = false;
  std::string bytes = std::string("\0\xff\0\x7f", 4), sql;
  int prepared = 0, stepped = 0, finalized = 0, blob_read = 0, length_read = 0;
} fixture;
void Reset() { fixture = Fixture{}; }
struct FakeApi {
  int sqlite3_prepare(uint64_t, const char* sql, int, uint64_t** stmt, const char**) {
    ++fixture.prepared; fixture.sql = sql;
    if ((!fixture.prepare_code || fixture.partial_prepare) && !fixture.null_statement)
      *stmt = reinterpret_cast<uint64_t*>(1);
    return fixture.prepare_code;
  }
  int sqlite3_step(uint64_t*) { return ++fixture.stepped % 2 == 1 ? fixture.first : fixture.second; }
  int sqlite3_column_count(uint64_t*) { return fixture.columns; }
  int sqlite3_column_type(uint64_t*, int) { return fixture.type; }
  int sqlite3_column_bytes(uint64_t*, int) {
    return ++fixture.length_read > 1 && fixture.changed_length ? fixture.length + 1 : fixture.length;
  }
  const void* sqlite3_column_blob(uint64_t*, int) {
    ++fixture.blob_read;
    if (fixture.throw_copy) throw std::bad_alloc();
    return fixture.null_pointer ? nullptr : fixture.bytes.data();
  }
  int sqlite3_finalize(uint64_t*) { ++fixture.finalized; return fixture.final_code; }
};

voice_candidate::Result FakeRead(std::string id = "9007199254740993",
                                 std::vector<uint64_t> handles = {1}) {
  FakeApi api; return Read(api, handles, id);
}
void Failure(Status status) {
  const auto result = FakeRead(); Check(result.status == status && result.bytes.empty());
  Check(fixture.finalized == 1);
}

// Signatures mirror the fixed helper's SqliteFunction on 64-bit hosts.
struct RealApi {
  int (*sqlite3_prepare)(uint64_t, const char*, int, uint64_t**, const char**);
  int (*sqlite3_step)(uint64_t*);
  int (*sqlite3_column_count)(uint64_t*);
  int (*sqlite3_column_type)(uint64_t*, int);
  int (*sqlite3_column_bytes)(uint64_t*, int);
  const void* (*sqlite3_column_blob)(uint64_t*, int);
  int (*sqlite3_finalize)(uint64_t*);
  int (*open)(const char*, uint64_t**);
  int (*close)(uint64_t*);
  int (*exec)(uint64_t, const char*, void*, void*, void*);
#ifdef _WIN32
  HMODULE library;
  void* Symbol(const char* name) { return reinterpret_cast<void*>(GetProcAddress(library, name)); }
#else
  void* library;
  void* Symbol(const char* name) { return dlsym(library, name); }
#endif
  template<class T> void Load(T& pointer, const char* name) {
    pointer = reinterpret_cast<T>(Symbol(name)); Check(pointer != nullptr);
  }
  RealApi() {
    static_assert(sizeof(void*) == sizeof(uint64_t), "64-bit only");
#ifdef _WIN32
    library = LoadLibraryExW(L"winsqlite3.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
#elif defined(__APPLE__)
    library = dlopen("/usr/lib/libsqlite3.dylib", RTLD_NOW | RTLD_LOCAL);
#else
    library = dlopen("libsqlite3.so.0", RTLD_NOW | RTLD_LOCAL);
#endif
    Check(library != nullptr);
    Load(sqlite3_prepare, "sqlite3_prepare_v2"); Load(sqlite3_step, "sqlite3_step");
    Load(sqlite3_column_count, "sqlite3_column_count"); Load(sqlite3_column_type, "sqlite3_column_type");
    Load(sqlite3_column_bytes, "sqlite3_column_bytes"); Load(sqlite3_column_blob, "sqlite3_column_blob");
    Load(sqlite3_finalize, "sqlite3_finalize"); Load(open, "sqlite3_open");
    Load(close, "sqlite3_close"); Load(exec, "sqlite3_exec");
  }
  ~RealApi() {
#ifdef _WIN32
    FreeLibrary(library);
#else
    dlclose(library);
#endif
  }
};
struct Database {
  RealApi& api; uint64_t* pointer = nullptr;
  explicit Database(RealApi& a) : api(a) { Check(api.open(":memory:", &pointer) == 0); }
  uint64_t Handle() const { return reinterpret_cast<uint64_t>(pointer); }
  void Sql(const char* sql) { Check(api.exec(Handle(), sql, nullptr, nullptr, nullptr) == 0); }
  void Close() { Check(api.close(pointer) == 0); pointer = nullptr; }
  ~Database() { if (pointer) api.close(pointer); }
};

void RealCase(const std::string& name) {
  RealApi api; Database a(api), b(api);
  a.Sql("CREATE TABLE Media (Reserved0 INTEGER, Buf);");
  b.Sql("CREATE TABLE Media (Reserved0 INTEGER, Buf);");
  const std::vector<uint64_t> handles{a.Handle(), b.Handle()};
  const std::string id = "9007199254740993";
  if (name == "sqlite-empty") {
    Check(Read(api, handles, id).status == Status::NotFound);
  } else if (name == "sqlite-binary") {
    a.Sql("INSERT INTO Media VALUES (9007199254740992, X'99');");
    b.Sql("INSERT INTO Media VALUES (9007199254740993, X'00FF007F');");
    const auto result = Read(api, handles, id);
    Check(result.status == Status::Ok && result.bytes == std::string("\0\xff\0\x7f", 4));
  } else if (name == "sqlite-int64") {
    a.Sql("INSERT INTO Media VALUES (9223372036854775807, X'FF00');");
    Check(Read(api, handles, "9223372036854775807").bytes == std::string("\xff\0", 2));
    Check(Read(api, handles, "9223372036854775808").status == Status::InvalidId);
  } else if (name == "sqlite-types") {
    for (const char* value : {"NULL", "'text'", "123", "1.5", "X''"}) {
      a.Sql("DELETE FROM Media;");
      a.Sql((std::string("INSERT INTO Media VALUES (9007199254740993,") + value + ");").c_str());
      const auto result = Read(api, handles, id);
      Check(result.status == Status::InvalidBlob && result.bytes.empty());
    }
  } else if (name == "sqlite-size") {
    a.Sql("INSERT INTO Media VALUES (9007199254740993, zeroblob(2097152));");
    Check(Read(api, handles, id).bytes.size() == voice_candidate::kMaxBytes);
    a.Sql("UPDATE Media SET Buf = zeroblob(2097153);");
    Check(Read(api, handles, id).status == Status::TooLarge);
  } else if (name == "sqlite-ambiguous") {
    a.Sql("INSERT INTO Media VALUES (9007199254740993, X'01'), (9007199254740993, X'02');");
    Check(Read(api, handles, id).status == Status::Ambiguous);
    a.Sql("DELETE FROM Media; INSERT INTO Media VALUES (9007199254740993, X'01');");
    b.Sql("INSERT INTO Media VALUES (9007199254740993, X'01');");
    Check(Read(api, handles, id).status == Status::Ambiguous);
  } else if (name == "sqlite-error-after-match") {
    a.Sql("INSERT INTO Media VALUES (9007199254740993, X'01');");
    b.Sql("DROP TABLE Media;");
    const auto result = Read(api, handles, id);
    Check(result.status == Status::QueryFailed && result.bytes.empty());
  } else throw std::runtime_error("unknown case");
  // SQLITE_BUSY here would expose an unfinalized prepared statement.
  a.Close(); b.Close();
}

void Run(const std::string& name) {
  Reset();
  if (name.rfind("sqlite-", 0) == 0) { RealCase(name); return; }
  if (name == "legacy-row-boundary") {
    std::vector<std::vector<std::string>> result{{"Buf"}};
    bool legacy_failed = false;
    try { (void)result.at(1).at(0); } catch (const std::out_of_range&) { legacy_failed = true; }
    Check(legacy_failed); fixture.first = 101; Failure(Status::NotFound);
  } else if (name == "id-validation") {
    for (const char* id : {"", "0", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ",
                          "1;DROP TABLE Media", "9223372036854775808", "18446744073709551615"}) {
      const auto r = FakeRead(id); Check(r.status == Status::InvalidId && r.bytes.empty());
    }
    Check(fixture.prepared == 0);
    Check(FakeRead("9223372036854775807").status == Status::Ok);
    Check(fixture.sql == "SELECT Buf FROM Media WHERE Reserved0=9223372036854775807 LIMIT 2;");
  } else if (name == "handles-validation") {
    for (auto h : {std::vector<uint64_t>{}, {0}, {1, 1}, std::vector<uint64_t>(65, 1)}) {
      Check(FakeRead("1", h).status == Status::InvalidHandles);
    }
    Check(fixture.prepared == 0);
    fixture.first = 101;
    std::vector<uint64_t> maximum;
    for (uint64_t i = 1; i <= 64; ++i) maximum.push_back(i);
    Check(FakeRead("1", maximum).status == Status::NotFound && fixture.finalized == 64);
  } else if (name == "binary-all-values") {
    fixture.bytes.clear(); for (int i = 0; i < 256; ++i) fixture.bytes.push_back(static_cast<char>(i));
    fixture.length = 256; Check(FakeRead().bytes == fixture.bytes);
  } else if (name == "empty-results") {
    fixture.first = 101; Failure(Status::NotFound);
  } else if (name == "prepare-failure") {
    fixture.prepare_code = 1; Check(FakeRead().status == Status::QueryFailed);
    Check(fixture.finalized == 0);
    fixture.partial_prepare = true; Failure(Status::QueryFailed);
    Reset(); fixture.null_statement = true; Check(FakeRead().status == Status::QueryFailed);
    Check(fixture.finalized == 0);
  } else if (name == "step-failure") {
    for (int code : {1, 5, 7, 9, 11}) { Reset(); fixture.first = code; Failure(Status::QueryFailed); }
    Reset(); fixture.second = 5; Failure(Status::QueryFailed);
  } else if (name == "finalize-failure") {
    fixture.final_code = 5; Failure(Status::QueryFailed);
  } else if (name == "column-boundary") {
    for (int count : {0, 2, -1}) { Reset(); fixture.columns = count; Failure(Status::InvalidShape); }
  } else if (name == "blob-type-boundary") {
    for (int type : {1, 2, 3, 5}) { Reset(); fixture.type = type; Failure(Status::InvalidBlob); }
  } else if (name == "blob-length-boundary") {
    for (int size : {0, -1}) { Reset(); fixture.length = size; Failure(Status::InvalidBlob); }
    Reset(); fixture.length = 2097153; Failure(Status::TooLarge); Check(fixture.blob_read == 0);
    Reset(); fixture.null_pointer = true; Failure(Status::InvalidBlob);
    Reset(); fixture.changed_length = true; Failure(Status::InvalidBlob);
    Reset(); fixture.throw_copy = true; Failure(Status::QueryFailed);
  } else if (name == "duplicate-results") {
    fixture.second = 100; Failure(Status::Ambiguous);
    Reset(); Check(FakeRead("1", {1, 2}).status == Status::Ambiguous && fixture.finalized == 2);
  } else if (name == "database-names") {
    for (const wchar_t* value : {L"MediaMSG0.db", L"MediaMSG1.db", L"MediaMSG9999999999.db"})
      Check(voice_candidate::IsMediaDatabaseName(value));
    for (const wchar_t* value : {L"MSG0.db", L"MediaMSG.db", L"MediaMSG01.db", L"MediaMSG-1.db",
                                 L"MediaMSG0.db.bak", L"mediaMSG0.db", L"MediaMSG99999999999.db"})
      Check(!voice_candidate::IsMediaDatabaseName(value));
  } else throw std::runtime_error("unknown case");
}
int main(int argc, char** argv) {
  try { Check(argc == 2); Run(argv[1]); std::cout << "PASS\n"; return 0; }
  catch (...) { std::cerr << "OFFLINE_CHECK_FAILED\n"; return 1; }
}
