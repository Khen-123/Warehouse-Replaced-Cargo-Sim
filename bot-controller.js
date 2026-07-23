// bot-controller.js
// AUTOMATA_CORE_V5 - Warehouse Level Upgrades & Automated Decision Gateways

const BOT_DIRECTIONS = [
    { name: 'right', x: 1, y: 0 },
    { name: 'down', x: 0, y: 1 },
    { name: 'left', x: -1, y: 0 },
    { name: 'up', x: 0, y: -1 },
];

const BOT_COMMAND_LIBRARY = Object.freeze({
    move: 'move',
    strafeLeft: 'strafeLeft',
    strafeRight: 'strafeRight',
    wait: 'wait',
    turnLeft: 'turnLeft',
    turnRight: 'turnRight',
    pickup: 'pickup',
    dropoff: 'dropoff',
    scan: 'scan',
    isBlocked: 'isBlocked',
});

// --- CRATE SCHEMA CLASSIFICATION & COLOR CODING ---
const CRATE_TYPES = Object.freeze({
    standard: { id: 'standard', name: 'Standard (Small)', value: 50, color: '#f4b41b', zone: 'Peripheral-North' },
    medium: { id: 'medium', name: 'Medium Batch', value: 120, color: '#fdbb25', zone: 'Hub-Node-A' },
    large: { id: 'large', name: 'Large Priority', value: 250, color: '#ffb4a6', zone: 'Secure-Central-Terminal' }
});

// --- WAREHOUSE LEVEL TIERS (WAREHOUSE_LEVEL_FK) ---
const WAREHOUSE_LEVELS = Object.freeze({
    1: { level: 1, name: 'Standard Depot', width: 16, height: 16, cost: 0 },
    2: { level: 2, name: 'Expanded Terminal', width: 24, height: 24, cost: 500 },
    3: { level: 3, name: 'Megastructure Matrix', width: 32, height: 32, cost: 1200 }
});

const SENSOR_MODES = Object.freeze({
    basic: 'basic',
    advanced: 'advanced',
    spectral: 'spectral'
});

function getLevenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    )
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

class AdvancedBotController {
    constructor(options = {}) {
        this.warehouseLevel = options.warehouseLevel || 1;
        const initialConfig = WAREHOUSE_LEVELS[this.warehouseLevel] || WAREHOUSE_LEVELS[1];

        this.gridWidth = options.gridWidth || initialConfig.width;
        this.gridHeight = options.gridHeight || initialConfig.height;
        this.gridSize = options.gridSize || 32;

        this.worldObjects = new Map(options.worldObjects || []);
        this.crateMetadata = new Map(options.crateMetadata || []);
        this.initCargoClasses();

        this.deliveryZones = new Set(options.deliveryZones || ['7,5']);
        this.collisionObjects = new Set(options.collisionObjects || []);

        this.bots = options.bots || [
            {
                bot_id: 'MK-1_ROLLER_01',
                x: 2,
                y: 2,
                orientationIndex: 0,
                taskQueue: [],
                taskState: 'IDLE',
                inventory: { capacity: 2, slots: [], batchType: null },
                lastScanResult: 'empty',
                script: `// REPEAT LOOP HARVEST TEST\nrepeat(4) {\n    move();\n}\n`,
                lastCommandAt: 0
            },
            {
                bot_id: 'MK-1_ROLLER_02',
                x: 4,
                y: 2,
                orientationIndex: 0,
                taskQueue: [],
                taskState: 'IDLE',
                inventory: { capacity: 2, slots: [], batchType: null },
                lastScanResult: 'empty',
                script: `// SECONDARY BOT SCRIPT\nmove();\nturnRight();\nmove();`,
                lastCommandAt: 0
            }
        ];

        this.selectedBotId = this.bots[0].bot_id;
        this.gold = options.gold || 0;
        this.commandDelayMs = options.commandDelayMs || 400;
        this.sensorMode = options.sensorMode || SENSOR_MODES.basic;
        this.activeUpgrades = new Set(options.activeUpgrades || []);

        this.initSelectorUI();
    }

    initCargoClasses() {
        if (this.worldObjects.size === 0) {
            const initialCargo = [
                { id: 'SM-01', tier: 'standard', x: 2, y: 1 },
                { id: 'MD-01', tier: 'medium', x: 7, y: 7 },
                { id: 'LG-01', tier: 'large', x: 12, y: 10 }
            ];

            initialCargo.forEach(cargo => {
                const key = `${cargo.x},${cargo.y}`;
                this.worldObjects.set(key, 'crate');
                this.crateMetadata.set(key, { ...CRATE_TYPES[cargo.tier], code: cargo.id, x: cargo.x, y: cargo.y });
            });
        }
    }

    getActiveBot() {
        return this.bots.find(b => b.bot_id === this.selectedBotId) || this.bots[0];
    }

