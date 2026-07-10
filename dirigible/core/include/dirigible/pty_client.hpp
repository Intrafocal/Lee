#pragma once

#include "dirigible/transport.hpp"
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

namespace dirigible {

// ---------------------------------------------------------------------------
// PTYClient — WebSocket subscriber for a single PTY stream
//
// Connects to ws://{host}:{port}/pty/{id}/stream?token={token}
// Receives PTY output, sends keyboard input upstream.
// ---------------------------------------------------------------------------

class PTYClient {
public:
    using DataCallback = std::function<void(const uint8_t* data, size_t len)>;
    using ExitCallback = std::function<void(int exit_code)>;

    PTYClient(ITransportFactory* factory,
              const std::string& host, int port, int pty_id,
              const std::string& token = "");
    ~PTYClient();

    void connect();
    void disconnect();
    bool isConnected() const;

    // Receive PTY output
    void onData(DataCallback cb);
    void onExit(ExitCallback cb);

    // Send keyboard input to PTY
    void sendInput(const char* data, size_t len);
    void sendInput(const std::string& text);

    // Send resize event
    void sendResize(int cols, int rows);

    int ptyId() const { return pty_id_; }

private:
    IWebSocket* ws_ = nullptr;
    std::string host_;
    int port_;
    int pty_id_;
    std::string token_;

    DataCallback on_data_;
    ExitCallback on_exit_;

    int last_cols_ = 0;
    int last_rows_ = 0;  // re-asserted on every (re)connect
};

}  // namespace dirigible
