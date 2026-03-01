/**
 * DevOpsPane - Config-driven service manager dashboard
 *
 * Reads config.yaml environments and provides controls for starting/stopping services,
 * viewing logs, and sending signals to running processes.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

// Get the Lee API from preload
const lee = (window as any).lee;

// Service configuration from config.yaml
interface ServiceConfig {
  name: string;
  command: string;
  cwd?: string;
  port?: number;
  health_check?: string;
  auto_start?: boolean;
  restart_on_failure?: boolean;
  env?: Record<string, string>;
}

interface EnvironmentConfig {
  name: string;
  description?: string;
  services: ServiceConfig[];
}

// Runtime service state
interface ServiceState {
  name: string;
  config: ServiceConfig;
  status: 'stopped' | 'starting' | 'running' | 'error';
  ptyId?: number;
  logs: string[];
  error?: string;
}

interface DevOpsPaneProps {
  workspace: string;
  active: boolean;
}

export const DevOpsPane: React.FC<DevOpsPaneProps> = ({ workspace, active }) => {
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([]);
  const [activeEnvIndex, setActiveEnvIndex] = useState(0);
  const [services, setServices] = useState<Map<string, ServiceState>>(new Map());
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Scroll logs to bottom when they update
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [services, selectedService]);

  // Load config on mount
  useEffect(() => {
    const loadConfig = async () => {
      if (!lee?.config?.load) {
        // Fallback to sample config if API not available
        setEnvironments([
          {
            name: 'Sample Environment',
            description: 'Add environments to lee/config.yaml',
            services: [
              { name: 'Example Service', command: 'echo "Configure services in config.yaml"' }
            ]
          }
        ]);
        setLoading(false);
        return;
      }

      try {
        const config = await lee.config.load(workspace);
        if (config?.environments) {
          setEnvironments(config.environments);
          // Initialize service states
          const serviceMap = new Map<string, ServiceState>();
          config.environments.forEach((env: EnvironmentConfig) => {
            env.services.forEach((svc: ServiceConfig) => {
              const key = `${env.name}:${svc.name}`;
              serviceMap.set(key, {
                name: svc.name,
                config: svc,
                status: 'stopped',
                logs: [],
              });
            });
          });
          setServices(serviceMap);
        }
      } catch (error) {
        console.error('Failed to load config:', error);
      }
      setLoading(false);
    };

    loadConfig();
  }, [workspace]);

  // Setup PTY data listener
  useEffect(() => {
    if (!lee?.pty?.onData) return;

    const handleData = (ptyId: number, data: string) => {
      // Find service with this ptyId and append logs
      setServices(prev => {
        const next = new Map(prev);
        for (const [key, state] of next.entries()) {
          if (state.ptyId === ptyId) {
            // Split data into lines and filter empty ones
            const newLines = data.split('\n').filter(line => line.trim());
            if (newLines.length > 0) {
              next.set(key, {
                ...state,
                logs: [...state.logs, ...newLines].slice(-500) // Keep last 500 lines
              });
            }
            break;
          }
        }
        return next;
      });
    };

    const handleExit = (ptyId: number, code: number) => {
      setServices(prev => {
        const next = new Map(prev);
        for (const [key, state] of next.entries()) {
          if (state.ptyId === ptyId) {
            next.set(key, {
              ...state,
              status: code === 0 ? 'stopped' : 'error',
              ptyId: undefined,
              logs: [...state.logs, `Process exited with code ${code}`]
            });
            break;
          }
        }
        return next;
      });
    };

    lee.pty.onData(handleData);
    lee.pty.onExit(handleExit);

    // Note: We don't clean up listeners here as they're shared with terminals
    // The main App.tsx handles cleanup on unmount
  }, []);

  // Start a service
  const startService = useCallback(async (envName: string, service: ServiceConfig) => {
    const key = `${envName}:${service.name}`;

    if (!lee?.pty?.spawn) {
      setServices(prev => {
        const next = new Map(prev);
        const state = next.get(key);
        if (state) {
          next.set(key, {
            ...state,
            status: 'error',
            logs: [...state.logs, 'Error: Not running in Electron']
          });
        }
        return next;
      });
      return;
    }

    setServices(prev => {
      const next = new Map(prev);
      const state = next.get(key);
      if (state) {
        next.set(key, {
          ...state,
          status: 'starting',
          logs: [...state.logs, `$ ${service.command}`]
        });
      }
      return next;
    });

    try {
      // Parse command into shell command
      const cwd = service.cwd ? `${workspace}/${service.cwd}` : workspace;

      // Spawn a shell that runs the command
      const ptyId = await lee.pty.spawn('/bin/bash', ['-c', service.command], cwd, service.name);

      setServices(prev => {
        const next = new Map(prev);
        const state = next.get(key);
        if (state) {
          next.set(key, {
            ...state,
            status: 'running',
            ptyId,
            logs: [...state.logs, `Started (PTY ${ptyId})`]
          });
        }
        return next;
      });
    } catch (error: any) {
      setServices(prev => {
        const next = new Map(prev);
        const state = next.get(key);
        if (state) {
          next.set(key, {
            ...state,
            status: 'error',
            error: error.message,
            logs: [...state.logs, `Error: ${error.message}`]
          });
        }
        return next;
      });
    }
  }, [workspace]);

  // Stop a service
  const stopService = useCallback(async (envName: string, service: ServiceConfig) => {
    const key = `${envName}:${service.name}`;
    const state = services.get(key);

    if (!state?.ptyId) {
      return;
    }

    try {
      // Send SIGTERM via PTY kill
      if (lee?.pty?.kill) {
        await lee.pty.kill(state.ptyId);
      }

      setServices(prev => {
        const next = new Map(prev);
        const s = next.get(key);
        if (s) {
          next.set(key, {
            ...s,
            status: 'stopped',
            ptyId: undefined,
            logs: [...s.logs, 'Stopped']
          });
        }
        return next;
      });
    } catch (error: any) {
      console.error('Failed to stop service:', error);
      setServices(prev => {
        const next = new Map(prev);
        const s = next.get(key);
        if (s) {
          next.set(key, {
            ...s,
            logs: [...s.logs, `Error stopping: ${error.message}`]
          });
        }
        return next;
      });
    }
  }, [services]);

  // Send input to a running service (for hot reload etc)
  const sendInput = useCallback((key: string, input: string) => {
    const state = services.get(key);
    if (state?.ptyId && lee?.pty?.write) {
      lee.pty.write(state.ptyId, input);
    }
  }, [services]);

  // Get status indicator
  const getStatusIndicator = (status: ServiceState['status']) => {
    switch (status) {
      case 'running': return '🟢';
      case 'starting': return '🟡';
      case 'error': return '🔴';
      default: return '⚪';
    }
  };

  const activeEnv = environments[activeEnvIndex];
  const selectedState = selectedService ? services.get(selectedService) : null;

  if (loading) {
    return (
      <div className="devops-pane" style={{ display: active ? 'flex' : 'none' }}>
        <div className="devops-loading">Loading configuration...</div>
      </div>
    );
  }

  return (
    <div className="devops-pane" style={{ display: active ? 'flex' : 'none' }}>
      {/* Environment tabs */}
      <div className="devops-env-tabs">
        {environments.map((env, index) => (
          <button
            key={env.name}
            className={`devops-env-tab ${index === activeEnvIndex ? 'active' : ''}`}
            onClick={() => setActiveEnvIndex(index)}
          >
            {env.name}
          </button>
        ))}
      </div>

      {/* Main content area */}
      <div className="devops-content">
        {/* Services list */}
        <div className="devops-services">
          <div className="devops-services-header">
            <span>Services</span>
            {activeEnv?.description && (
              <span className="devops-env-desc">{activeEnv.description}</span>
            )}
          </div>
          <div className="devops-services-list">
            {activeEnv?.services.map((service) => {
              const key = `${activeEnv.name}:${service.name}`;
              const state = services.get(key);
              const isSelected = selectedService === key;
              const isRunning = state?.status === 'running';

              return (
                <div
                  key={service.name}
                  className={`devops-service-row ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelectedService(key)}
                >
                  <span className="devops-service-status">
                    {getStatusIndicator(state?.status || 'stopped')}
                  </span>
                  <span className="devops-service-name">{service.name}</span>
                  {service.port && (
                    <span className="devops-service-port">:{service.port}</span>
                  )}
                  <div className="devops-service-actions">
                    {isRunning ? (
                      <button
                        className="devops-btn stop"
                        onClick={(e) => {
                          e.stopPropagation();
                          stopService(activeEnv.name, service);
                        }}
                        title="Stop"
                      >
                        ⏹
                      </button>
                    ) : (
                      <button
                        className="devops-btn start"
                        onClick={(e) => {
                          e.stopPropagation();
                          startService(activeEnv.name, service);
                        }}
                        title="Start"
                        disabled={state?.status === 'starting'}
                      >
                        ▶
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Log viewer */}
        <div className="devops-logs">
          <div className="devops-logs-header">
            {selectedService ? (
              <>
                <span>Logs: {selectedService.split(':')[1]}</span>
                {selectedState?.status === 'running' && selectedState?.config?.name?.toLowerCase().includes('flutter') && (
                  <button
                    className="devops-btn"
                    onClick={() => sendInput(selectedService, 'r')}
                    title="Hot Reload"
                    style={{ marginLeft: '8px', width: 'auto', padding: '0 8px' }}
                  >
                    🔄 Hot Reload
                  </button>
                )}
              </>
            ) : (
              <span>Select a service to view logs</span>
            )}
          </div>
          <div className="devops-logs-content">
            {selectedState?.logs.map((log, i) => (
              <div key={i} className="devops-log-line">{log}</div>
            ))}
            {selectedState && selectedState.logs.length === 0 && (
              <div className="devops-log-empty">No logs yet. Click ▶ to start the service.</div>
            )}
            {!selectedService && (
              <div className="devops-log-empty">Select a service from the list to view its logs.</div>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default DevOpsPane;