    initSelectorUI() {
        const selector = document.getElementById('bot-selector');
        if (!selector) return;
        selector.innerHTML = '';
        this.bots.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.bot_id;
            opt.textContent = b.bot_id;
            if (b.bot_id === this.selectedBotId) opt.selected = true;
            selector.appendChild(opt);
        });
    }

    selectBot(botId) {
        const active = this.getActiveBot();
        const textarea = document.getElementById('code-textarea');
        if (active && textarea) {
            active.script = textarea.value;
        }

        this.selectedBotId = botId;
        const newActive = this.getActiveBot();
        if (newActive && textarea) {
            textarea.value = newActive.script;
            if (typeof updateEditorMetrics === 'function') updateEditorMetrics();
        }
        clearErrorHighlights();

        const selector = document.getElementById('bot-selector');
        if (selector && selector.value !== botId) {
            selector.value = botId;
        }
        
        setRunButtonState(newActive.taskQueue.length === 0 && newActive.taskState === 'IDLE');
    }

    // --- Persistence support (storage-manager.js): flushes whatever is
    // currently typed in the editor into the active bot's memory (mirrors
    // the same flush selectBot() does), then returns a saved_scripts-shaped
    // snapshot of every bot's script for saving. ---
    getScriptSnapshot() {
        const active = this.getActiveBot();
        const textarea = document.getElementById('code-textarea');
        if (active && textarea) {
            active.script = textarea.value;
        }
        return this.bots.map(b => ({
            script_id: b.bot_id,
            title: b.bot_id,
            code: b.script
        }));
    }

    // --- Persistence support (storage-manager.js): applies a saved_scripts
    // snapshot back onto matching bots by bot_id, then refreshes the visible
    // editor if it's showing the currently selected bot. ---
    hydrateScripts(savedScripts) {
        if (!Array.isArray(savedScripts)) return;
        savedScripts.forEach(entry => {
            const bot = this.bots.find(b => b.bot_id === entry.script_id);
            if (bot && typeof entry.code === 'string') {
                bot.script = entry.code;
            }
        });

        const active = this.getActiveBot();
        const textarea = document.getElementById('code-textarea');
        if (active && textarea) {
            textarea.value = active.script;
            if (typeof updateEditorMetrics === 'function') updateEditorMetrics();
        }
    }

    getFacingVector() { 
        const bot = this.getActiveBot();
        return BOT_DIRECTIONS[bot.orientationIndex % BOT_DIRECTIONS.length]; 
    }

    getStrafeVector(directionType) {
        const bot = this.getActiveBot();
        const offset = directionType === 'right' ? 1 : 3; 
        return BOT_DIRECTIONS[(bot.orientationIndex + offset) % BOT_DIRECTIONS.length];
    }
    
    setTaskState(nextState) { 
        const bot = this.getActiveBot();
        bot.taskState = nextState; 
    }
    
    toTileKey(x, y) { return `${x},${y}`; }

    getFrontTile() {
        const bot = this.getActiveBot();
        const direction = this.getFacingVector();
        return { x: bot.x + direction.x, y: bot.y + direction.y };
    }

    isInBounds(x, y) { return x >= 0 && y >= 0 && x < this.gridWidth && y < this.gridHeight; }

    isBlocked() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        const botOccupied = this.bots.some(b => b.bot_id !== this.selectedBotId && b.x === front.x && b.y === front.y);
        return !this.isInBounds(front.x, front.y) || this.collisionObjects.has(key) || botOccupied;
    }

    isStrafeBlocked(strafeDir) {
        const bot = this.getActiveBot();
        const dir = this.getStrafeVector(strafeDir);
        const nextX = bot.x + dir.x;
        const nextY = bot.y + dir.y;
        const key = this.toTileKey(nextX, nextY);
        const botOccupied = this.bots.some(b => b.bot_id !== this.selectedBotId && b.x === nextX && b.y === nextY);
        return !this.isInBounds(nextX, nextY) || this.collisionObjects.has(key) || botOccupied;
    }

    evaluateCondition(condStr) {
        const clean = condStr.trim();
        const bot = this.getActiveBot();

        if (clean.startsWith('inventory')) {
            const parts = clean.split(/==|!=/);
            if (parts.length === 2) {
                const targetState = parts[1].trim().replace(/['"]/g, '');
                const isNotEqual = clean.includes('!=');
                const inventoryMatch = bot.inventory.batchType === targetState || (bot.inventory.slots.length === 0 && targetState === 'empty');
                return isNotEqual ? !inventoryMatch : inventoryMatch;
            }
        }

        const cleanNoSpaces = clean.replace(/\s+/g, '');
        if (cleanNoSpaces === 'isBlocked()==false' || cleanNoSpaces === '!isBlocked()') {
            return !this.isBlocked();
        }
        if (cleanNoSpaces === 'isBlocked()==true' || cleanNoSpaces === 'isBlocked()') {
            return this.isBlocked();
        }
        if (cleanNoSpaces.startsWith('scan()')) {
            const parts = cleanNoSpaces.split('==');
            if (parts.length === 2) {
                const target = parts[1].trim().replace(/['"]/g, '');
                return this.scan() === target;
            }
        }
        return false;
    }

    tokenizeAndCompileScript(scriptString) {
        const lines = scriptString.split('\n');
        const validCommands = Object.keys(BOT_COMMAND_LIBRARY);
        const collectedErrors = [];
        const tokens = [];

        let totalBraceBalance = 0;
        let lastTokenLineNum = 1;

        lines.forEach((rawLine, idx) => {
            const lineNum = idx + 1;
            let trimmed = rawLine.trim();
            if (!trimmed || trimmed.startsWith('//')) return;

            lastTokenLineNum = lineNum;

            for (let i = 0; i < trimmed.length; i++) {
                if (trimmed[i] === '{') totalBraceBalance++;
                if (trimmed[i] === '}') totalBraceBalance--;
            }

            if (trimmed.includes('} else')) {
                const parts = trimmed.split('} else');
                tokens.push({ lineNum, text: parts[0].trim() + '}', raw: rawLine });
                tokens.push({ lineNum, text: 'else ' + parts[1].trim(), raw: rawLine });
                return;
            }

            if (trimmed.includes('}') && !trimmed.startsWith('}')) {
                const parts = trimmed.split('}');
                const firstPart = parts[0].trim();
                if (firstPart) tokens.push({ lineNum, text: firstPart, raw: rawLine });
                tokens.push({ lineNum, text: '}', raw: rawLine });
                const remaining = parts.slice(1).join('}').trim();
                if (remaining) tokens.push({ lineNum, text: remaining, raw: rawLine });
                return;
            }

            tokens.push({ lineNum, text: trimmed, raw: rawLine });
        });

        if (totalBraceBalance > 0) {
            collectedErrors.push({
                lineNum: lastTokenLineNum,
                lineText: lines[lastTokenLineNum - 1] || '}',
                message: `SyntaxError: Missing closing bracket '}' to match open scope`,
                suggestion: `Add '}' to close block`
            });
        } else if (totalBraceBalance < 0) {
            collectedErrors.push({
                lineNum: lastTokenLineNum,
                lineText: lines[lastTokenLineNum - 1] || '}',
                message: `SyntaxError: Unexpected extra closing bracket '}'`,
                suggestion: `Remove extraneous '}'`
            });
        }

        let tokenIndex = 0;
        const parseBlock = (isTopLevel = false) => {
            const instructions = [];
            while (tokenIndex < tokens.length) {
                const token = tokens[tokenIndex];
                const trimmed = token.text;
                const lineNum = token.lineNum;

                if (trimmed === '}' || trimmed.startsWith('}')) {
                    tokenIndex++;
                    if (isTopLevel) continue;
                    return instructions;
                }

                if (trimmed.toLowerCase().startsWith('while')) {
                    const match = trimmed.match(/^while\s*\((.*?)\)\s*(\{)?/i);
                    if (!match) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid while loop syntax`, suggestion: `while (condition) {` });
                        tokenIndex++;
                        continue;
                    }
                    const condition = match[1].trim();
                    tokenIndex++;
                    instructions.push({ type: 'WHILE', condition, body: parseBlock(false) });
                    continue;
                }

                if (trimmed.toLowerCase().startsWith('repeat')) {
                    const match = trimmed.match(/^repeat\s*\((.*?)\)\s*(\{)?/i);
                    if (!match) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid repeat loop syntax`, suggestion: `repeat(N) {` });
                        tokenIndex++;
                        continue;
                    }
                    const countArg = match[1].trim();
                    tokenIndex++;
                    instructions.push({ type: 'REPEAT', count: countArg, body: parseBlock(false) });
                    continue;
                }

                if (trimmed.toLowerCase().startsWith('if')) {
                    const match = trimmed.match(/^if\s*\((.*?)\)\s*(\{)?/i);
                    if (!match) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid if statement syntax`, suggestion: `if (condition) {` });
                        tokenIndex++;
                        continue;
                    }
                    const condition = match[1].trim();
                    tokenIndex++;
                    const ifBody = parseBlock(false);

                    let elseBody = [];
                    if (tokenIndex < tokens.length) {
                        let nextToken = tokens[tokenIndex];
                        if (nextToken.text.toLowerCase().startsWith('else')) {
                            tokenIndex++; 
                            if (tokenIndex < tokens.length && tokens[tokenIndex].text === '{') {
                                tokenIndex++; 
                                elseBody = parseBlock(false);
                            } else {
                                elseBody = parseBlock(false);
                            }
                        }
                    }
                    instructions.push({ type: 'IF', condition, ifBody, elseBody });
                    continue;
                }

                let cleanContent = trimmed.split('//')[0].trim();
                if (cleanContent.endsWith('{')) cleanContent = cleanContent.slice(0, -1).trim();
                if (!cleanContent) { tokenIndex++; continue; }

                const isBlockHeader = /^(while|if|repeat|else)\b/i.test(cleanContent);
                if (!cleanContent.endsWith(';') && !cleanContent.endsWith('}') && !isBlockHeader) {
                    collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Expected ';' at end of statement`, suggestion: `${cleanContent};` });
                    tokenIndex++;
                    continue;
                }

                const stmtBody = cleanContent.endsWith(';') ? cleanContent.slice(0, -1).trim() : cleanContent;
                if (!stmtBody) { tokenIndex++; continue; }

                const match = stmtBody.match(/^([a-zA-Z_]\w*)\s*\((.*?)\)$/);

                if (!match) {
                    collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid statement syntax structure`, suggestion: `${stmtBody};` });
                    tokenIndex++;
                    continue;
                }

                const commandName = match[1];
                const paramArg = match[2].trim();

                if (!BOT_COMMAND_LIBRARY[commandName]) {
                    let closest = validCommands[0];
                    let minDst = Infinity;
                    validCommands.forEach(vc => {
                        const dst = getLevenshteinDistance(commandName, vc);
                        if (dst < minDst) { minDst = dst; closest = vc; }
                    });
                    collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Misspelled function '${commandName}'`, suggestion: `${closest}(${match[2]});` });
                    tokenIndex++;
                    continue;
                }

                if ((commandName === 'move' || commandName === 'strafeLeft' || commandName === 'strafeRight') && paramArg !== '') {
                    const repeatSteps = parseInt(paramArg, 10);
                    if (!isNaN(repeatSteps) && repeatSteps > 0) {
                        for (let s = 0; s < repeatSteps; s++) {
                            instructions.push({ type: 'COMMAND', name: commandName });
                        }
                    } else {
                        instructions.push({ type: 'COMMAND', name: commandName });
                    }
                } else if (commandName === 'wait' && paramArg !== '') {
                    const seconds = parseFloat(paramArg);
                    instructions.push({ type: 'COMMAND', name: 'wait', duration: (!isNaN(seconds) ? seconds * 1000 : 1000) });
                } else {
                    instructions.push({ type: 'COMMAND', name: commandName });
                }
                tokenIndex++;
            }
            return instructions;
        };

        const compiledInstructions = parseBlock(true);
        if (collectedErrors.length > 0) throw collectedErrors;
        return compiledInstructions;
    }

    parseAndExecute(scriptString) {
        const bot = this.getActiveBot();
        if (bot.taskQueue.length > 0 || bot.taskState !== 'IDLE') return;
        clearErrorHighlights();

        try {
            const instructions = this.tokenizeAndCompileScript(scriptString);
            if (instructions.length === 0) return;
            bot.taskQueue = instructions;
            setRunButtonState(false);
        } catch (errs) {
            console.error(errs);
            setRunButtonState(true);
            if (Array.isArray(errs)) highlightMultipleErrors(errs);
            else if (errs && errs.lineNum) highlightMultipleErrors([errs]);
            else this.displayError(`ERR: ${errs.message || errs}`);
        }
    }

    displayError(message) {
        console.warn(message);
        const container = document.getElementById('VIEWPORT_ACTIVE');
        if (container && !document.getElementById('error-banner')) {
            const banner = document.createElement('div');
            banner.id = 'error-banner';
            banner.style.position = 'absolute';
            banner.style.top = '10px';
            banner.style.left = '50%';
            banner.style.transform = 'translateX(-50%)';
            banner.style.backgroundColor = '#93000a';
            banner.style.color = '#ffdad6';
            banner.style.padding = '4px 12px';
            banner.style.fontSize = '10px';
            banner.style.fontFamily = 'JetBrains Mono, monospace';
            banner.style.fontWeight = '700';
            banner.style.zIndex = '100';
            banner.style.border = '2px solid #ffb4ab';
            banner.textContent = message;
            container.appendChild(banner);
            setTimeout(() => banner.remove(), 2500);
        }
    }

    executeCommand(commandObj) {
        const cmdName = typeof commandObj === 'object' ? commandObj.name : commandObj;
        const duration = typeof commandObj === 'object' ? commandObj.duration : undefined;

        switch (cmdName) {
            case BOT_COMMAND_LIBRARY.move: return this.move();
            case BOT_COMMAND_LIBRARY.strafeLeft: return this.strafe('left');
            case BOT_COMMAND_LIBRARY.strafeRight: return this.strafe('right');
            case BOT_COMMAND_LIBRARY.wait: return this.wait(duration);
            case BOT_COMMAND_LIBRARY.turnLeft: return this.turnLeft();
            case BOT_COMMAND_LIBRARY.turnRight: return this.turnRight();
            case BOT_COMMAND_LIBRARY.pickup: return this.pickup();
            case BOT_COMMAND_LIBRARY.dropoff: return this.dropoff();
            case BOT_COMMAND_LIBRARY.scan: return this.scan();
            case BOT_COMMAND_LIBRARY.isBlocked: return this.isBlocked();
        }
    }

    move() {
        const bot = this.getActiveBot();
        const direction = this.getFacingVector();
        const nextX = bot.x + direction.x;
        const nextY = bot.y + direction.y;
        if (this.isBlocked() || !this.isInBounds(nextX, nextY)) {
            this.setTaskState('BLOCKED');
            this.displayError('ERR: Movement blocked by obstacle/boundary');
            bot.taskQueue = [];
            this.setTaskState('IDLE');
            setRunButtonState(true);
            return;
        }
        this.setTaskState('MOVING');
        bot.x = nextX;
        bot.y = nextY;
        this.setTaskState('IDLE');
    }

    strafe(strafeDir) {
        const bot = this.getActiveBot();
        const direction = this.getStrafeVector(strafeDir);
        const nextX = bot.x + direction.x;
        const nextY = bot.y + direction.y;
        if (this.isStrafeBlocked(strafeDir) || !this.isInBounds(nextX, nextY)) {
            this.setTaskState('BLOCKED');
            this.displayError('ERR: Strafing blocked by obstacle/boundary');
            bot.taskQueue = [];
            this.setTaskState('IDLE');
            setRunButtonState(true);
            return;
        }
        this.setTaskState('STRAFING');
        bot.x = nextX;
        bot.y = nextY;
        this.setTaskState('IDLE');
    }

    wait(durationMs = 1000) {
        const bot = this.getActiveBot();
        this.setTaskState('WAITING');
        bot.waitCompleteAt = performance.now() + durationMs;
    }

    turnLeft() {
        const bot = this.getActiveBot();
        this.setTaskState('TURNING');
        bot.orientationIndex = (bot.orientationIndex + 3) % BOT_DIRECTIONS.length;
        this.setTaskState('IDLE');
    }

    turnRight() {
        const bot = this.getActiveBot();
        this.setTaskState('TURNING');
        bot.orientationIndex = (bot.orientationIndex + 1) % BOT_DIRECTIONS.length;
        this.setTaskState('IDLE');
    }

    pickup() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        const bot = this.getActiveBot();

        if (!bot.inventory || !Array.isArray(bot.inventory.slots)) {
            bot.inventory = { capacity: 2, slots: [], batchType: null };
        }

        if (this.worldObjects.get(key) === 'crate') {
            const crateMeta = this.crateMetadata.get(key) || CRATE_TYPES.standard;

            if (bot.inventory.slots.length >= bot.inventory.capacity) {
                this.displayError('ERR: Inventory slot capacity reached');
                return;
            }

            if (bot.inventory.slots.length > 0 && bot.inventory.batchType !== crateMeta.id) {
                this.displayError(`ERR: Cannot mix cargo tiers (${bot.inventory.batchType} vs ${crateMeta.id})`);
                return;
            }

            bot.inventory.slots.push(crateMeta);
            bot.inventory.batchType = crateMeta.id;

            this.worldObjects.delete(key);
            this.crateMetadata.delete(key);
            this.displayError(`SUCCESS: Picked up ${crateMeta.name} [Slot ${bot.inventory.slots.length}/${bot.inventory.capacity}]`);
        }
    }

    dropoff() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        const bot = this.getActiveBot();

        if (!bot.inventory || !Array.isArray(bot.inventory.slots)) {
            bot.inventory = { capacity: 2, slots: [], batchType: null };
        }

        if (this.deliveryZones.has(key) && bot.inventory.slots.length > 0) {
            const batchTier = bot.inventory.batchType;
            const currentSlots = bot.inventory.slots.length;

            if (batchTier === 'medium' && currentSlots < 2) {
                this.displayError(`ERR: Medium batch requires 2 consecutive crates (have ${currentSlots}/2)`);
                return;
            }

            if (batchTier === 'large' && currentSlots < 1) {
                this.displayError(`ERR: Large priority shipment validation failed`);
                return;
            }

            let totalBatchValue = 0;
            bot.inventory.slots.forEach(crate => {
                totalBatchValue += crate.value;
            });

            if (batchTier === 'medium') totalBatchValue = Math.round(totalBatchValue * 1.25);
            if (batchTier === 'large') totalBatchValue = Math.round(totalBatchValue * 1.50);

            bot.inventory.slots = [];
            bot.inventory.batchType = null;
            
            this.gold += totalBatchValue;
            const goldEl = document.getElementById('ui-gold');
            if (goldEl) goldEl.innerHTML = `${this.gold} <span class="text-[10px]">AU</span>`;

            this.displayError(`SUCCESS: Delivered sequence! Earned ${totalBatchValue} AU`);
            
            this.worldObjects.set('3,5', 'crate');
            this.crateMetadata.set('3,5', { ...CRATE_TYPES.standard, code: 'SM-RESPAWN', x: 3, y: 5 });

            // --- AUTOMATED MILESTONE DECISION GATE CHECK ---
            const nextConfig = WAREHOUSE_LEVELS[this.warehouseLevel + 1];
            if (nextConfig && this.gold >= nextConfig.cost) {
                this.displayError(`MILESTONE: Ready to unlock ${nextConfig.name}! Check upgrade panel.`);
            }
        }
    }

    scan() {
        const bot = this.getActiveBot();
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        const obj = this.worldObjects.get(key);

        if (!obj) {
            bot.lastScanResult = 'empty';
            return 'empty';
        }

        if (obj === 'crate') {
            const crateMeta = this.crateMetadata.get(key) || CRATE_TYPES.standard;
            if (this.sensorMode === SENSOR_MODES.advanced || this.activeUpgrades.has('spectral_scanner')) {
                bot.lastScanResult = `${crateMeta.id}:${crateMeta.value}AU`;
            } else {
                bot.lastScanResult = 'crate';
            }
        } else {
            bot.lastScanResult = obj;
        }

        return bot.lastScanResult;
    }

    inspectCrate() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        if (this.worldObjects.get(key) === 'crate') {
            return this.crateMetadata.get(key) || CRATE_TYPES.standard;
        }
        return null;
    }

    purchaseNewBot(cost = 300) {
        if (this.gold >= cost && this.bots.length < 20) {
            this.gold -= cost;
            const goldEl = document.getElementById('ui-gold');
            if (goldEl) goldEl.innerHTML = `${this.gold} <span class="text-[10px]">AU</span>`;

            const newId = `MK-1_ROLLER_${String(this.bots.length + 1).padStart(2, '0')}`;
            this.bots.push({
                bot_id: newId,
                x: 2,
                y: 4,
                orientationIndex: 0,
                taskQueue: [],
                taskState: 'IDLE',
                inventory: { capacity: 2, slots: [], batchType: null },
                lastScanResult: 'empty',
                script: `// EXPANDED FLEET UNIT SCRIPT\nmove();\ndropoff();`,
                lastCommandAt: 0
            });
            this.initSelectorUI();
            this.displayError(`SUCCESS: Purchased new unit ${newId}`);
        } else {
            this.displayError(`ERR: Insufficient AU or Fleet Capacity Full`);
        }
    }

    purchaseUpgrade(upgradeId, cost) {
        if (this.gold >= cost) {
            this.gold -= cost;
            const goldEl = document.getElementById('ui-gold');
            if (goldEl) goldEl.innerHTML = `${this.gold} <span class="text-[10px]">AU</span>`;
            
            this.activeUpgrades.add(upgradeId);
            if (upgradeId === 'faster_cpu') {
                this.commandDelayMs = Math.max(100, this.commandDelayMs * 0.85);
            } else if (upgradeId === 'spectral_scanner') {
                this.sensorMode = SENSOR_MODES.advanced;
            }

            this.displayError(`SUCCESS: Unlocked upgrade [${upgradeId.toUpperCase()}]`);
        } else {
            this.displayError(`ERR: Insufficient AU for upgrade`);
        }
    }

    // --- DYNAMIC WAREHOUSE LEVEL EXPANSION (warehouse_level_FK) ---
    upgradeWarehouse() {
        const nextLevelNum = this.warehouseLevel + 1;
        const nextConfig = WAREHOUSE_LEVELS[nextLevelNum];

        if (!nextConfig) {
            this.displayError('ERR: Maximum warehouse level reached');
            return;
        }

        if (this.gold >= nextConfig.cost) {
            this.gold -= nextConfig.cost;
            this.warehouseLevel = nextLevelNum;
            this.gridWidth = nextConfig.width;
            this.gridHeight = nextConfig.height;

            const goldEl = document.getElementById('ui-gold');
            if (goldEl) goldEl.innerHTML = `${this.gold} <span class="text-[10px]">AU</span>`;

            if (typeof resizeBotVisualizer === 'function') {
                resizeBotVisualizer(this, 'VIEWPORT_ACTIVE');
            }

            this.displayError(`SUCCESS: Upgraded to ${nextConfig.name} (${nextConfig.width}x${nextConfig.height})`);
        } else {
            this.displayError(`ERR: Insufficient AU for warehouse upgrade (Needs ${nextConfig.cost} AU)`);
        }
    }

    update(now = performance.now()) {
        this.bots.forEach(bot => {
            if (!bot.inventory || !Array.isArray(bot.inventory.slots)) {
                bot.inventory = { capacity: 2, slots: [], batchType: null };
            }

            if (bot.taskState === 'WAITING') {
                if (now < (bot.waitCompleteAt || 0)) return;
                bot.taskState = 'IDLE';
            }

            if (bot.taskState !== 'IDLE' || bot.taskQueue.length === 0) return;
            if (now - bot.lastCommandAt < this.commandDelayMs) return;
            
            const nextTask = bot.taskQueue[0];
            bot.lastCommandAt = now;

            const prevSelected = this.selectedBotId;
            this.selectedBotId = bot.bot_id;

            if (nextTask.type === 'COMMAND') {
                bot.taskQueue.shift();
                this.executeCommand(nextTask);
            } else if (nextTask.type === 'WHILE') {
                const conditionMet = this.evaluateCondition(nextTask.condition);
                if (conditionMet) {
                    bot.taskQueue.shift();
                    bot.taskQueue.unshift(...JSON.parse(JSON.stringify(nextTask.body)), nextTask);
                } else {
                    bot.taskQueue.shift();
                }
            } else if (nextTask.type === 'REPEAT') {
                let remainingCount = nextTask._remainingCount;
                if (remainingCount === undefined) {
                    remainingCount = parseInt(nextTask.count, 10);
                    if (isNaN(remainingCount)) remainingCount = 1;
                }

                if (remainingCount > 0) {
                    if (nextTask._remainingCount === undefined) {
                        nextTask._remainingCount = remainingCount - 1;
                    } else {
                        nextTask._remainingCount--;
                    }
                    bot.taskQueue.shift();
                    const loopClone = JSON.parse(JSON.stringify(nextTask));
                    bot.taskQueue.unshift(...JSON.parse(JSON.stringify(nextTask.body)), loopClone);
                } else {
                    bot.taskQueue.shift();
                }
            } else if (nextTask.type === 'IF') {
                const conditionMet = this.evaluateCondition(nextTask.condition);
                bot.taskQueue.shift();
                const activeBranch = conditionMet ? nextTask.ifBody : nextTask.elseBody;
                if (activeBranch && activeBranch.length > 0) {
                    bot.taskQueue.unshift(...JSON.parse(JSON.stringify(activeBranch)));
                }
            }

            this.selectedBotId = prevSelected;

            if (bot.taskQueue.length === 0 && bot.taskState === 'IDLE') {
                if (bot.bot_id === this.selectedBotId) {
                    setRunButtonState(true);
                }
            }
        });
    }
}

