// storage-manager.js
// AUTOMATA_CORE_V5 - Persistence Layer
// LocalStorage <-> Backend DB sync, matching the PLAYER / WAREHOUSE_LEVELS /
// PLAYER_COMMANDS / COMMAND_UNLOCK_RULES schema from the ERD (5.3.1).
//
// Load this file BEFORE bot-controller.js:
//   <script src="storage-manager.js"></script>
//   <script src="bot-controller.js"></script>

(function (global) {
    'use strict';

    // =========================================================================
    // CONFIG
    // =========================================================================
    const CONFIG = {
        LOCAL_STORAGE_KEY: 'automata_core_save_v1',
        PLAYER_ID_KEY: 'automata_core_player_id',
        API_BASE: '/api',
        SAVE_ENDPOINT: '/api/player/save',
        LOAD_ENDPOINT: '/api/player/load',
        COMMAND_UNLOCK_ENDPOINT: '/api/player/commands/unlock',
        BOTS_SAVE_ENDPOINT: '/api/player/bots/save',
        // Frequent, low-stakes changes (gold ticking up) get debounced.
        DEBOUNCE_MS: 2500,
        // Critical milestones bypass the debounce and sync immediately.
        MAX_RETRY_ATTEMPTS: 4,
        RETRY_BASE_DELAY_MS: 1000,
    };

    // =========================================================================
    // COMMAND_UNLOCK_RULES (static reference table, mirrors the ERD)
    // Maps purchasable upgrade/command ids -> rule metadata. Base commands
    // (move, wait, turnLeft, etc.) are tier 0 / free and included only for
    // completeness; only tier >= 1 entries are ever purchased at runtime.
    // =========================================================================
    const COMMAND_UNLOCK_RULES = Object.freeze({
        move:             { rule_id: 'RULE-000', command_name: 'move',             gold_threshold: 0,   tier_level: 0, description: 'Base movement command, unlocked by default.' },
        wait:             { rule_id: 'RULE-001', command_name: 'wait',             gold_threshold: 0,   tier_level: 0, description: 'Base wait command, unlocked by default.' },
        turnLeft:         { rule_id: 'RULE-002', command_name: 'turnLeft',         gold_threshold: 0,   tier_level: 0, description: 'Base rotate-left command, unlocked by default.' },
        turnRight:        { rule_id: 'RULE-003', command_name: 'turnRight',        gold_threshold: 0,   tier_level: 0, description: 'Base rotate-right command, unlocked by default.' },
        pickup:           { rule_id: 'RULE-004', command_name: 'pickup',           gold_threshold: 0,   tier_level: 0, description: 'Base pickup command, unlocked by default.' },
        dropoff:          { rule_id: 'RULE-005', command_name: 'dropoff',          gold_threshold: 0,   tier_level: 0, description: 'Base dropoff command, unlocked by default.' },
        faster_cpu:       { rule_id: 'RULE-101', command_name: 'faster_cpu',       gold_threshold: 450, tier_level: 1, description: 'Reduces command execution delay by ~15%.' },
        spectral_scanner: { rule_id: 'RULE-102', command_name: 'spectral_scanner', gold_threshold: 600, tier_level: 2, description: 'Enables advanced sensor readout with crate value scanning.' },
    });

    function getUnlockRule(commandOrUpgradeId) {
        return COMMAND_UNLOCK_RULES[commandOrUpgradeId] || {
            rule_id: `RULE-CUSTOM-${commandOrUpgradeId}`,
            command_name: commandOrUpgradeId,
            gold_threshold: 0,
            tier_level: 0,
            description: 'Unregistered rule (not present in COMMAND_UNLOCK_RULES).',
        };
    }

    function getOrCreatePlayerId() {
        let id = localStorage.getItem(CONFIG.PLAYER_ID_KEY);
        if (!id) {
            id = 'PLYR-' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
            localStorage.setItem(CONFIG.PLAYER_ID_KEY, id);
        }
        return id;
    }

    function nowIso() {
        return new Date().toISOString();
    }

    // =========================================================================
    // A. LocalStorageService
    // =========================================================================
    const LocalStorageService = {
        getDefaultState(playerId) {
            return {
                player_id: playerId,
                gold: 0,
                unlocked_commands: ['move', 'wait', 'turnLeft', 'turnRight', 'pickup', 'dropoff'],
                // PLAYER_COMMANDS rows: { rule_id, unlocked_at } - one per unlocked rule.
                player_commands: [],
                warehouse_level_FK: 1,
                max_bots: 2,
                total_play_time: 0,
                fleet: [],
                active_upgrades: [],
                // saved_scripts: [{ script_id, title, code }] - one entry per bot's editor contents.
                saved_scripts: [],
                created_at: nowIso(),
                updated_at: nowIso(),
            };
        },

        /**
         * Persists the given player state to LocalStorage as JSON.
         * @param {object} playerState - shape matching the PLAYER table + fleet/upgrades extras
         */
        saveGameData(playerState) {
            try {
                const payload = {
                    ...playerState,
                    updated_at: nowIso(),
                };
                localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(payload));
                return payload;
            } catch (err) {
                console.error('[LocalStorageService] Failed to save game data:', err);
                return null;
            }
        },

        /**
         * Loads player state from LocalStorage, falling back to sane defaults
         * (Gold = 0, Warehouse Level = 1) if no save exists or it's corrupt.
         */
        loadGameData() {
            const playerId = getOrCreatePlayerId();
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);

            if (!raw) {
                const defaults = this.getDefaultState(playerId);
                this.saveGameData(defaults);
                return defaults;
            }

            try {
                const parsed = JSON.parse(raw);
                // Merge over defaults so newly-added fields never come back undefined.
                return { ...this.getDefaultState(playerId), ...parsed };
            } catch (err) {
                console.warn('[LocalStorageService] Corrupt save detected, resetting to defaults:', err);
                const defaults = this.getDefaultState(playerId);
                this.saveGameData(defaults);
                return defaults;
            }
        },

        clear() {
            localStorage.removeItem(CONFIG.LOCAL_STORAGE_KEY);
        },
    };

    // =========================================================================
    // B. SyncService
    // =========================================================================
    const SyncService = {
        _debounceTimer: null,
        _pendingState: null,
        _isSyncing: false,
        _isOnline: true,

        /**
         * Builds the exact PLAYER-table-shaped payload the backend expects.
         * BOT rows are synced separately via toBotsApiPayload()/syncFleet(),
         * so the PLAYER row itself stays lean.
         */
        toApiPayload(playerState) {
            return {
                player_id: playerState.player_id,
                gold: playerState.gold,
                unlocked_commands: JSON.stringify(playerState.unlocked_commands || []),
                saved_scripts: JSON.stringify(playerState.saved_scripts || []),
                warehouse_level_FK: playerState.warehouse_level_FK,
                max_bots: playerState.max_bots,
                total_play_time: playerState.total_play_time,
                created_at: playerState.created_at,
                updated_at: nowIso(),
                // Non-ERD-core extra carried alongside for full fidelity restores.
                // A stricter backend can ignore/strip this server-side.
                _extras: {
                    active_upgrades: playerState.active_upgrades || [],
                },
            };
        },

        /**
         * Builds BOT-table-shaped rows (per the ERD) from the controller's
         * fleet snapshot, ready to POST to BOTS_SAVE_ENDPOINT.
         */
        toBotsApiPayload(playerId, fleet) {
            return (fleet || []).map(bot => ({
                bot_id: bot.bot_id,
                player_id_FK: playerId,
                position_x: bot.x,
                position_y: bot.y,
                facing_direction: bot.orientationIndex,
                state: bot.taskState || 'IDLE',
                battery_level: bot.battery_level != null ? bot.battery_level : 100,
                inventory_FK: bot.inventory_FK || null,
                script: bot.script,
                last_executed: nowIso(),
            }));
        },

        /**
         * Writes one PLAYER_COMMANDS row (referencing COMMAND_UNLOCK_RULES)
         * for a newly unlocked command/upgrade.
         */
        toCommandUnlockPayload(playerId, ruleId, unlockedAt) {
            return {
                player_id: playerId,
                rule_id: ruleId,
                unlocked_at: unlockedAt || nowIso(),
            };
        },

        async _postToApi(endpoint, payload) {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(`Sync request failed: ${response.status} ${response.statusText}`);
            }
            return response.json().catch(() => ({}));
        },

        async _syncWithRetry(playerState, attempt = 1) {
            const payload = this.toApiPayload(playerState);
            try {
                this._isSyncing = true;
                const result = await this._postToApi(CONFIG.SAVE_ENDPOINT, payload);
                this._isSyncing = false;
                this._isOnline = true;
                return result;
            } catch (err) {
                this._isSyncing = false;
                console.warn(`[SyncService] Sync attempt ${attempt} failed:`, err.message);

                if (attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
                    const delay = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    await new Promise(res => setTimeout(res, delay));
                    return this._syncWithRetry(playerState, attempt + 1);
                }

                this._isOnline = false;
                console.error('[SyncService] All sync attempts exhausted. Local save is preserved; will retry on next change.');
                return null;
            }
        },

        /**
         * Debounced sync - used for frequent, low-stakes updates like gold
         * accumulation from repeated dropoff() calls. Coalesces rapid-fire
         * changes into a single network request.
         */
        syncDebounced(playerState) {
            this._pendingState = playerState;
            if (this._debounceTimer) clearTimeout(this._debounceTimer);

            this._debounceTimer = setTimeout(() => {
                const stateToSync = this._pendingState;
                this._pendingState = null;
                this._debounceTimer = null;
                this._syncWithRetry(stateToSync);
            }, CONFIG.DEBOUNCE_MS);
        },

        /**
         * Immediate sync - used for critical milestones (warehouse upgrades,
         * command unlocks) that should never be lost to a debounce window.
         */
        async syncImmediate(playerState) {
            if (this._debounceTimer) {
                clearTimeout(this._debounceTimer);
                this._debounceTimer = null;
                this._pendingState = null;
            }
            return this._syncWithRetry(playerState);
        },

        /**
         * Immediately syncs the fleet snapshot as BOT rows. Fleet composition
         * changes (new unit purchased) are rare and important enough to skip
         * the debounce.
         */
        async syncFleet(playerId, fleet) {
            const payload = this.toBotsApiPayload(playerId, fleet);
            try {
                this._isSyncing = true;
                const result = await this._postToApi(CONFIG.BOTS_SAVE_ENDPOINT, { player_id: playerId, bots: payload });
                this._isSyncing = false;
                return result;
            } catch (err) {
                this._isSyncing = false;
                console.warn('[SyncService] Fleet sync failed (will retry on next fleet change):', err.message);
                return null;
            }
        },

        /**
         * Immediately writes a PLAYER_COMMANDS row referencing the matching
         * COMMAND_UNLOCK_RULES entry. Unlocks are milestones, so no debounce.
         */
        async syncCommandUnlock(playerId, ruleId, unlockedAt) {
            const payload = this.toCommandUnlockPayload(playerId, ruleId, unlockedAt);
            try {
                this._isSyncing = true;
                const result = await this._postToApi(CONFIG.COMMAND_UNLOCK_ENDPOINT, payload);
                this._isSyncing = false;
                return result;
            } catch (err) {
                this._isSyncing = false;
                console.warn('[SyncService] Command unlock sync failed (will retry on next unlock):', err.message);
                return null;
            }
        },

        /**
         * Pulls the latest server-side copy of the player row. Useful for
         * cross-device hydration; falls back to null on failure so the caller
         * can keep using the LocalStorage copy.
         */
        async loadFromServer(playerId) {
            try {
                const response = await fetch(`${CONFIG.LOAD_ENDPOINT}?player_id=${encodeURIComponent(playerId)}`);
                if (!response.ok) throw new Error(`Load failed: ${response.status}`);
                const data = await response.json();
                return {
                    ...data,
                    unlocked_commands: typeof data.unlocked_commands === 'string'
                        ? JSON.parse(data.unlocked_commands)
                        : (data.unlocked_commands || []),
                    active_upgrades: data._extras && data._extras.active_upgrades ? data._extras.active_upgrades : [],
                };
            } catch (err) {
                console.warn('[SyncService] Could not load from server, using local save instead:', err.message);
                return null;
            }
        },
    };

    // =========================================================================
    // C. PersistenceManager - wires LocalStorageService + SyncService into
    //    AdvancedBotController without needing to rewrite its internals.
    // =========================================================================
    class PersistenceManager {
        constructor() {
            this.playerState = LocalStorageService.loadGameData();
            this.controller = null;
            this._playTimeInterval = null;
        }

        /**
         * Serializes the live controller into a PLAYER-table-shaped object.
         */
        serialize(controller) {
            return {
                ...this.playerState,
                gold: controller.gold,
                warehouse_level_FK: controller.warehouseLevel,
                max_bots: Math.max(this.playerState.max_bots || 2, controller.bots.length),
                unlocked_commands: Array.from(new Set([
                    ...(this.playerState.unlocked_commands || []),
                    ...Array.from(controller.activeUpgrades || []),
                ])),
                active_upgrades: Array.from(controller.activeUpgrades || []),
                player_commands: this.playerState.player_commands || [],
                saved_scripts: typeof controller.getScriptSnapshot === 'function'
                    ? controller.getScriptSnapshot()
                    : (this.playerState.saved_scripts || []),
                fleet: controller.bots.map(b => ({
                    bot_id: b.bot_id,
                    x: b.x,
                    y: b.y,
                    orientationIndex: b.orientationIndex,
                    script: b.script,
                })),
            };
        }

        /**
         * Attaches save/sync hooks to a live AdvancedBotController instance and
         * hydrates it from whatever was last persisted (LocalStorage first,
         * with an optional async server reconciliation pass).
         */
        attach(controller) {
            this.controller = controller;
            this._hydrateController(controller);
            this._startPlayTimeTracking();

            // --- Hook: gold changes from dropoff() ---
            const originalDropoff = controller.dropoff.bind(controller);
            controller.dropoff = (...args) => {
                const goldBefore = controller.gold;
                const result = originalDropoff(...args);
                if (controller.gold !== goldBefore) {
                    this.onGoldChange(controller);
                }
                return result;
            };

            // --- Hook: warehouse level changes from upgradeWarehouse() ---
            const originalUpgradeWarehouse = controller.upgradeWarehouse.bind(controller);
            controller.upgradeWarehouse = (...args) => {
                const levelBefore = controller.warehouseLevel;
                const result = originalUpgradeWarehouse(...args);
                if (controller.warehouseLevel !== levelBefore) {
                    this.onWarehouseUpgrade(controller);
                }
                return result;
            };

            // --- Hook: command/ability unlocks from purchaseUpgrade() ---
            const originalPurchaseUpgrade = controller.purchaseUpgrade.bind(controller);
            controller.purchaseUpgrade = (upgradeId, cost) => {
                const hadUpgrade = controller.activeUpgrades.has(upgradeId);
                const result = originalPurchaseUpgrade(upgradeId, cost);
                if (!hadUpgrade && controller.activeUpgrades.has(upgradeId)) {
                    this.onCommandUnlock(controller, upgradeId);
                } else if (controller.gold !== undefined) {
                    this.onGoldChange(controller); // gold spent, still worth a debounced save
                }
                return result;
            };

            // --- Hook: fleet growth from purchaseNewBot() ---
            const originalPurchaseNewBot = controller.purchaseNewBot.bind(controller);
            controller.purchaseNewBot = (...args) => {
                const fleetBefore = controller.bots.length;
                const result = originalPurchaseNewBot(...args);
                if (controller.bots.length !== fleetBefore) {
                    this.onFleetChange(controller);
                }
                return result;
            };

            // --- Hook: script edits in the code editor textarea ---
            const scriptTextarea = document.getElementById('code-textarea');
            if (scriptTextarea) {
                scriptTextarea.addEventListener('input', () => {
                    this.onScriptEdit(controller);
                });
            }

            // Persist on tab close as a final safety net.
            window.addEventListener('beforeunload', () => {
                LocalStorageService.saveGameData(this.serialize(controller));
            });

            controller.persistence = this;
            return controller;
        }

        _hydrateController(controller) {
            const state = this.playerState;
            controller.gold = state.gold;
            controller.warehouseLevel = state.warehouse_level_FK;
            (state.active_upgrades || []).forEach(id => controller.activeUpgrades.add(id));

            const config = (global.WAREHOUSE_LEVELS || {})[state.warehouse_level_FK];
            if (config) {
                controller.gridWidth = config.width;
                controller.gridHeight = config.height;
            }

            if (Array.isArray(state.fleet) && state.fleet.length > 0) {
                state.fleet.forEach(saved => {
                    const bot = controller.bots.find(b => b.bot_id === saved.bot_id);
                    if (bot) {
                        bot.x = saved.x;
                        bot.y = saved.y;
                        bot.orientationIndex = saved.orientationIndex;
                        bot.script = saved.script;
                    }
                });
            }

            // saved_scripts is the source of truth for editor contents (it's
            // captured live from the DOM on every save, whereas fleet[].script
            // above is only as fresh as the last bot switch) - apply it last
            // so it wins, and so the visible editor gets refreshed on boot.
            if (typeof controller.hydrateScripts === 'function') {
                controller.hydrateScripts(state.saved_scripts);
            }
        }

        _startPlayTimeTracking() {
            // Increment total_play_time (seconds) every 30s and piggyback a
            // debounced save so playtime isn't lost on crash/refresh.
            this._playTimeInterval = setInterval(() => {
                this.playerState.total_play_time = (this.playerState.total_play_time || 0) + 30;
                if (this.controller) this.onGoldChange(this.controller);
            }, 30000);
        }

        // --- Event handlers -------------------------------------------------

        /**
         * Debounced save triggered on every keystroke in the script editor.
         * Waits for a pause in typing before writing to LocalStorage/sync so
         * we don't thrash on every character.
         */
        onScriptEdit(controller) {
            if (this._scriptEditDebounce) clearTimeout(this._scriptEditDebounce);
            this._scriptEditDebounce = setTimeout(() => {
                this.playerState = this.serialize(controller);
                LocalStorageService.saveGameData(this.playerState);
                SyncService.syncDebounced(this.playerState);
            }, 1000);
        }

        onGoldChange(controller) {
            this.playerState = this.serialize(controller);
            LocalStorageService.saveGameData(this.playerState);
            SyncService.syncDebounced(this.playerState);
        }

        onWarehouseUpgrade(controller) {
            this.playerState = this.serialize(controller);
            LocalStorageService.saveGameData(this.playerState);
            SyncService.syncImmediate(this.playerState);
        }

        onCommandUnlock(controller, commandOrUpgradeId) {
            this.playerState = this.serialize(controller);

            const rule = getUnlockRule(commandOrUpgradeId);
            const unlockedAt = nowIso();

            if (!this.playerState.unlocked_commands.includes(commandOrUpgradeId)) {
                this.playerState.unlocked_commands.push(commandOrUpgradeId);
            }
            if (!this.playerState.player_commands.some(pc => pc.rule_id === rule.rule_id)) {
                this.playerState.player_commands.push({ rule_id: rule.rule_id, unlocked_at: unlockedAt });
            }

            LocalStorageService.saveGameData(this.playerState);
            // Gold was spent to unlock this, so the PLAYER row needs a sync too.
            SyncService.syncImmediate(this.playerState);
            // Dedicated PLAYER_COMMANDS row, per the ERD's join table.
            SyncService.syncCommandUnlock(this.playerState.player_id, rule.rule_id, unlockedAt);
        }

        onFleetChange(controller) {
            this.playerState = this.serialize(controller);
            LocalStorageService.saveGameData(this.playerState);
            // max_bots may have changed on the PLAYER row.
            SyncService.syncImmediate(this.playerState);
            // Fleet composition itself syncs as BOT rows via its own endpoint.
            SyncService.syncFleet(this.playerState.player_id, this.playerState.fleet);
        }
    }

    // =========================================================================
    // Exports
    // =========================================================================
    global.LocalStorageService = LocalStorageService;
    global.SyncService = SyncService;
    global.PersistenceManager = PersistenceManager;
    global.COMMAND_UNLOCK_RULES = COMMAND_UNLOCK_RULES;

})(window);
