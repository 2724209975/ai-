#include "receive_policy.h"
#include <iostream>
#include <stdexcept>
using p4_receive::Action;
void Check(bool value) { if (!value) throw std::runtime_error("failed"); }
const std::string token(64, 'a');
Action Call(p4_receive::Policy& policy, std::string path = "/api/p4ReceiveStatus", uint64_t now = 0,
            std::string auth = "Bearer " + token, std::string method = "POST", bool origin = false,
            std::string body = "{}") {
  return policy.Authorize(method, path, auth, origin, body, now);
}
void Run(const std::string& name) {
  p4_receive::Policy policy(token, "fixture_peer", 0);
  if (name == "routes") {
    Check(Call(policy) == Action::Status);
    Check(Call(policy, "/api/checkLogin") == Action::Login);
    Check(Call(policy, "/api/hookSyncMsg") == Action::Hook);
    Check(Call(policy, "/api/unhookSyncMsg") == Action::Unhook);
    for (const char* route : {"/api/sendTextMsg", "/api/execSql", "/api/getVoiceByMsgId", "/api/getDBInfo",
                              "/api/getUserInfo", "/websocket/x", "/api/p4ReceiveStatus?x=1"})
      Check(Call(policy, route) == Action::Deny);
  } else if (name == "credentials") {
    Check(Call(policy, "/api/hookSyncMsg", 0, "Bearer " + std::string(64, 'b')) == Action::Deny);
    Check(Call(policy, "/api/hookSyncMsg", 0, "bearer " + token) == Action::Deny);
    Check(Call(policy, "/api/hookSyncMsg", 0, "Bearer " + token + " ") == Action::Deny);
    Check(Call(policy, "/api/hookSyncMsg", 0, "") == Action::Deny);
    Check(Call(policy, "/api/hookSyncMsg") == Action::Hook);
  } else if (name == "protocol") {
    Check(Call(policy, "/api/hookSyncMsg", 0, "Bearer " + token, "GET") == Action::Deny);
    Check(Call(policy, "/api/hookSyncMsg", 0, "Bearer " + token, "POST", true) == Action::Deny);
    for (const char* body : {"", "{ }", "{\"msgId\":1}", "PRIVATE_CONTENT"})
      Check(Call(policy, "/api/hookSyncMsg", 0, "Bearer " + token, "POST", false, body) == Action::Deny);
  } else if (name == "invalid-configuration") {
    for (const std::string& secret : {std::string(""), std::string(63, 'a'), std::string(64, 'g')}) {
      p4_receive::Policy invalid(secret, "fixture_peer", 0); Check(Call(invalid) == Action::Deny);
    }
    for (const char* peer : {"", "group@chatroom", "a\nb", "../secret"}) {
      p4_receive::Policy invalid(token, peer, 0); Check(Call(invalid) == Action::Deny);
    }
  } else if (name == "rate-unhook") {
    for (int i = 0; i < 10; ++i) Check(Call(policy) == Action::Status);
    Check(Call(policy, "/api/hookSyncMsg") == Action::Deny);
    Check(Call(policy, "/api/unhookSyncMsg") == Action::Unhook);
    Check(Call(policy, "/api/hookSyncMsg", 1000) == Action::Hook);
  } else if (name == "total-unhook") {
    for (uint64_t i = 0; i < 64; ++i) Check(Call(policy, "/api/p4ReceiveStatus", i * 1000) == Action::Status);
    Check(Call(policy, "/api/p4ReceiveStatus", 65000) == Action::Deny);
    Check(Call(policy, "/api/unhookSyncMsg", 65000) == Action::Unhook);
  } else if (name == "expired-unhook") {
    Check(Call(policy, "/api/hookSyncMsg", 599999) == Action::Hook);
    Check(Call(policy, "/api/hookSyncMsg", 600000) == Action::Deny);
    Check(Call(policy, "/api/p4ReceiveStatus", 600000) == Action::Status);
    Check(Call(policy, "/api/unhookSyncMsg", 600000) == Action::Unhook);
    p4_receive::Policy future(token, "fixture_peer", 1000);
    Check(Call(future, "/api/hookSyncMsg", 999) == Action::Deny);
  } else if (name == "peer-filter") {
    policy.Observe("another_peer", 34, "9007199254740993", 0);
    Check(policy.Get(0).voice == 0 && policy.Get(0).latest_voice_id.empty());
    policy.Observe("fixture_peer", 1, "1", 0); policy.Observe("fixture_peer", 3, "2", 0);
    policy.Observe("fixture_peer", 34, "9007199254740993", 0); policy.Observe("fixture_peer", 47, "4", 0);
    const auto result = policy.Get(0);
    Check(result.text == 1 && result.image == 1 && result.voice == 1 && result.other == 1);
    Check(result.latest_voice_id == "9007199254740993");
    policy.Observe("fixture_peer", 34, "18446744073709551615", 0);
    Check(policy.Get(0).voice == 2 && policy.Get(0).latest_voice_id.empty());
  } else if (name == "capture-bounds") {
    for (int i = 0; i < 17; ++i) policy.Observe("fixture_peer", 34, "1", 0);
    Check(policy.Get(0).voice == 16 && policy.Get(0).message_limit);
    p4_receive::Policy expired(token, "fixture_peer", 0);
    expired.Observe("fixture_peer", 34, "1", 600000);
    Check(expired.Get(600000).voice == 0 && expired.Get(600000).expired);
  } else throw std::runtime_error("unknown");
}
int main(int argc, char** argv) {
  try { Check(argc == 2); Run(argv[1]); std::cout << "PASS\n"; return 0; }
  catch (...) { std::cerr << "P4_POLICY_CHECK_FAILED\n"; return 1; }
}
