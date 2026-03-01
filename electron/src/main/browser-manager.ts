/**
 * Browser Manager - Manages browser webview instances and CDP interactions.
 *
 * Features:
 * - Track active browser tabs/webContents
 * - Navigation with domain approval flow
 * - CDP access via webContents.debugger for:
 *   - Screenshots
 *   - DOM/Accessibility tree snapshots
 *   - Click/type automation
 * - Approved domains tracking per session
 */

import { EventEmitter } from 'events';
import { webContents, BrowserWindow } from 'electron';

// Browser state for a single tab
export interface BrowserState {
  webContentsId: number;
  tabId: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  debuggerAttached: boolean;
}

// Navigation request that requires approval
export interface NavigationRequest {
  id: string;
  webContentsId: number;
  url: string;
  domain: string;
  timestamp: number;
  resolved: boolean;
  approved?: boolean;
}

// CDP command result
export interface CDPResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * BrowserManager handles browser tab lifecycle and CDP interactions.
 *
 * Events:
 * - 'state': Emitted when browser state changes
 * - 'navigation-request': Emitted when navigation needs approval
 */
export class BrowserManager extends EventEmitter {
  private browsers: Map<number, BrowserState> = new Map(); // webContentsId -> state
  private tabToBrowser: Map<number, number> = new Map(); // tabId -> webContentsId
  private approvedDomains: Set<string> = new Set();
  private pendingNavigations: Map<string, NavigationRequest> = new Map();
  private getMainWindow: () => BrowserWindow | null;

  constructor(getMainWindow: () => BrowserWindow | null) {
    super();
    this.getMainWindow = getMainWindow;

    // Always approved domains (safe defaults)
    this.approvedDomains.add('google.com');
    this.approvedDomains.add('www.google.com');
    this.approvedDomains.add('duckduckgo.com');
    this.approvedDomains.add('github.com');
    this.approvedDomains.add('stackoverflow.com');
  }

  /**
   * Register a browser tab with its webContentsId.
   * Called from renderer when a browser tab is created.
   */
  registerBrowser(tabId: number, webContentsId: number): BrowserState {
    const state: BrowserState = {
      webContentsId,
      tabId,
      url: '',
      title: 'New Tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      debuggerAttached: false,
    };

    this.browsers.set(webContentsId, state);
    this.tabToBrowser.set(tabId, webContentsId);

    console.log(`[BrowserManager] Registered browser tab ${tabId} with webContents ${webContentsId}`);
    return state;
  }

