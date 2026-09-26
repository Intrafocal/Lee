/**
 * Dev-only canned CockpitAPI and Hester snapshot, so the Cockpit can be built
 * and eyeballed before lee-tab, lee-ops and hester-multi-ws are merged.
 * Enabled with `localStorage.setItem('cockpitFake', '1')` in a dev build only
 * (see useCockpit.ts). Never imported in production. Nothing here spawns a
 * process or types into a PTY.
 */

import type {
  CheckinResult,
  CockpitAPI,
  CockpitTask,
  FeedEntry,
  FeedSnapshot,
  LaunchResult,
  LintSnapshot,
  OperationsSnapshot,
  TabRuntimeInfo,
  TabStateInfo,
} from '../../shared/cockpit';
import { CHECKIN_PROMPT } from '../../shared/cockpit';
import type { CockpitSnapshot } from '../lib/hesterCockpit';

const WS = '/Users/ben/Development/Lee';

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60000).toISOString();
}

function state(pty: number, s: TabStateInfo['state'], mins: number): TabStateInfo {
  return { pty_id: pty, state: s, source: 'shell-integration', since: minutesAgo(mins), quiet_ms: mins * 60000, foreground: null };
}

function fakeTabs(): TabRuntimeInfo[] {
  return [
    {
      pty_id: 901,
      tab_id: null,
      window_id: 1,
      workspace: WS,
      label: 'Pi · refactor',
      tab_type: 'agent',
      kind: 'agent',
      provider: 'pi',
      fidelity: 'screen',
      state: state(901, 'idle-at-prompt', 3),
      shell_integration: false,
      cwd: WS,
      last_command: null,
      operation: null,
      task_id: null,
      session_id: null,
      tail: ['Refactored cockpit-bus imports.', 'All tests pass.', '> '],
    },
    {
      pty_id: 902,
      tab_id: null,
      window_id: 1,
      workspace: WS,
      label: 'Terminal 2',
      tab_type: 'terminal',
      kind: 'shell',
      provider: null,
      fidelity: 'activity',
      state: state(902, 'busy', 12),
      shell_integration: true,
      cwd: `${WS}/electron`,
      last_command: { sig: 'a1b2c3d4e5f6', argv0: 'npm', text: 'npm run dev', exit_code: null, at: minutesAgo(12) },
      operation: null,
      task_id: null,
      session_id: null,
      tail: [],
    },
  ];
}

let feedVersion = 1;

function entry(partial: Partial<FeedEntry> & Pick<FeedEntry, 'id' | 'kind' | 'title'>): FeedEntry {
  feedVersion += 1;
  return {
    version: feedVersion,
    workspace: null,
    severity: 'ambient',
    producer: 'ops',
    text: null,
    text_is_agent: false,
    created_at: minutesAgo(4),
    updated_at: minutesAgo(4),
    state: 'open',
    item_ref: null,
    ref: {},
    actions: [],
    pinned: false,
    expires_at: null,
    ...partial,
  };
}

