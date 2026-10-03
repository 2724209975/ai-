#ifndef CHAT_AGENT_RECEIVE_ENDPOINT_H
#define CHAT_AGENT_RECEIVE_ENDPOINT_H
#include <cstdint>
#include <string>
struct mg_connection;
struct mg_http_message;
namespace p4_receive {
void Handle(struct mg_connection* connection, struct mg_http_message* message);
void Observe(const std::string& from, uint32_t type, const std::string& id);
}
#endif
