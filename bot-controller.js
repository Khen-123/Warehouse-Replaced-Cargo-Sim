// --- CONSTANTS: The Core Logic Rules ---
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

class BotController {
    constructor(options = {}) {
        this.gridWidth = options.gridWidth || 16;
        this.gridHeight = options.gridHeight || 16;
        this.gridSize = options.gridSize || 32;

        this.worldObjects = new Map(options.worldObjects || [['3,5', 'crate']]);
        this.deliveryZones = new Set(options.deliveryZones || ['7,5']);
        this.collisionObjects = new Set(options.collisionObjects || []);

        // Multi-Bot Fleet Initialization (Aligning with WAREHOUSE_LEVELS & BOT Schema)
        this.bots = options.bots || [
            {
                bot_id: 'MK-1_ROLLER_01',
                x: 2,
                y: 2,
                orientationIndex: 0,
                taskQueue: [],
                taskState: 'IDLE',
                inventory: 'empty',
                lastScanResult: 'empty',
                script: `// CONTINUOUS HARVEST LOOP\nwhile (inventory == 'empty') {\n    scan();\n    if (scan() == 'crate') {\n        pickup();\n    } else {\n        move();\n    }\n}\nstrafeRight(5);\ndropoff();`,
                lastCommandAt: 0
            },
            {
                bot_id: 'MK-1_ROLLER_02',
                x: 4,
                y: 2,
                orientationIndex: 0,
                taskQueue: [],
                taskState: 'IDLE',
                inventory: 'empty',
                lastScanResult: 'empty',
                script: `// SECONDARY BOT SCRIPT\nmove();\nturnRight();\nmove();`,
                lastCommandAt: 0
            }
        ];

        this.selectedBotId = this.bots[0].bot_id;
        this.gold = options.gold || 0;
        this.commandDelayMs = options.commandDelayMs || 400;

        this.initSelectorUI();
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
        // Save current textarea content to active bot script buffer before switching
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

        // Sync dropdown selector element UI state if out of sync
        const selector = document.getElementById('bot-selector');
        if (selector && selector.value !== botId) {
            selector.value = botId;
        }
        
        setRunButtonState(newActive.taskQueue.length === 0 && newActive.taskState === 'IDLE');
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
                const matches = bot.inventory === targetState;
                return isNotEqual ? !matches : matches;
            }
        }

        const cleanNoSpaces = clean.replace(/\s+/g, '');
        if (cleanNoSpaces === 'isBlocked()==false' || cleanNoSpaces === '!isBlocked()' || cleanNoSpaces === 'isBlocked()==1' === false) {
            return !this.isBlocked();
        }
        if (cleanNoSpaces === 'isBlocked()==true' || cleanNoSpaces === 'isBlocked()' || cleanNoSpaces === 'isBlocked()==1') {
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
        lines.forEach((rawLine, idx) => {
            const lineNum = idx + 1;
            let trimmed = rawLine.trim();
            if (!trimmed || trimmed.startsWith('//')) return;

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

                if (trimmed.startsWith('REPEAT') || trimmed.startsWith('repeat')) {
                    const match = trimmed.match(/^(?:REPEAT|repeat)\s*\(\s*(\d+)\s*\)\s*(\{)?/);
                    if (!match) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid REPEAT syntax`, suggestion: `REPEAT (3) {` });
                        tokenIndex++;
                        continue;
                    }
                    if (!trimmed.includes('{')) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Missing opening bracket '{'`, suggestion: `REPEAT (${match[1]}) {` });
                    }
                    const repeatCount = parseInt(match[1], 10);
                    tokenIndex++;
                    const blockBody = parseBlock(false);
                    for (let i = 0; i < repeatCount; i++) {
                        blockBody.forEach(cmd => instructions.push(JSON.parse(JSON.stringify(cmd))));
                    }
                    continue;
                }

                if (trimmed.startsWith('while')) {
                    const match = trimmed.match(/^while\s*\((.*?)\)\s*(\{)?/);
                    if (!match) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid while loop syntax`, suggestion: `while (condition) {` });
                        tokenIndex++;
                        continue;
                    }
                    if (!trimmed.includes('{')) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Missing opening bracket '{'`, suggestion: `while (${match[1]}) {` });
                    }
                    const condition = match[1].trim();
                    tokenIndex++;
                    instructions.push({ type: 'WHILE', condition, body: parseBlock(false) });
                    continue;
                }

                if (trimmed.startsWith('for')) {
                    const match = trimmed.match(/^for\s*\((.*?)\)\s*(\{)?/);
                    if (!match) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid for loop syntax`, suggestion: `for (let i = 0; i < 3; i++) {` });
                        tokenIndex++;
                        continue;
                    }
                    if (!trimmed.includes('{')) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Missing opening bracket '{'`, suggestion: `${trimmed} {` });
                    }
                    const headerParts = match[1].split(';');
                    let limit = 1;
                    if (headerParts.length >= 2) {
                        const numMatch = headerParts[1].match(/<\s*(\d+)/);
                        if (numMatch) limit = parseInt(numMatch[1], 10);
                    }
                    tokenIndex++;
                    const body = parseBlock(false);
                    for (let step = 0; step < limit; step++) {
                        body.forEach(cmd => instructions.push(JSON.parse(JSON.stringify(cmd))));
                    }
                    continue;
                }

                if (trimmed.startsWith('if')) {
                    const match = trimmed.match(/^if\s*\((.*?)\)\s*(\{)?/);
                    if (!match) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid if statement syntax`, suggestion: `if (condition) {` });
                        tokenIndex++;
                        continue;
                    }
                    if (!trimmed.includes('{')) {
                        collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Missing opening bracket '{'`, suggestion: `if (${match[1]}) {` });
                    }
                    const condition = match[1].trim();
                    tokenIndex++;
                    const ifBody = parseBlock(false);

                    let elseBody = [];
                    if (tokenIndex < tokens.length) {
                        let nextToken = tokens[tokenIndex];
                        if (nextToken.text.startsWith('else')) {
                            tokenIndex++; 
                            if (tokenIndex < tokens.length && tokens[tokenIndex].text === '{') {
                                tokenIndex++; 
                                elseBody = parseBlock(false);
                            } else if (nextToken.text.includes('{')) {
                                elseBody = parseBlock(false);
                            } else {
                                collectedErrors.push({ lineNum: nextToken.lineNum, lineText: nextToken.raw, message: `In line ${nextToken.lineNum}: Missing opening bracket '{' after else`, suggestion: `else {` });
                            }
                        }
                    }
                    instructions.push({ type: 'IF', condition, ifBody, elseBody });
                    continue;
                }

                if (trimmed.startsWith('else')) {
                    collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Orphaned 'else' statement`, suggestion: `Attach to an 'if' block` });
                    tokenIndex++;
                    continue;
                }

                let cleanContent = trimmed.split('//')[0].trim();
                if (cleanContent.endsWith('{')) cleanContent = cleanContent.slice(0, -1).trim();

                if (!cleanContent) { tokenIndex++; continue; }

                if (!cleanContent.endsWith(';')) {
                    collectedErrors.push({ lineNum, lineText: token.raw, message: `In line ${lineNum}: Expected ';' at end of statement`, suggestion: `${cleanContent};` });
                    tokenIndex++;
                    continue;
                }

                const stmtBody = cleanContent.slice(0, -1).trim();
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
                    if (!isNaN(seconds) && seconds > 0) {
                        instructions.push({ type: 'COMMAND', name: 'wait', duration: seconds * 1000 });
                    } else {
                        instructions.push({ type: 'COMMAND', name: 'wait', duration: 1000 });
                    }
                } else {
                    instructions.push({ type: 'COMMAND', name: commandName });
                }
                tokenIndex++;
            }

            if (!isTopLevel) {
                collectedErrors.push({ lineNum: lines.length, lineText: lines[lines.length - 1] || '', message: `Block closure error: Missing closing bracket '}'`, suggestion: `Add '}'` });
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
        if (bot.inventory === 'empty' && this.worldObjects.get(key) === 'crate') {
            bot.inventory = 'full';
            this.worldObjects.delete(key);
        }
    }

    dropoff() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        const bot = this.getActiveBot();
        if (this.deliveryZones.has(key) && bot.inventory === 'full') {
            bot.inventory = 'empty';
            this.gold += 50;
            const goldEl = document.getElementById('ui-gold');
            if (goldEl) goldEl.innerHTML = `${this.gold} <span class="text-[10px]">AU</span>`;
            
            this.worldObjects.set('3,5', 'crate');
        }
    }

    scan() {
        const bot = this.getActiveBot();
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        bot.lastScanResult = this.worldObjects.get(key) || 'empty';
        return bot.lastScanResult;
    }

    update(now = performance.now()) {
        this.bots.forEach(bot => {
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

function initBotVisualizer(controller, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const crateEl = document.createElement('div');
    crateEl.style.position = 'absolute';
    crateEl.style.width = '32px';
    crateEl.style.height = '32px';
    crateEl.style.backgroundColor = '#f4b41b';
    crateEl.style.left = (3 * 32) + 'px';
    crateEl.style.top = (5 * 32) + 'px';
    crateEl.style.border = '2px solid #ffd588';
    crateEl.style.display = 'flex';
    crateEl.style.alignItems = 'center';
    crateEl.style.justifyContent = 'center';
    crateEl.innerHTML = '<span class="material-symbols-outlined text-xs text-on-primary">box</span>';
    container.appendChild(crateEl);

    const zoneEl = document.createElement('div');
    zoneEl.style.position = 'absolute';
    zoneEl.style.width = '32px';
    zoneEl.style.height = '32px';
    zoneEl.style.backgroundColor = 'rgba(140, 242, 114, 0.2)';
    zoneEl.style.left = (7 * 32) + 'px';
    zoneEl.style.top = (5 * 32) + 'px';
    zoneEl.style.border = '2px dashed #8cf272';
    container.appendChild(zoneEl);

    // --- FEATURE ADDITION: Floating Tooltip Layer for Hover Telemetry ---
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

    function updateVisuals() {
        const active = controller.getActiveBot();

        // --- FULL TELEMETRY PANEL PROP MAPPING ---
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
        if (telInventory) telInventory.textContent = active.inventory;
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

        // Render/Update individual bot elements & interactive click shortcuts
        controller.bots.forEach(bot => {
            let el = botElementsMap.get(bot.bot_id);
            if (!el) {
                el = document.createElement('div');
                el.style.position = 'absolute';
                el.style.width = '32px';
                el.style.height = '32px';
                el.style.backgroundColor = bot.bot_id === controller.selectedBotId ? '#ffd588' : '#fdbb25';
                el.style.border = '2px solid #412d00';
                el.style.zIndex = '50';
                el.style.display = 'flex';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'center';
                el.style.cursor = 'pointer';
                el.innerHTML = `<div style="width: 8px; height: 8px; background: #412d00;"></div>`;
                
                // --- FEATURE ADDITION: Click to Select Shortcut & Hover Telemetry ---
                el.addEventListener('click', () => {
                    controller.selectBot(bot.bot_id);
                });
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

        // Update active hover tooltip info dynamically per frame if hovered
        if (hoveredBotId) {
            const targetBot = controller.bots.find(b => b.bot_id === hoveredBotId);
            if (targetBot) {
                const facingName = BOT_DIRECTIONS[targetBot.orientationIndex % BOT_DIRECTIONS.length].name.toUpperCase();
                tooltipEl.innerHTML = `
                    <strong>${targetBot.bot_id}</strong><br>
                    POS: (${targetBot.x}, ${targetBot.y})<br>
                    FACING: ${facingName}<br>
                    STATE: <span style="color: ${targetBot.taskState !== 'IDLE' ? '#8cf272' : '#ffd588'}">${targetBot.taskState}</span><br>
                    INV: ${targetBot.inventory}<br>
                    SCAN: ${targetBot.lastScanResult}
                `;
            }
        }

        const isCratePresent = controller.worldObjects.has('3,5');
        if (isCratePresent) {
            crateEl.style.display = 'flex';
        } else {
            crateEl.style.display = 'none';
        }

        requestAnimationFrame(updateVisuals);
    }
    updateVisuals();
}

window.botController = new BotController({ commandDelayMs: 400 });
initBotVisualizer(window.botController, 'VIEWPORT_ACTIVE');

function gameLoop() {
    if (window.botController) {
        window.botController.update();
    }
    requestAnimationFrame(gameLoop);
}
gameLoop();