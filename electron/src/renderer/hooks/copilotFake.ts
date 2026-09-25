/**
 * Dev-only canned CopilotAPI, so lee-ui can be built and eyeballed before
 * lee-core/lee-queue-hooks are merged. Enabled with
 * `localStorage.setItem('copilotFake', '1')` in a dev build only
 * (see useCopilot.ts). Never imported in production.
 */

import type {
  ActionResult,
  AttentionItem,
  AttentionSnapshot,
  AwayState,
  CaptureRequest,
  CaptureResult,
  CeremonyAction,
  CopilotAPI,
  DeviceInfo,
  FocusItem,
  FocusState,
  HandoffProposals,
  HandoffRequest,
  HandoffResult,
  PresenceState,
  ReplyRequest,
  ReturnInfo,
  SnoozeRequest,
} from '../../shared/copilot';

function now(): string {
  return new Date().toISOString();
}

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60000).toISOString();
}

let version = 1;

function makeItem(partial: Partial<AttentionItem> & Pick<AttentionItem, 'id' | 'kind' | 'title' | 'text'>): AttentionItem {
  version += 1;
  return {
    version,
    severity: 'needs-you',
    state: 'open',
    parked: false,
    wake: false,
    notify: false,
    related_to_focus: false,
    created_at: minutesAgo(5),
    updated_at: now(),
    active_wait_ms: 5 * 60000,
    source: {
      kind: 'agent',
      provider: 'claude',
      session_id: 'sess_fake_1',
      pty_id: 12,
      window_id: 1,
      tab_id: 3,
      tab_label: 'Claude',
      workspace: '/Users/ben/Development/Lee',
      cwd: '/Users/ben/Development/Lee',
    },
    actions: ['open', 'dismiss'],
    ...partial,
  };
}

function initialItems(): AttentionItem[] {
  return [
    makeItem({
      id: 'att_fake_approval',
      kind: 'approval',
      title: 'Claude wants to use Bash',
      text: 'run: npm test',
      severity: 'blocking',
      actions: ['approve', 'deny', 'open', 'snooze', 'dismiss'],
      created_at: minutesAgo(2),
      active_wait_ms: 2 * 60000,
      tool: { name: 'Bash', preview: 'npm test', signature: 'abc123def456' },
    }),
    makeItem({
      id: 'att_fake_waiting',
      kind: 'waiting',
      title: 'Claude is waiting for you',
      text: 'Should I use Redux or Zustand for the new state slice?',
      severity: 'needs-you',
      actions: ['reply', 'open', 'snooze', 'dismiss'],
      created_at: minutesAgo(9),
      active_wait_ms: 9 * 60000,
    }),
    makeItem({
      id: 'att_fake_review',
      kind: 'review',
      title: 'Claude finished a turn',
      text: 'Refactored the pairing store and added tests; all green.',
      severity: 'ambient',
      actions: ['reply', 'open', 'dismiss'],
      created_at: minutesAgo(20),
      active_wait_ms: 0,
    }),
  ];
}

