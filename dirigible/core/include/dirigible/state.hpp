#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace dirigible {

// ---------------------------------------------------------------------------
// Event system — simple callback-based event bus
// ---------------------------------------------------------------------------

enum class Event {
    ContextUpdated,     // LeeContext changed on active machine
    ConnectionChanged,  // WS connect/disconnect on active machine
    MachineSwitched,    // active machine changed
    MachineOnline,      // a machine came online
    MachineOffline,     // a machine went offline
};

class EventBus {
public:
    using Callback = std::function<void()>;
    using PtyCallback = std::function<void(int pty_id, const uint8_t* data, size_t len)>;

    static EventBus& instance();

    // Subscribe to events
    void on(Event event, Callback cb);
    void onPtyData(PtyCallback cb);

    // Emit events (called by core internals)
    void emit(Event event);
    void emitPtyData(int pty_id, const uint8_t* data, size_t len);

private:
    EventBus() = default;

    struct EventSlot {
        Event event;
        Callback cb;
    };
    std::vector<EventSlot> listeners_;
    std::vector<PtyCallback> pty_listeners_;
};

}  // namespace dirigible