function setRunButtonState(isInteractive) {
    const btn = document.getElementById('run-script-btn');
    if (!btn) return;
    
    if (isInteractive) {
        btn.removeAttribute('disabled');
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.className = "mt-4 bg-primary-container text-on-primary-container font-code-sm text-code-sm py-3 pixel-border hover:brightness-110 active:shadow-[inset_2px_2px_0px_#000] transition-all flex items-center justify-center gap-2 group";
    } else {
        btn.setAttribute('disabled', 'true');
        btn.style.opacity = '0.65';
        btn.style.cursor = 'not-allowed';
        btn.className = "mt-4 bg-surface-container-high text-on-surface-variant font-code-sm text-code-sm py-3 pixel-border transition-all flex items-center justify-center gap-2 group";
    }
}

function highlightMultipleErrors(errors) {
    const errorSummaries = [];
    errors.forEach(err => {
        const lineNumEl = document.getElementById(`line-num-${err.lineNum}`);
        if (lineNumEl) {
            lineNumEl.style.backgroundColor = '#93000a';
            lineNumEl.style.color = '#ffdad6';
            lineNumEl.style.fontWeight = '700';
        }
        if (err.suggestion) {
            errorSummaries.push(`${err.message} <span style="color: #ffd588;">suggestion: ${err.suggestion}</span>`);
        } else {
            errorSummaries.push(`${err.message}`);
        }
    });

    const container = document.getElementById('VIEWPORT_ACTIVE');
    if (container) {
        const existingBanner = document.getElementById('error-banner');
        if (existingBanner) existingBanner.remove();

        const banner = document.createElement('div');
        banner.id = 'error-banner';
        banner.style.position = 'absolute';
        banner.style.top = '10px';
        banner.style.left = '50%';
        banner.style.transform = 'translateX(-50%)';
        banner.style.backgroundColor = '#93000a';
        banner.style.color = '#ffdad6';
        banner.style.padding = '8px 16px';
        banner.style.fontSize = '10px';
        banner.style.fontFamily = 'JetBrains Mono, monospace';
        banner.style.fontWeight = '700';
        banner.style.zIndex = '100';
        banner.style.border = '2px solid #ffb4ab';
        banner.style.textAlign = 'left';
        banner.style.maxWidth = '90%';
        banner.style.maxHeight = '150px';
        banner.style.overflowY = 'auto';
        banner.innerHTML = `<strong>COMPILE_ERR (${errors.length} issue${errors.length > 1 ? 's' : ''}):</strong><br>` + errorSummaries.join('<br>');
        container.appendChild(banner);
    }
}