export function createFakeCopilotApi(): CopilotAPI {
  let items = initialItems();
  const snapshotListeners = new Set<(s: AttentionSnapshot) => void>();
  const presenceListeners = new Set<(p: PresenceState) => void>();
  const returnListeners = new Set<(r: ReturnInfo) => void>();

  const focus: FocusState = {
    active: false,
    session_id: null,
    source: null,
    started_at: null,
    item: null,
    quiet_count: 0,
  };

  const away: AwayState = {
    active: false,
    handoff_id: null,
    started_at: null,
    summary: { mode: 'on_return' },
    summary_delivered: false,
    wake_item_ids: [],
    wake_pty_ids: [],
    parked_count: 0,
  };

  const presence: PresenceState = {
    at_machine: true,
    lee_active: true,
    engaged: true,
    engaged_via: 'lee',
    engaged_device_id: null,
    locked: false,
    last_lee_input_at: now(),
    last_engaged_at: now(),
    away_since: null,
    since: minutesAgo(30),
  };

  const devices: DeviceInfo[] = [
    {
      device_id: 'dev_fake0001aaaa',
      name: "Ben's iPhone",
      kind: 'aeronaut',
      created_at: minutesAgo(60 * 24),
      last_seen_at: minutesAgo(10),
      last_ip: '192.168.1.23',
      paired_via: 'qr',
      revoked_at: null,
    },
  ];

  function snapshot(): AttentionSnapshot {
    const open = items.filter((i) => i.state === 'open');
    return {
      items,
      counts: {
        blocking: open.filter((i) => i.severity === 'blocking').length,
        needs_you: open.filter((i) => i.severity === 'needs-you').length,
        ambient: open.filter((i) => i.severity === 'ambient').length,
        parked: open.filter((i) => i.parked).length,
      },
      focus,
      away,
      generated_at: now(),
    };
  }

  function emitSnapshot(): void {
    const s = snapshot();
    snapshotListeners.forEach((cb) => cb(s));
  }

  function findItem(id: string): AttentionItem | undefined {
    return items.find((i) => i.id === id);
  }

  function resolve(id: string, patch: Partial<AttentionItem>): ActionResult {
    const item = findItem(id);
    if (!item) return { success: false, error: 'not found' };
    Object.assign(item, patch, { version: item.version + 1, updated_at: now() });
    emitSnapshot();
    return { success: true, item };
  }

  const api: CopilotAPI = {
    getPresence: () => Promise.resolve(presence),
    onPresence: (cb) => {
      presenceListeners.add(cb);
      return () => presenceListeners.delete(cb);
    },
    logCeremony: (_action: CeremonyAction, _target?: string) => {},
    capture: (_req: CaptureRequest): Promise<CaptureResult> =>
      Promise.resolve({ success: true, someday_id: `sd_fake_${Date.now()}`, spooled: false }),
    devices: {
      list: () => Promise.resolve(devices),
      revoke: (deviceId: string) => {
        const d = devices.find((x) => x.device_id === deviceId);
        if (d) d.revoked_at = now();
        return Promise.resolve({ success: true });
      },
      create: (name: string, kind: string) => {
        const device: DeviceInfo = {
          device_id: `dev_fake${Math.random().toString(16).slice(2, 10)}`,
          name,
          kind,
          created_at: now(),
          last_seen_at: null,
          last_ip: null,
          paired_via: 'manual',
          revoked_at: null,
        };
        devices.unshift(device);
        return Promise.resolve({ success: true, device, token: crypto.randomUUID() });
      },
    },
    getSnapshot: () => Promise.resolve(snapshot()),
    onSnapshot: (cb) => {
      snapshotListeners.add(cb);
      return () => snapshotListeners.delete(cb);
    },
    reply: (itemId: string, req: ReplyRequest) => {
      if (req.action === 'text' && !req.text) return Promise.resolve({ success: false, error: 'text required' });
      return Promise.resolve(resolve(itemId, { state: 'resolved' }));
    },
    snooze: (itemId: string, _req: SnoozeRequest) => Promise.resolve(resolve(itemId, { state: 'snoozed' })),
    dismiss: (itemId: string) => Promise.resolve(resolve(itemId, { state: 'dismissed' })),
    setWake: (itemId: string, wake: boolean) => Promise.resolve(resolve(itemId, { wake })),
    openItem: (itemId: string) => Promise.resolve(resolve(itemId, {})),
    focusStart: (item?: FocusItem | null) => {
      focus.active = true;
      focus.session_id = 'focus_fake_1';
      focus.source = 'manual';
      focus.started_at = now();
      focus.item = item ?? { kind: 'workspace', workspace: '/Users/ben/Development/Lee' };
      focus.quiet_count = items.filter((i) => i.state === 'open' && i.severity !== 'blocking').length;
      emitSnapshot();
      return Promise.resolve(focus);
    },
    focusStop: () => {
      focus.active = false;
      focus.session_id = null;
      focus.source = null;
      focus.started_at = null;
      focus.item = null;
      focus.quiet_count = 0;
      emitSnapshot();
      return Promise.resolve(focus);
    },
    handoffProposals: (): Promise<HandoffProposals> =>
      Promise.resolve({
        agents: [
          {
            pty_id: 12,
            window_id: 1,
            tab_id: 3,
            label: 'Claude',
            provider: 'claude',
            workspace: '/Users/ben/Development/Lee',
            state: 'idle',
            last_summary: 'Refactored the pairing store and added tests; all green.',
          },
        ],
        waiting: items.filter((i) => i.state === 'open'),
        workspaces: ['/Users/ben/Development/Lee'],
        default_summary: { mode: 'on_return' },
      }),
    handoffStart: (_req: HandoffRequest): Promise<HandoffResult> => {
      away.active = true;
      away.handoff_id = `handoff_fake_${Date.now()}`;
      away.started_at = now();
      emitSnapshot();
      return Promise.resolve({ success: true, away, launched: _req.launch.length });
    },
    handoffEnd: () => {
      away.active = false;
      away.handoff_id = null;
      away.started_at = null;
      emitSnapshot();
      return Promise.resolve(away);
    },
    onReturn: (cb) => {
      returnListeners.add(cb);
      return () => returnListeners.delete(cb);
    },
  };

  return api;
}
