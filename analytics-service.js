// analytics-service.js
// AUTOMATA_CORE_V5 - Real-Time Analytics & EXECUTION_LOG Entity Tracking
//
// Wires into the existing (currently dormant) UI hooks already present in
// index.html: #ui-throughput / #ui-throughput-bar, #ui-errors, the Uptime
// stat card, #flow-graph-container, and the footer's ERR_LOGS link.
//
// Load order (see index.html):
//   <script src="storage-manager.js"></script>
//   <script src="analytics-service.js"></script>
//   <script src="bot-controller.js"></script>

(function (global) {
    'use strict';

    const CONFIG = {
        LOGS_SYNC_ENDPOINT: '/api/player/logs/sync',
        SAMPLE_INTERVAL_MS: 1000,       // uptime state sampling cadence
        FLOW_BUCKET_MS: 12000,          // 5 buckets x 12s = 60s rolling flow graph
        PERSIST_INTERVAL_MS: 10000,     // how often logs are buffered -> saved/synced
        MAX_BUFFER: 500,                // in-memory cap
        MAX_PERSISTED: 200,             // cap written to LocalStorage / sent to API
        TARGET_DELIVERIES_PER_MIN: 4,   // normalizes throughput into a 0-100% gauge
        ERROR_WINDOW_SIZE: 50,          // rolling window for the error-rate stat
        RECENT_ERROR_MS: 2000,          // how "fresh" an error must be to count toward uptime's error bucket
    };

    function nowIso() {
        return new Date().toISOString();
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // =========================================================================
    // ExecutionLogService - buffers EXECUTION_LOG rows
    //   { log_id, bot_id, timestamp, command_executed, success, message }
    // =========================================================================
    const ExecutionLogService = {
        _buffer: [],
        _counter: 0,

        createEntry({ botId, commandExecuted, success, message }) {
            this._counter += 1;
            const entry = {
                log_id: `LOG-${Date.now()}-${this._counter}`,
                bot_id: botId || 'SYSTEM',
                timestamp: nowIso(),
                command_executed: commandExecuted || 'UNKNOWN',
                success: !!success,
                message: message || '',
            };
            this._buffer.push(entry);
            if (this._buffer.length > CONFIG.MAX_BUFFER) this._buffer.shift();
            return entry;
        },

        getAll() { return this._buffer.slice(); },
        getRecent(n) { return this._buffer.slice(-n); },
        getPersistable() { return this._buffer.slice(-CONFIG.MAX_PERSISTED); },
        hydrate(entries) {
            if (Array.isArray(entries)) this._buffer = entries.slice(-CONFIG.MAX_BUFFER);
        },
        clear() { this._buffer = []; },
    };

    // =========================================================================
    // AnalyticsService - metrics + DOM wiring + persistence of the log buffer
    // =========================================================================
    class AnalyticsService {
        constructor() {
            this.controller = null;
            this.sessionStart = performance.now();
            this.stateSeconds = { active: 0, idle: 0, error: 0 };
            this.deliveryTimestamps = [];   // for the throughput gauge (last 60s)
            this.flowBuckets = [0, 0, 0, 0, 0];
            this._currentFlowBucketCount = 0;
            this._currentCommandContext = null;
            this._loggedDuringCurrentCommand = false;
            this._sampleTimer = null;
            this._flowBucketTimer = null;
            this._persistTimer = null;
        }

        attach(controller) {
            this.controller = controller;
            this._hydrateFromLocalLog();
            this._wrapExecuteCommand(controller);
            this._wrapDisplayError(controller);
            this._wrapParseAndExecute(controller);
            this._wrapDropoffForThroughput(controller);
            this._wireLogViewer();

            this._sampleTimer = setInterval(() => this._sampleUptimeState(), CONFIG.SAMPLE_INTERVAL_MS);
            this._flowBucketTimer = setInterval(() => this._rotateFlowBucket(), CONFIG.FLOW_BUCKET_MS);
            this._persistTimer = setInterval(() => this._persistLogs(), CONFIG.PERSIST_INTERVAL_MS);
            window.addEventListener('beforeunload', () => this._persistLogs());

            this._updateDOM();
            controller.analytics = this;
            return controller;
        }

        // --- Hooks --------------------------------------------------------

        _wrapExecuteCommand(controller) {
            const original = controller.executeCommand.bind(controller);
            controller.executeCommand = (commandObj) => {
                const cmdName = typeof commandObj === 'object' ? commandObj.name : commandObj;
                const bot = controller.getActiveBot();
                this._currentCommandContext = { botId: bot ? bot.bot_id : 'UNKNOWN', command: cmdName };
                this._loggedDuringCurrentCommand = false;

                const result = original(commandObj);

                // If the command didn't already log itself via displayError
                // (e.g. a plain successful move/turn/wait/scan), log a default
                // SUCCESS entry so every executed command has exactly one row.
                if (!this._loggedDuringCurrentCommand && cmdName) {
                    ExecutionLogService.createEntry({
                        botId: this._currentCommandContext.botId,
                        commandExecuted: cmdName,
                        success: true,
                        message: 'OK',
                    });
                }
                this._currentCommandContext = null;
                return result;
            };
        }

        _wrapDisplayError(controller) {
            const original = controller.displayError.bind(controller);
            controller.displayError = (message) => {
                const ctx = this._currentCommandContext;
                const isError = /^ERR:/i.test(message);
                const isSuccess = /^SUCCESS:/i.test(message);
                const status = isError ? 'ERROR' : (isSuccess ? 'SUCCESS' : 'WARNING');
                const activeBot = controller.getActiveBot();

                ExecutionLogService.createEntry({
                    botId: ctx ? ctx.botId : (activeBot ? activeBot.bot_id : 'SYSTEM'),
                    commandExecuted: ctx ? ctx.command : 'SYSTEM_EVENT',
                    success: !isError,
                    message: `[${status}] ${message}`,
                });
                this._loggedDuringCurrentCommand = true;

                return original(message);
            };
        }

        _wrapParseAndExecute(controller) {
            const original = controller.parseAndExecute.bind(controller);
            controller.parseAndExecute = (scriptString) => {
                const bot = controller.getActiveBot();
                // Tags any compile-time (script syntax) error raised inside
                // the original as a SCRIPT_COMPILE log entry via displayError.
                this._currentCommandContext = { botId: bot ? bot.bot_id : 'UNKNOWN', command: 'SCRIPT_COMPILE' };
                this._loggedDuringCurrentCommand = false;
                const result = original(scriptString);
                this._currentCommandContext = null;
                return result;
            };
        }

        _wrapDropoffForThroughput(controller) {
            const original = controller.dropoff.bind(controller);
            controller.dropoff = (...args) => {
                const goldBefore = controller.gold;
                const result = original(...args);
                if (controller.gold > goldBefore) {
                    const ts = Date.now();
                    this.deliveryTimestamps.push(ts);
                    this._currentFlowBucketCount += 1;
                }
                return result;
            };
        }

        // --- Sampling / bucketing -----------------------------------------

        _sampleUptimeState() {
            const recentError = ExecutionLogService.getRecent(5).some(
                e => !e.success && (Date.now() - new Date(e.timestamp).getTime()) < CONFIG.RECENT_ERROR_MS
            );
            const bots = (this.controller && this.controller.bots) || [];
            const anyActive = bots.some(b => Array.isArray(b.taskQueue) && b.taskQueue.length > 0);

            if (recentError) this.stateSeconds.error += 1;
            else if (anyActive) this.stateSeconds.active += 1;
            else this.stateSeconds.idle += 1;

            this._updateDOM();
        }

        _rotateFlowBucket() {
            this.flowBuckets.push(this._currentFlowBucketCount);
            if (this.flowBuckets.length > 5) this.flowBuckets.shift();
            this._currentFlowBucketCount = 0;
            this._renderFlowGraph();
        }

        // --- DOM rendering ---------------------------------------------------

        _updateDOM() {
            const now = Date.now();
            this.deliveryTimestamps = this.deliveryTimestamps.filter(t => now - t <= 60000);
            const perMinute = this.deliveryTimestamps.length;
            const efficiencyPct = Math.min(100, (perMinute / CONFIG.TARGET_DELIVERIES_PER_MIN) * 100);

            const throughputEl = document.getElementById('ui-throughput');
            const throughputBar = document.getElementById('ui-throughput-bar');
            if (throughputEl) {
                throughputEl.textContent = `${efficiencyPct.toFixed(1)}%`;
                throughputEl.title = `${perMinute} deliveries in the last 60s`;
            }
            if (throughputBar) throughputBar.style.width = `${efficiencyPct.toFixed(1)}%`;

            const elapsedMs = performance.now() - this.sessionStart;
            const totalMin = Math.floor(elapsedMs / 60000);
            const hours = Math.floor(totalMin / 60);
            const mins = totalMin % 60;
            const uptimeEl = document.getElementById('ui-uptime');
            if (uptimeEl) {
                uptimeEl.textContent = `${hours}h ${String(mins).padStart(2, '0')}m`;
                const totalSampled = this.stateSeconds.active + this.stateSeconds.idle + this.stateSeconds.error;
                if (totalSampled > 0) {
                    const activePct = ((this.stateSeconds.active / totalSampled) * 100).toFixed(0);
                    const idlePct = ((this.stateSeconds.idle / totalSampled) * 100).toFixed(0);
                    const errorPct = ((this.stateSeconds.error / totalSampled) * 100).toFixed(0);
                    uptimeEl.title = `Active ${activePct}% | Idle ${idlePct}% | Error ${errorPct}%`;
                }
            }

            const recentLogs = ExecutionLogService.getRecent(CONFIG.ERROR_WINDOW_SIZE);
            const errorCount = recentLogs.filter(e => !e.success).length;
            const errorPctVal = recentLogs.length > 0 ? (errorCount / recentLogs.length) * 100 : 0;
            const errorsEl = document.getElementById('ui-errors');
            if (errorsEl) errorsEl.textContent = `${errorPctVal.toFixed(2)}%`;

            this._renderFlowGraph();
        }

        _renderFlowGraph() {
            const container = document.getElementById('flow-graph-container');
            if (!container) return;
            const bars = container.children;
            const maxVal = Math.max(1, ...this.flowBuckets);
            for (let i = 0; i < bars.length; i++) {
                const val = this.flowBuckets[i] || 0;
                const pct = Math.min(100, (val / maxVal) * 100);
                bars[i].style.height = `${pct}%`;
            }
        }

        // --- EXECUTION_LOG viewer (footer "ERR_LOGS" link) ------------------

        _wireLogViewer() {
            const link = document.getElementById('err-logs-link');
            if (link) {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.openLogViewer();
                });
            }
            const closeBtn = document.getElementById('log-viewer-close');
            if (closeBtn) closeBtn.addEventListener('click', () => this.closeLogViewer());
            const backdrop = document.getElementById('log-viewer-modal');
            if (backdrop) {
                backdrop.addEventListener('click', (e) => {
                    if (e.target === backdrop) this.closeLogViewer();
                });
            }
        }

        openLogViewer() {
            const modal = document.getElementById('log-viewer-modal');
            const body = document.getElementById('log-viewer-body');
            if (!modal || !body) return;

            const entries = ExecutionLogService.getAll().slice().reverse().slice(0, 200);
            body.innerHTML = entries.length > 0
                ? entries.map(e => `
                    <div class="flex gap-2 py-1 border-b border-outline-variant/30 font-code-sm text-[10px] ${e.success ? 'text-on-surface-variant' : 'text-secondary-container'}">
                        <span class="w-20 shrink-0">${escapeHtml(new Date(e.timestamp).toLocaleTimeString())}</span>
                        <span class="w-28 shrink-0 text-primary">${escapeHtml(e.bot_id)}</span>
                        <span class="w-28 shrink-0">${escapeHtml(e.command_executed)}</span>
                        <span class="w-12 shrink-0 font-bold ${e.success ? 'text-tertiary' : 'text-secondary-container'}">${e.success ? 'OK' : 'ERR'}</span>
                        <span class="flex-1 break-words">${escapeHtml(e.message)}</span>
                    </div>
                `).join('')
                : '<div class="text-on-surface-variant text-xs p-4">No executions logged yet.</div>';

            modal.classList.remove('hidden');
        }

        closeLogViewer() {
            const modal = document.getElementById('log-viewer-modal');
            if (modal) modal.classList.add('hidden');
        }

        // --- Persistence: buffer -> LocalStorage snapshot + backend sync ---

        _hydrateFromLocalLog() {
            if (!global.LocalStorageService) return;
            try {
                const saved = global.LocalStorageService.loadGameData();
                if (Array.isArray(saved.execution_log)) {
                    ExecutionLogService.hydrate(saved.execution_log);
                }
            } catch (err) {
                console.warn('[AnalyticsService] Could not hydrate execution log:', err.message);
            }
        }

        _persistLogs() {
            if (!global.LocalStorageService) return;

            // Merge into the same snapshot storage-manager.js writes/reads,
            // rather than a separate key, so one save = one source of truth.
            const current = global.LocalStorageService.loadGameData();
            current.execution_log = ExecutionLogService.getPersistable();
            global.LocalStorageService.saveGameData(current);

            fetch(CONFIG.LOGS_SYNC_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    player_id: current.player_id,
                    logs: ExecutionLogService.getRecent(CONFIG.ERROR_WINDOW_SIZE),
                }),
            }).catch(err => {
                console.warn('[AnalyticsService] Log sync failed (buffer kept, will retry next cycle):', err.message);
            });
        }
    }

    global.ExecutionLogService = ExecutionLogService;
    global.AnalyticsService = AnalyticsService;

})(window);