  /**
   * Unregister a browser tab.
   */
  unregisterBrowser(tabId: number): void {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId !== undefined) {
      // Detach debugger if attached
      const state = this.browsers.get(webContentsId);
      if (state?.debuggerAttached) {
        this.detachDebugger(webContentsId);
      }

      this.browsers.delete(webContentsId);
      this.tabToBrowser.delete(tabId);
      console.log(`[BrowserManager] Unregistered browser tab ${tabId}`);
    }
  }

  /**
   * Update browser state from renderer.
   */
  updateState(webContentsId: number, update: Partial<BrowserState>): void {
    const state = this.browsers.get(webContentsId);
    if (state) {
      Object.assign(state, update);
      this.emit('state', state);
    }
  }

  /**
   * Get browser state by tab ID.
   */
  getByTabId(tabId: number): BrowserState | undefined {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId !== undefined) {
      return this.browsers.get(webContentsId);
    }
    return undefined;
  }

  /**
   * Get all active browsers.
   */
  getAll(): BrowserState[] {
    return Array.from(this.browsers.values());
  }

  /**
   * Extract domain from URL.
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return '';
    }
  }

  /**
   * Check if a domain is approved for navigation.
   */
  isDomainApproved(domain: string): boolean {
    // Check exact match
    if (this.approvedDomains.has(domain)) {
      return true;
    }

    // Check if subdomain of approved domain
    for (const approved of this.approvedDomains) {
      if (domain.endsWith('.' + approved)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Approve a domain for the session.
   */
  approveDomain(domain: string): void {
    this.approvedDomains.add(domain);
    console.log(`[BrowserManager] Approved domain: ${domain}`);
  }

  /**
   * Request navigation with optional domain approval.
   * Returns immediately if domain is approved, otherwise emits event for user confirmation.
   */
  async requestNavigation(
    tabId: number,
    url: string,
    requireApproval: boolean = true
  ): Promise<{ approved: boolean; requestId?: string }> {
    const domain = this.extractDomain(url);

    // If domain is already approved or approval not required, proceed
    if (!requireApproval || this.isDomainApproved(domain)) {
      return { approved: true };
    }

    // Create navigation request for user approval
    const requestId = `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const webContentsId = this.tabToBrowser.get(tabId);

    const request: NavigationRequest = {
      id: requestId,
      webContentsId: webContentsId || 0,
      url,
      domain,
      timestamp: Date.now(),
      resolved: false,
    };

    this.pendingNavigations.set(requestId, request);

    // Emit event for UI to show confirmation
    this.emit('navigation-request', request);

    // Send status message to UI via main window
    const mainWindow = this.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('status:push', {
        id: requestId,
        message: `Hester wants to navigate to ${domain}`,
        type: 'info',
        prompt: `Allow navigation to ${url}?`,
        actions: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
      });
    }

    return { approved: false, requestId };
  }

  /**
   * Resolve a pending navigation request.
   */
  resolveNavigation(requestId: string, approved: boolean): void {
    const request = this.pendingNavigations.get(requestId);
    if (!request || request.resolved) {
      return;
    }

    request.resolved = true;
    request.approved = approved;

    if (approved) {
      // Add domain to approved list
      this.approveDomain(request.domain);
    }

    this.emit('navigation-resolved', request);
    this.pendingNavigations.delete(requestId);
  }

  // ============================================
  // CDP (Chrome DevTools Protocol) Operations
  // ============================================

  /**
   * Attach debugger to a webContents for CDP access.
   */
  async attachDebugger(webContentsId: number): Promise<CDPResult> {
    const state = this.browsers.get(webContentsId);
    if (!state) {
      return { success: false, error: 'Browser not found' };
    }

    if (state.debuggerAttached) {
      return { success: true };
    }

    try {
      const wc = webContents.fromId(webContentsId);
      if (!wc) {
        return { success: false, error: 'WebContents not found' };
      }

      wc.debugger.attach('1.3');
      state.debuggerAttached = true;
      console.log(`[BrowserManager] Debugger attached to webContents ${webContentsId}`);
      return { success: true };
    } catch (error) {
      console.error(`[BrowserManager] Failed to attach debugger:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Detach debugger from a webContents.
   */
  detachDebugger(webContentsId: number): void {
    const state = this.browsers.get(webContentsId);
    if (!state?.debuggerAttached) {
      return;
    }

    try {
      const wc = webContents.fromId(webContentsId);
      if (wc) {
        wc.debugger.detach();
      }
      state.debuggerAttached = false;
      console.log(`[BrowserManager] Debugger detached from webContents ${webContentsId}`);
    } catch (error) {
      console.error(`[BrowserManager] Failed to detach debugger:`, error);
    }
  }

  /**
   * Send a CDP command to a webContents.
   */
  async sendCDPCommand(
    webContentsId: number,
    method: string,
    params: Record<string, any> = {}
  ): Promise<CDPResult> {
    const state = this.browsers.get(webContentsId);
    if (!state) {
      return { success: false, error: 'Browser not found' };
    }

    // Ensure debugger is attached
    if (!state.debuggerAttached) {
      const attachResult = await this.attachDebugger(webContentsId);
      if (!attachResult.success) {
        return attachResult;
      }
    }

    try {
      const wc = webContents.fromId(webContentsId);
      if (!wc) {
        return { success: false, error: 'WebContents not found' };
      }

      const result = await wc.debugger.sendCommand(method, params);
      return { success: true, data: result };
    } catch (error) {
      console.error(`[BrowserManager] CDP command failed (${method}):`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Take a screenshot of the browser viewport.
   */
  async screenshot(tabId: number): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    return this.sendCDPCommand(webContentsId, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
  }

  // ============================================
  // Screencast & Remote Input (Aeronaut)
  // ============================================

  /**
   * Override device metrics so the page renders at mobile dimensions.
   */
  async setDeviceMetrics(
    tabId: number,
    options: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }
  ): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    return this.sendCDPCommand(webContentsId, 'Emulation.setDeviceMetricsOverride', {
      width: Math.round(options.width),
      height: Math.round(options.height),
      deviceScaleFactor: options.deviceScaleFactor ?? 2,
      mobile: options.mobile ?? true,
    });
  }

  /**
   * Clear device metrics override.
   */
  async clearDeviceMetrics(tabId: number): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    return this.sendCDPCommand(webContentsId, 'Emulation.clearDeviceMetricsOverride', {});
  }

  /**
   * Start CDP screencast for streaming browser frames to Aeronaut.
   */
  async startScreencast(
    tabId: number,
    options: { maxWidth?: number; maxHeight?: number; quality?: number } = {}
  ): Promise<CDPResult & { webContentsId?: number }> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    const result = await this.sendCDPCommand(webContentsId, 'Page.startScreencast', {
      format: 'jpeg',
      quality: options.quality ?? 80,
      maxWidth: options.maxWidth ?? 1170,
      maxHeight: options.maxHeight ?? 2532,
      everyNthFrame: 1,
    });

    return { ...result, webContentsId };
  }

  /**
   * Stop CDP screencast.
   */
  async stopScreencast(tabId: number): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    return this.sendCDPCommand(webContentsId, 'Page.stopScreencast');
  }

  /**
   * Acknowledge a screencast frame so CDP sends the next one.
   */
  async ackScreencastFrame(tabId: number, sessionId: number): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    return this.sendCDPCommand(webContentsId, 'Page.screencastFrameAck', {
      sessionId,
    });
  }

  /**
   * Dispatch a mouse event via CDP (for Aeronaut remote touch → mouse translation).
   */
  async dispatchMouseEvent(
    tabId: number,
    type: 'mousePressed' | 'mouseReleased' | 'mouseWheel' | 'mouseMoved',
    x: number,
    y: number,
    options: { button?: string; clickCount?: number; deltaX?: number; deltaY?: number } = {}
  ): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    return this.sendCDPCommand(webContentsId, 'Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: options.button ?? 'left',
      clickCount: options.clickCount ?? 1,
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 0,
    });
  }

  /**
   * Dispatch a key event via CDP (for Aeronaut remote keyboard input).
   */
  async dispatchKeyEvent(
    tabId: number,
    type: 'keyDown' | 'keyUp' | 'char',
    options: { key?: string; text?: string; code?: string } = {}
  ): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    return this.sendCDPCommand(webContentsId, 'Input.dispatchKeyEvent', {
      type,
      ...options,
    });
  }

  /**
   * Get the webContentsId for a given tab (used by screencast event routing).
   */
  getWebContentsId(tabId: number): number | undefined {
    return this.tabToBrowser.get(tabId);
  }

  /**
   * Get DOM snapshot (accessibility tree).
   */
  async getDOM(tabId: number): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    // Get accessibility tree for better LLM parsing
    const result = await this.sendCDPCommand(
      webContentsId,
      'Accessibility.getFullAXTree',
      {}
    );

    return result;
  }

  /**
   * Click on an element by selector.
   */
  async click(tabId: number, selector: string): Promise<CDPResult> {
    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    // Get document
    const docResult = await this.sendCDPCommand(webContentsId, 'DOM.getDocument', {});
    if (!docResult.success) {
      return docResult;
    }

    // Find element by selector
    const queryResult = await this.sendCDPCommand(webContentsId, 'DOM.querySelector', {
      nodeId: docResult.data.root.nodeId,
      selector,
    });

    if (!queryResult.success || !queryResult.data.nodeId) {
      return { success: false, error: `Element not found: ${selector}` };
    }

    // Get element bounding box
    const boxResult = await this.sendCDPCommand(webContentsId, 'DOM.getBoxModel', {
      nodeId: queryResult.data.nodeId,
    });

    if (!boxResult.success) {
      return boxResult;
    }

    // Calculate click coordinates (center of element)
    const content = boxResult.data.model.content;
    const x = (content[0] + content[2]) / 2;
    const y = (content[1] + content[5]) / 2;

    // Simulate mouse click
    await this.sendCDPCommand(webContentsId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });

    await this.sendCDPCommand(webContentsId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });

    return { success: true, data: { clicked: selector, x, y } };
  }

  /**
   * Type text into an element.
   */
  async type(tabId: number, selector: string, text: string): Promise<CDPResult> {
    // First click to focus
    const clickResult = await this.click(tabId, selector);
    if (!clickResult.success) {
      return clickResult;
    }

    const webContentsId = this.tabToBrowser.get(tabId);
    if (webContentsId === undefined) {
      return { success: false, error: 'Browser tab not found' };
    }

    // Type each character
    for (const char of text) {
      await this.sendCDPCommand(webContentsId, 'Input.dispatchKeyEvent', {
        type: 'char',
        text: char,
      });
    }

    return { success: true, data: { typed: text, selector } };
  }

  /**
   * Fill a form with multiple fields.
   */
  async fillForm(
    tabId: number,
    fields: Array<{ selector: string; value: string }>
  ): Promise<CDPResult> {
    const results: Array<{ selector: string; success: boolean; error?: string }> = [];

    for (const field of fields) {
      const result = await this.type(tabId, field.selector, field.value);
      results.push({
        selector: field.selector,
        success: result.success,
        error: result.error,
      });
    }

    const allSuccess = results.every((r) => r.success);
    return {
      success: allSuccess,
      data: { fields: results },
      error: allSuccess ? undefined : 'Some fields failed to fill',
    };
  }
}
