#include "dirigible/pty_client.hpp"
#include "dirigible/state.hpp"
#include "cJSON.h"
#include <cstring>

namespace dirigible {

PTYClient::PTYClient(ITransportFactory* factory,
                     const std::string& host, int port, int pty_id,
                     const std::string& token)
    : host_(host), port_(port), pty_id_(pty_id), token_(token) {
    ws_ = factory->createWebSocket(5000);
}

PTYClient::~PTYClient() {
    disconnect();
    delete ws_;
}

void PTYClient::connect() {
    std::string url = "ws://" + host_ + ":" + std::to_string(port_)
                    + "/pty/" + std::to_string(pty_id_) + "/stream";
    if (!token_.empty()) {
        url += "?token=" + token_;
    }

    ws_->onMessage([this](cJSON* msg) {
        // PTY stream messages:
        //   { "type": "data", "data": "..." }
        //   { "type": "exit", "code": N }
        cJSON* type_item = cJSON_GetObjectItemCaseSensitive(msg, "type");
        if (!type_item || !cJSON_IsString(type_item)) return;

        if (strcmp(type_item->valuestring, "data") == 0) {
            cJSON* data_item = cJSON_GetObjectItemCaseSensitive(msg, "data");
            if (data_item && cJSON_IsString(data_item) && data_item->valuestring) {
                size_t len = strlen(data_item->valuestring);
                auto* bytes = reinterpret_cast<const uint8_t*>(data_item->valuestring);
                if (on_data_) {
                    on_data_(bytes, len);
                }
                EventBus::instance().emitPtyData(pty_id_, bytes, len);
            }
        } else if (strcmp(type_item->valuestring, "exit") == 0) {
            cJSON* code_item = cJSON_GetObjectItemCaseSensitive(msg, "code");
            int code = code_item ? code_item->valueint : -1;
            if (on_exit_) {
                on_exit_(code);
            }
        }
    });

    ws_->connect(url);
}

void PTYClient::disconnect() {
    if (ws_) {
        ws_->disconnect();
    }
}

bool PTYClient::isConnected() const {
    return ws_ && ws_->isConnected();
}

void PTYClient::onData(DataCallback cb) {
    on_data_ = std::move(cb);
}

void PTYClient::onExit(ExitCallback cb) {
    on_exit_ = std::move(cb);
}

void PTYClient::sendInput(const char* data, size_t len) {
    if (ws_ && ws_->isConnected()) {
        ws_->sendText(std::string(data, len));
    }
}

void PTYClient::sendInput(const std::string& text) {
    if (ws_ && ws_->isConnected()) {
        ws_->sendText(text);
    }
}

void PTYClient::sendResize(int cols, int rows) {
    if (!ws_ || !ws_->isConnected()) return;

    cJSON* msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "type", "resize");
    cJSON_AddNumberToObject(msg, "cols", cols);
    cJSON_AddNumberToObject(msg, "rows", rows);
    ws_->sendJson(msg);
}

}  // namespace dirigible