function clearErrorHighlights() {
    const lineNumbersEl = document.getElementById('code-line-numbers');
    if (lineNumbersEl) {
        Array.from(lineNumbersEl.children).forEach(child => {
            child.style.backgroundColor = '';
            child.style.color = '';
            child.style.fontWeight = '';
        });
    }
    const banner = document.getElementById('error-banner');
    if (banner) banner.remove();
}

function resizeBotVisualizer(controller, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const totalWidth = controller.gridWidth * controller.gridSize;
    const totalHeight = controller.gridHeight * controller.gridSize;
    container.style.width = totalWidth + 'px';
    container.style.height = totalHeight + 'px';
    container.style.minWidth = totalWidth + 'px';
    container.style.minHeight = totalHeight + 'px';
}

function initBotVisualizer(controller, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    resizeBotVisualizer(controller, containerId);

    const dynamicCargoElements = new Map();

    const zoneEl = document.createElement('div');
    zoneEl.style.position = 'absolute';
    zoneEl.style.width = controller.gridSize + 'px';
    zoneEl.style.height = controller.gridSize + 'px';
    zoneEl.style.backgroundColor = 'rgba(140, 242, 114, 0.2)';
    zoneEl.style.left = (7 * controller.gridSize) + 'px';
    zoneEl.style.top = (5 * controller.gridSize) + 'px';
    zoneEl.style.border = '2px dashed #8cf272';
    container.appendChild(zoneEl);

    const tooltipEl = document.createElement('div');
    tooltipEl.id = 'bot-hover-tooltip';
    tooltipEl.style.position = 'absolute';
    tooltipEl.style.backgroundColor = '#1a1c18';
    tooltipEl.style.color = '#e2e3dd';
    tooltipEl.style.border = '2px solid #412d00';
    tooltipEl.style.padding = '6px 10px';
    tooltipEl.style.fontSize = '9px';
    tooltipEl.style.fontFamily = 'JetBrains Mono, monospace';
    tooltipEl.style.zIndex = '100';
    tooltipEl.style.pointerEvents = 'none';
    tooltipEl.style.display = 'none';
    container.appendChild(tooltipEl);

    const botElementsMap = new Map();
    let hoveredBotId = null;
    let hoveredCargoKey = null;

    function updateVisuals() {
        const active = controller.getActiveBot();

        const telId = document.getElementById('telemetry-id');
        const telPos = document.getElementById('telemetry-pos');
        const telFacing = document.getElementById('telemetry-facing');
        const telState = document.getElementById('telemetry-state');
        const telInventory = document.getElementById('telemetry-inventory');
        const telLastScan = document.getElementById('telemetry-last-scan');
        const uiUnits = document.getElementById('ui-units');
        const uiFleetList = document.getElementById('ui-fleet-list');

        if (telId) telId.textContent = active.bot_id;
        if (telPos) telPos.textContent = `(${active.x}, ${active.y})`;
        if (telFacing) telFacing.textContent = BOT_DIRECTIONS[active.orientationIndex % BOT_DIRECTIONS.length].name.toUpperCase();
        if (telState) telState.textContent = active.taskState;
        if (telInventory) {
            const invSlots = active.inventory && Array.isArray(active.inventory.slots) ? active.inventory.slots : [];
            telInventory.textContent = invSlots.length > 0 ? `${active.inventory.batchType} (${invSlots.length}/2)` : 'empty';
        }
        if (telLastScan) telLastScan.textContent = active.lastScanResult;

        if (uiUnits) uiUnits.innerHTML = `${controller.bots.length} / 20 <span class="text-[10px]">BOTS</span>`;

        if (uiFleetList) {
            uiFleetList.innerHTML = controller.bots.map(b => `
                <div class="flex justify-between items-center text-xs cursor-pointer hover:text-primary transition-colors" onclick="window.botController.selectBot('${b.bot_id}')">
                    <span class="font-code-sm ${b.bot_id === controller.selectedBotId ? 'text-primary font-bold' : 'text-on-surface'}">${b.bot_id}</span>
                    <span class="font-code-sm text-[10px] ${b.taskState !== 'IDLE' ? 'text-tertiary animate-pulse' : 'text-on-surface-variant'}">${b.taskState}</span>
                </div>
            `).join('');
        }

        const activeKeys = new Set();
        controller.worldObjects.forEach((type, key) => {
            if (type === 'crate') {
                activeKeys.add(key);
                let crateEl = dynamicCargoElements.get(key);
                if (!crateEl) {
                    crateEl = document.createElement('div');
                    crateEl.style.position = 'absolute';
                    crateEl.style.width = controller.gridSize + 'px';
                    crateEl.style.height = controller.gridSize + 'px';
                    crateEl.style.border = '2px solid #412d00';
                    crateEl.style.zIndex = '40';
                    crateEl.style.display = 'flex';
                    crateEl.style.alignItems = 'center';
                    crateEl.style.justifyContent = 'center';
                    crateEl.style.cursor = 'pointer';
                    crateEl.innerHTML = '<span class="material-symbols-outlined text-xs text-on-primary">box</span>';
                    
                    crateEl.addEventListener('mouseenter', () => { hoveredCargoKey = key; tooltipEl.style.display = 'block'; });
                    crateEl.addEventListener('mouseleave', () => { hoveredCargoKey = null; tooltipEl.style.display = 'none'; });
                    crateEl.addEventListener('mousemove', (e) => {
                        const rect = container.getBoundingClientRect();
                        tooltipEl.style.left = (e.clientX - rect.left + 12) + 'px';
                        tooltipEl.style.top = (e.clientY - rect.top - 28) + 'px';
                    });

                    container.appendChild(crateEl);
                    dynamicCargoElements.set(key, crateEl);
                }
                const [cx, cy] = key.split(',').map(Number);
                const meta = controller.crateMetadata.get(key) || CRATE_TYPES.standard;
                
                crateEl.style.backgroundColor = meta.color;
                crateEl.style.left = (cx * controller.gridSize) + 'px';
                crateEl.style.top = (cy * controller.gridSize) + 'px';
                crateEl.style.display = 'flex';
            }
        });

        dynamicCargoElements.forEach((el, key) => {
            if (!activeKeys.has(key)) {
                el.remove();
                dynamicCargoElements.delete(key);
            }
        });

        controller.bots.forEach(bot => {
            let el = botElementsMap.get(bot.bot_id);
            if (!el) {
                el = document.createElement('div');
                el.style.position = 'absolute';
                el.style.width = controller.gridSize + 'px';
                el.style.height = controller.gridSize + 'px';
                el.style.border = '2px solid #412d00';
                el.style.zIndex = '50';
                el.style.display = 'flex';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'center';
                el.style.cursor = 'pointer';
                el.innerHTML = `<div style="width: 8px; height: 8px; background: #412d00;"></div>`;
                
                el.addEventListener('click', () => { controller.selectBot(bot.bot_id); });
                el.addEventListener('mouseenter', () => { hoveredBotId = bot.bot_id; tooltipEl.style.display = 'block'; });
                el.addEventListener('mouseleave', () => { hoveredBotId = null; tooltipEl.style.display = 'none'; });
                el.addEventListener('mousemove', (e) => {
                    const rect = container.getBoundingClientRect();
                    tooltipEl.style.left = (e.clientX - rect.left + 12) + 'px';
                    tooltipEl.style.top = (e.clientY - rect.top - 28) + 'px';
                });

                container.appendChild(el);
                botElementsMap.set(bot.bot_id, el);
            }

            el.style.backgroundColor = bot.bot_id === controller.selectedBotId ? '#ffd588' : '#fdbb25';
            el.style.borderColor = bot.bot_id === controller.selectedBotId ? '#8cf272' : '#412d00';
            el.style.left = (bot.x * controller.gridSize) + 'px';
            el.style.top = (bot.y * controller.gridSize) + 'px';
        });

        if (hoveredBotId) {
            const targetBot = controller.bots.find(b => b.bot_id === hoveredBotId);
            if (targetBot) {
                const facingName = BOT_DIRECTIONS[targetBot.orientationIndex % BOT_DIRECTIONS.length].name.toUpperCase();
                const invSlots = targetBot.inventory && Array.isArray(targetBot.inventory.slots) ? targetBot.inventory.slots : [];
                const invStr = invSlots.length > 0 ? `${targetBot.inventory.batchType} (${invSlots.length}/2)` : 'empty';
                tooltipEl.innerHTML = `
                    <strong>${targetBot.bot_id}</strong><br>
                    POS: (${targetBot.x}, ${targetBot.y})<br>
                    FACING: ${facingName}<br>
                    STATE: <span style="color: ${targetBot.taskState !== 'IDLE' ? '#8cf272' : '#ffd588'}">${targetBot.taskState}</span><br>
                    INV: ${invStr}<br>
                    SCAN: ${targetBot.lastScanResult}
                `;
            }
        } else if (hoveredCargoKey) {
            const crateMeta = controller.crateMetadata.get(hoveredCargoKey);
            if (crateMeta) {
                tooltipEl.innerHTML = `
                    <strong>CRATE: ${crateMeta.code || 'CARGO'}</strong><br>
                    CLASS: <span style="color: ${crateMeta.color}">${crateMeta.name}</span><br>
                    VALUE: ${crateMeta.value} AU<br>
                    POS: (${crateMeta.x}, ${crateMeta.y})<br>
                    ZONE: ${crateMeta.zone || 'General'}
                `;
            }
        }

        requestAnimationFrame(updateVisuals);
    }
    updateVisuals();
}

window.botController = new AdvancedBotController({ commandDelayMs: 400 });

// --- Persistence: hydrates gold/warehouse level/unlocks from LocalStorage
// and hooks dropoff()/upgradeWarehouse()/purchaseUpgrade()/purchaseNewBot()
// to auto-save + sync with the backend. See storage-manager.js. ---
if (window.PersistenceManager) {
    window.gamePersistence = new window.PersistenceManager();
    window.gamePersistence.attach(window.botController);
}

// --- Analytics: real-time throughput/uptime/error metrics + EXECUTION_LOG
// tracking. Wires into the existing (previously dormant) UI hooks in
// index.html: #ui-throughput, #ui-errors, #ui-uptime, #flow-graph-container,
// and the ERR_LOGS footer link. See analytics-service.js. ---
if (window.AnalyticsService) {
    window.gameAnalytics = new window.AnalyticsService();
    window.gameAnalytics.attach(window.botController);
}

initBotVisualizer(window.botController, 'VIEWPORT_ACTIVE');

function gameLoop() {
    if (window.botController) {
        window.botController.update();
    }
    requestAnimationFrame(gameLoop);
}
gameLoop();