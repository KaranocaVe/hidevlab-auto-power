// ==UserScript==
// @name         HiDevLab 自动开机/抢卡助手
// @namespace    https://hidevlab.huawei.com/
// @version      1.3.0
// @description  自动识别 HiDevLab 开发环境，防止页面休眠，按用户勾选的目标循环重试开机并记录完整日志。
// @match        https://hidevlab.huawei.com/online-develop*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'hidevlab-auto-power-settings-v1';
  const PANEL_ID = 'hidevlab-auto-power-panel';
  const MAX_LOG_ENTRIES = 2000;
  const DEFAULTS = {
    intervalMs: 2500,
    retryDelayMs: 100,
    selectedNames: [],
    stopOnSuccess: true,
    autoConfirm: true,
    keepAwake: true,
    panelCollapsed: false,
    panelPosition: null,
  };

  const state = {
    running: false,
    tickTimer: null,
    ticking: false,
    pendingName: null,
    pendingSince: 0,
    confirmAwaiting: false,
    manualConfirmPending: false,
    lastActionAt: 0,
    successNotified: new Set(),
    observer: null,
    targetRefreshTimer: null,
    attempts: 0,
    logEntries: [],
    summaryLogs: [],
    logView: 'summary',
    wakeLock: null,
    heartbeatTimer: null,
    wakeLockRetryTimer: null,
    panelHost: null,
    dragState: null,
  };

  const settings = loadSettings();

  function loadSettings() {
    try {
      const saved = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, {}) : {};
      const merged = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
      if (!Array.isArray(merged.selectedNames)) {
        merged.selectedNames = String(merged.targetNames || '')
          .split(/[\n,，]/)
          .map((name) => name.trim())
          .filter(Boolean);
      }
      return merged;
    } catch (error) {
      console.warn('[HiDevLab 助手] 读取设置失败', error);
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, { ...settings });
    } catch (error) {
      console.warn('[HiDevLab 助手] 保存设置失败', error);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getVisibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"], .tiny-modal, .tiny-dialog')]
      .filter(isVisible);
  }

  function getVisibleDialogText() {
    return getVisibleDialogs().map((dialog) => cleanText(dialog.innerText)).join(' | ');
  }

  function getRows() {
    return [...document.querySelectorAll('tr[data-rowid], tr.tiny-grid-body__row')]
      .filter(isVisible)
      .map((row) => {
        const nameCell = row.querySelector('[data-colid="col_2"]') || row.querySelector('td:nth-child(2)');
        const statusCell = row.querySelector('[data-colid="col_3"]') || row.querySelector('td:nth-child(3)');
        const descriptionCell = row.querySelector('[data-colid="col_4"]') || row.querySelector('td:nth-child(4)');
        const powerButton = [...row.querySelectorAll('button')]
          .find((button) => cleanText(button.innerText) === '开机');
        return {
          row,
          name: cleanText(nameCell?.innerText),
          status: cleanText(statusCell?.innerText),
          description: cleanText(descriptionCell?.innerText),
          powerButton,
        };
      })
      .filter((item) => item.name);
  }

  function isSuccessStatus(status) {
    if (!status || /开机中|关机中|已关机|失败|异常|排队|申请中/.test(status)) return false;
    return /运行中|已开机|已启动|启动成功|开机成功|可连接/.test(status);
  }

  function isStoppedStatus(status) {
    return /已关机|关机|开机失败|失败|异常/.test(status) && !/开机中|运行中/.test(status);
  }

  function targetNameSet() {
    return new Set((Array.isArray(settings.selectedNames) ? settings.selectedNames : []).filter(Boolean));
  }

  function isTarget(row) {
    return targetNameSet().has(row.name);
  }

  function updateSelectedNamesFromPanel() {
    if (!shadowRoot) return;
    settings.selectedNames = [...shadowRoot.querySelectorAll('[data-role="targets"] input[type="checkbox"]:checked')]
      .map((input) => input.value)
      .filter(Boolean);
    saveSettings();
    updateTargetCount();
  }

  function updateTargetCount() {
    const count = shadowRoot?.querySelector('[data-role="target-count"]');
    if (count) count.textContent = `已选 ${targetNameSet().size}`;
  }

  function refreshTargetList() {
    if (!shadowRoot) return;
    const targetBox = shadowRoot.querySelector('[data-role="targets"]');
    if (!targetBox) return;
    const selected = targetNameSet();
    const rows = getRows();
    targetBox.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'target-empty';
      empty.textContent = '正在等待页面识别开发环境…';
      targetBox.appendChild(empty);
      updateTargetCount();
      return;
    }
    for (const row of rows) {
      const label = document.createElement('label');
      label.className = 'target-item';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = row.name;
      input.checked = selected.has(row.name);
      input.addEventListener('change', updateSelectedNamesFromPanel);
      const name = document.createElement('span');
      name.className = 'target-meta';
      const nameText = document.createElement('span');
      nameText.className = 'target-name';
      nameText.textContent = row.name;
      const description = document.createElement('span');
      description.className = 'target-description';
      description.textContent = row.description || '未提供规格描述';
      name.append(nameText, description);
      const status = document.createElement('span');
      status.className = 'target-status';
      status.textContent = row.status || '未知状态';
      label.append(input, name, status);
      targetBox.appendChild(label);
    }
    updateTargetCount();
  }

  function scheduleTargetRefresh() {
    if (state.targetRefreshTimer) return;
    state.targetRefreshTimer = setTimeout(() => {
      state.targetRefreshTimer = null;
      refreshTargetList();
    }, 120);
  }

  function renderLogs() {
    const logBox = shadowRoot?.querySelector('[data-role="log"]');
    const logCount = shadowRoot?.querySelector('[data-role="log-count"]');
    const toggleButton = shadowRoot?.querySelector('[data-action="toggle-log"]');
    if (!logBox) return;

    const entries = state.logView === 'full'
      ? state.logEntries
      : state.summaryLogs;
    logBox.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement('div');
      item.dataset.kind = entry.kind;
      if (state.logView === 'full') {
        item.textContent = `${entry.time} ${entry.message}`;
      } else {
        const repeat = entry.count > 1 ? ` ×${entry.count}` : '';
        const range = entry.firstTime === entry.lastTime
          ? entry.firstTime
          : `${entry.firstTime}–${entry.lastTime}`;
        item.textContent = `${range}${repeat} ${entry.message}`;
      }
      logBox.appendChild(item);
    }
    if (logCount) logCount.textContent = `${state.logEntries.length} 条`;
    if (toggleButton) toggleButton.textContent = state.logView === 'full' ? '显示摘要' : '查看完整日志';
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setStatus(message, kind = 'info') {
    const status = shadowRoot?.querySelector('[data-role="status"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function log(message, kind = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = { time, message, kind };
    state.logEntries.push(entry);
    if (state.logEntries.length > MAX_LOG_ENTRIES) state.logEntries.shift();

    const key = `${kind}:${message}`;
    const last = state.summaryLogs[state.summaryLogs.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      last.lastTime = time;
    } else {
      state.summaryLogs.push({ key, time, firstTime: time, lastTime: time, message, kind, count: 1 });
      if (state.summaryLogs.length > 400) state.summaryLogs.shift();
    }

    console.info(`[HiDevLab 助手] ${message}`);
    renderLogs();
    setStatus(message, kind);
  }

  function toggleLogView() {
    state.logView = state.logView === 'full' ? 'summary' : 'full';
    renderLogs();
  }

  function setAwakeStatus(message, kind = 'info') {
    const status = shadowRoot?.querySelector('[data-role="awake"]');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function scheduleWakeLockRetry() {
    if (state.wakeLockRetryTimer || !state.running || !settings.keepAwake) return;
    state.wakeLockRetryTimer = setTimeout(() => {
      state.wakeLockRetryTimer = null;
      requestWakeLock();
    }, 5000);
  }

  async function requestWakeLock() {
    if (!state.running || !settings.keepAwake) return;
    if (!('wakeLock' in navigator)) {
      setAwakeStatus('浏览器不支持 Wake Lock', 'warn');
      return;
    }
    if (document.visibilityState !== 'visible') {
      setAwakeStatus('页面后台，等待回到前台保活', 'warn');
      return;
    }
    if (state.wakeLock && !state.wakeLock.released) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
        if (state.running) {
          setAwakeStatus('保活已释放，正在重试', 'warn');
          scheduleWakeLockRetry();
        }
      });
      setAwakeStatus('Wake Lock 保活中', 'success');
    } catch (error) {
      state.wakeLock = null;
      setAwakeStatus(`保活申请失败：${error?.message || '浏览器拒绝'}`, 'warn');
      scheduleWakeLockRetry();
    }
  }

  function startKeepAwake() {
    if (!settings.keepAwake) {
      setAwakeStatus('保活未启用', 'info');
      return;
    }
    requestWakeLock();
    if (!state.heartbeatTimer) {
      state.heartbeatTimer = setInterval(() => {
        if (!state.running) return;
        if (document.visibilityState === 'visible') requestWakeLock();
      }, 15000);
    }
  }

  async function stopKeepAwake() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.wakeLockRetryTimer) clearTimeout(state.wakeLockRetryTimer);
    state.heartbeatTimer = null;
    state.wakeLockRetryTimer = null;
    if (state.wakeLock) {
      try {
        await state.wakeLock.release();
      } catch (error) {
        console.debug('[HiDevLab 助手] 释放 Wake Lock 失败', error);
      }
    }
    state.wakeLock = null;
    setAwakeStatus('保活已停止', 'info');
  }

  function sendNotification(title, body) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({
          title,
          text: body,
          timeout: 10000,
          onclick: () => window.focus(),
        });
        return true;
      }
      if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification(title, { body, tag: 'hidevlab-auto-power' });
        notification.onclick = () => window.focus();
        return true;
      }
    } catch (error) {
      console.warn('[HiDevLab 助手] 发送通知失败', error);
    }
    return false;
  }

  async function prepareNotifications() {
    if (typeof GM_notification === 'function') return true;
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      return (await Notification.requestPermission()) === 'granted';
    } catch (error) {
      return false;
    }
  }

  function clickElement(element) {
    if (!element || !isVisible(element) || element.disabled) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return true;
  }

  function findVisibleDialogByText(text) {
    return getVisibleDialogs().find((dialog) => cleanText(dialog.innerText).includes(text));
  }

  function clickDialogButton(dialog, label) {
    if (!dialog) return false;
    const button = [...dialog.querySelectorAll('button')]
      .find((candidate) => cleanText(candidate.innerText) === label);
    return clickElement(button);
  }

  async function confirmPowerOn() {
    if (!settings.autoConfirm) {
      state.confirmAwaiting = false;
      state.manualConfirmPending = true;
      log('已点击开机，等待手动确认。', 'wait');
      return;
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const dialog = findVisibleDialogByText('确认开机');
      if (dialog) {
        if (clickDialogButton(dialog, '确定')) {
          state.confirmAwaiting = false;
          state.manualConfirmPending = false;
          log(`已确认 ${state.pendingName}，等待资源调度…`, 'wait');
          return;
        }
      }
      await sleep(150);
    }
    state.confirmAwaiting = false;
    state.pendingName = null;
    state.pendingSince = 0;
    log('未找到“确认开机”对话框，本轮不重复提交。', 'warn');
  }

  function stop(reason = '已停止') {
    state.running = false;
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = null;
    state.ticking = false;
    stopKeepAwake();
    updateControls();
    log(reason, 'info');
  }

  function findSuccessfulRow(rows) {
    if (state.pendingName) {
      return rows.find((row) => row.name === state.pendingName && isSuccessStatus(row.status));
    }
    return rows.find((row) => isTarget(row) && isSuccessStatus(row.status));
  }

  function chooseCandidate(rows) {
    return rows.find((row) => isTarget(row)
      && isStoppedStatus(row.status)
      && row.powerButton
      && !row.powerButton.disabled);
  }

  function scheduleTick(delayMs = 100) {
    setTimeout(() => {
      if (state.running && !state.ticking) tick();
    }, Math.max(50, Number(delayMs) || 100));
  }

  async function submitCandidate(rows, force = false) {
    const candidate = chooseCandidate(rows);
    if (!candidate) {
      log('暂时没有符合条件的“已关机”环境。', 'wait');
      return false;
    }

    const now = Date.now();
    if (!force && now - state.lastActionAt < Math.max(1500, Number(settings.intervalMs) || DEFAULTS.intervalMs)) return false;
    state.lastActionAt = now;
    state.attempts += 1;
    updateControls();
    state.pendingName = candidate.name;
    state.pendingSince = now;
    state.manualConfirmPending = false;
    state.confirmAwaiting = clickElement(candidate.powerButton);
    if (state.confirmAwaiting) {
      log(`已点击 ${candidate.name} 的“开机”，等待确认框…`, 'action');
      await confirmPowerOn();
      scheduleTick(settings.retryDelayMs);
    }
    return true;
  }

  async function tick() {
    if (!state.running || state.ticking) return;
    state.ticking = true;
    try {
      const rows = getRows();
      const successRow = findSuccessfulRow(rows);
      if (successRow) {
        const successKey = `${successRow.name}:${successRow.status}`;
        if (!state.successNotified.has(successKey)) {
          state.successNotified.add(successKey);
          const body = `${successRow.name} 当前状态：${successRow.status}`;
          sendNotification('HiDevLab 开机成功', body);
          log(`抢卡成功：${body}`, 'success');
        }
        if (settings.stopOnSuccess) {
          stop('已成功，自动停止。');
          return;
        }
      }

      const dialogText = getVisibleDialogText();
      if (state.confirmAwaiting) {
        await confirmPowerOn();
        return;
      }

      if (state.manualConfirmPending) {
        if (findVisibleDialogByText('确认开机')) return;
        state.manualConfirmPending = false;
      }

      if (dialogText.includes('资源调度中')) {
        const queueDialog = findVisibleDialogByText('资源调度中');
        if (!clickDialogButton(queueDialog, '关闭')) {
          log('资源调度弹窗没有找到“关闭”按钮，等待页面更新。', 'warn');
          return;
        }
        log('已关闭“资源调度中”，立即重试开机。', 'action');
        state.pendingName = null;
        state.pendingSince = 0;
        await sleep(Math.max(50, Number(settings.retryDelayMs) || DEFAULTS.retryDelayMs));
        if (state.running) await submitCandidate(getRows(), true);
        return;
      }

      if (state.pendingName) {
        const pending = rows.find((row) => row.name === state.pendingName);
        if (pending && /开机中|连接中|准备中|启动中|申请中|排队|运行中/.test(pending.status)) {
          log(`${pending.name}：${pending.status}，等待结果。`, 'wait');
          return;
        }
        if (Date.now() - state.pendingSince < 800) return;
        state.pendingName = null;
        state.pendingSince = 0;
      }

      await submitCandidate(rows);
    } catch (error) {
      console.error('[HiDevLab 助手] 运行异常', error);
      log(`运行异常：${error?.message || error}`, 'error');
    } finally {
      state.ticking = false;
    }
  }

  function start() {
    if (state.running) return;
    if (targetNameSet().size === 0) {
      log('请先在自动识别列表中勾选至少一个目标环境。', 'warn');
      return;
    }
    state.running = true;
    state.pendingName = null;
    state.pendingSince = 0;
    state.successNotified.clear();
    state.attempts = 0;
    updateControls();
    log(`开始新一轮抢卡：每 ${Math.max(1500, settings.intervalMs)}ms 检查一次，尝试计数已重置。`, 'action');
    startKeepAwake();
    tick();
    state.tickTimer = setInterval(tick, Math.max(1500, settings.intervalMs));
  }

  function updateControls() {
    const startButton = shadowRoot?.querySelector('[data-action="start"]');
    const stopButton = shadowRoot?.querySelector('[data-action="stop"]');
    const stateBadge = shadowRoot?.querySelector('[data-role="running"]');
    const attemptBadge = shadowRoot?.querySelector('[data-role="attempts"]');
    if (startButton) startButton.disabled = state.running;
    if (stopButton) stopButton.disabled = !state.running;
    if (stateBadge) {
      stateBadge.textContent = state.running ? '运行中' : '已停止';
      stateBadge.dataset.running = String(state.running);
    }
    if (attemptBadge) attemptBadge.textContent = `尝试 ${state.attempts}`;
  }

  function setPanelPosition(x, y, persist = true) {
    const host = state.panelHost;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    const nextX = Math.min(Math.max(0, Number(x) || 0), maxX);
    const nextY = Math.min(Math.max(0, Number(y) || 0), maxY);
    host.style.left = `${Math.round(nextX)}px`;
    host.style.top = `${Math.round(nextY)}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    if (persist) {
      settings.panelPosition = { x: nextX, y: nextY };
      saveSettings();
    }
  }

  function applyPanelCollapsed() {
    const panel = shadowRoot?.querySelector('.panel');
    const button = shadowRoot?.querySelector('[data-action="toggle-collapse"]');
    if (!panel || !button) return;
    panel.classList.toggle('collapsed', Boolean(settings.panelCollapsed));
    button.textContent = settings.panelCollapsed ? '展开' : '收起';
    button.setAttribute('aria-expanded', String(!settings.panelCollapsed));
    requestAnimationFrame(() => {
      if (!state.panelHost) return;
      const rect = state.panelHost.getBoundingClientRect();
      setPanelPosition(rect.left, rect.top, false);
    });
  }

  function setupPanelInteractions() {
    const head = shadowRoot?.querySelector('.head');
    const collapseButton = shadowRoot?.querySelector('[data-action="toggle-collapse"]');
    if (!head || !collapseButton || !state.panelHost) return;

    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation();
      settings.panelCollapsed = !settings.panelCollapsed;
      saveSettings();
      applyPanelCollapsed();
    });

    const finishDrag = (event) => {
      if (!state.dragState || state.dragState.pointerId !== event.pointerId) return;
      try { head.releasePointerCapture(event.pointerId); } catch (error) { /* no-op */ }
      state.dragState = null;
      const rect = state.panelHost.getBoundingClientRect();
      setPanelPosition(rect.left, rect.top, true);
    };

    head.addEventListener('pointerdown', (event) => {
      if (event.target?.closest?.('button')) return;
      const rect = state.panelHost.getBoundingClientRect();
      state.dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      head.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    head.addEventListener('pointermove', (event) => {
      if (!state.dragState || state.dragState.pointerId !== event.pointerId) return;
      setPanelPosition(
        event.clientX - state.dragState.offsetX,
        event.clientY - state.dragState.offsetY,
        false,
      );
    });
    head.addEventListener('pointerup', finishDrag);
    head.addEventListener('pointercancel', finishDrag);
    window.addEventListener('resize', () => {
      const rect = state.panelHost.getBoundingClientRect();
      setPanelPosition(rect.left, rect.top, false);
    });

    if (settings.panelPosition) {
      setPanelPosition(settings.panelPosition.x, settings.panelPosition.y, false);
    }
    applyPanelCollapsed();
  }

  function bindSettings() {
    const intervalInput = shadowRoot.querySelector('[data-setting="intervalMs"]');
    const retryInput = shadowRoot.querySelector('[data-setting="retryDelayMs"]');
    const stopInput = shadowRoot.querySelector('[data-setting="stopOnSuccess"]');
    const confirmInput = shadowRoot.querySelector('[data-setting="autoConfirm"]');
    const awakeInput = shadowRoot.querySelector('[data-setting="keepAwake"]');

    intervalInput.value = String(settings.intervalMs);
    retryInput.value = String(settings.retryDelayMs);
    stopInput.checked = settings.stopOnSuccess;
    confirmInput.checked = settings.autoConfirm;
    awakeInput.checked = settings.keepAwake;

    intervalInput.addEventListener('change', () => {
      settings.intervalMs = Math.max(1500, Number(intervalInput.value) || DEFAULTS.intervalMs);
      intervalInput.value = String(settings.intervalMs);
      saveSettings();
    });
    retryInput.addEventListener('change', () => {
      settings.retryDelayMs = Math.max(50, Number(retryInput.value) || DEFAULTS.retryDelayMs);
      retryInput.value = String(settings.retryDelayMs);
      saveSettings();
    });
    stopInput.addEventListener('change', () => {
      settings.stopOnSuccess = stopInput.checked;
      saveSettings();
    });
    confirmInput.addEventListener('change', () => {
      settings.autoConfirm = confirmInput.checked;
      saveSettings();
    });
    awakeInput.addEventListener('change', () => {
      settings.keepAwake = awakeInput.checked;
      saveSettings();
      if (state.running) {
        if (settings.keepAwake) startKeepAwake();
        else stopKeepAwake();
      } else {
        setAwakeStatus(settings.keepAwake ? '运行时启用保活' : '保活未启用', 'info');
      }
    });
  }

  let shadowRoot;

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:16px;right:16px;';
    document.documentElement.appendChild(host);
    state.panelHost = host;
    shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel { width: 360px; color: #1f2937; background: #fff; border: 1px solid #dbe3ef; border-radius: 14px; box-shadow: 0 12px 38px rgba(15, 23, 42, .22); font: 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; overflow: hidden; }
        .head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding: 12px 14px; background: linear-gradient(135deg,#0f4c81,#1565c0); color:#fff; cursor:move; user-select:none; touch-action:none; }
        .head-title { min-width:0; display:flex; flex-direction:column; gap:2px; }
        .title { font-weight: 700; font-size: 14px; }
        .head-subtitle { font-size:10px; opacity:.78; }
        .head-actions { display:flex; align-items:center; gap:5px; flex-wrap:wrap; justify-content:flex-end; }
        .badge, .attempts { padding: 2px 7px; border-radius: 999px; background: rgba(255,255,255,.2); font-size: 11px; white-space:nowrap; }
        .badge[data-running="true"] { background: #16a34a; }
        .attempts { background: rgba(255,255,255,.14); }
        .collapse-button { color:#fff; background:rgba(255,255,255,.18); padding:4px 7px; font-size:11px; }
        .body { padding: 12px 14px 14px; }
        .panel.collapsed .body { display:none; }
        .row { display:grid; grid-template-columns: 108px 1fr; gap:8px; align-items:center; margin: 8px 0; }
        label { color:#475569; }
        input[type="number"], input[type="text"], select { width:100%; min-height:30px; border:1px solid #cbd5e1; border-radius:7px; padding: 4px 8px; font: inherit; color:#0f172a; background:#fff; }
        input:disabled { background:#f1f5f9; color:#94a3b8; }
        .check { display:flex; align-items:center; gap:7px; margin:8px 0; color:#334155; }
        .buttons { display:flex; gap:8px; margin: 12px 0 8px; }
        button { border:0; border-radius:8px; padding:7px 12px; cursor:pointer; font:600 13px/1.2 inherit; }
        button:disabled { cursor:not-allowed; opacity:.45; }
        .start { color:#fff; background:#0f766e; flex:1; }
        .stop { color:#fff; background:#b91c1c; flex:1; }
        .target-head { display:flex; justify-content:space-between; align-items:center; margin: 4px 0 6px; font-weight:600; color:#334155; }
        .target-count { color:#64748b; font-size:11px; font-weight:400; }
        .target-actions { display:flex; gap:6px; margin-bottom:6px; }
        .target-action { padding:4px 7px; color:#334155; background:#e2e8f0; font-size:11px; }
        .targets { max-height:150px; overflow:auto; border:1px solid #cbd5e1; border-radius:8px; padding:5px; background:#f8fafc; }
        .target-item { display:grid; grid-template-columns:18px minmax(0,1fr) auto; gap:6px; align-items:center; padding:6px 5px; border-radius:6px; cursor:pointer; }
        .target-item:hover { background:#e2e8f0; }
        .target-meta { min-width:0; display:flex; flex-direction:column; gap:1px; }
        .target-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#0f172a; }
        .target-description { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#64748b; font-size:10px; }
        .target-status { color:#64748b; font-size:11px; white-space:nowrap; }
        .target-empty { padding:8px 5px; color:#64748b; font-size:11px; }
        .hint { color:#64748b; font-size:11px; margin: 8px 0; }
        .status { min-height: 21px; padding: 6px 8px; border-radius:7px; background:#f1f5f9; color:#475569; }
        .status[data-kind="success"] { background:#dcfce7; color:#166534; }
        .status[data-kind="error"], .status[data-kind="warn"] { background:#fee2e2; color:#991b1b; }
        .awake { margin: 6px 0; color:#64748b; font-size:11px; }
        .awake[data-kind="success"] { color:#15803d; }
        .awake[data-kind="warn"] { color:#b45309; }
        .log-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; padding-top:6px; border-top:1px solid #e2e8f0; color:#64748b; font-size:11px; }
        .log-toggle { border:0; padding:2px 5px; color:#2563eb; background:transparent; font-size:11px; cursor:pointer; }
        .log { max-height: 180px; overflow:auto; margin-top:4px; color:#64748b; font-size:11px; }
        .log div { padding: 2px 0; }
        .log div[data-kind="success"] { color:#15803d; }
        .log div[data-kind="error"], .log div[data-kind="warn"] { color:#b91c1c; }
      </style>
      <section class="panel" aria-label="HiDevLab 自动开机助手">
        <header class="head" title="拖动此处移动面板"><div class="head-title"><span class="title">HiDevLab 抢卡助手</span><span class="head-subtitle">拖动标题栏移动</span></div><div class="head-actions"><span class="badge" data-role="running">已停止</span><span class="attempts" data-role="attempts">尝试 0</span><button class="collapse-button" data-action="toggle-collapse" aria-expanded="true">收起</button></div></header>
        <div class="body">
          <div class="target-head"><span>自动识别的开发环境</span><span class="target-count" data-role="target-count">已选 0</span></div>
          <div class="target-actions"><button class="target-action" data-action="select-stopped">全选已关机</button><button class="target-action" data-action="clear-selection">清空选择</button></div>
          <div class="targets" data-role="targets"></div>
          <div class="row"><label>检查间隔(ms)</label><input data-setting="intervalMs" type="number" min="1500" step="500"></div>
          <div class="row"><label>关闭后重试(ms)</label><input data-setting="retryDelayMs" type="number" min="50" step="50"></div>
          <label class="check"><input data-setting="autoConfirm" type="checkbox">自动点击“确认开机”</label>
          <label class="check"><input data-setting="stopOnSuccess" type="checkbox">成功后自动停止并通知</label>
          <label class="check"><input data-setting="keepAwake" type="checkbox">运行时尽量防止标签页休眠</label>
          <div class="buttons"><button class="start" data-action="start">开始抢卡</button><button class="stop" data-action="stop" disabled>停止</button></div>
          <div class="status" data-role="status">脚本已加载，默认不会自动点击。</div>
          <div class="awake" data-role="awake">运行时启用 Wake Lock 保活</div>
          <div class="hint">遇到“资源调度中”会点关闭并立即重试；只操作页面按钮，不调用隐藏接口。</div>
          <div class="log-head"><span>日志 <span data-role="log-count">0 条</span></span><button class="log-toggle" data-action="toggle-log">查看完整日志</button></div>
          <div class="log" data-role="log"></div>
        </div>
      </section>`;

    bindSettings();
    setupPanelInteractions();
    shadowRoot.querySelector('[data-action="toggle-log"]').addEventListener('click', toggleLogView);
    shadowRoot.querySelector('[data-action="select-stopped"]').addEventListener('click', () => {
      settings.selectedNames = getRows().filter((row) => isStoppedStatus(row.status)).map((row) => row.name);
      saveSettings();
      refreshTargetList();
    });
    shadowRoot.querySelector('[data-action="clear-selection"]').addEventListener('click', () => {
      settings.selectedNames = [];
      saveSettings();
      refreshTargetList();
    });
    shadowRoot.querySelector('[data-action="start"]').addEventListener('click', async () => {
      const notificationReady = await prepareNotifications();
      if (!notificationReady) log('通知权限未开启，成功时将只在面板中提示。', 'warn');
      start();
    });
    shadowRoot.querySelector('[data-action="stop"]').addEventListener('click', () => stop());
    refreshTargetList();
    setAwakeStatus(settings.keepAwake ? '运行时启用 Wake Lock 保活' : '保活未启用', 'info');
    renderLogs();
    updateControls();
  }

  function observePage() {
    state.observer = new MutationObserver(() => {
      scheduleTargetRefresh();
      if (state.running && !state.ticking) tick();
    });
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'class'] });
  }

  function init() {
    createPanel();
    observePage();
    document.addEventListener('visibilitychange', () => {
      if (state.running) requestWakeLock();
    });
    log('脚本已加载，默认不会自动点击。', 'info');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
