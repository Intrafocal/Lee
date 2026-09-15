#include "dirigible/hester_client.hpp"
#include "cJSON.h"
#include <cstring>

namespace dirigible {

HesterClient::HesterClient(ITransportFactory* factory,
                            const std::string& host, int port)
    : factory_(factory), host_(host), port_(port) {
    http_ = factory_->createHttpClient(0);  // 0 = no timeout for SSE streams
}

HesterClient::~HesterClient() {
    delete http_;
}

void HesterClient::send(const std::string& message,
                         const std::string& session_id,
                         const std::string& source) {
    if (!http_) return;

    // Build request body: { session_id, source, message }
    cJSON* body = cJSON_CreateObject();
    if (!session_id.empty()) {
        cJSON_AddStringToObject(body, "session_id", session_id.c_str());
    }
    cJSON_AddStringToObject(body, "source", source.c_str());
    cJSON_AddStringToObject(body, "message", message.c_str());

    std::string url = "http://" + host_ + ":" + std::to_string(port_)
                    + "/context/stream";

    http_->postSSE(url, body,
        [this](const std::string& event, const std::string& data) {
            handleEvent(event, data);
        },
        [this](bool ok) {
            if (on_done_) on_done_(ok);
        });
}

void HesterClient::handleEvent(const std::string& event, const std::string& data) {
    // Hester events:
    //   event: phase    data: {"phase": "thinking", "iteration": 1}
    //   event: response data: {"session_id": "...", "text": "..."}
    //   event: error    data: {"message": "..."}
    //   event: done     data: {}

    cJSON* json = cJSON_Parse(data.c_str());

    if (event == "phase") {
        std::string phase_name;
        std::string detail;
        if (json) {
            cJSON* p = cJSON_GetObjectItemCaseSensitive(json, "phase");
            if (p && cJSON_IsString(p)) phase_name = p->valuestring;

            cJSON* tn = cJSON_GetObjectItemCaseSensitive(json, "tool_name");
            if (tn && cJSON_IsString(tn)) detail = tn->valuestring;
        }
        if (on_phase_) on_phase_(parsePhase(phase_name), detail);

    } else if (event == "response") {
        std::string text;
        if (json) {
            cJSON* t = cJSON_GetObjectItemCaseSensitive(json, "text");
            if (t && cJSON_IsString(t)) text = t->valuestring;
            // Some payloads use "content" instead
            if (text.empty()) {
                cJSON* c = cJSON_GetObjectItemCaseSensitive(json, "content");
                if (c && cJSON_IsString(c)) text = c->valuestring;
            }
        }
        if (on_response_) on_response_(text);

    } else if (event == "error") {
        std::string msg;
        if (json) {
            cJSON* m = cJSON_GetObjectItemCaseSensitive(json, "message");
            if (m && cJSON_IsString(m)) msg = m->valuestring;
        }
        if (on_error_) on_error_(msg);

    } else if (event == "done") {
        // The done callback is also fired by postSSE itself when the stream
        // ends, so this branch is mostly informational.
    }

    if (json) cJSON_Delete(json);
}

HesterPhase HesterClient::parsePhase(const std::string& name) {
    if (name == "preparing")  return HesterPhase::Preparing;
    if (name == "thinking")   return HesterPhase::Thinking;
    if (name == "acting")     return HesterPhase::Acting;
    if (name == "observing")  return HesterPhase::Observing;
    if (name == "responding") return HesterPhase::Responding;
    return HesterPhase::Unknown;
}

}  // namespace dirigible