function fakeFeed(): FeedEntry[] {
  return [
    entry({
      id: 'feed_fake_fail',
      kind: 'failure',
      severity: 'needs-you',
      title: 'electron:build failed (exit 2)',
      text: 'src/renderer/App.tsx(12,3): error TS2304',
      ref: { op: 'electron:build', run_id: 'run_fake_1' },
      actions: [{ id: 'fix', label: 'Fix with agent', style: 'primary' }, { id: 'task', label: 'Create task' }],
    }),
    entry({
      id: 'feed_fake_proposal',
      kind: 'proposal',
      severity: 'needs-you',
      producer: 'hester',
      title: 'Hester proposes: run dirigible/firmware:flash',
      ref: { proposal_id: 'prop_fake_1' },
      actions: [
        { id: 'approve', label: 'Run', style: 'primary', confirm_text: 'idf.py -p /dev/cu.usbmodem1101 flash (in dirigible/firmware)' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
      created_at: minutesAgo(1),
      updated_at: minutesAgo(1),
    }),
    entry({
      id: 'feed_fake_checkin',
      kind: 'event',
      producer: 'checkin',
      title: 'Checked in on Pi · refactor: in-progress',
      text: 'Moving the tab runtime behind the bus; two files left.',
      text_is_agent: true,
      created_at: minutesAgo(15),
      updated_at: minutesAgo(15),
    }),
  ];
}

function fakeOps(workspace: string): OperationsSnapshot {
  return {
    workspace,
    operations: [
      {
        def: { name: 'electron:build', kind: 'oneshot', command: 'npm run build', cwd: 'electron', produces: [] },
        source: 'operations-file',
        status: 'failed',
        last_run: {
          run_id: 'run_fake_1',
          op: 'electron:build',
          workspace,
          pty_id: null,
          tab_id: null,
          by: 'user',
          started_at: minutesAgo(6),
          ended_at: minutesAgo(5),
          status: 'failed',
          exit_code: 2,
          duration_ms: 48000,
          readings: [],
          inputs_sig: null,
        },
        running: null,
        linked_pty_id: null,
        service: null,
      },
      {
        def: { name: 'electron:dev', kind: 'long-running', command: 'npm run dev', cwd: 'electron' },
        source: 'operations-file',
        status: 'running',
        last_run: null,
        running: null,
        linked_pty_id: 902,
        service: null,
      },
      {
        def: { name: 'dirigible/firmware:flash', kind: 'oneshot', command: 'idf.py -p {port} flash', cwd: 'dirigible/firmware', params: ['port'], confirm: true },
        source: 'operations-file',
        status: 'idle',
        last_run: null,
        running: null,
        linked_pty_id: null,
        service: null,
      },
    ],
    suggestions: [
      { def: { name: 'aeronaut:test', kind: 'oneshot', command: 'flutter test', cwd: 'aeronaut' }, detected_from: 'aeronaut/pubspec.yaml' },
    ],
    proposals: [],
    agent: { model: 'claude-haiku-4-5-20251001', plan_model: 'sonnet', escalate_model: 'sonnet' },
    generated_at: new Date().toISOString(),
  };
}

function task(partial: Partial<CockpitTask> & Pick<CockpitTask, 'id' | 'title' | 'status'>): CockpitTask {
  return {
    workspace: WS,
    title_source: 'user',
    kind: 'bug',
    lead: 'delegate',
    play: false,
    agent: null,
    sessions: [],
    serves: [],
    workstream: null,
    confirmed: true,
    confirmed_at: minutesAgo(30),
    urgency: null,
    quadrant: null,
    timebox_min: 30,
    due: null,
    origin: { kind: 'launcher' },
    busy_ms: 0,
    turns: 0,
    files: [],
    files_count: 0,
    summary: null,
    lee_status: null,
    last_checkin_at: null,
    commits: [],
    outcome: null,
    accepted: null,
    created_at: minutesAgo(30),
    updated_at: minutesAgo(2),
    closed_at: null,
    version: 1,
    ...partial,
  };
}

export function fakeHesterSnapshot(workspace: string): CockpitSnapshot {
  return {
    workspace,
    workspace_id: 'fake0001',
    version: 1,
    tasks: {
      open: [
        task({
          id: 'task-fake0001',
          title: 'Fix /fs/list 404 against packaged Lee',
          status: 'running',
          agent: { provider: 'claude', pty_id: 12, session_id: 'sess_fake_1', tab_label: 'Claude' },
          busy_ms: 12 * 60000,
          turns: 3,
          files_count: 2,
          serves: ['G2'],
          summary: 'Added requireAuth to the /fs routes; writing the test now.',
        }),
        task({
          id: 'task-fake0002',
          title: 'Claude in Lee',
          title_source: 'auto',
          status: 'review',
          confirmed: false,
          confirmed_at: null,
          origin: { kind: 'agent' },
          kind: 'unknown',
          summary: 'Refactored the pairing store and added tests; all green.',
        }),
        task({ id: 'task-fake0003', title: 'Write the v2 release notes', status: 'queued', lead: 'human', kind: 'chore' }),
      ],
      recent_closed: [
        task({
          id: 'task-fake0004',
          title: 'Trackball scroll in Dirigible',
          status: 'done',
          accepted: true,
          closed_at: minutesAgo(60 * 20),
          outcome: 'Done by you.',
          commits: ['5cfeb62'],
        }),
      ],
      recent_events: [{ at: minutesAgo(8), task_id: 'task-fake0002', kind: 'auto_created', text: 'Task created: Claude in Lee' }],
    },
    workstreams: [],
    someday: { open: 4, untriaged_over_7d: 1 },
    readings: { latest: [] },
    generated_at: new Date().toISOString(),
  };
}

function emptyLint(workspace: string | null): LintSnapshot {
  return { workspace, diagnostics: [], counts: { info: 0, warn: 0, needs_you: 0 }, rules: [], generated_at: new Date().toISOString() };
}

export function createFakeCockpitApi(): CockpitAPI {
  let feed = fakeFeed();
  const tabs = fakeTabs();
  const feedListeners = new Set<(s: FeedSnapshot) => void>();

  const snapshot = (): FeedSnapshot => ({ workspace: null, entries: feed, generated_at: new Date().toISOString() });
  const emitFeed = () => feedListeners.forEach((cb) => cb(snapshot()));
  const addEvent = (title: string, text: string | null, agent = false) => {
    feed = [entry({ id: `feed_fake_${Date.now()}`, kind: 'event', producer: 'launch', title, text, text_is_agent: agent, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }), ...feed];
    emitFeed();
  };

  return {
    tabs: {
      list: (workspace) => Promise.resolve(tabs.map((t) => ({ ...t, workspace: workspace ?? WS }))),
      onChange: () => () => {},
      read: (ptyId) => Promise.resolve({ pty_id: ptyId, text: '', cursor: 0, truncated: false, state: 'idle-at-prompt' }),
      state: (ptyId) => Promise.resolve(state(ptyId, 'idle-at-prompt', 1)),
      send: () => Promise.resolve({ success: false, error: 'forbidden' }),
      focus: () => Promise.resolve({ success: false, error: 'fake' }),
      rename: () => Promise.resolve({ success: false, error: 'fake' }),
    },
    files: () => Promise.resolve({ files: ['README.md', 'electron/src/main/main.ts'], truncated: false }),
    checkin: (ptyId): Promise<CheckinResult> => {
      addEvent(`Checked in on ${ptyId} (fake)`, `Would type: ${CHECKIN_PROMPT}`);
      return Promise.resolve({ success: true, checkin_id: 'chk_fake', state: 'sent', source: 'screen' });
    },
    checkinCancel: () => Promise.resolve({ success: true }),
    launch: (req): Promise<LaunchResult> => {
      addEvent(`Launched (fake): ${req.title || (req.prompt ?? '').slice(0, 60) || 'Task'}`, `lead ${req.lead ?? 'delegate'} · nothing was started`);
      return Promise.resolve({ success: true, task_id: `task-${Math.random().toString(16).slice(2, 10)}`, pty_id: null, relayed: false });
    },
    feed: {
      get: () => Promise.resolve(snapshot()),
      onChange: (cb) => {
        feedListeners.add(cb);
        return () => {
          feedListeners.delete(cb);
        };
      },
      act: (entryId, actionId) => {
        const e = feed.find((x) => x.id === entryId);
        if (!e) return Promise.resolve({ success: false, error: 'not_found' });
        feed = feed.map((x) => (x.id === entryId ? { ...x, state: actionId === 'dismiss' ? 'dismissed' : 'done', version: x.version + 1 } : x));
        emitFeed();
        return Promise.resolve({ success: true });
      },
    },
    logEvent: (event) => console.log('[cockpitFake] event', event),
    onCreateTab: () => () => {},
    createTabResult: () => {},
    onGoInto: () => () => {},
    ops: {
      list: (workspace) => Promise.resolve(fakeOps(workspace)),
      onChange: () => () => {},
      run: (req) => {
        addEvent(`Ran (fake) ${req.name ?? req.command}`, 'nothing was typed');
        return Promise.resolve({ success: true });
      },
      stop: () => Promise.resolve({ success: true }),
      confirm: () => Promise.resolve({ success: true }),
      dismissSuggestion: () => Promise.resolve({ success: true }),
      save: () => Promise.resolve({ success: true }),
      linkTab: () => Promise.resolve({ success: true }),
      startAgent: () => Promise.resolve({ success: false, error: 'fake' }),
      serialPorts: () => Promise.resolve(['/dev/cu.usbmodem1101']),
    },
    lint: {
      list: (workspace) => Promise.resolve(emptyLint(workspace ?? null)),
      onChange: () => () => {},
      fix: () => Promise.resolve({ success: false, error: 'fake' }),
      dismiss: () => Promise.resolve({ success: true }),
      suppress: () => Promise.resolve({ success: true }),
      shown: () => {},
      learnTool: () => {},
    },
  };
}
